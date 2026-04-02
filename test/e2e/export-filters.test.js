'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('export flow - filter flags (e2e)', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-filter-e2e-'));

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(process.stdout, 'write').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.exportFormat = 'both';
    CONFIG.throttleMs = 0;
    CONFIG.includeProjects = false;
    CONFIG.projectsOnly = false;
    CONFIG.downloadFiles = false;
    CONFIG.updateExisting = false;
    CONFIG.showSummary = false;
    initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockConversationList(conversations) {
    return {
      items: conversations.map(c => ({
        id: c.id,
        title: c.title,
        create_time: c.create_time || 1700000000,
        update_time: c.update_time || 1700001000,
      })),
      total: conversations.length,
      limit: 28,
      offset: 0,
    };
  }

  function mockFullConversation(id, title) {
    return {
      id,
      title,
      create_time: 1700000000,
      update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['msg1'], message: null },
        msg1: {
          parent: 'root',
          children: [],
          message: {
            content: { content_type: 'text', parts: ['Hello'] },
            author: { role: 'user' },
            metadata: {},
          },
        },
      },
    };
  }

  function makeFetchMock(convList, convs) {
    const convMap = new Map(convs.map(c => [c.id, c]));
    let listFetched = false;
    return jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listFetched) {
          listFetched = true;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(convList) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], total: 0, limit: 28, offset: 0 }) });
      }
      for (const [id, conv] of convMap) {
        if (url.includes(id)) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(conv) });
        }
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });
  }

  describe('--max', () => {
    test('caps downloads at N when list is larger', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
        mockFullConversation('conv-004-gggg-hhhh', 'Conv 4'),
        mockFullConversation('conv-005-iiii-jjjj', 'Conv 5'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.maxConversations = 3;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(3);
      expect(result.skip).toBe(2);
    });

    test('downloads all when list is smaller than --max', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.maxConversations = 10;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(2);
      expect(result.skip).toBe(0);
    });

    test('already-downloaded convs do not count toward --max', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.maxConversations = 2;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const progress = loadProgress();
      // Pre-mark the first conversation as already downloaded
      progress.downloadedIds.push('conv-001-aaaa-bbbb');

      const result = await exportConversations('fake-token', progress);

      // Conv 1 is skipped (already downloaded), then convs 2 and 3 are downloaded (up to max=2)
      expect(result.skip).toBe(1);
      expect(result.success).toBe(2);
    });

    test('--max 1 downloads exactly one conversation', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.maxConversations = 1;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(1);
      expect(result.skip).toBe(2);
    });
  });

  describe('--conv', () => {
    test('only downloads conversations matching the filter', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.convFilter = new Set(['conv-001-aaaa-bbbb', 'conv-003-eeee-ffff']);

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(2);
      expect(result.skip).toBe(0);

      // Verify only the two matching JSON files exist
      const jsonFiles = fs.readdirSync(PATHS.jsonDir);
      expect(jsonFiles.length).toBe(2);
      expect(jsonFiles.some(f => f.includes('conv-00'))).toBe(true);
    });

    test('downloads nothing if --conv IDs are not in the list', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.convFilter = new Set(['conv-999-zzzz-yyyy']);

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(0);
    });

    test('single --conv ID downloads exactly that conversation', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.convFilter = new Set(['conv-002-cccc-dddd']);

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(1);
      const jsonFiles = fs.readdirSync(PATHS.jsonDir);
      expect(jsonFiles.length).toBe(1);
      expect(jsonFiles[0]).toContain('conv-002');
    });
  });

  describe('--max + --conv composition', () => {
    test('--max limits further after --conv filter is applied', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
        mockFullConversation('conv-004-gggg-hhhh', 'Conv 4'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      // Filter to 3 IDs, but cap at 2
      CONFIG.convFilter = new Set(['conv-001-aaaa-bbbb', 'conv-002-cccc-dddd', 'conv-003-eeee-ffff']);
      CONFIG.maxConversations = 2;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(2);
      expect(result.skip).toBe(1);
    });

    test('downloads all filtered convs when --max exceeds filtered list size', async () => {
      const convs = [
        mockFullConversation('conv-001-aaaa-bbbb', 'Conv 1'),
        mockFullConversation('conv-002-cccc-dddd', 'Conv 2'),
        mockFullConversation('conv-003-eeee-ffff', 'Conv 3'),
      ];
      const list = mockConversationList(convs);
      global.fetch = makeFetchMock(list, convs);

      CONFIG.convFilter = new Set(['conv-001-aaaa-bbbb', 'conv-002-cccc-dddd']);
      CONFIG.maxConversations = 10;

      const { exportConversations } = require('../../lib/exporter');
      const { loadProgress } = require('../../lib/storage');
      const result = await exportConversations('fake-token', loadProgress());

      expect(result.success).toBe(2);
      expect(result.skip).toBe(0);
    });
  });
});
