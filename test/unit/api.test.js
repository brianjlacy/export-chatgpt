'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('api', () => {
  let CONFIG, PATHS, initPaths, fetchNewConversations, fetchConversationListIncremental;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-api-test-'));

    jest.spyOn(console, 'log').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.throttleMs = 0;
    CONFIG.conversationsPerPage = 28;
    initPaths();

    ({ fetchNewConversations, fetchConversationListIncremental } = require('../../lib/api'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProgress(overrides = {}) {
    return {
      indexingComplete: false,
      lastOffset: 0,
      downloadedIds: [],
      projectsIndexingComplete: false,
      projectsLastCursor: null,
      projects: {},
      downloadedFileIds: [],
      ...overrides,
    };
  }

  function makeConv(id, create_time, update_time = 1775000000) {
    return { id, title: `Chat ${id}`, create_time, update_time };
  }

  function mockFetchPages(pages) {
    let call = 0;
    global.fetch = jest.fn().mockImplementation(() => {
      const page = pages[call] ?? { items: [], total: 0, limit: 28, offset: 0 };
      call++;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(page),
      });
    });
  }

  describe('fetchNewConversations', () => {
    test('returns existing index unchanged when first page is entirely <= since', async () => {
      const existingIndex = new Map([
        ['conv-1', makeConv('conv-1', 1700002000)],
      ]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: [makeConv('conv-1', 1700002000)], total: 1, limit: 28, offset: 0 },
      ]);

      const result = await fetchNewConversations('token', existingIndex, progress);

      expect(result.size).toBe(1);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('logs "up to date" when no new conversations found', async () => {
      const existingIndex = new Map([['conv-1', makeConv('conv-1', 1700002000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: [makeConv('conv-1', 1700002000)], total: 1, limit: 28, offset: 0 },
      ]);

      await fetchNewConversations('token', existingIndex, progress);

      const logs = console.log.mock.calls.map(c => c[0]).join('\n');
      expect(logs).toContain('up to date');
    });

    test('adds new conversations whose update_time > since', async () => {
      const existingIndex = new Map([
        ['conv-old', makeConv('conv-old', 1700001000)],
      ]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        {
          items: [
            makeConv('conv-new', 1700002000), // newer than since (1700001000)
            makeConv('conv-old', 1700001000), // at watermark — stop
          ],
          total: 2, limit: 28, offset: 0,
        },
      ]);

      const result = await fetchNewConversations('token', existingIndex, progress);

      expect(result.size).toBe(2);
      expect(result.has('conv-new')).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('stops mid-page at watermark and does not advance to next page', async () => {
      const existingIndex = new Map([
        ['conv-1', makeConv('conv-1', 1700001000)],
      ]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        {
          items: [makeConv('conv-new', 1700002000), makeConv('conv-1', 1700001000)],
          total: 2, limit: 28, offset: 0,
        },
        // This second page should never be fetched
        { items: [makeConv('conv-other', 1700000500)], total: 1, limit: 28, offset: 28 },
      ]);

      await fetchNewConversations('token', existingIndex, progress);

      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('fetches a second page when first full page is all > since', async () => {
      const convs28 = Array.from({ length: 28 }, (_, i) =>
        makeConv(`conv-new-${i}`, 1700003000 + i)
      );
      const existingIndex = new Map([['conv-old', makeConv('conv-old', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: convs28, total: 29, limit: 28, offset: 0 },
        { items: [makeConv('conv-old', 1700001000)], total: 1, limit: 28, offset: 28 },
      ]);

      const result = await fetchNewConversations('token', existingIndex, progress);

      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(result.size).toBe(29); // 28 new + 1 existing
    });

    test('skips already-indexed conversations with create_time > since', async () => {
      const existingIndex = new Map([
        ['conv-known', makeConv('conv-known', 1700002000)],
        ['conv-old', makeConv('conv-old', 1700001000)],
      ]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        {
          items: [
            makeConv('conv-known', 1700002500), // already in index (create_time > since but known)
            makeConv('conv-old', 1700001000),   // watermark
          ],
          total: 2, limit: 28, offset: 0,
        },
      ]);

      const result = await fetchNewConversations('token', existingIndex, progress);

      expect(result.size).toBe(2); // no new entries
    });

    test('does not call saveIndex when no new conversations found', async () => {
      const existingIndex = new Map([['conv-1', makeConv('conv-1', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: [makeConv('conv-1', 1700001000)], total: 1, limit: 28, offset: 0 },
      ]);

      const writeSpy = jest.spyOn(fs, 'writeFileSync');
      await fetchNewConversations('token', existingIndex, progress);

      const indexWrites = writeSpy.mock.calls.filter(([p]) => String(p).includes('conversation-index'));
      expect(indexWrites).toHaveLength(0);
    });

    test('calls saveIndex when new conversations are found', async () => {
      const existingIndex = new Map([['conv-old', makeConv('conv-old', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        {
          items: [makeConv('conv-new', 1700002000), makeConv('conv-old', 1700001000)],
          total: 2, limit: 28, offset: 0,
        },
      ]);

      const writeSpy = jest.spyOn(fs, 'writeFileSync');
      await fetchNewConversations('token', existingIndex, progress);

      const indexWrites = writeSpy.mock.calls.filter(([p]) => String(p).includes('conversation-index'));
      expect(indexWrites.length).toBeGreaterThan(0);
    });

    test('handles ISO string create_time correctly as watermark', async () => {
      const existingIndex = new Map([
        ['conv-1', makeConv('conv-1', '2023-11-15T00:00:00.000Z')], // ISO string
      ]);
      const progress = makeProgress({ indexingComplete: true });
      const since = new Date('2023-11-15T00:00:00.000Z').getTime() / 1000;

      // conv-new has update_time just after since; conv-old is at since
      mockFetchPages([
        {
          items: [
            makeConv('conv-new', since + 1),
            makeConv('conv-1', since),
          ],
          total: 2, limit: 28, offset: 0,
        },
      ]);

      const result = await fetchNewConversations('token', existingIndex, progress);
      expect(result.size).toBe(2);
      expect(result.has('conv-new')).toBe(true);
    });

    test('propagates auth errors', async () => {
      const existingIndex = new Map([['conv-1', makeConv('conv-1', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      const authError = new Error('Unauthorized');
      authError.authError = true;
      global.fetch = jest.fn().mockRejectedValue(authError);

      await expect(fetchNewConversations('token', existingIndex, progress))
        .rejects.toMatchObject({ authError: true });
    });
  });

  describe('fetchConversationListIncremental — delta dispatch', () => {
    test('calls fetchNewConversations when indexingComplete is true', async () => {
      const existingIndex = new Map([['conv-1', makeConv('conv-1', 1700001000)]]);
      const progress = makeProgress({ indexingComplete: true });

      mockFetchPages([
        { items: [makeConv('conv-1', 1700001000)], total: 1, limit: 28, offset: 0 },
      ]);

      const result = await fetchConversationListIncremental('token', existingIndex, progress);

      // Delta path: only 1 fetch (not the full scan loop)
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const logs = console.log.mock.calls.map(c => c[0]).join('\n');
      expect(logs).toContain('Checking for new conversations');
      expect(result).toBe(existingIndex);
    });

    test('runs full scan when indexingComplete is false', async () => {
      const existingIndex = new Map();
      const progress = makeProgress({ indexingComplete: false });

      mockFetchPages([
        { items: [makeConv('conv-1', 1700001000)], total: 1, limit: 28, offset: 0 },
        { items: [], total: 0, limit: 28, offset: 28 },
      ]);

      const result = await fetchConversationListIncremental('token', existingIndex, progress);

      const logs = console.log.mock.calls.map(c => c[0]).join('\n');
      expect(logs).toContain('Fetching conversation list');
      expect(logs).not.toContain('Checking for new conversations');
      expect(result.size).toBe(1);
    });
  });
});
