'use strict';

// Regression tests for permanent conversation-fetch failures (HTTP 404).
//
// The listing endpoint keeps returning rows for conversations whose detail
// endpoint 404s (deleted, purged by workspace retention, or never fully
// materialized), and the local index is append-only. Without a persisted
// record of the failure, every run re-requests every dead conversation
// forever. See the file-level analogue: progress.failedFileIds.

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

    test('tags 404 as notFound with status, and does not retry', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 404, ok: false, statusText: 'Not Found' });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}).catch(e => e);

      expect(error.notFound).toBe(true);
      expect(error.status).toBe(404);
      expect(error.noRetry).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('does not tag other HTTP errors as notFound', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 500, ok: false, statusText: 'Server Error' });

      const error = await auth.fetchWithRetry('https://example.test/c/1', {}, 1).catch(e => e);

      expect(error.notFound).toBeUndefined();
      expect(error.status).toBe(500);
    });

    test('auth errors stay auth errors, not notFound', async () => {
      global.fetch = jest.fn().mockResolvedValue({ status: 401, ok: false, statusText: 'Unauthorized' });

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

    test('reports conversations skipped this run as unavailable', () => {
      printSummary(summary({ regular: { success: 5, skip: 0, update: 0, error: 0, fileCount: 0, dead: 683 } }));
      expect(output()).toContain('683 unavailable');
    });

    test('reports the cumulative failed total and how to retry', () => {
      printSummary(summary({ failedConversations: 683 }));
      const out = output();
      expect(out).toContain('683 conversation(s) return HTTP 404');
      expect(out).toContain('--retry-failed');
      expect(out).toContain('failedConversationIds');
    });

    test('stays silent when nothing failed', () => {
      printSummary(summary());
      expect(output()).not.toContain('unavailable');
      expect(output()).not.toContain('--retry-failed');
    });
  });

  describe('CLI flag', () => {
    test('--retry-failed sets retryFailedConversations', () => {
      const { CONFIG } = require('../../lib/config');
      expect(CONFIG.retryFailedConversations).toBe(false);
    });
  });
});
