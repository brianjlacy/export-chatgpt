'use strict';

describe('downloader', () => {
  let extractFileReferences, getExtensionFromFilename;

  beforeEach(() => {
    jest.resetModules();
    ({ extractFileReferences, getExtensionFromFilename } = require('../../lib/downloader'));
  });

  describe('extractFileReferences', () => {
    test('extracts image references from multimodal content', () => {
      const data = {
        id: 'conv-1',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-123', metadata: {}, size_bytes: 5000 },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0]).toEqual({
        fileId: 'img-123',
        conversationId: 'conv-1',
        type: 'image',
        metadata: {},
        sizeBytes: 5000,
      });
    });

    test('extracts canvas references', () => {
      const data = {
        id: 'conv-2',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'canvas_asset_pointer', asset_pointer: 'sediment://canvas-456', metadata: {} },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('canvas');
      expect(refs[0].fileId).toBe('canvas-456');
    });

    test('extracts standalone canvas content', () => {
      const data = {
        id: 'conv-3',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'canvas',
                asset_pointer: 'file-service://standalone-canvas',
                metadata: {},
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('canvas');
    });

    test('extracts attachment references', () => {
      const data = {
        id: 'conv-4',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'other_pointer', asset_pointer: 'file-service://file-789', metadata: {} },
                ],
              },
            },
          },
        },
      };
      const refs = extractFileReferences(data);
      expect(refs).toHaveLength(1);
      expect(refs[0].type).toBe('attachment');
    });

    test('returns empty array for no mapping', () => {
      expect(extractFileReferences({})).toEqual([]);
    });

    test('returns empty array for messages without content', () => {
      const data = {
        id: 'conv-5',
        mapping: {
          node1: { message: null },
          node2: { message: { content: null } },
        },
      };
      expect(extractFileReferences(data)).toEqual([]);
    });

    test('skips parts without asset_pointer', () => {
      const data = {
        id: 'conv-6',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: ['just text', null, { no_pointer: true }],
              },
            },
          },
        },
      };
      expect(extractFileReferences(data)).toEqual([]);
    });

    test('handles multiple files from same conversation', () => {
      const data = {
        id: 'conv-7',
        mapping: {
          node1: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-1', metadata: {} },
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-2', metadata: {} },
                ],
              },
            },
          },
          node2: {
            message: {
              content: {
                content_type: 'multimodal_text',
                parts: [
                  { content_type: 'image_asset_pointer', asset_pointer: 'file-service://img-3', metadata: {} },
                ],
              },
            },
          },
        },
      };
      expect(extractFileReferences(data)).toHaveLength(3);
    });
  });

  describe('getExtensionFromFilename', () => {
    test('extracts extension', () => {
      expect(getExtensionFromFilename('photo.jpg')).toBe('.jpg');
      expect(getExtensionFromFilename('document.pdf')).toBe('.pdf');
      expect(getExtensionFromFilename('archive.tar.gz')).toBe('.gz');
    });

    test('returns empty string for no extension', () => {
      expect(getExtensionFromFilename('README')).toBe('');
    });

    test('returns empty string for null/undefined', () => {
      expect(getExtensionFromFilename(null)).toBe('');
      expect(getExtensionFromFilename(undefined)).toBe('');
    });
  });
});
