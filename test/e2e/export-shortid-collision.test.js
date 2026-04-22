'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// Regression tests for issue #12: shortId collision causing silent data loss
describe('shortId collision — issue #12 regression', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-collision-test-'));

    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(process.stdout, 'write').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.exportFormat = 'json';
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

  // These two IDs share the same first 8 chars (67ee983e) but differ at position 9+.
  // Before the fix, the existence check `f.includes(shortId)` with shortId='67ee983e'
  // would match the first conversation's file when checking the second, causing a silent skip.
  const CONV_1_ID = '67ee983e-2858-800c-b17f-b34bdad73b2a';
  const CONV_2_ID = '67ee983e-26c4-800c-b17f-abc123def456';

  function makeConvEntry(id, title = 'Test') {
    return { id, title, create_time: 1700000000, update_time: 1700001000 };
  }

  function makeFullConv(id, title = 'Test') {
    return {
      id, title, create_time: 1700000000, update_time: 1700001000,
      mapping: {
        root: { parent: null, children: ['m1'], message: null },
        m1: {
          parent: 'root', children: [],
          message: { content: { content_type: 'text', parts: ['hi'] }, author: { role: 'user' }, metadata: {} },
        },
      },
    };
  }

  test('downloads both conversations that share an 8-char ID prefix', async () => {
    // Conv-1 already on disk (pre-existing file from a prior run) — progress does NOT have its ID.
    fs.mkdirSync(PATHS.jsonDir, { recursive: true });
    const conv1File = path.join(PATHS.jsonDir, `1970-01-01_Test_${CONV_1_ID.substring(0, 13)}.json`);
    fs.writeFileSync(conv1File, JSON.stringify(makeFullConv(CONV_1_ID)));

    let listCallCount = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      if (url.includes('/conversations?')) {
        listCallCount++;
        if (listCallCount === 1) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({
              items: [makeConvEntry(CONV_1_ID, 'Test'), makeConvEntry(CONV_2_ID, 'Test 2')],
              total: 2, limit: 28, offset: 0,
            }),
          });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [], total: 2, limit: 28, offset: 28 }),
        });
      }
      if (url.includes(CONV_2_ID)) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve(makeFullConv(CONV_2_ID, 'Test 2')),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [] }) });
    });

    const { exportConversations } = require('../../lib/exporter');
    const { loadProgress } = require('../../lib/storage');
    const progress = loadProgress();

    const result = await exportConversations('fake-token', progress);

    // Conv-1 detected via file existence → skip. Conv-2 must NOT be skipped by conv-1's file.
    expect(result.skip).toBe(1);
    expect(result.success).toBe(1);

    const jsonFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.endsWith('.json'));
    expect(jsonFiles.length).toBe(2);
  });

  test('conv-2 would have been silently skipped with old 8-char shortId', () => {
    fs.mkdirSync(PATHS.jsonDir, { recursive: true });
    const conv1File = path.join(PATHS.jsonDir, `1970-01-01_Test_${CONV_1_ID.substring(0, 13)}.json`);
    fs.writeFileSync(conv1File, JSON.stringify(makeFullConv(CONV_1_ID)));

    const files = fs.readdirSync(PATHS.jsonDir);

    const oldShortId = CONV_2_ID.substring(0, 8);
    const wouldHaveCollided = files.filter(f => f.includes(oldShortId)).length > 0;
    expect(wouldHaveCollided).toBe(true);

    const newShortId = CONV_2_ID.substring(0, 13);
    const collides = files.filter(f => f.includes(newShortId)).length > 0;
    expect(collides).toBe(false);
  });
});

// Unit tests for --verify and --refetch-missing helpers (PRs #14 & #15)
describe('collectIdsOnDisk / findSilentlySkippedConversations / refetchMissing', () => {
  let CONFIG, PATHS, initPaths, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-verify-test-'));

    jest.spyOn(console, 'log').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConvFile(dir, id, title = 'Test') {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `file_${id.substring(0, 8)}.json`),
      JSON.stringify({ id, title })
    );
  }

  test('collectIdsOnDisk finds IDs in regular json dir', () => {
    writeConvFile(PATHS.jsonDir, 'aaaa-1111');
    writeConvFile(PATHS.jsonDir, 'bbbb-2222');

    const { collectIdsOnDisk } = require('../../lib/exporter');
    const onDisk = collectIdsOnDisk();

    expect(onDisk.has('aaaa-1111')).toBe(true);
    expect(onDisk.has('bbbb-2222')).toBe(true);
    expect(onDisk.size).toBe(2);
  });

  test('collectIdsOnDisk finds IDs in project json subdirs', () => {
    const projJsonDir = path.join(PATHS.projectsDir, 'my-project', 'json');
    writeConvFile(projJsonDir, 'proj-conv-1111');

    const { collectIdsOnDisk } = require('../../lib/exporter');
    const onDisk = collectIdsOnDisk();

    expect(onDisk.has('proj-conv-1111')).toBe(true);
  });

  test('collectIdsOnDisk handles missing dirs gracefully', () => {
    const { collectIdsOnDisk } = require('../../lib/exporter');
    expect(() => collectIdsOnDisk()).not.toThrow();
    expect(collectIdsOnDisk().size).toBe(0);
  });

  test('findSilentlySkippedConversations returns IDs in progress but not on disk', () => {
    writeConvFile(PATHS.jsonDir, 'conv-on-disk');

    const progress = { downloadedIds: ['conv-on-disk', 'conv-missing'] };
    const { findSilentlySkippedConversations } = require('../../lib/exporter');
    const missing = findSilentlySkippedConversations(progress);

    expect(missing).toEqual(['conv-missing']);
  });

  test('findSilentlySkippedConversations returns empty array when all present', () => {
    writeConvFile(PATHS.jsonDir, 'conv-a');
    writeConvFile(PATHS.jsonDir, 'conv-b');

    const progress = { downloadedIds: ['conv-a', 'conv-b'] };
    const { findSilentlySkippedConversations } = require('../../lib/exporter');
    expect(findSilentlySkippedConversations(progress)).toEqual([]);
  });

  test('refetchMissing removes IDs without files from progress.downloadedIds', () => {
    writeConvFile(PATHS.jsonDir, 'conv-present');

    const { saveProgress } = require('../../lib/storage');
    const progress = {
      downloadedIds: ['conv-present', 'conv-missing-1', 'conv-missing-2'],
      projects: {},
      indexingComplete: true,
      lastOffset: 0,
      projectsIndexingComplete: false,
      projectsLastCursor: null,
      downloadedFileIds: [],
      failedFileIds: {},
    };
    saveProgress(progress);

    const { refetchMissing } = require('../../lib/exporter');
    const count = refetchMissing(progress);

    expect(count).toBe(2);
    expect(progress.downloadedIds).toEqual(['conv-present']);
  });

  // Regression test for the bug fix: refetchMissing must independently scan per-project arrays.
  // The submitted PR only propagated the top-level missing set to per-project arrays, which would
  // miss project-level silent skips entirely when the top-level had no missing IDs.
  test('refetchMissing clears missing IDs from per-project downloadedIds', () => {
    const projJsonDir = path.join(PATHS.projectsDir, 'proj', 'json');
    writeConvFile(projJsonDir, 'proj-conv-present');

    const { saveProgress } = require('../../lib/storage');
    const progress = {
      downloadedIds: [],
      projects: {
        'proj-id': {
          name: 'proj',
          indexingComplete: true,
          lastCursor: null,
          downloadedIds: ['proj-conv-present', 'proj-conv-missing'],
        },
      },
      indexingComplete: true,
      lastOffset: 0,
      projectsIndexingComplete: false,
      projectsLastCursor: null,
      downloadedFileIds: [],
      failedFileIds: {},
    };
    saveProgress(progress);

    const { refetchMissing } = require('../../lib/exporter');
    refetchMissing(progress);

    expect(progress.projects['proj-id'].downloadedIds).toEqual(['proj-conv-present']);
  });

  test('refetchMissing returns 0 when all IDs present', () => {
    writeConvFile(PATHS.jsonDir, 'conv-a');

    const { saveProgress } = require('../../lib/storage');
    const progress = {
      downloadedIds: ['conv-a'],
      projects: {},
      indexingComplete: true, lastOffset: 0,
      projectsIndexingComplete: false, projectsLastCursor: null,
      downloadedFileIds: [], failedFileIds: {},
    };
    saveProgress(progress);

    const { refetchMissing } = require('../../lib/exporter');
    const count = refetchMissing(progress);
    expect(count).toBe(0);
  });
});

// Unit tests for --include-archived (PR #16)
describe('fetchConversationListIncremental — include-archived (PR #16)', () => {
  let CONFIG, PATHS, initPaths, fetchConversationListIncremental, tmpDir;

  beforeEach(() => {
    jest.resetModules();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-archived-test-'));

    jest.spyOn(console, 'log').mockImplementation();

    ({ CONFIG, PATHS, initPaths } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.throttleMs = 0;
    CONFIG.conversationsPerPage = 28;
    CONFIG.includeArchived = false;
    initPaths();

    ({ fetchConversationListIncremental } = require('../../lib/api'));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeProgress() {
    return {
      indexingComplete: false, lastOffset: 0, downloadedIds: [],
      projectsIndexingComplete: false, projectsLastCursor: null, projects: {},
      downloadedFileIds: [], failedFileIds: {},
    };
  }

  test('active bucket URL includes is_archived=false', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ items: [], total: 0, limit: 28, offset: 0 }),
    });

    await fetchConversationListIncremental('token', new Map(), makeProgress());

    const urls = global.fetch.mock.calls.map(c => c[0]);
    expect(urls.some(u => u.includes('is_archived=false'))).toBe(true);
    expect(urls.some(u => u.includes('is_archived=true'))).toBe(false);
  });

  test('archived bucket URL includes is_archived=true when --include-archived is set', async () => {
    CONFIG.includeArchived = true;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ items: [], total: 0, limit: 28, offset: 0 }),
    });

    await fetchConversationListIncremental('token', new Map(), makeProgress());

    const urls = global.fetch.mock.calls.map(c => c[0]);
    expect(urls.some(u => u.includes('is_archived=true'))).toBe(true);
  });

  test('archived conversations are tagged with _archived: true in the index', async () => {
    CONFIG.includeArchived = true;

    const archivedConv = { id: 'archived-conv-1', title: 'Archived', create_time: 1700000000, update_time: 1700001000 };
    let callNum = 0;
    global.fetch = jest.fn().mockImplementation((url) => {
      callNum++;
      if (url.includes('is_archived=false')) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], total: 0 }) });
      }
      if (url.includes('is_archived=true') && callNum <= 2) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ items: [archivedConv], total: 1, limit: 28, offset: 0 }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ items: [], total: 0 }) });
    });

    const index = new Map();
    await fetchConversationListIncremental('token', index, makeProgress());

    expect(index.has('archived-conv-1')).toBe(true);
    expect(index.get('archived-conv-1')._archived).toBe(true);
  });

  test('archived bucket uses separate progress keys that do not affect active keys', async () => {
    CONFIG.includeArchived = true;

    global.fetch = jest.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ items: [], total: 0, limit: 28, offset: 0 }),
    });

    const progress = makeProgress();
    await fetchConversationListIncremental('token', new Map(), progress);

    expect(progress.indexingComplete).toBe(true);
    expect(progress.archivedIndexingComplete).toBe(true);
    expect(progress.lastArchivedOffset).toBeUndefined();
  });
});
