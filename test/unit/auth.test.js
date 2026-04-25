'use strict';

// Mock sleep so retry/backoff delays don't slow tests down
jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
});

describe('auth', () => {
  let CONFIG, createApiHeaders, extractAccountIdFromJWT;

  beforeEach(() => {
    jest.resetModules();
    ({ CONFIG } = require('../../lib/config'));
    ({ createApiHeaders, extractAccountIdFromJWT } = require('../../lib/auth'));
  });

  describe('createApiHeaders', () => {
    test('includes Authorization header with bearer token', () => {
      const headers = createApiHeaders('test-token');
      expect(headers['Authorization']).toBe('Bearer test-token');
    });

    test('includes standard headers', () => {
      const headers = createApiHeaders('token');
      expect(headers['Accept']).toBe('application/json');
      expect(headers['Content-Type']).toBe('application/json');
      expect(headers['User-Agent']).toBeTruthy();
    });

    test('includes account ID header when configured', () => {
      CONFIG.accountId = 'team-account-123';
      const headers = createApiHeaders('token');
      expect(headers['chatgpt-account-id']).toBe('team-account-123');
    });

    test('omits account ID header when not configured', () => {
      CONFIG.accountId = null;
      const headers = createApiHeaders('token');
      expect(headers['chatgpt-account-id']).toBeUndefined();
    });
  });

  describe('extractAccountIdFromJWT', () => {
    function makeJWT(payload) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.signature`;
    }

    test('extracts account ID for team plan', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'team',
          chatgpt_account_id: 'acct-123',
        },
      });
      expect(extractAccountIdFromJWT(token)).toBe('acct-123');
    });

    test('extracts account ID for enterprise plan', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'enterprise',
          chatgpt_account_id: 'acct-456',
        },
      });
      expect(extractAccountIdFromJWT(token)).toBe('acct-456');
    });

    test('returns null for personal plans', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'free',
          chatgpt_account_id: 'acct-789',
        },
      });
      expect(extractAccountIdFromJWT(token)).toBeNull();
    });

    test('returns null for pro plan', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': {
          chatgpt_plan_type: 'pro',
        },
      });
      expect(extractAccountIdFromJWT(token)).toBeNull();
    });

    test('returns null for invalid token', () => {
      expect(extractAccountIdFromJWT('not-a-jwt')).toBeNull();
      expect(extractAccountIdFromJWT('')).toBeNull();
    });

    test('returns null when auth claim is missing', () => {
      const token = makeJWT({ sub: 'user123' });
      expect(extractAccountIdFromJWT(token)).toBeNull();
    });
  });

  describe('fetchWithRetry', () => {
    let fetchWithRetry;

    beforeEach(() => {
      jest.resetModules();
      jest.spyOn(console, 'log').mockImplementation();
      ({ CONFIG } = require('../../lib/config'));
      CONFIG.verbose = false;
      ({ fetchWithRetry } = require('../../lib/auth'));
    });

    afterEach(() => {
      jest.restoreAllMocks();
      if (global.fetch?.mockRestore) global.fetch.mockRestore();
    });

    test('returns response on success', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 1);
      expect(response.ok).toBe(true);
      global.fetch.mockRestore();
    });

    test('throws authError on 401', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, statusText: 'Unauthorized',
      });
      await expect(fetchWithRetry('https://example.com', {}, 1))
        .rejects.toMatchObject({ authError: true });
      global.fetch.mockRestore();
    });

    test('throws authError on 403', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 403, statusText: 'Forbidden',
      });
      await expect(fetchWithRetry('https://example.com', {}, 1))
        .rejects.toMatchObject({ authError: true });
      global.fetch.mockRestore();
    });

    test('flags cloudflareError on 403 with cf-mitigated: challenge header', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: (name) => (name === 'cf-mitigated' ? 'challenge' : null) },
      });
      await expect(fetchWithRetry('https://example.com', {}, 1))
        .rejects.toMatchObject({ authError: true, cloudflareError: true });
      global.fetch.mockRestore();
    });

    test('does not flag cloudflareError on 403 without cf-mitigated header', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        headers: { get: () => null },
      });
      const err = await fetchWithRetry('https://example.com', {}, 1).catch(e => e);
      expect(err.authError).toBe(true);
      expect(err.cloudflareError).toBeUndefined();
      global.fetch.mockRestore();
    });

    test('retries on non-OK responses', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
      global.fetch.mockRestore();
    });

    test('retries on 429 rate limit', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: () => '0' },
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
      global.fetch.mockRestore();
    }, 30000);

    test('throws after all retries exhausted', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 500, statusText: 'Server Error',
      });
      await expect(fetchWithRetry('https://example.com', {}, 2))
        .rejects.toThrow('HTTP 500');
      global.fetch.mockRestore();
    });
  });

  describe('extractUserIdFromJWT', () => {
    let extractUserIdFromJWT;

    beforeEach(() => {
      jest.resetModules();
      ({ extractUserIdFromJWT } = require('../../lib/auth'));
    });

    function makeJWT(payload) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.signature`;
    }

    test('returns chatgpt_user_id from OpenAI auth namespace', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': { chatgpt_user_id: 'user-abc123' },
      });
      expect(extractUserIdFromJWT(token)).toBe('user-abc123');
    });

    test('falls back to user_id when chatgpt_user_id is absent', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': { user_id: 'user-fallback' },
      });
      expect(extractUserIdFromJWT(token)).toBe('user-fallback');
    });

    test('returns null when auth namespace is missing', () => {
      const token = makeJWT({ sub: 'google-oauth2|12345' });
      expect(extractUserIdFromJWT(token)).toBeNull();
    });

    test('returns null when both user ID fields are absent', () => {
      const token = makeJWT({
        'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' },
      });
      expect(extractUserIdFromJWT(token)).toBeNull();
    });

    test('returns null for malformed token', () => {
      expect(extractUserIdFromJWT('not.a.jwt')).toBeNull();
      expect(extractUserIdFromJWT('garbage')).toBeNull();
      expect(extractUserIdFromJWT('')).toBeNull();
    });
  });

  describe('extractExpiryFromJWT', () => {
    let extractExpiryFromJWT;

    beforeEach(() => {
      jest.resetModules();
      ({ extractExpiryFromJWT } = require('../../lib/auth'));
    });

    function makeJWT(payload) {
      const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
      return `${header}.${body}.signature`;
    }

    test('returns exp claim converted from seconds to ms', () => {
      const token = makeJWT({ exp: 1777509211 });
      expect(extractExpiryFromJWT(token)).toBe(1777509211 * 1000);
    });

    test('returns null when exp claim is missing', () => {
      const token = makeJWT({ sub: 'user123' });
      expect(extractExpiryFromJWT(token)).toBeNull();
    });

    test('returns null when exp is not a number', () => {
      const token = makeJWT({ exp: 'soon' });
      expect(extractExpiryFromJWT(token)).toBeNull();
    });

    test('returns null for malformed token', () => {
      expect(extractExpiryFromJWT('not-a-jwt')).toBeNull();
      expect(extractExpiryFromJWT('')).toBeNull();
    });
  });

  describe('pacing persistence', () => {
    let getPacingSnapshot, restorePacingSnapshot, getPacingStats;

    beforeEach(() => {
      jest.resetModules();
      jest.spyOn(console, 'log').mockImplementation();
      ({ getPacingSnapshot, restorePacingSnapshot, getPacingStats } = require('../../lib/auth'));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('snapshot contains currentInterval, consecutive429s, lastUpdated', () => {
      const snap = getPacingSnapshot();
      expect(snap).toHaveProperty('currentInterval');
      expect(snap).toHaveProperty('consecutive429s');
      expect(snap).toHaveProperty('lastUpdated');
      expect(typeof snap.currentInterval).toBe('number');
      expect(typeof snap.consecutive429s).toBe('number');
      expect(typeof snap.lastUpdated).toBe('number');
    });

    test('restore rejects null/undefined input', () => {
      expect(restorePacingSnapshot(null)).toBe(false);
      expect(restorePacingSnapshot(undefined)).toBe(false);
    });

    test('restore rejects non-object input', () => {
      expect(restorePacingSnapshot('string')).toBe(false);
      expect(restorePacingSnapshot(42)).toBe(false);
    });

    test('restore rejects stale snapshot (>10min old)', () => {
      const snap = {
        currentInterval: 30000,
        consecutive429s: 2,
        lastUpdated: Date.now() - (11 * 60 * 1000),
      };
      expect(restorePacingSnapshot(snap)).toBe(false);
      // State should not have been mutated to stale values
      expect(getPacingSnapshot().currentInterval).not.toBe(30000);
    });

    test('restore applies fresh snapshot', () => {
      const snap = {
        currentInterval: 25000,
        consecutive429s: 3,
        lastUpdated: Date.now() - 5000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      const restored = getPacingSnapshot();
      expect(restored.currentInterval).toBe(25000);
      expect(restored.consecutive429s).toBe(3);
    });

    test('restore caps currentInterval at PACING_MAX_INTERVAL_MS (120s)', () => {
      const snap = {
        currentInterval: 300000, // 5 min — above cap
        consecutive429s: 5,
        lastUpdated: Date.now(),
      };
      restorePacingSnapshot(snap);
      expect(getPacingSnapshot().currentInterval).toBe(120000);
    });

    test('restore ignores currentInterval below baselineFloor', () => {
      // baselineFloor is 2000. Values below that (stale/junk) should be rejected.
      const snap = {
        currentInterval: 500,
        consecutive429s: 0,
        lastUpdated: Date.now(),
      };
      restorePacingSnapshot(snap);
      // Unchanged from default baseline (2000), not lowered to 500
      expect(getPacingSnapshot().currentInterval).toBeGreaterThanOrEqual(2000);
    });

    test('restore ignores negative consecutive429s', () => {
      const snap = {
        currentInterval: 15000,
        consecutive429s: -1,
        lastUpdated: Date.now(),
      };
      restorePacingSnapshot(snap);
      expect(getPacingSnapshot().consecutive429s).toBeGreaterThanOrEqual(0);
    });

    test('getPacingStats exposes peakInterval', () => {
      const stats = getPacingStats();
      expect(stats).toHaveProperty('peakInterval');
      expect(typeof stats.peakInterval).toBe('number');
      expect(stats.peakInterval).toBeGreaterThanOrEqual(stats.currentInterval);
    });

    test('restore updates peakInterval to max of current/restored', () => {
      const snap = {
        currentInterval: 40000,
        consecutive429s: 1,
        lastUpdated: Date.now(),
      };
      restorePacingSnapshot(snap);
      expect(getPacingStats().peakInterval).toBeGreaterThanOrEqual(40000);
    });

    test('fresh snapshot (age < 60s) is restored verbatim', () => {
      const snap = {
        currentInterval: 80000,
        consecutive429s: 2,
        lastUpdated: Date.now() - 30 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      expect(getPacingSnapshot().currentInterval).toBe(80000);
      expect(getPacingSnapshot().consecutive429s).toBe(2);
    });

    test('mid-age snapshot (5min) decays to ~50% of interval', () => {
      const snap = {
        currentInterval: 100000, // 100s
        consecutive429s: 3,
        lastUpdated: Date.now() - 5 * 60 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      const { currentInterval } = getPacingSnapshot();
      // Linear decay between 60s (factor 1) and 600s (factor 0):
      //   factor = 1 - (300-60)/(600-60) = 1 - 240/540 ≈ 0.556
      //   100000 * 0.556 ≈ 55555
      expect(currentInterval).toBeGreaterThan(50000);
      expect(currentInterval).toBeLessThan(60000);
    });

    test('near-stale snapshot (9min) decays heavily', () => {
      const snap = {
        currentInterval: 100000,
        consecutive429s: 4,
        lastUpdated: Date.now() - 9 * 60 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      const { currentInterval } = getPacingSnapshot();
      // factor = 1 - (540-60)/540 ≈ 0.111
      // 100000 * 0.111 ≈ 11111 — but baselineFloor is 2000, so no floor applied
      expect(currentInterval).toBeGreaterThan(10000);
      expect(currentInterval).toBeLessThan(15000);
    });

    test('decayed interval clamps up to baselineFloor', () => {
      const snap = {
        currentInterval: 3000, // just above baseline
        consecutive429s: 1,
        lastUpdated: Date.now() - 9 * 60 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      // 3000 * ~0.111 = ~333, clamped to baselineFloor (2000)
      expect(getPacingSnapshot().currentInterval).toBe(2000);
    });

    test('decay scales consecutive429s linearly with age', () => {
      const snap = {
        currentInterval: 60000,
        consecutive429s: 5,
        lastUpdated: Date.now() - 5 * 60 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      // factor ≈ 0.556, 5 * 0.556 ≈ 2.78 → floor = 2
      expect(getPacingSnapshot().consecutive429s).toBe(2);
    });

    test('near-stale decay floors consecutive429s toward 0', () => {
      const snap = {
        currentInterval: 60000,
        consecutive429s: 5,
        lastUpdated: Date.now() - 9 * 60 * 1000,
      };
      expect(restorePacingSnapshot(snap)).toBe(true);
      // factor ≈ 0.111, 5 * 0.111 ≈ 0.56 → floor = 0
      expect(getPacingSnapshot().consecutive429s).toBe(0);
    });
  });

  describe('throttle', () => {
    let throttle;

    beforeEach(() => {
      jest.resetModules();
      jest.spyOn(process.stdout, 'write').mockImplementation();
      ({ CONFIG } = require('../../lib/config'));
      ({ throttle } = require('../../lib/auth'));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test('returns immediately when throttleMs is 0', async () => {
      CONFIG.throttleMs = 0;
      const start = Date.now();
      await throttle();
      expect(Date.now() - start).toBeLessThan(50);
    });

    test('returns immediately on first call (no prior request)', async () => {
      CONFIG.throttleMs = 60000; // 60s would block if not first call
      const start = Date.now();
      await throttle(); // first call — no prior request, so no wait
      expect(Date.now() - start).toBeLessThan(100);
    });
  });
});
