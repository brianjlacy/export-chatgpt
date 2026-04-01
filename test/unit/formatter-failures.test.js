'use strict';

describe('formatter failure cases', () => {
  let CONFIG;

  beforeEach(() => {
    jest.resetModules();
    ({ CONFIG } = require('../../lib/config'));
  });

  const load = () => require('../../lib/formatter');

  describe('extractMessageContent - malformed data', () => {
    test('handles message with null content', () => {
      const { extractMessageContent } = load();
      expect(extractMessageContent({ content: null, metadata: {} })).toBe('');
    });

    test('handles message with undefined metadata', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text', parts: ['hello'] } };
      expect(extractMessageContent(msg)).toBe('hello');
    });

    test('handles text content with non-string parts', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text', parts: [null, 42, 'valid', undefined] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('valid');
    });

    test('handles text content with empty parts array', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text', parts: [] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles text content with no parts', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text' }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles multimodal content with empty asset_pointer', () => {
      CONFIG.downloadFiles = true;
      const { extractMessageContent } = load();
      const msg = {
        content: {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'image_asset_pointer', asset_pointer: '' }],
        },
        metadata: {},
      };
      const result = extractMessageContent(msg);
      expect(result).toBe('[Image]');
    });

    test('handles multimodal content with only sediment:// prefix', () => {
      CONFIG.downloadFiles = true;
      const { extractMessageContent } = load();
      const msg = {
        content: {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'sediment://' }],
        },
        metadata: {},
      };
      const result = extractMessageContent(msg);
      // After stripping prefix, fileId is empty string → falsy
      expect(result).toBe('[Image]');
    });

    test('handles thoughts content with empty parts', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'thoughts', parts: ['  ', ''] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles browsing display with empty text', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'tether_browsing_display', parts: [] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles reasoning_recap with whitespace-only text', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'reasoning_recap', parts: ['   '] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles unknown content type gracefully', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'future_type_xyz', parts: ['data'] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles content that is a plain string', () => {
      const { extractMessageContent } = load();
      const msg = { content: 'just a string', metadata: {} };
      expect(extractMessageContent(msg)).toBe('just a string');
    });
  });

  describe('extractMessagesInOrder - edge cases', () => {
    test('handles mapping with disconnected nodes (orphans)', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          root: { parent: null, children: ['msg1'], message: null },
          msg1: { parent: 'root', children: ['missing_child'], message: { content: { content_type: 'text', parts: ['Hello'] } } },
          orphan: { parent: 'nonexistent', children: [], message: { content: { content_type: 'text', parts: ['Lost'] } } },
        },
      };
      // Should get msg1 but not crash when following missing_child
      const messages = extractMessagesInOrder(conversation);
      expect(messages).toHaveLength(1);
      expect(messages[0].content.parts[0]).toBe('Hello');
    });

    test('handles node with empty children array', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          root: { parent: null, children: [], message: null },
        },
      };
      expect(extractMessagesInOrder(conversation)).toEqual([]);
    });

    test('handles node with null message content', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          root: { parent: null, children: ['msg1'], message: null },
          msg1: { parent: 'root', children: [], message: { content: null } },
        },
      };
      // Node with null content should be skipped (no crash)
      expect(extractMessagesInOrder(conversation)).toEqual([]);
    });
  });

  describe('formatToolMessage - edge cases', () => {
    test('handles tool message with no author', () => {
      const { formatToolMessage } = load();
      const msg = { author: null, metadata: {}, content: { content_type: 'text', parts: ['output'] } };
      const result = formatToolMessage(msg);
      expect(result).toContain('unknown_tool');
    });

    test('handles research kickoff with no title', () => {
      const { formatToolMessage } = load();
      const msg = {
        author: { name: 'research_kickoff_tool.start_research_task' },
        metadata: {},
        content: {},
      };
      expect(formatToolMessage(msg)).toContain('Research Task');
    });

    test('handles tool message with empty content', () => {
      const { formatToolMessage } = load();
      const msg = { author: { name: 'custom' }, metadata: {}, content: {} };
      expect(formatToolMessage(msg)).toBe('');
    });

    test('handles clarify_with_text with empty parts', () => {
      const { formatToolMessage } = load();
      const msg = {
        author: { name: 'research_kickoff_tool.clarify_with_text' },
        metadata: {},
        content: { parts: [] },
      };
      expect(formatToolMessage(msg)).toBe('');
    });
  });

  describe('conversationToMarkdown - edge cases', () => {
    test('handles conversation with no title', () => {
      const { conversationToMarkdown } = load();
      const conv = { id: 'test', mapping: {} };
      const md = conversationToMarkdown(conv);
      expect(md).toContain('Untitled');
    });

    test('handles conversation with missing id', () => {
      const { conversationToMarkdown } = load();
      const conv = { conversation_id: 'alt-id', title: 'Test', mapping: {} };
      const md = conversationToMarkdown(conv);
      expect(md).toContain('alt-id');
    });

    test('handles messages with unknown roles', () => {
      const { conversationToMarkdown } = load();
      const conv = {
        id: 'test', title: 'Test',
        mapping: {
          root: { parent: null, children: ['msg1'], message: null },
          msg1: {
            parent: 'root', children: [],
            message: {
              content: { content_type: 'text', parts: ['data'] },
              author: { role: 'unknown_role' },
              metadata: {},
            },
          },
        },
      };
      const md = conversationToMarkdown(conv);
      // Unknown roles should not crash; content just won't have a section header
      expect(md).toContain('# Test');
    });

    test('handles title with special YAML characters', () => {
      const { conversationToMarkdown } = load();
      const conv = { id: 'test', title: 'Title with "quotes" and: colons', mapping: {} };
      const md = conversationToMarkdown(conv);
      expect(md).toContain('title: "Title with \\"quotes\\" and: colons"');
    });
  });

  describe('sanitizeFilename - adversarial inputs', () => {
    test('handles path traversal attempts', () => {
      const { sanitizeFilename } = load();
      expect(sanitizeFilename('../../../etc/passwd')).not.toContain('..');
    });

    test('handles all-special-character names', () => {
      const { sanitizeFilename } = load();
      const result = sanitizeFilename('???:::***');
      expect(result).not.toContain('?');
      expect(result).not.toContain(':');
      expect(result).not.toContain('*');
    });

    test('handles unicode characters', () => {
      const { sanitizeFilename } = load();
      const result = sanitizeFilename('会話テスト');
      expect(result.length).toBeGreaterThan(0);
    });

    test('handles extremely long names', () => {
      const { sanitizeFilename } = load();
      const result = sanitizeFilename('a'.repeat(10000));
      expect(result.length).toBeLessThanOrEqual(100);
    });
  });

  describe('getDatePrefix - edge cases', () => {
    test('handles negative timestamp', () => {
      const { getDatePrefix } = load();
      // Negative timestamp = before epoch
      const result = getDatePrefix(-1);
      // Should still produce a valid date or 'unknown'
      expect(typeof result).toBe('string');
    });

    test('handles zero timestamp', () => {
      const { getDatePrefix } = load();
      expect(getDatePrefix(0)).toBe('unknown');
    });

    test('handles very large timestamp', () => {
      const { getDatePrefix } = load();
      const result = getDatePrefix(99999999999);
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
