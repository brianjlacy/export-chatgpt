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

let lastRequestTime = 0;

// Adaptive throttle state. Raises throttleMs on 429s and gently lowers it
// after sustained successful runs. Clamped to [minThrottleMs, maxThrottleMs].
// No-op when CONFIG.adaptiveThrottle is false.
let consecutiveSuccesses = 0;
const SUCCESS_STREAK_TO_DECREMENT = 20;
const HIT_INCREMENT_MS = 2000;
const SUCCESS_DECREMENT_MS = 1000;

function noteRateLimit() {
  if (!CONFIG.adaptiveThrottle) return;
  consecutiveSuccesses = 0;
  const newThrottle = Math.min(CONFIG.throttleMs + HIT_INCREMENT_MS, CONFIG.maxThrottleMs);
  if (newThrottle !== CONFIG.throttleMs) {
    verboseLog(`    Adaptive throttle: ${CONFIG.throttleMs / 1000}s → ${newThrottle / 1000}s (rate-limit hit)`);
    CONFIG.throttleMs = newThrottle;
  }
}

function noteSuccess() {
  if (!CONFIG.adaptiveThrottle) return;
  consecutiveSuccesses++;
  if (consecutiveSuccesses >= SUCCESS_STREAK_TO_DECREMENT) {
    consecutiveSuccesses = 0;
    const newThrottle = Math.max(CONFIG.throttleMs - SUCCESS_DECREMENT_MS, CONFIG.minThrottleMs);
    if (newThrottle !== CONFIG.throttleMs) {
      verboseLog(`    Adaptive throttle: ${CONFIG.throttleMs / 1000}s → ${newThrottle / 1000}s (${SUCCESS_STREAK_TO_DECREMENT} consecutive successes)`);
      CONFIG.throttleMs = newThrottle;
    }
  }
}

async function throttle() {
  if (CONFIG.throttleMs === 0) return;
  const elapsed = Date.now() - lastRequestTime;
  const remaining = CONFIG.throttleMs - elapsed;
  if (remaining > 0) {
    const endTime = Date.now() + remaining;
    const tick = () => {
      const secsLeft = Math.ceil((endTime - Date.now()) / 1000);
      process.stdout.write(`\r  Throttling: Waiting ${secsLeft}s...   `);
    };
    tick();
    const interval = setInterval(tick, 1000);
    await sleep(remaining);
    clearInterval(interval);
    process.stdout.write('\r' + ' '.repeat(40) + '\r'); // clear the line
  }
  lastRequestTime = Date.now();
}

async function fetchWithRetry(url, options, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 401 || response.status === 403) {
        verboseLog(`    Auth error: ${response.status} ${response.statusText} — ${url}`);
        const error = new Error(`Authentication failed (${response.status}). Your Bearer token may be expired.`);
        error.authError = true;
        throw error;
      }

      if (response.status === 429) {
        noteRateLimit();
        const rateLimitDelays = [60, 120, 300]; // seconds
        const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
        const waitTime = retryAfter > 0 ? retryAfter * 1000 : (rateLimitDelays[i] ?? 300) * 1000;
        console.log(`  Rate limited. Waiting ${waitTime / 1000}s before retry...`);
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

      noteSuccess();
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

module.exports = { createApiHeaders, fetchWithRetry, throttle, extractUserIdFromJWT, extractAccountIdFromJWT, getAccessToken, verifyToken };
