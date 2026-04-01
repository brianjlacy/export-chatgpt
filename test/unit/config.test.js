'use strict';

describe('config', () => {
  let CONFIG, PATHS, initPaths, verboseLog, sleep;

  beforeEach(() => {
    jest.resetModules();
    ({ CONFIG, PATHS, initPaths, verboseLog, sleep } = require('../../lib/config'));
  });

  describe('CONFIG defaults', () => {
    test('has correct default values', () => {
      expect(CONFIG.baseUrl).toBe('https://chatgpt.com');
      expect(CONFIG.apiBase).toBe('https://chatgpt.com/backend-api');
      expect(CONFIG.outputDir).toBe('./exports');
      expect(CONFIG.delayBetweenRequests).toBe(1500);
      expect(CONFIG.conversationsPerPage).toBe(28);
      expect(CONFIG.exportFormat).toBe('both');
      expect(CONFIG.accountId).toBeNull();
      expect(CONFIG.updateExisting).toBe(false);
      expect(CONFIG.includeProjects).toBe(true);
      expect(CONFIG.projectsOnly).toBe(false);
      expect(CONFIG.downloadFiles).toBe(true);
      expect(CONFIG.downloadImages).toBe(true);
      expect(CONFIG.downloadCanvas).toBe(true);
      expect(CONFIG.downloadAttachments).toBe(true);
      expect(CONFIG.verbose).toBe(false);
      expect(CONFIG.nonInteractive).toBe(false);
      expect(CONFIG.showSummary).toBe(true);
      expect(CONFIG.showDonate).toBe(true);
    });

    test('CONFIG is mutable', () => {
      CONFIG.outputDir = '/tmp/test';
      expect(CONFIG.outputDir).toBe('/tmp/test');
    });
  });

  describe('initPaths', () => {
    test('populates PATHS based on CONFIG.outputDir', () => {
      CONFIG.outputDir = '/tmp/test-export';
      initPaths();

      expect(PATHS.indexFile).toContain('conversation-index.json');
      expect(PATHS.progressFile).toContain('.export-progress.json');
      expect(PATHS.jsonDir).toContain('json');
      expect(PATHS.mdDir).toContain('markdown');
      expect(PATHS.filesDir).toContain('files');
      expect(PATHS.projectsDir).toContain('projects');
      expect(PATHS.projectIndexFile).toContain('project-index.json');

      // All paths should start with the output dir
      for (const val of Object.values(PATHS)) {
        expect(val).toMatch(/^\/tmp\/test-export/);
      }
    });
  });

  describe('verboseLog', () => {
    test('logs when verbose is true', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      CONFIG.verbose = true;
      verboseLog('test message');
      expect(spy).toHaveBeenCalledWith('test message');
      spy.mockRestore();
    });

    test('does not log when verbose is false', () => {
      const spy = jest.spyOn(console, 'log').mockImplementation();
      CONFIG.verbose = false;
      verboseLog('test message');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  describe('sleep', () => {
    test('resolves after the specified time', async () => {
      const start = Date.now();
      await sleep(50);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });

    test('returns a promise', () => {
      const result = sleep(1);
      expect(result).toBeInstanceOf(Promise);
    });
  });
});
