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
