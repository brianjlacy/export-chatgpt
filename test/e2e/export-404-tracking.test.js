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
        return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('{"detail":"Not found"}') });
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
    CONFIG.skipFailedConversations = false;
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

  test('RETRIES the 404 on the second run by default — a 404 is not proof of deletion', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    const progress = loadProgress();
    await exportConversations('fake-token', progress);

    // Second run, fresh mock and progress reloaded from disk
    const secondFetch = installFetch();
    const progress2 = loadProgress();
    const result = await exportConversations('fake-token', progress2);

    expect(detailCalls(secondFetch, 'conv-002')).toBe(1);
    expect(result.dead).toBe(0);
    expect(result.error).toBe(1);
    expect(progress2.failedConversationIds['conv-002-dead-beef'].attempts).toBe(2);
  });

  test('--skip-failed still retries until the ID has failed on 3 separate runs', async () => {
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');
    CONFIG.skipFailedConversations = true;

    const seen = [];
    for (let run = 1; run <= 4; run++) {
      const f = installFetch();
      const result = await exportConversations('fake-token', loadProgress());
      seen.push({ run, requested: detailCalls(f, 'conv-002'), dead: result.dead });
    }

    // Requested on runs 1-3, skipped only from run 4 once attempts hit the threshold
    expect(seen.map(s => s.requested)).toEqual([1, 1, 1, 0]);
    expect(seen[3].dead).toBe(1);
  });

  test('a run-level collapse is never eligible for skipping, even with --skip-failed', async () => {
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    // 40 conversations, all 404 — a session-level failure, not 40 deletions
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `conv-${String(i).padStart(3, '0')}-cccc-dddd`, title: `C${i}`, create_time: 1700000000,
    }));
    let listed = false;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        if (!listed) { listed = true; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: many, total: 40, limit: 28, offset: 0 }) }); }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
      }
      return Promise.resolve({ ok: false, status: 404, statusText: 'Not Found', text: () => Promise.resolve('{"detail":"Not found"}') });
    });

    const progress = loadProgress();
    await exportConversations('fake-token', progress);

    const entries = Object.values(progress.failedConversationIds);
    expect(entries.length).toBe(40);
    expect(entries.every(e => e.duringRunCollapse)).toBe(true);

    // Even opted in and past the attempt threshold, collapse-tagged IDs are retried
    CONFIG.skipFailedConversations = true;
    for (const e of Object.values(progress.failedConversationIds)) e.attempts = 10;
    const { saveProgress } = require('../../lib/storage');
    saveProgress(progress);

    const f = installFetch();
    const result = await exportConversations('fake-token', loadProgress());
    expect(result.dead).toBe(0);
  });

  test('--skip-failed skips only after the threshold is met', async () => {
    installFetch();
    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');

    await exportConversations('fake-token', loadProgress());

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
