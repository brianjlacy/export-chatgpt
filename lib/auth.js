'use strict';

const { CONFIG, verboseLog, sleep } = require('./config');

function createApiHeaders(accessToken) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  };

  if (CONFIG.accountId) {
    headers['chatgpt-account-id'] = CONFIG.accountId;
  }

  return headers;
}

// Adaptive Pacing State — module-level. Persisted to .export-progress.json
// via getPacingSnapshot() / restorePacingSnapshot() so that if a run is
// interrupted (token expiry, OOM, user Ctrl-C) the next run resumes at the
// last-learned cadence instead of re-discovering the 429 ceiling from 2s.
const PACING = {
  currentInterval: 2000,
  consecutive429s: 0,
  baselineFloor: 2000,
  payloadBaseline: 2000,
  indexingBaseline: 5000,
  jitterFactor: 0.15,
  lastUpdated: Date.now(),
  // Peak currentInterval seen this session. Not persisted — reset on each run
  // so the end-of-run summary reports what this session actually endured.
  peakInterval: 2000,
};

// Restored pacing older than this is considered stale — the rate-limit
// window has likely drained, so resuming at a cautious interval is wasteful.
// Start fresh from baseline instead.
const PACING_STALE_MS = 10 * 60 * 1000;
const PACING_MAX_INTERVAL_MS = 120000;
// Snapshots within this window are restored verbatim — the bucket has not
// drained meaningfully. Beyond it we linearly decay toward baseline up to
// PACING_STALE_MS. Empirically: resuming at a 115s interval after a restart
// yielded ~32 conv/hr, while resetting to 20s yielded ~176 conv/hr with zero
// 429s — the bucket had drained during the restart, so inheriting the
// pessimistic interval was stranding throughput.
const PACING_AGE_FULL_RESTORE_MS = 60 * 1000;

function getPacingSnapshot() {
  return {
    currentInterval: PACING.currentInterval,
    consecutive429s: PACING.consecutive429s,
    lastUpdated: PACING.lastUpdated,
  };
}

function getPacingStats() {
  return {
    currentInterval: PACING.currentInterval,
    peakInterval: PACING.peakInterval,
    consecutive429s: PACING.consecutive429s,
  };
}

// Reset session-only stats (peakInterval) so the end-of-run summary reflects
// what the CURRENT run endured, not the high-water mark from an earlier
// run() invocation in the same process (tests, wrapper scripts).
function resetSessionPacingStats() {
  PACING.peakInterval = PACING.currentInterval;
}

function restorePacingSnapshot(snap) {
  if (!snap || typeof snap !== 'object') return false;
  const age = Date.now() - (snap.lastUpdated || 0);
  if (age > PACING_STALE_MS) {
    verboseLog(`    Pacing snapshot ${Math.round(age / 60000)} min old — starting at baseline`);
    return false;
  }
  let decayFactor = 1;
  if (age > PACING_AGE_FULL_RESTORE_MS) {
    decayFactor = 1 - (age - PACING_AGE_FULL_RESTORE_MS) / (PACING_STALE_MS - PACING_AGE_FULL_RESTORE_MS);
  }
  if (typeof snap.currentInterval === 'number' && snap.currentInterval >= PACING.baselineFloor) {
    const decayed = Math.round(snap.currentInterval * decayFactor);
    const floored = Math.max(PACING.baselineFloor, decayed);
    PACING.currentInterval = Math.min(floored, PACING_MAX_INTERVAL_MS);
    PACING.peakInterval = Math.max(PACING.peakInterval, PACING.currentInterval);
  }
  // consecutive429s drives how aggressively the next 429 escalates. Decay
  // it on the same curve as currentInterval so a restart 61s later doesn't
  // cliff the counter from 4 to 0, which would re-enter fresh-first-hit
  // territory before the bucket has actually drained.
  if (typeof snap.consecutive429s === 'number' && snap.consecutive429s >= 0) {
    PACING.consecutive429s = Math.floor(snap.consecutive429s * decayFactor);
  }
  PACING.lastUpdated = snap.lastUpdated;
  const decayNote = decayFactor < 1
    ? ` (decayed ${Math.round((1 - decayFactor) * 100)}% from ${(snap.currentInterval / 1000).toFixed(1)}s)`
    : '';
  console.log(`  Pacing restored from previous run: interval=${(PACING.currentInterval / 1000).toFixed(1)}s, consecutive429s=${PACING.consecutive429s} (${Math.round(age / 1000)}s ago)${decayNote}`);
  return true;
}

let lastRequestTime = 0;

function applyJitter(ms) {
  const jitter = ms * PACING.jitterFactor;
  const amount = (Math.random() * 2 - 1) * jitter;
  return Math.max(0, ms + amount);
}

function updatePacingOnSuccess() {
  PACING.consecutive429s = 0;
  PACING.currentInterval = Math.max(PACING.baselineFloor, PACING.currentInterval - 500);
  PACING.lastUpdated = Date.now();
}

function updatePacingOn429(retryAfterMs) {
  if (retryAfterMs) {
    PACING.currentInterval = retryAfterMs;
  } else {
    if (PACING.consecutive429s === 0) {
      PACING.currentInterval = 20000;
    } else {
      PACING.currentInterval = Math.min(120000, PACING.currentInterval * 1.5);
    }
    PACING.consecutive429s++;
  }
  PACING.peakInterval = Math.max(PACING.peakInterval, PACING.currentInterval);
  PACING.lastUpdated = Date.now();
}

async function throttle(phase = 'payload', options = {}) {
  // Pacing fully disabled (test bypass, or user passed --throttle 0).
  if (CONFIG.throttleMs === 0) {
    lastRequestTime = Date.now();
    return;
  }

  let base = (phase === 'indexing') ? PACING.indexingBaseline : PACING.payloadBaseline;

  if (phase === 'indexing' && options.offset !== undefined) {
    base += Math.floor(options.offset / 50) * 1000;
  }

  // User-specified floor via --throttle (null = no user floor).
  if (typeof CONFIG.throttleMs === 'number' && CONFIG.throttleMs > 0) {
    base = Math.max(base, CONFIG.throttleMs);
  }

  const delay = Math.max(PACING.currentInterval, base);
  const finalDelay = applyJitter(delay);


  const elapsed = Date.now() - lastRequestTime;
  const remaining = finalDelay - elapsed;
  if (remaining > 0) {
    if (process.stdout.isTTY) {
      // Interactive: live ticker that overwrites itself via \r.
      const endTime = Date.now() + remaining;
      const tick = () => {
        const secsLeft = Math.ceil((endTime - Date.now()) / 1000);
        process.stdout.write(`\r  Throttling (${phase}): Waiting ${secsLeft}s...   `);
      };
      tick();
      const interval = setInterval(tick, 1000);
      await sleep(remaining);
      clearInterval(interval);
      process.stdout.write('\r' + ' '.repeat(50) + '\r');
    } else {
      // Headless: one-shot log. \r-tickers pile into a single 100KB+ line
      // in log files and make tailing useless. Sub-5s waits are skipped
      // to keep the log readable.
      const secs = Math.ceil(remaining / 1000);
      if (secs >= 5) console.log(`  Throttling (${phase}): ${secs}s`);
      await sleep(remaining);
    }
  }
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url, options, retries = 6) {
  const fetcher = CONFIG.useBrowserFetch
    ? require('./browser-fetch').browserFetch
    : fetch;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetcher(url, options);

      if (response.status === 401 || response.status === 403) {
        // Cloudflare's anti-bot interstitial is also served as 403. The
        // `cf-mitigated: challenge` header is the authoritative signal —
        // surface this as a distinct error so we don't tell the user to
        // rotate a token that isn't actually the problem.
        const isCfChallenge = response.status === 403
          && response.headers?.get?.('cf-mitigated') === 'challenge';
        if (isCfChallenge) {
          verboseLog(`    Cloudflare challenge — ${url}`);
          const error = new Error('Cloudflare challenge detected (IP reputation flag). Your token is likely valid; wait 30-60 min and retry, or run from a different IP.');
          error.cloudflareError = true;
          // Keep authError set so existing save-progress-and-bail paths
          // still trigger — the flag marks "stop now, preserve state."
          error.authError = true;
          throw error;
        }
        verboseLog(`    Auth error: ${response.status} ${response.statusText} — ${url}`);
        const error = new Error(`Authentication failed (${response.status}). Your Bearer token may be expired.`);
        error.authError = true;
        throw error;
      }

      if (response.status === 429) {
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
        updatePacingOn429(retryAfter > 0 ? retryAfter * 1000 : null);

        const waitTime = applyJitter(PACING.currentInterval);
        console.log(`\n  Rate limited. Waiting ${Math.round(waitTime / 1000)}s before retry...`);
        await sleep(waitTime);
        continue;
      }

      if (response.status === 404) {
        verboseLog(`    HTTP 404 Not Found — ${url}`);
        const error = new Error(`HTTP 404: Not Found`);
        error.noRetry = true;
        throw error;
      }

      if (!response.ok) {
        verboseLog(`    HTTP ${response.status} ${response.statusText} — ${url}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      updatePacingOnSuccess();
      return response;
    } catch (error) {
      if (error.authError || error.noRetry) throw error;
      if (i === retries - 1) throw error;
      console.log(`  Request failed, retrying (${i + 1}/${retries})...`);
      verboseLog(`    Reason: ${error.message}`);
      await sleep(2000);
    }
  }
  throw new Error('Request failed after maximum retries');
}

// Extract ChatGPT user ID from a JWT bearer token.
// Uses chatgpt_user_id from the OpenAI auth namespace (not the Auth0 'sub' claim,
// which contains the OAuth provider identity and is not suitable as a directory name).
function extractUserIdFromJWT(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const auth = payload?.['https://api.openai.com/auth'];
    return auth?.chatgpt_user_id || auth?.user_id || null;
  } catch {
    return null;
  }
}

// Extract token expiry (as epoch ms) from the standard JWT `exp` claim.
// Returns null for malformed tokens or missing claim. The claim is in seconds
// per RFC 7519 — we convert to ms to match Date.now() for easy comparison.
function extractExpiryFromJWT(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload?.exp) ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

// Extract Teams account ID from a JWT bearer token (avoids manual entry).
// Only returns the account ID for business plans (team, enterprise) that require
// the chatgpt-account-id header. Personal plans (free, pro) should not include it.
function extractAccountIdFromJWT(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const auth = payload?.['https://api.openai.com/auth'];
    const planType = auth?.chatgpt_plan_type;
    const businessPlans = ['team', 'enterprise'];
    if (!businessPlans.includes(planType)) return null;
    return auth?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

// Get access token from session (fallback method)
async function getAccessToken(sessionToken) {
  console.log('Getting access token from session...');

  const response = await fetchWithRetry(
    `${CONFIG.baseUrl}/api/auth/session`,
    {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': `__Secure-next-auth.session-token=${sessionToken}`,
      }
    }
  );

  const data = await response.json();

  if (!data.accessToken) {
    throw new Error('Could not get access token. Session token may be invalid.');
  }

  return data.accessToken;
}

// Verify whether the token is still valid by making a lightweight API call.
// Returns true if valid, false if expired/revoked.
async function verifyToken(accessToken) {
  try {
    const response = await fetch(
      `${CONFIG.apiBase}/conversations?limit=1&offset=0&order=updated`,
      { headers: createApiHeaders(accessToken) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

module.exports = { createApiHeaders, fetchWithRetry, throttle, extractUserIdFromJWT, extractAccountIdFromJWT, extractExpiryFromJWT, getAccessToken, verifyToken, getPacingSnapshot, restorePacingSnapshot, getPacingStats, resetSessionPacingStats };
