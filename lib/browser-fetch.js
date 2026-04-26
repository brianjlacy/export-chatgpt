'use strict';

// Headless-Chrome fetch bypass for Cloudflare IP reputation blocks.
// When an IP is flagged, Cloudflare serves a "managed challenge" page that
// requires a real browser to solve. This module launches a Playwright Chromium
// instance, solves the challenge, then proxies all API fetches through the
// browser context so they inherit the valid CF session.

let browser = null;
let context = null;
let page = null;

async function ensureReady() {
  if (page) return;

  const { chromium } = require('playwright');
  console.log('\n  [CF bypass] Starting headless Chrome...');

  // Use the full Chromium binary (not the stripped headless shell) so that
  // Cloudflare's managed challenge can fingerprint a complete browser environment.
  browser = await chromium.launch({
    headless: true,
    executablePath: chromium.executablePath(),
    args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
  });
  context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  // Remove the navigator.webdriver flag that signals automation to CF's challenge.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
    window.chrome = { runtime: {} };
  });
  page = await context.newPage();

  console.log('  [CF bypass] Navigating to chatgpt.com (solving Cloudflare challenge)...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'load', timeout: 60000 });

  // If the page loaded a CF managed challenge, window._cf_chl_opt will be set.
  // The browser will solve it automatically and redirect; poll for cf_clearance.
  const challenged = await page.evaluate(() => typeof window._cf_chl_opt !== 'undefined');
  if (challenged) {
    console.log('  [CF bypass] Challenge detected, waiting for it to resolve...');
    let solved = false;
    for (let i = 0; i < 60; i++) {
      const cookies = await context.cookies('https://chatgpt.com');
      if (cookies.some(c => c.name === 'cf_clearance')) {
        solved = true;
        break;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
    if (!solved) throw new Error('[CF bypass] Cloudflare challenge did not resolve within 60s');
  }

  console.log('  [CF bypass] Session ready — routing API calls through browser.\n');
}

async function browserFetch(url, options = {}) {
  await ensureReady();

  // Convert Headers instance or plain object to a serializable plain object.
  const headersObj = {};
  if (options.headers) {
    if (typeof options.headers.forEach === 'function') {
      options.headers.forEach((v, k) => { headersObj[k] = v; });
    } else {
      Object.assign(headersObj, options.headers);
    }
  }

  // setExtraHTTPHeaders applies to every subsequent request from the page,
  // including page.goto() navigations. Auth headers don't change mid-session,
  // but we set them per-call anyway since the caller owns the token lifecycle.
  // Avoids page.route() URL globbing (the API URL contains `?` and `&` which
  // are glob metacharacters and would prevent a literal-URL match).
  await page.setExtraHTTPHeaders(headersObj);

  // page.goto() (Sec-Fetch-Mode: navigate) bypasses the CF WAF rule that
  // challenges in-page fetch() calls (Sec-Fetch-Mode: cors).
  // Returns null for direct binary downloads (no DOM) — treat as a
  // retriable network error rather than crashing with a null-dereference.
  const response = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  if (!response) {
    const err = new Error('browserFetch: page.goto() returned null (binary download or navigation aborted)');
    err.noRetry = false;
    throw err;
  }

  const status = response.status();
  const respHeaders = response.headers();

  if (respHeaders['cf-mitigated'] === 'challenge') {
    const error = new Error('Cloudflare challenge on API endpoint — browser bypass insufficient.');
    error.cloudflareError = true;
    error.authError = true;
    throw error;
  }

  // response.text() returns the raw HTTP body — no dependency on Chromium's
  // JSON auto-formatter or document.body parsing.
  const body = await response.text();

  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => respHeaders[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(JSON.parse(body)),
    text: () => Promise.resolve(body),
  };
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
    context = null;
    page = null;
  }
}

module.exports = { browserFetch, closeBrowser };
