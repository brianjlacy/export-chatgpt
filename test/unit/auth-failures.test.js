'use strict';

// Mock sleep so retry/backoff delays don't slow tests down
jest.mock('../../lib/config', () => {
  const actual = jest.requireActual('../../lib/config');
  return { ...actual, sleep: jest.fn().mockResolvedValue(undefined) };
});

describe('auth failure cases', () => {
  let CONFIG, fetchWithRetry, getAccessToken, verifyToken;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation();
    ({ CONFIG } = require('../../lib/config'));
    CONFIG.verbose = false;
    ({ fetchWithRetry, getAccessToken, verifyToken } = require('../../lib/auth'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (global.fetch?.mockRestore) global.fetch.mockRestore();
  });

  describe('fetchWithRetry - network errors', () => {
    test('retries on network/DNS failure', async () => {
      global.fetch = jest.fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('throws after exhausting retries on persistent network failure', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      await expect(fetchWithRetry('https://example.com', {}, 2))
        .rejects.toThrow('ECONNREFUSED');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('does not retry auth errors even with retries remaining', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, statusText: 'Unauthorized',
      });
      await expect(fetchWithRetry('https://example.com', {}, 5))
        .rejects.toMatchObject({ authError: true });
      // Auth errors throw immediately, no retries
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('auth error message mentions token expiry', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, statusText: 'Unauthorized',
      });
      await expect(fetchWithRetry('https://example.com', {}, 1))
        .rejects.toThrow(/Bearer token.*expired/i);
    });

    test('handles timeout/abort errors', async () => {
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      global.fetch = jest.fn()
        .mockRejectedValueOnce(abortError)
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
    });

    test('handles 429 with retry-after header', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: (h) => h === 'retry-after' ? '1' : null },
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
    }, 10000);

    test('handles 429 without retry-after header (uses exponential backoff)', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({
          ok: false, status: 429, statusText: 'Too Many Requests',
          headers: { get: () => null },
        })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
    }, 30000);

    test('handles 502 Bad Gateway with retry', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 502, statusText: 'Bad Gateway' })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
    });

    test('handles 503 Service Unavailable with retry', async () => {
      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 503, statusText: 'Service Unavailable' })
        .mockResolvedValueOnce({ ok: true, status: 200 });
      const response = await fetchWithRetry('https://example.com', {}, 2);
      expect(response.ok).toBe(true);
    });
  });

  describe('verifyToken', () => {
    test('returns true when conversations endpoint returns 200', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 });
      const result = await verifyToken('valid-token');
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/conversations?limit=1'),
        expect.objectContaining({ headers: expect.any(Object) }),
      );
    });

    test('returns false when conversations endpoint returns 401', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401 });
      const result = await verifyToken('expired-token');
      expect(result).toBe(false);
    });

    test('returns false when conversations endpoint returns 403', async () => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403 });
      const result = await verifyToken('revoked-token');
      expect(result).toBe(false);
    });

    test('returns false on network error', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
      const result = await verifyToken('any-token');
      expect(result).toBe(false);
    });
  });

  describe('getAccessToken - failure cases', () => {
    test('throws when session response has no accessToken', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ user: 'test' }),
      });
      await expect(getAccessToken('bad-session-token'))
        .rejects.toThrow(/Could not get access token/);
    });

    test('throws on auth failure during session exchange', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, statusText: 'Unauthorized',
      });
      await expect(getAccessToken('expired-session'))
        .rejects.toMatchObject({ authError: true });
    });

    test('succeeds with valid session token', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ accessToken: 'new-bearer-token' }),
      });
      const token = await getAccessToken('valid-session');
      expect(token).toBe('new-bearer-token');
    });
  });
});
