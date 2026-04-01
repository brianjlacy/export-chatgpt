'use strict';

// Pure text-transform functions — no I/O, no HTTP.
// Note: extractMessageContent reads CONFIG.downloadFiles to decide image link format.
const { CONFIG } = require('./config');

function formatDate(timestamp) {
  if (!timestamp) return 'unknown';
  try {
    const date = typeof timestamp === 'string'
      ? new Date(timestamp)
      : new Date(timestamp * 1000);
    if (isNaN(date.getTime())) return 'unknown';
    return date.toISOString();
  } catch (e) {
    return 'unknown';
  }
}

function escapeYaml(str) {
  if (!str) return '';
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ');
}

// Security fix S1: protect against bare dot-only names that could traverse directories.
function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100)
    .replace(/^\.+$/, 'untitled');
}

function sanitizeProjectFolder(name) {
  if (!name) return 'untitled_project';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .substring(0, 50)
    .replace(/^\.+$/, 'untitled_project');
}

function getDatePrefix(timestamp) {
  try {
    if (timestamp) {
      const date = typeof timestamp === 'string'
        ? new Date(timestamp)
        : new Date(timestamp * 1000);
      if (!isNaN(date.getTime())) {
        return date.toISOString().split('T')[0];
      }
    }
  } catch (e) {
    // Ignore
  }
  return 'unknown';
}

function extractMessagesInOrder(conversation) {
  if (!conversation.mapping) return [];

  const messages = [];
  const mapping = conversation.mapping;

  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent) {
      rootId = id;
      break;
    }
  }

  if (!rootId) return [];

  function traverse(nodeId) {
    const node = mapping[nodeId];
    if (!node) return;

    if (node.message && node.message.content) {
      messages.push(node.message);
    }

    if (node.children && node.children.length > 0) {
      traverse(node.children[0]);
    }
  }

  traverse(rootId);
  return messages;
}

function extractMessageContent(message) {
  if (!message.content) return '';

  const content = message.content;
  const metadata = message.metadata || {};

  // Skip visually hidden messages
  if (metadata.is_visually_hidden_from_conversation) return '';

  // Standard text
  if (content.content_type === 'text' && content.parts) {
    return content.parts.filter(p => typeof p === 'string').join('\n');
  }

  // Code execution results
  if (content.content_type === 'code' && content.text) {
    return '```\n' + content.text + '\n```';
  }

  // Multimodal text (images/files)
  if (content.content_type === 'multimodal_text' && content.parts) {
    const parts = [];
    for (const part of content.parts) {
      if (typeof part === 'string') {
        parts.push(part);
      } else if (part && part.content_type === 'image_asset_pointer') {
        const fileId = (part.asset_pointer || '').replace(/^(sediment|file-service):\/\//, '');
        if (CONFIG.downloadFiles && fileId) {
          const ext = guessFileExtension(part);
          parts.push(`![image](files/${fileId}${ext})`);
        } else if (fileId) {
          parts.push(`[Image: ${fileId}]`);
        } else {
          parts.push('[Image]');
        }
      }
    }
    return parts.join('\n');
  }

  // Browsing display results
  if (content.content_type === 'tether_browsing_display') {
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    if (text.trim()) {
      return `> **Browsing Result:**\n>\n> ${text.replace(/\n/g, '\n> ')}`;
    }
    return '';
  }

  // Thinking / reasoning (o1/o3)
  if (content.content_type === 'thoughts') {
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    if (text.trim()) {
      return `<details>\n<summary>Thinking</summary>\n\n${text}\n\n</details>`;
    }
    return '';
  }

  // Reasoning recap
  if (content.content_type === 'reasoning_recap') {
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    if (text.trim()) {
      return `*Reasoning recap: ${text}*`;
    }
    return '';
  }

  // Model editable context (system context) - skip
  if (content.content_type === 'model_editable_context') {
    return '';
  }

  if (typeof content === 'string') {
    return content;
  }

  return '';
}

function guessFileExtension(assetPart) {
  if (assetPart.metadata) {
    if (assetPart.metadata.dalle) return '.png';
  }
  return '.png';
}

function formatToolMessage(message) {
  const name = message.author?.name || 'unknown_tool';
  const metadata = message.metadata || {};
  const content = message.content || {};

  // Deep research initiation
  if (name === 'research_kickoff_tool.start_research_task') {
    const title = metadata.async_task_title || 'Research Task';
    return `> **Deep Research:** ${title}`;
  }

  // Deep research clarification
  if (name === 'research_kickoff_tool.clarify_with_text') {
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    if (text.trim()) {
      return `> **Research Clarification:** ${text}`;
    }
    return '';
  }

  // File search
  if (name === 'file_search') {
    const text = (content.parts || []).filter(p => typeof p === 'string').join('\n');
    if (text.trim()) {
      return `> **Searched files:** ${text}`;
    }
    return '';
  }

  // Generic tool output
  const text = extractMessageContent(message);
  if (text.trim()) {
    return `> **Tool (${name}):** ${text}`;
  }
  return '';
}

function conversationToMarkdown(conversation) {
  const lines = [];

  lines.push('---');
  lines.push(`title: "${escapeYaml(conversation.title || 'Untitled')}"`);
  lines.push(`id: ${conversation.id || conversation.conversation_id}`);
  lines.push(`create_time: ${formatDate(conversation.create_time)}`);
  lines.push(`update_time: ${formatDate(conversation.update_time)}`);
  if (conversation.model) {
    lines.push(`model: ${conversation.model}`);
  }
  if (conversation.gizmo_id) {
    lines.push(`project_id: ${conversation.gizmo_id}`);
  }
  lines.push('---');
  lines.push('');
  lines.push(`# ${conversation.title || 'Untitled'}`);
  lines.push('');

  const messages = extractMessagesInOrder(conversation);

  for (const msg of messages) {
    const role = msg.author?.role || 'unknown';
    const metadata = msg.metadata || {};

    // Handle async task result messages with header
    if (metadata.is_async_task_result_message) {
      const taskTitle = metadata.async_task_title || 'Research Result';
      lines.push(`## Assistant (Deep Research: ${taskTitle})`);
      lines.push('');
      const content = extractMessageContent(msg);
      if (content.trim()) {
        lines.push(content);
        lines.push('');
      }
      continue;
    }

    if (role === 'tool') {
      const toolContent = formatToolMessage(msg);
      if (toolContent.trim()) {
        lines.push(toolContent);
        lines.push('');
      }
      continue;
    }

    const content = extractMessageContent(msg);
    if (!content.trim()) continue;

    if (role === 'user') {
      lines.push('## User');
      lines.push('');
      lines.push(content);
      lines.push('');
    } else if (role === 'assistant') {
      lines.push('## Assistant');
      lines.push('');
      lines.push(content);
      lines.push('');
    } else if (role === 'system' && content.trim()) {
      lines.push('## System');
      lines.push('');
      lines.push(content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

module.exports = {
  formatDate,
  escapeYaml,
  sanitizeFilename,
  sanitizeProjectFolder,
  getDatePrefix,
  extractMessagesInOrder,
  extractMessageContent,
  guessFileExtension,
  formatToolMessage,
  conversationToMarkdown,
};
