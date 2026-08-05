'use strict';

// Regression tests for conversation fetches that return HTTP 404.
//
// Two different situations share this status code, distinguishable only by
// the response body:
//   no_access  — "You don't have access to this conversation". Stable and
//                conversation-specific; reproduces from the browser.
//   not_found  — a bare 404. Usually the client's fault (edge/bot rejection,
//                which climbs the longer a run goes) and retryable.
// Verified against a live account: of 60 sampled failures, 31 were no_access
// and 29 returned HTTP 200 with full content moments later. Treating the
// second kind as permanent would convert a recoverable failure into silent
// data loss, so it is always retried unless the user opts out.

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('permanently failed conversations', () => {
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-chatgpt-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('storage progress schema', () => {
    function loadStorageWithProgressFile(contents) {
      const { CONFIG, PATHS } = require('../../lib/config');
      CONFIG.outputDir = tmpDir;
      PATHS.progressFile = path.join(tmpDir, '.export-progress.json');
      if (contents !== undefined) {
        fs.writeFileSync(PATHS.progressFile, JSON.stringify(contents));
      }
      return require('../../lib/storage');
    }

    test('fresh progress includes failedConversationIds', () => {
      const { loadProgress } = loadStorageWithProgressFile();
      expect(loadProgress().failedConversationIds).toEqual({});
    });

    test('migrates a progress file written before the field existed', () => {
      const { loadProgress } = loadStorageWithProgressFile({
        indexingComplete: true,
        lastOffset: 84,
        downloadedIds: ['a', 'b'],
      });
      const progress = loadProgress();
      expect(progress.failedConversationIds).toEqual({});
      expect(progress.downloadedIds).toEqual(['a', 'b']);
    });

    test('preserves existing failedConversationIds', () => {
      const existing = { 'dead-id': { status: 404, reason: 'not_found', attempts: 3 } };
      const { loadProgress } = loadStorageWithProgressFile({
        downloadedIds: [],
        failedConversationIds: existing,
      });
      expect(loadProgress().failedConversationIds).toEqual(existing);
    });

    test('round-trips through saveProgress', () => {
      const { loadProgress, saveProgress } = loadStorageWithProgressFile();
      const progress = loadProgress();
      progress.failedConversationIds['dead-id'] = { status: 404, attempts: 1 };
      saveProgress(progress);
      expect(loadProgress().failedConversationIds['dead-id']).toEqual({ status: 404, attempts: 1 });
    });
  });

  describe('fetchWithRetry 404 tagging', () => {
    let auth, CONFIG;

    beforeEach(() => {
      ({ CONFIG } = require('../../lib/config'));
      CONFIG.throttleMs = 0;
      auth = require('../../lib/auth');
    });

    afterEach(() => {
      delete global.fetch;
    });

    test('tags a bare 404 as notFound, ambiguous, and does not retry', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 404, ok: false, statusText: 'Not Found', text: () => Promise.resolve('{"detail":"Not found"}'),
      });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}).catch(e => e);

      expect(error.notFound).toBe(true);
      expect(error.accessDenied).toBe(false);
      expect(error.status).toBe(404);
      expect(error.noRetry).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('distinguishes an access-denied 404 from a bare one', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        status: 404, ok: false, statusText: 'Not Found',
        text: () => Promise.resolve('{"detail":{"message":"You don\u2019t have access to this conversation. Make sure you\u2019re logged in to the right account."}}'),
      });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}).catch(e => e);

      expect(error.notFound).toBe(true);
      expect(error.accessDenied).toBe(true);
      expect(error.message).toMatch(/No access/);
    });

    test('does not tag other HTTP errors as notFound', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false, statusText: 'Server Error', text: () => Promise.resolve('') });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}, 1).catch(e => e);

      expect(error.notFound).toBeUndefined();
      expect(error.status).toBe(500);
    });

    test('auth errors stay auth errors, not notFound', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false, statusText: 'Unauthorized', text: () => Promise.resolve('') });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}).catch(e => e);

      expect(error.authError).toBe(true);
      expect(error.notFound).toBeUndefined();
    });
  });

  describe('printSummary reporting', () => {
    let printSummary, CONFIG, logSpy;

    beforeEach(() => {
      ({ CONFIG } = require('../../lib/config'));
      CONFIG.outputDir = tmpDir;
      CONFIG.showSummary = true;
      CONFIG.downloadFiles = false;
      ({ printSummary } = require('../../lib/exporter'));
      logSpy = jest.spyOn(console, 'log').mockImplementation();
    });

    afterEach(() => logSpy.mockRestore());

    const output = () => logSpy.mock.calls.map(c => c[0]).join('\n');
    const summary = (overrides = {}) => ({
      regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, dead: 0 },
      projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0, dead: 0 },
      ...overrides,
    });

    test('reports conversations skipped this run', () => {
      printSummary(summary({ regular: { success: 5, skip: 0, update: 0, error: 0, fileCount: 0, dead: 683 } }));
      expect(output()).toContain('683 skipped (prior 404s)');
    });

    test('splits the 404 total into stable and ambiguous', () => {
      printSummary(summary({ failedConversations: 683, failedNoAccess: 340 }));
      const out = output();
      expect(out).toContain('683 total');
      expect(out).toContain('340 — server says this account cannot read them');
      expect(out).toContain('343 — ambiguous. Retried automatically next run.');
      expect(out).toContain('failedConversationIds');
      expect(out).not.toMatch(/purged/);
    });

    test('stays silent when nothing failed', () => {
      printSummary(summary());
      expect(output()).not.toContain('skipped (prior 404s)');
      expect(output()).not.toContain('404 responses');
    });
  });

  describe('CLI flag', () => {
    test('skipping is off by default — failures are retried', () => {
      const { CONFIG } = require('../../lib/config');
      expect(CONFIG.skipFailedConversations).toBe(false);
    });
  });
});
