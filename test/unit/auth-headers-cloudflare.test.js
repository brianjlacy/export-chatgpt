'use strict';

// Regression test for the Cloudflare bot-fingerprint patch.
// chatgpt.com/backend-api sits behind Cloudflare which rejects requests that
// don't look browser-shaped. createApiHeaders() must mirror the browser's
// User-Agent, Referer, and Origin so Node fetch() gets through.
//
// Empirical diagnosis: 78V-Framework/_inbox/teams-auth-discovery-260606.md.

const { CONFIG } = require('../../lib/config');
const { createApiHeaders } = require('../../lib/auth');

describe('createApiHeaders — Cloudflare-friendly request shape', () => {
  const originalAccountId = CONFIG.accountId;
  afterEach(() => {
    CONFIG.accountId = originalAccountId;
  });

  test('sends the Authorization Bearer with the supplied token', () => {
    const h = createApiHeaders('eyJfaketoken123');
    expect(h.Authorization).toBe('Bearer eyJfaketoken123');
  });

  test('sends a Mac Chrome User-Agent (not the old Windows UA)', () => {
    const h = createApiHeaders('t');
    expect(h['User-Agent']).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36'
    );
    // Defensive: ensure no stale Windows UA leaked back in.
    expect(h['User-Agent']).not.toMatch(/Windows/);
  });

  test('sends Referer: https://chatgpt.com/', () => {
    const h = createApiHeaders('t');
    expect(h.Referer).toBe('https://chatgpt.com/');
  });

  test('sends Origin: https://chatgpt.com', () => {
    const h = createApiHeaders('t');
    expect(h.Origin).toBe('https://chatgpt.com');
  });

  test('sends Accept and Content-Type as JSON', () => {
    const h = createApiHeaders('t');
    expect(h.Accept).toBe('application/json');
    expect(h['Content-Type']).toBe('application/json');
  });

  test('omits chatgpt-account-id when CONFIG.accountId is unset', () => {
    CONFIG.accountId = null;
    const h = createApiHeaders('t');
    expect(h['chatgpt-account-id']).toBeUndefined();
  });

  test('sets chatgpt-account-id when CONFIG.accountId is set (Teams/workspace pinning)', () => {
    CONFIG.accountId = '871145c2-3112-49b8-8614-5dfe25e3b1eb';
    const h = createApiHeaders('t');
    expect(h['chatgpt-account-id']).toBe('871145c2-3112-49b8-8614-5dfe25e3b1eb');
  });

  test('does not leak unexpected headers (defensive — keeps the surface tight for upstream review)', () => {
    CONFIG.accountId = 'x';
    const h = createApiHeaders('t');
    const allowed = new Set([
      'Accept',
      'Content-Type',
      'Authorization',
      'User-Agent',
      'Referer',
      'Origin',
      'chatgpt-account-id',
    ]);
    Object.keys(h).forEach((k) => {
      expect(allowed.has(k)).toBe(true);
    });
  });
});
