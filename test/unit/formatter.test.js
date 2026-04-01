'use strict';

let CONFIG;

beforeEach(() => {
  jest.resetModules();
  ({ CONFIG } = require('../../lib/config'));
});

const load = () => require('../../lib/formatter');

describe('formatter', () => {
  describe('formatDate', () => {
    test('returns ISO string for numeric timestamp (seconds)', () => {
      const { formatDate } = load();
      // 1700000000 = 2023-11-14T22:13:20.000Z
      const result = formatDate(1700000000);
      expect(result).toBe('2023-11-14T22:13:20.000Z');
    });

    test('returns ISO string for string timestamp', () => {
      const { formatDate } = load();
      const result = formatDate('2023-06-15T10:00:00Z');
      expect(result).toBe('2023-06-15T10:00:00.000Z');
    });

    test('returns "unknown" for null/undefined', () => {
      const { formatDate } = load();
      expect(formatDate(null)).toBe('unknown');
      expect(formatDate(undefined)).toBe('unknown');
    });

    test('returns "unknown" for invalid timestamp', () => {
      const { formatDate } = load();
      expect(formatDate('not-a-date')).toBe('unknown');
    });
  });

  describe('escapeYaml', () => {
    test('escapes double quotes', () => {
      const { escapeYaml } = load();
      expect(escapeYaml('say "hello"')).toBe('say \\"hello\\"');
    });

    test('replaces newlines with spaces', () => {
      const { escapeYaml } = load();
      expect(escapeYaml('line1\nline2')).toBe('line1 line2');
    });

    test('returns empty string for falsy input', () => {
      const { escapeYaml } = load();
      expect(escapeYaml(null)).toBe('');
      expect(escapeYaml('')).toBe('');
    });
  });

  describe('sanitizeFilename', () => {
    test('replaces unsafe characters with underscores', () => {
      const { sanitizeFilename } = load();
      expect(sanitizeFilename('file<name>:test')).toBe('file_name__test');
    });

    test('replaces whitespace with underscores', () => {
      const { sanitizeFilename } = load();
      expect(sanitizeFilename('my file name')).toBe('my_file_name');
    });

    test('truncates to 100 characters', () => {
      const { sanitizeFilename } = load();
      const longName = 'a'.repeat(150);
      expect(sanitizeFilename(longName).length).toBe(100);
    });

    test('returns "untitled" for falsy input', () => {
      const { sanitizeFilename } = load();
      expect(sanitizeFilename(null)).toBe('untitled');
      expect(sanitizeFilename('')).toBe('untitled');
    });

    test('replaces dot-only names (directory traversal prevention)', () => {
      const { sanitizeFilename } = load();
      // Multi-dot sequences are collapsed to '_', preventing traversal
      expect(sanitizeFilename('..')).toBe('_');
      expect(sanitizeFilename('...')).toBe('_');
      // Single dot still caught by final regex
      expect(sanitizeFilename('.')).toBe('untitled');
    });
  });

  describe('sanitizeProjectFolder', () => {
    test('replaces unsafe characters', () => {
      const { sanitizeProjectFolder } = load();
      expect(sanitizeProjectFolder('My Project: Test')).toBe('My_Project__Test');
    });

    test('truncates to 50 characters', () => {
      const { sanitizeProjectFolder } = load();
      const longName = 'a'.repeat(80);
      expect(sanitizeProjectFolder(longName).length).toBe(50);
    });

    test('returns "untitled_project" for falsy input', () => {
      const { sanitizeProjectFolder } = load();
      expect(sanitizeProjectFolder(null)).toBe('untitled_project');
      expect(sanitizeProjectFolder('')).toBe('untitled_project');
    });

    test('replaces dot-only names', () => {
      const { sanitizeProjectFolder } = load();
      // Multi-dot sequences are collapsed to '_', preventing traversal
      expect(sanitizeProjectFolder('..')).toBe('_');
      expect(sanitizeProjectFolder('.')).toBe('untitled_project');
    });
  });

  describe('getDatePrefix', () => {
    test('returns YYYY-MM-DD for numeric timestamp', () => {
      const { getDatePrefix } = load();
      expect(getDatePrefix(1700000000)).toBe('2023-11-14');
    });

    test('returns YYYY-MM-DD for string timestamp', () => {
      const { getDatePrefix } = load();
      expect(getDatePrefix('2023-06-15T10:00:00Z')).toBe('2023-06-15');
    });

    test('returns "unknown" for falsy input', () => {
      const { getDatePrefix } = load();
      expect(getDatePrefix(null)).toBe('unknown');
      expect(getDatePrefix(undefined)).toBe('unknown');
    });
  });

  describe('extractMessagesInOrder', () => {
    test('extracts messages following first-child path', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          root: { parent: null, children: ['msg1'], message: null },
          msg1: { parent: 'root', children: ['msg2'], message: { content: { content_type: 'text', parts: ['Hello'] }, author: { role: 'user' } } },
          msg2: { parent: 'msg1', children: [], message: { content: { content_type: 'text', parts: ['Hi!'] }, author: { role: 'assistant' } } },
        },
      };
      const messages = extractMessagesInOrder(conversation);
      expect(messages).toHaveLength(2);
      expect(messages[0].content.parts[0]).toBe('Hello');
      expect(messages[1].content.parts[0]).toBe('Hi!');
    });

    test('returns empty array for missing mapping', () => {
      const { extractMessagesInOrder } = load();
      expect(extractMessagesInOrder({})).toEqual([]);
    });

    test('returns empty array when no root node found', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          a: { parent: 'b', children: [] },
          b: { parent: 'a', children: [] },
        },
      };
      expect(extractMessagesInOrder(conversation)).toEqual([]);
    });

    test('skips nodes without messages', () => {
      const { extractMessagesInOrder } = load();
      const conversation = {
        mapping: {
          root: { parent: null, children: ['empty'], message: null },
          empty: { parent: 'root', children: ['msg'], message: null },
          msg: { parent: 'empty', children: [], message: { content: { content_type: 'text', parts: ['Hi'] } } },
        },
      };
      const messages = extractMessagesInOrder(conversation);
      expect(messages).toHaveLength(1);
    });
  });

  describe('extractMessageContent', () => {
    test('extracts plain text content', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text', parts: ['Hello world'] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('Hello world');
    });

    test('extracts code content', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'code', text: 'print("hi")' }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('```\nprint("hi")\n```');
    });

    test('skips visually hidden messages', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'text', parts: ['Hidden'] }, metadata: { is_visually_hidden_from_conversation: true } };
      expect(extractMessageContent(msg)).toBe('');
    });

    test('handles multimodal text with images when downloadFiles is true', () => {
      CONFIG.downloadFiles = true;
      const { extractMessageContent } = load();
      const msg = {
        content: {
          content_type: 'multimodal_text',
          parts: [
            'Some text',
            { content_type: 'image_asset_pointer', asset_pointer: 'file-service://abc123' },
          ],
        },
        metadata: {},
      };
      const result = extractMessageContent(msg);
      expect(result).toContain('Some text');
      expect(result).toContain('![image](files/abc123.png)');
    });

    test('handles multimodal text with images when downloadFiles is false', () => {
      CONFIG.downloadFiles = false;
      const { extractMessageContent } = load();
      const msg = {
        content: {
          content_type: 'multimodal_text',
          parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://abc123' }],
        },
        metadata: {},
      };
      expect(extractMessageContent(msg)).toContain('[Image: abc123]');
    });

    test('returns empty string for no content', () => {
      const { extractMessageContent } = load();
      expect(extractMessageContent({ metadata: {} })).toBe('');
    });

    test('handles thoughts content type', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'thoughts', parts: ['Thinking...'] }, metadata: {} };
      const result = extractMessageContent(msg);
      expect(result).toContain('<details>');
      expect(result).toContain('Thinking...');
    });

    test('handles browsing display content', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'tether_browsing_display', parts: ['Result text'] }, metadata: {} };
      const result = extractMessageContent(msg);
      expect(result).toContain('Browsing Result');
      expect(result).toContain('Result text');
    });

    test('handles reasoning_recap content', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'reasoning_recap', parts: ['Summary'] }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('*Reasoning recap: Summary*');
    });

    test('returns empty for model_editable_context', () => {
      const { extractMessageContent } = load();
      const msg = { content: { content_type: 'model_editable_context' }, metadata: {} };
      expect(extractMessageContent(msg)).toBe('');
    });
  });

  describe('mimeToExtension', () => {
    test('maps known MIME types to extensions', () => {
      const { mimeToExtension } = load();
      expect(mimeToExtension('image/png')).toBe('.png');
      expect(mimeToExtension('image/jpeg')).toBe('.jpg');
      expect(mimeToExtension('application/pdf')).toBe('.pdf');
      expect(mimeToExtension('application/json')).toBe('.json');
      expect(mimeToExtension('text/html')).toBe('.html');
      expect(mimeToExtension('text/plain')).toBe('.txt');
    });

    test('handles MIME with charset suffix', () => {
      const { mimeToExtension } = load();
      expect(mimeToExtension('text/html; charset=utf-8')).toBe('.html');
      expect(mimeToExtension('application/json; charset=utf-8')).toBe('.json');
    });

    test('returns empty string for unknown MIME types', () => {
      const { mimeToExtension } = load();
      expect(mimeToExtension('application/octet-stream')).toBe('');
      expect(mimeToExtension('video/mp4')).toBe('');
    });

    test('returns empty string for null/undefined/empty', () => {
      const { mimeToExtension } = load();
      expect(mimeToExtension(null)).toBe('');
      expect(mimeToExtension(undefined)).toBe('');
      expect(mimeToExtension('')).toBe('');
    });
  });

  describe('guessFileExtension', () => {
    test('returns .png for DALL-E images', () => {
      const { guessFileExtension } = load();
      expect(guessFileExtension({ metadata: { dalle: true } })).toBe('.png');
    });

    test('defaults to .png', () => {
      const { guessFileExtension } = load();
      expect(guessFileExtension({ metadata: {} })).toBe('.png');
      expect(guessFileExtension({})).toBe('.png');
    });
  });

  describe('formatToolMessage', () => {
    test('formats deep research kickoff', () => {
      const { formatToolMessage } = load();
      const msg = {
        author: { name: 'research_kickoff_tool.start_research_task' },
        metadata: { async_task_title: 'My Research' },
        content: {},
      };
      expect(formatToolMessage(msg)).toBe('> **Deep Research:** My Research');
    });

    test('formats file search', () => {
      const { formatToolMessage } = load();
      const msg = {
        author: { name: 'file_search' },
        metadata: {},
        content: { content_type: 'text', parts: ['search results'] },
      };
      expect(formatToolMessage(msg)).toContain('Searched files');
    });

    test('formats generic tool with content', () => {
      const { formatToolMessage } = load();
      const msg = {
        author: { name: 'custom_tool' },
        metadata: {},
        content: { content_type: 'text', parts: ['output'] },
      };
      expect(formatToolMessage(msg)).toContain('Tool (custom_tool)');
    });
  });

  describe('conversationToMarkdown', () => {
    test('generates markdown with YAML frontmatter', () => {
      const { conversationToMarkdown } = load();
      const conversation = {
        id: 'test-id-123',
        title: 'Test Conversation',
        create_time: 1700000000,
        update_time: 1700001000,
        mapping: {
          root: { parent: null, children: ['msg1'], message: null },
          msg1: { parent: 'root', children: ['msg2'], message: { content: { content_type: 'text', parts: ['Hello'] }, author: { role: 'user' }, metadata: {} } },
          msg2: { parent: 'msg1', children: [], message: { content: { content_type: 'text', parts: ['Hi there!'] }, author: { role: 'assistant' }, metadata: {} } },
        },
      };
      const md = conversationToMarkdown(conversation);
      expect(md).toContain('---');
      expect(md).toContain('title: "Test Conversation"');
      expect(md).toContain('id: test-id-123');
      expect(md).toContain('## User');
      expect(md).toContain('Hello');
      expect(md).toContain('## Assistant');
      expect(md).toContain('Hi there!');
    });

    test('includes project_id when gizmo_id present', () => {
      const { conversationToMarkdown } = load();
      const conversation = {
        id: 'test-id',
        title: 'Test',
        gizmo_id: 'gizmo-abc',
        mapping: {},
      };
      const md = conversationToMarkdown(conversation);
      expect(md).toContain('project_id: gizmo-abc');
    });

    test('handles conversation with no messages', () => {
      const { conversationToMarkdown } = load();
      const conversation = { id: 'test', title: 'Empty', mapping: {} };
      const md = conversationToMarkdown(conversation);
      expect(md).toContain('# Empty');
    });
  });
});
