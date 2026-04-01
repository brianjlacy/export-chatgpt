'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('downloader failure cases', () => {
  let CONFIG, PATHS, tmpDir;

  beforeEach(() => {
    jest.resetModules();
    jest.spyOn(console, 'log').mockImplementation();

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-fail-'));

    ({ CONFIG, PATHS } = require('../../lib/config'));
    CONFIG.outputDir = tmpDir;
    CONFIG.downloadImages = true;
    CONFIG.downloadCanvas = true;
    CONFIG.downloadAttachments = true;
    CONFIG.delayBetweenRequests = 0;
    CONFIG.verbose = false;
    require('../../lib/config').initPaths();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (global.fetch?.mockRestore) global.fetch.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('downloadConversationFiles - failure cases', () => {
    test('continues downloading other files when one file fails', async () => {
      const { downloadConversationFiles } = require('../../lib/downloader');
      const { loadProgress } = require('../../lib/storage');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-fail', metadata: {} },
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-ok', metadata: {} },
                ],
              },
            },
          },
        },
      };

      let callCount = 0;
      global.fetch = jest.fn().mockImplementation((url) => {
        callCount++;
        // First file: getFileDownloadUrl succeeds but download fails
        if (url.includes('img-fail') && url.includes('/files/download/')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ status: 'success', download_url: 'https://cdn.example.com/fail.png', file_name: 'fail.png' }),
          });
        }
        if (url === 'https://cdn.example.com/fail.png') {
          return Promise.resolve({ ok: false, status: 500 });
        }
        // Second file: succeeds
        if (url.includes('img-ok') && url.includes('/files/download/')) {
          return Promise.resolve({
            ok: true, status: 200,
            json: () => Promise.resolve({ status: 'success', download_url: 'https://cdn.example.com/ok.png', file_name: 'ok.png' }),
          });
        }
        if (url === 'https://cdn.example.com/ok.png') {
          return Promise.resolve({
            ok: true, status: 200,
            headers: { get: () => 'image/png' },
            arrayBuffer: () => Promise.resolve(new ArrayBuffer(100)),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      });

      const progress = loadProgress();
      const filesDir = path.join(tmpDir, 'files');
      const count = await downloadConversationFiles('token', conversationData, filesDir, progress);

      // Should have downloaded 1 file (the second one) even though the first failed
      expect(count).toBe(1);
      expect(progress.downloadedFileIds).toContain('img-ok');
      expect(progress.downloadedFileIds).not.toContain('img-fail');
    });

    test('skips files that were already downloaded', async () => {
      const { downloadConversationFiles } = require('../../lib/downloader');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://already-done', metadata: {} },
                ],
              },
            },
          },
        },
      };

      global.fetch = jest.fn();
      const progress = {
        downloadedFileIds: ['already-done'],
        projects: {},
      };
      const count = await downloadConversationFiles('token', conversationData, tmpDir, progress);

      expect(count).toBe(0);
      // fetch should not have been called since the file was already downloaded
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('handles getFileDownloadUrl returning non-success status', async () => {
      const { downloadConversationFiles } = require('../../lib/downloader');
      const { loadProgress } = require('../../lib/storage');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://no-url', metadata: {} },
                ],
              },
            },
          },
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: true, status: 200,
        json: () => Promise.resolve({ status: 'error', message: 'File not found' }),
      });

      const progress = loadProgress();
      const count = await downloadConversationFiles('token', conversationData, tmpDir, progress);

      // Should gracefully skip (warning logged, count stays 0)
      expect(count).toBe(0);
    });

    test('respects CONFIG.downloadImages filter', async () => {
      CONFIG.downloadImages = false;
      const { downloadConversationFiles } = require('../../lib/downloader');
      const { loadProgress } = require('../../lib/storage');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-1', metadata: {} },
                ],
              },
            },
          },
        },
      };

      global.fetch = jest.fn();
      const count = await downloadConversationFiles('token', conversationData, tmpDir, loadProgress());
      expect(count).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test('propagates auth errors from file download URL fetch', async () => {
      const { downloadConversationFiles } = require('../../lib/downloader');
      const { loadProgress } = require('../../lib/storage');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-1', metadata: {} },
                ],
              },
            },
          },
        },
      };

      global.fetch = jest.fn().mockResolvedValue({
        ok: false, status: 401, statusText: 'Unauthorized',
      });

      const progress = loadProgress();
      await expect(downloadConversationFiles('expired-token', conversationData, tmpDir, progress))
        .rejects.toMatchObject({ authError: true });
    });

    test('returns 0 for conversation with no file references', async () => {
      const { downloadConversationFiles } = require('../../lib/downloader');
      const { loadProgress } = require('../../lib/storage');

      const conversationData = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: { content_type: 'text', parts: ['Just text'] },
            },
          },
        },
      };

      const count = await downloadConversationFiles('token', conversationData, tmpDir, loadProgress());
      expect(count).toBe(0);
    });
  });

  describe('downloadFile - failure cases', () => {
    test('retries up to 3 times on failure', async () => {
      const { downloadFile } = require('../../lib/downloader');

      global.fetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({
          ok: true, status: 200,
          headers: { get: () => 'image/png' },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(50)),
        });

      const outPath = path.join(tmpDir, 'test-retry.png');
      const result = await downloadFile('https://cdn.example.com/file.png', outPath, 'token');
      expect(result.bytes).toBe(50);
      expect(result.contentType).toBe('image/png');
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });

    test('throws after 3 failed download attempts', async () => {
      const { downloadFile } = require('../../lib/downloader');

      global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 });

      const outPath = path.join(tmpDir, 'test-fail.png');
      await expect(downloadFile('https://cdn.example.com/file.png', outPath, 'token'))
        .rejects.toThrow(/File download failed/);
      expect(global.fetch).toHaveBeenCalledTimes(3);
    });
  });

  describe('extractFileReferences - robustness', () => {
    test('handles conversation with deeply nested but empty mapping', () => {
      const { extractFileReferences } = require('../../lib/downloader');
      const data = { id: 'conv', mapping: { n1: { message: { content: { content_type: 'text', parts: [] } } } } };
      expect(extractFileReferences(data)).toEqual([]);
    });

    test('strips sediment:// prefix from asset pointers', () => {
      const { extractFileReferences } = require('../../lib/downloader');
      const data = {
        id: 'conv',
        mapping: {
          n1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://abc-123', metadata: {} }],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs[0].fileId).toBe('abc-123');
    });

    test('strips file-service:// prefix from asset pointers', () => {
      const { extractFileReferences } = require('../../lib/downloader');
      const data = {
        id: 'conv',
        mapping: {
          n1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://xyz-789', metadata: {} }],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs[0].fileId).toBe('xyz-789');
    });
  });
});
