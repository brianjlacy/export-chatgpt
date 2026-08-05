'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

jest.setTimeout(120000);

// End-to-end: a conversation that 404s on the detail endpoint must be recorded
// once and then skipped, instead of being re-requested on every subsequent run.
describe('permanent 404 tracking across runs (e2e)', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  const makeConv = (id, title) => ({
    id, title, create_time: 1700000000, update_time: 1700001000,
    mapping: {
      root: { parent: null, children: ['m1'], message: null },
      m1: { parent: 'root', children: [], message: { content: { content_type: 'text', parts: ['Hi'] }, author: { role: 'user' }, metadata: {} } },
    },
  });

  const convList = {
    items: [
      { id: 'conv-001-aaaa-bbbb', title: 'Alive', create_time: 1700000000 },
      { id: 'conv-002-dead-beef', title: 'Deleted server-side', create_time: 1700000000 },
    ],
    total: 2, limit: 28, offset: 0,
  };

  // Serves the list once per run, a real conversation for conv-001, and 404 for conv-002.
  function installFetch() {
    let listFetched = false;
    const fetchMock = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listFetched) {
          listFetched = true;
          return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(convList) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      if (url.includes('conv-001')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(makeConv('conv-001-aaaa-bbbb', 'Alive')) });
      }
      if (url.includes('conv-002')) {
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found' });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });
    global.fetch = fetchMock;
    return fetchMock;
  }

  const detailCalls = (mock, idFragment) =>
    mock.mock.calls.filter(c => String(c[0]).includes(`/conversation/${idFragment}`)).length;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-404-e2e-'));
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
    CONFIG.retryFailedConversations = false;
    CONFIG.showSummary = true;
    initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (global.fetch?.mockRestore) global.fetch.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('records the 404 on first run', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const progress = loadProgress();
    const result = await exportConversations('fake-token', progress);

    expect(result.success).toBe(1);
    expect(result.error).toBe(1);

    const entry = progress.failedConversationIds['conv-002-dead-beef'];
    expect(entry).toMatchObject({ status: 404, reason: 'not_found', attempts: 1 });
    expect(entry.firstFailedAt).toBeTruthy();
    expect(entry.lastFailedAt).toBeTruthy();

    // Persisted, not just in memory
    const onDisk = JSON.parse(fs.readFileSync(PATHS.progressFile, 'utf8'));
    expect(onDisk.failedConversationIds['conv-002-dead-beef'].status).toBe(404);
  });

  test('skips the dead conversation on the second run without re-requesting it', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const progress = loadProgress();
    await exportConversations('fake-token', progress);

    // Second run, fresh mock and progress reloaded from disk
    const secondFetch = installFetch();
    const result = await exportConversations('fake-token', loadProgress());

    expect(detailCalls(secondFetch, 'conv-002')).toBe(0);
    expect(result.dead).toBe(1);
    expect(result.error).toBe(0);
  });

  test('--retry-failed re-requests it', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await exportConversations('fake-token', loadProgress());

    CONFIG.retryFailedConversations = true;
    const secondFetch = installFetch();
    const progress = loadProgress();
    const result = await exportConversations('fake-token', progress);

    expect(detailCalls(secondFetch, 'conv-002')).toBe(1);
    expect(result.dead).toBe(0);
    expect(result.error).toBe(1);
    // Attempt count accumulates rather than resetting
    expect(progress.failedConversationIds['conv-002-dead-beef'].attempts).toBe(2);
  });

  test('a conversation that starts working again is exported normally', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await exportConversations('fake-token', loadProgress());

    CONFIG.retryFailedConversations = true;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(makeConv('conv-002-dead-beef', 'Back from the dead')) });
    });

    const progress = loadProgress();
    const result = await exportConversations('fake-token', progress);
    expect(result.error).toBe(0);
    expect(result.success).toBe(1);
    // The stale failure record is cleared, not left behind
    expect(progress.failedConversationIds['conv-002-dead-beef']).toBeUndefined();
    expect(JSON.parse(require('fs').readFileSync(PATHS.progressFile, 'utf8')).failedConversationIds)
      .toEqual({});
  });
});
