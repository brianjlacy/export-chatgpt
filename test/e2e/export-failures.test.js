'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// fetchWithRetry uses 6 retries × 2s sleep, so failures take ~12s each
jest.setTimeout(120000);

describe('export flow - failure cases (e2e)', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-fail-e2e-'));

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
    if (global.fetch?.mockRestore) global.fetch.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('auth error during conversation fetch propagates with authError flag', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await expect(exportConversations('expired-token', loadProgress()))
      .rejects.toMatchObject({ authError: true });
  });

  test('individual conversation errors are counted without stopping export', async () => {
    const convList = {
      items: [
        { id: 'conv-001-aaaa-bbbb', title: 'Good', create_time: 1700000000 },
        { id: 'conv-002-cccc-dddd', title: 'Bad', create_time: 1700000000 },
        { id: 'conv-003-eeee-ffff', title: 'Good 2', create_time: 1700000000 },
      ],
      total: 3, limit: 28, offset: 0,
    };

    const makeConv = (id, title) => ({
      id, title, create_time: 1700000000, update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['m1'], message: null },
        m1: { parent: 'root', children: [], message: { content: { content_type: 'text', parts: ['Hi'] }, author: { role: 'user' }, metadata: {} } },
      },
    });

    let listFetched = false;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listFetched) {
          listFetched = true;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(convList) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      if (url.includes('conv-001')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(makeConv('conv-001-aaaa-bbbb', 'Good')) });
      }
      if (url.includes('conv-002')) {
        // This conversation fetch fails with a server error
        return Promise.resolve({ ok: false, status: 500, statusText: 'Internal Server Error' });
      }
      if (url.includes('conv-003')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(makeConv('conv-003-eeee-ffff', 'Good 2')) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const result = await exportConversations('fake-token', loadProgress());

    // 2 succeeded, 1 errored (the retry exhaustion becomes an error count)
    expect(result.success).toBe(2);
    expect(result.error).toBe(1);
    expect(result.skip).toBe(0);
  });

  test('progress is preserved after auth error mid-export', async () => {
    const convList = {
      items: [
        { id: 'conv-001-aaaa-bbbb', title: 'First', create_time: 1700000000 },
        { id: 'conv-002-cccc-dddd', title: 'Second', create_time: 1700000000 },
      ],
      total: 2, limit: 28, offset: 0,
    };

    const makeConv = (id, title) => ({
      id, title, create_time: 1700000000, update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['m1'], message: null },
        m1: { parent: 'root', children: [], message: { content: { content_type: 'text', parts: ['Hi'] }, author: { role: 'user' }, metadata: {} } },
      },
    });

    let listFetched = false;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listFetched) {
          listFetched = true;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(convList) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      if (url.includes('conv-001')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(makeConv('conv-001-aaaa-bbbb', 'First')) });
      }
      if (url.includes('conv-002')) {
        // Token expires on second conversation
        return Promise.resolve({ ok: false, status: 401, statusText: 'Unauthorized' });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');
    const progress = loadProgress();

    await expect(exportConversations('expiring-token', progress))
      .rejects.toMatchObject({ authError: true });

    // First conversation should have been saved before auth error on second
    const savedProgress = loadProgress();
    expect(savedProgress.downloadedIds).toContain('conv-001-aaaa-bbbb');
    expect(savedProgress.downloadedIds).not.toContain('conv-002-cccc-dddd');

    // JSON file should exist for the first conversation
    const jsonFiles = fs.existsSync(PATHS.jsonDir) ? fs.readdirSync(PATHS.jsonDir) : [];
    expect(jsonFiles.length).toBe(1);
  });

  test('run() prints summary even on auth error before exiting', async () => {
    CONFIG.includeProjects = false;
    CONFIG.showSummary = true;

    global.fetch = jest.fn().mockResolvedValue({
      ok: false, status: 401, statusText: 'Unauthorized',
    });

    // Mock process.exit to prevent actual exit
    const mockExit = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    const { run } = require('../../lib/exporter');

    await expect(run('expired-token')).rejects.toThrow('process.exit called');

    const logCalls = console.log.mock.calls.map(c => c.join(' ')).join('\n');
    expect(logCalls).toContain('Export Complete!');

    mockExit.mockRestore();
  });

  test('empty conversation list results in zero counts', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ items: [], total: 0, limit: 28, offset: 0 }),
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const result = await exportConversations('fake-token', loadProgress());
    expect(result).toEqual({ success: 0, skip: 0, update: 0, error: 0, fileCount: 0 });
  });

  test('conversation with no mapping produces valid but empty markdown', async () => {
    const convList = {
      items: [{ id: 'conv-001-aaaa-bbbb', title: 'Empty Conv', create_time: 1700000000 }],
      total: 1, limit: 28, offset: 0,
    };

    let listFetched = false;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listFetched) {
          listFetched = true;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(convList) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      if (url.includes('/conversation/')) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({
            id: 'conv-001-aaaa-bbbb', title: 'Empty Conv',
            create_time: 1700000000, update_time: 1700001000,
            mapping: {},
          }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const result = await exportConversations('fake-token', loadProgress());
    expect(result.success).toBe(1);

    // Markdown file should exist and be valid
    const mdFiles = fs.readdirSync(PATHS.mdDir);
    expect(mdFiles.length).toBe(1);
    const md = fs.readFileSync(path.join(PATHS.mdDir, mdFiles[0]), 'utf8');
    expect(md).toContain('---');
    expect(md).toContain('Empty Conv');
  });

  test('run() handles non-auth errors by re-throwing', async () => {
    CONFIG.includeProjects = false;

    global.fetch = jest.fn().mockRejectedValue(new Error('Network completely dead'));

    const { run } = require('../../lib/exporter');

    await expect(run('fake-token')).rejects.toThrow('Network completely dead');
  });
});
