'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('storage failure cases', () => {
  let PATHS, ensureDir, loadIndex, saveIndex, loadProgress, saveProgress;
  let tmpDir;

  beforeEach(() => {
    jest.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-fail-'));
    const config = require('../../lib/config');
    config.CONFIG.outputDir = tmpDir;
    config.initPaths();
    ({ PATHS } = config);
    ({ ensureDir, loadIndex, saveIndex, loadProgress, saveProgress } = require('../../lib/storage'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('loadIndex - failure cases', () => {
    test('handles empty file gracefully', () => {
      fs.writeFileSync(PATHS.indexFile, '');
      const spy = jest.spyOn(console, 'log').mockImplementation();
      const index = loadIndex();
      expect(index.size).toBe(0);
      spy.mockRestore();
    });

    test('handles file with valid JSON but wrong structure', () => {
      fs.writeFileSync(PATHS.indexFile, '"just a string"');
      const spy = jest.spyOn(console, 'log').mockImplementation();
      const index = loadIndex();
      // JSON parses but .map() will fail on a string → catch block
      expect(index.size).toBe(0);
      spy.mockRestore();
    });

    test('handles file with null content', () => {
      fs.writeFileSync(PATHS.indexFile, 'null');
      const spy = jest.spyOn(console, 'log').mockImplementation();
      const index = loadIndex();
      expect(index.size).toBe(0);
      spy.mockRestore();
    });

    test('handles file with array of items missing id field', () => {
      fs.writeFileSync(PATHS.indexFile, JSON.stringify([{ title: 'no id' }]));
      const index = loadIndex();
      // Should still create Map entries (with undefined keys)
      expect(index.size).toBe(1);
    });
  });

  describe('loadProgress - failure cases', () => {
    test('handles empty progress file', () => {
      fs.writeFileSync(PATHS.progressFile, '');
      const progress = loadProgress();
      expect(progress.indexingComplete).toBe(false);
      expect(progress.downloadedIds).toEqual([]);
    });

    test('handles progress file with only partial data', () => {
      fs.writeFileSync(PATHS.progressFile, JSON.stringify({ indexingComplete: true }));
      const progress = loadProgress();
      expect(progress.indexingComplete).toBe(true);
      expect(progress.projects).toEqual({});
      expect(progress.downloadedFileIds).toEqual([]);
    });

    test('handles progress file with extra unexpected fields', () => {
      const data = {
        indexingComplete: true,
        lastOffset: 10,
        downloadedIds: ['a'],
        projects: {},
        downloadedFileIds: [],
        projectsIndexingComplete: false,
        projectsLastCursor: null,
        extraField: 'should not break',
      };
      fs.writeFileSync(PATHS.progressFile, JSON.stringify(data));
      const progress = loadProgress();
      expect(progress.indexingComplete).toBe(true);
      expect(progress.extraField).toBe('should not break');
    });

    test('handles binary/garbage content', () => {
      fs.writeFileSync(PATHS.progressFile, Buffer.from([0x00, 0xFF, 0xFE, 0xBB]));
      const progress = loadProgress();
      expect(progress.indexingComplete).toBe(false);
    });
  });

  describe('saveIndex - edge cases', () => {
    test('saves empty Map without error', () => {
      expect(() => saveIndex(new Map())).not.toThrow();
      const data = JSON.parse(fs.readFileSync(PATHS.indexFile, 'utf8'));
      expect(data).toEqual([]);
    });

    test('saves Map with complex conversation data', () => {
      const map = new Map([
        ['id1', { id: 'id1', title: 'Test', mapping: { root: {} } }],
      ]);
      expect(() => saveIndex(map)).not.toThrow();
      const loaded = loadIndex();
      expect(loaded.get('id1').mapping).toBeDefined();
    });
  });

  describe('saveProgress - edge cases', () => {
    test('saves progress with large downloadedIds array', () => {
      const ids = Array.from({ length: 10000 }, (_, i) => `id-${i}`);
      const progress = { downloadedIds: ids, projects: {}, downloadedFileIds: [] };
      expect(() => saveProgress(progress)).not.toThrow();
      const loaded = loadProgress();
      expect(loaded.downloadedIds.length).toBe(10000);
    });
  });

  describe('ensureDir - edge cases', () => {
    test('handles creating directory that already exists', () => {
      ensureDir(tmpDir);
      // Should not throw
      ensureDir(tmpDir);
      expect(fs.existsSync(tmpDir)).toBe(true);
    });

    test('creates deeply nested directory', () => {
      const deep = path.join(tmpDir, 'a', 'b', 'c', 'd', 'e');
      ensureDir(deep);
      expect(fs.existsSync(deep)).toBe(true);
    });
  });
});
