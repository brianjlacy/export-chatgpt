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

async function fetchWithRetry(url, options, retries = 6) {
  const elapsed = Date.now() - lastRequestTime;
  if (elapsed < CONFIG.throttleMs) {
    const waitSec = Math.ceil((CONFIG.throttleMs - elapsed) / 1000);
    console.log(`  Throttling: Waiting ${waitSec}s...`);
    await sleep(CONFIG.throttleMs - elapsed);
  }
  lastRequestTime = Date.now();

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

module.exports = { createApiHeaders, fetchWithRetry, extractUserIdFromJWT, extractAccountIdFromJWT, getAccessToken };
