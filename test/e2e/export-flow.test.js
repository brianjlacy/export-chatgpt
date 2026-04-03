'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// E2E tests for the full export flow with mocked HTTP
describe('export flow (e2e)', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-e2e-'));

    // Suppress console output during tests
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
    CONFIG.showSummary = true;
    initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function mockConversationList(conversations) {
    // Returns paginated response matching the API format
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
          children: ['msg2'],
          message: {
            content: { content_type: 'text', parts: ['Hello'] },
            author: { role: 'user' },
            metadata: {},
          },
        },
        msg2: {
          parent: 'msg1',
          children: [],
          message: {
            content: { content_type: 'text', parts: ['Hi there!'] },
            author: { role: 'assistant' },
            metadata: {},
          },
        },
      },
    };
  }

  test('exports conversations to JSON and Markdown files', async () => {
    const convList = mockConversationList([
      { id: 'conv-001-aaaa-bbbb', title: 'Test Chat' },
      { id: 'conv-002-cccc-dddd', title: 'Another Chat' },
    ]);

    const fullConv1 = mockFullConversation('conv-001-aaaa-bbbb', 'Test Chat');
    const fullConv2 = mockFullConversation('conv-002-cccc-dddd', 'Another Chat');

    // Mock fetch to return conversation data
    let fetchCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      fetchCallCount++;
      if (url.includes('/conversations?')) {
        // First two pages return data, third returns empty (signals completion)
        if (fetchCallCount <= 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(convList),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 2, limit: 28, offset: 28 }),
        });
      }
      if (url.includes('/conversation/conv-001')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv1),
        });
      }
      if (url.includes('/conversation/conv-002')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv2),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [], total: 0 }),
      });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');
    const progress = loadProgress();

    const result = await exportConversations('fake-token', progress);

    expect(result.success).toBe(2);
    expect(result.skip).toBe(0);
    expect(result.error).toBe(0);

    // Verify JSON files were created
    const jsonFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.endsWith('.json'));
    expect(jsonFiles.length).toBe(2);

    // Verify MD files were created
    const mdFiles = fs.readdirSync(PATHS.mdDir).filter(f => f.endsWith('.md'));
    expect(mdFiles.length).toBe(2);

    // Verify JSON content is valid
    const jsonContent = JSON.parse(fs.readFileSync(path.join(PATHS.jsonDir, jsonFiles[0]), 'utf8'));
    expect(jsonContent.mapping).toBeDefined();

    // Verify MD content
    const mdContent = fs.readFileSync(path.join(PATHS.mdDir, mdFiles[0]), 'utf8');
    expect(mdContent).toContain('---');
    expect(mdContent).toContain('## User');
    expect(mdContent).toContain('## Assistant');

    // Verify progress was saved
    const savedProgress = loadProgress();
    expect(savedProgress.downloadedIds).toContain('conv-001-aaaa-bbbb');
    expect(savedProgress.downloadedIds).toContain('conv-002-cccc-dddd');

    global.fetch.mockRestore();
  });

  test('skips already-downloaded conversations', async () => {
    const convList = mockConversationList([
      { id: 'conv-001-aaaa-bbbb', title: 'Test Chat' },
    ]);

    let fetchCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      fetchCallCount++;
      if (url.includes('/conversations?')) {
        if (fetchCallCount <= 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(convList),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 1, limit: 28, offset: 28 }),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress, saveProgress } = require('../../lib/storage');

    // Pre-populate progress with already-downloaded ID
    const progress = loadProgress();
    progress.downloadedIds = ['conv-001-aaaa-bbbb'];
    saveProgress(progress);

    const result = await exportConversations('fake-token', progress);

    expect(result.skip).toBe(1);
    expect(result.success).toBe(0);

    global.fetch.mockRestore();
  });

  test('run() returns summary object', async () => {
    CONFIG.includeProjects = false;

    const convList = mockConversationList([
      { id: 'conv-001-aaaa-bbbb', title: 'Test' },
    ]);
    const fullConv = mockFullConversation('conv-001-aaaa-bbbb', 'Test');

    let fetchCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      fetchCallCount++;
      if (url.includes('/conversations?')) {
        if (fetchCallCount <= 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(convList),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 1, limit: 28, offset: 28 }),
        });
      }
      if (url.includes('/conversation/conv-001')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({ items: [] }),
      });
    });

    const { run } = require('../../lib/exporter');
    const summary = await run('fake-token');

    expect(summary).toBeDefined();
    expect(summary.regular.success).toBe(1);
    expect(summary.projects.count).toBe(0);

    global.fetch.mockRestore();
  });

  test('printSummary output reflects summary data', () => {
    CONFIG.includeProjects = true;
    CONFIG.downloadFiles = true;

    const calls = [];
    console.log.mockImplementation((...args) => calls.push(args.join(' ')));

    const { printSummary } = require('../../lib/exporter');
    printSummary({
      regular: { success: 42, skip: 5, update: 3, error: 2, fileCount: 18 },
      projects: { count: 3, conversations: 12, success: 8, skip: 1, update: 2, error: 1, fileCount: 5 },
    });

    const output = calls.join('\n');
    expect(output).toContain('Export Complete!');
    expect(output).toContain('55 downloaded');  // 42+3+8+2
    expect(output).toContain('6 skipped');       // 5+1
    expect(output).toContain('3 errors');        // 2+1
    expect(output).toContain('3 found');         // projects
    expect(output).toContain('23 downloaded');   // files: 18+5
  });

  test('--no-summary suppresses printSummary output', () => {
    CONFIG.showSummary = false;

    const calls = [];
    console.log.mockImplementation((...args) => calls.push(args.join(' ')));

    const { printSummary } = require('../../lib/exporter');
    printSummary({
      regular: { success: 10, skip: 0, update: 0, error: 0, fileCount: 0 },
      projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
    });

    expect(calls).toHaveLength(0);
  });

  test('export handles auth errors gracefully', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');
    const progress = loadProgress();

    await expect(exportConversations('expired-token', progress))
      .rejects.toMatchObject({ authError: true });

    global.fetch.mockRestore();
  });

  test('export writes only JSON when format is json', async () => {
    CONFIG.exportFormat = 'json';

    const convList = mockConversationList([
      { id: 'conv-001-aaaa-bbbb', title: 'JSON Only' },
    ]);
    const fullConv = mockFullConversation('conv-001-aaaa-bbbb', 'JSON Only');

    let fetchCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      fetchCallCount++;
      if (url.includes('/conversations?')) {
        if (fetchCallCount <= 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(convList),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 1, limit: 28, offset: 28 }),
        });
      }
      if (url.includes('/conversation/')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await exportConversations('fake-token', loadProgress());

    expect(fs.existsSync(PATHS.jsonDir)).toBe(true);
    expect(fs.readdirSync(PATHS.jsonDir).length).toBe(1);
    // MD dir should not have been created
    expect(fs.existsSync(PATHS.mdDir)).toBe(false);

    global.fetch.mockRestore();
  });

  describe('delta refresh', () => {
    test('second run finds new conversation and downloads it', async () => {
      const T_OLD = 1700001000;
      const T_NEW = 1700002000;

      // Seed index + progress as if a previous full scan completed
      const { loadProgress, saveProgress, saveIndex } = require('../../lib/storage');
      const progress = loadProgress();
      progress.indexingComplete = true;
      progress.lastOffset = 1;
      saveProgress(progress);
      saveIndex(new Map([
        ['conv-old', { id: 'conv-old', title: 'Old Chat', create_time: T_OLD, update_time: T_OLD }],
      ]));

      const fullConvNew = mockFullConversation('conv-new', 'New Chat');
      const fullConvOld = mockFullConversation('conv-old', 'Old Chat');

      global.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('/conversations?offset=0')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              items: [
                { id: 'conv-new', title: 'New Chat', create_time: T_NEW, update_time: T_NEW },
                { id: 'conv-old', title: 'Old Chat', create_time: T_OLD, update_time: T_OLD },
              ],
              total: 2, limit: 28, offset: 0,
            }),
          });
        }
        if (url.includes('/conversation/conv-new')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fullConvNew) });
        }
        if (url.includes('/conversation/conv-old')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(fullConvOld) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      });

      const { exportConversations } = require('../../lib/exporter');
      const freshProgress = loadProgress();
      const result = await exportConversations('fake-token', freshProgress);

      // Only the new conversation should be downloaded; old was already in progress.downloadedIds? No —
      // downloadedIds is empty in freshProgress, so both get downloaded.
      expect(result.success).toBe(2);

      // Crucially: only 1 fetch to the list endpoint (the delta page)
      const listFetches = global.fetch.mock.calls.filter(([u]) => u.includes('/conversations?'));
      expect(listFetches).toHaveLength(1);

      // indexingComplete remains true
      const savedProgress = loadProgress();
      expect(savedProgress.indexingComplete).toBe(true);

      // New conversation appears in index
      const indexData = JSON.parse(fs.readFileSync(PATHS.indexFile, 'utf8'));
      const ids = indexData.map(c => c.id);
      expect(ids).toContain('conv-new');
      expect(ids).toContain('conv-old');

      global.fetch.mockRestore();
    });

    test('second run logs "up to date" and makes only 1 list fetch when no new conversations', async () => {
      const T = 1700001000;

      const { loadProgress, saveProgress, saveIndex } = require('../../lib/storage');
      const progress = loadProgress();
      progress.indexingComplete = true;
      saveProgress(progress);
      saveIndex(new Map([
        ['conv-1', { id: 'conv-1', title: 'Chat', create_time: T, update_time: T }],
      ]));

      global.fetch = jest.fn().mockImplementation((url) => {
        if (url.includes('/conversations?')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              items: [{ id: 'conv-1', title: 'Chat', create_time: T, update_time: T }],
              total: 1, limit: 28, offset: 0,
            }),
          });
        }
        if (url.includes('/conversation/')) {
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(mockFullConversation('conv-1', 'Chat')) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      });

      const { exportConversations } = require('../../lib/exporter');
      await exportConversations('fake-token', loadProgress());

      const listFetches = global.fetch.mock.calls.filter(([u]) => u.includes('/conversations?'));
      expect(listFetches).toHaveLength(1);

      const logs = console.log.mock.calls.map(c => c[0]).join('\n');
      expect(logs).toContain('up to date');

      global.fetch.mockRestore();
    });
  });

  test('export writes only Markdown when format is markdown', async () => {
    CONFIG.exportFormat = 'markdown';

    const convList = mockConversationList([
      { id: 'conv-001-aaaa-bbbb', title: 'MD Only' },
    ]);
    const fullConv = mockFullConversation('conv-001-aaaa-bbbb', 'MD Only');

    let fetchCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      fetchCallCount++;
      if (url.includes('/conversations?')) {
        if (fetchCallCount <= 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve(convList),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 1, limit: 28, offset: 28 }),
        });
      }
      if (url.includes('/conversation/')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(fullConv),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await exportConversations('fake-token', loadProgress());

    expect(fs.existsSync(PATHS.mdDir)).toBe(true);
    expect(fs.readdirSync(PATHS.mdDir).length).toBe(1);
    // JSON dir should not have been created
    expect(fs.existsSync(PATHS.jsonDir)).toBe(false);

    global.fetch.mockRestore();
  });
});
