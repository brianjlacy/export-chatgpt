#!/usr/bin/env node

/**
 * ChatGPT Conversation Exporter (Resumable)
 *
 * Bulk exports all your ChatGPT conversations using the backend API.
 * Supports regular conversations, project conversations, file downloads,
 * and deep research results. Resumable across token expirations.
 *
 * Usage:
 *   node export-chatgpt.js --bearer "eyJ..." --account-id "f3ae362d-..."
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Command } = require('commander');

// Interactive prompt utilities
function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// Configuration
const CONFIG = {
  baseUrl: 'https://chatgpt.com',
  apiBase: 'https://chatgpt.com/backend-api',
  outputDir: './exports',
  delayBetweenRequests: 1500,
  conversationsPerPage: 28,
  exportFormat: 'both', // 'json', 'markdown', or 'both'
  accountId: null,
  updateExisting: false,
  includeProjects: true,
  projectsOnly: false,
  downloadFiles: true,
  downloadImages: true,
  downloadCanvas: true,
  downloadAttachments: true,
  verbose: false,
};

function verboseLog(msg) {
  if (CONFIG.verbose) console.log(msg);
}

// File paths (set after outputDir is finalized)
let PATHS = {};

function initPaths() {
  PATHS = {
    indexFile: path.join(CONFIG.outputDir, 'conversation-index.json'),
    progressFile: path.join(CONFIG.outputDir, '.export-progress.json'),
    jsonDir: path.join(CONFIG.outputDir, 'json'),
    mdDir: path.join(CONFIG.outputDir, 'markdown'),
    filesDir: path.join(CONFIG.outputDir, 'files'),
    projectsDir: path.join(CONFIG.outputDir, 'projects'),
    projectIndexFile: path.join(CONFIG.outputDir, 'projects', 'project-index.json'),
  };
}

// Configure Commander CLI
function setupCLI() {
  const pkg = require('./package.json');
  const program = new Command();

  program
    .name('export-chatgpt')
    .description('Bulk export ChatGPT conversations via backend API (resumable)')
    .version(pkg.version, '-v, --version', 'Output the version number')
    .option('--bearer <token>', 'Bearer/access token (or set CHATGPT_BEARER_TOKEN env var)')
    .option('--token <token>', 'Session token — alternative auth (or set CHATGPT_SESSION_TOKEN env var)')
    .option('--account-id <id>', 'ChatGPT Teams account ID')
    .option('-o, --output <dir>', 'Output directory', './exports')
    .option('--format <format>', 'Export format: json | markdown | both', 'both')
    .option('--delay <ms>', 'Delay between requests in ms', '1500')
    .option('--update', 'Re-download existing conversations', false)
    .option('--no-projects', 'Skip project conversations')
    .option('--projects-only', 'Export only project conversations (skip regular)')
    .option('--no-images', 'Skip downloading images')
    .option('--no-canvas', 'Skip downloading canvas documents')
    .option('--no-attachments', 'Skip downloading other file attachments')
    .option('--no-files', 'Skip ALL file downloads (overrides --no-images / --no-canvas / --no-attachments)')
    .option('--verbose', 'Show detailed request/response info and full error messages')
    .addHelpText('after', `
Resumable:
  If interrupted, run again with a fresh Bearer token.
  Already-downloaded conversations are skipped automatically.

How to get your Bearer token:
  1. Open https://chatgpt.com with DevTools (F12) > Network tab
  2. Find any request to "backend-api/conversations"
  3. Copy "authorization: Bearer eyJ..." (just the eyJ... part)
  4. For Teams accounts, also copy the "chatgpt-account-id" header value

Examples:
  # Export everything (conversations, projects, images, canvas, attachments):
  export-chatgpt --bearer "eyJ..."

  # Skip file downloads entirely:
  export-chatgpt --bearer "eyJ..." --no-files

  # Export only project conversations, no images:
  export-chatgpt --bearer "eyJ..." --projects-only --no-images

  # Skip projects, re-download existing conversations:
  export-chatgpt --bearer "eyJ..." --no-projects --update

  # Teams account:
  export-chatgpt --bearer "eyJ..." --account-id "f3ae362d-..."
`);

  program.parse();
  const opts = program.opts();

  const bearerToken = opts.bearer || process.env.CHATGPT_BEARER_TOKEN || null;
  const sessionToken = opts.token || process.env.CHATGPT_SESSION_TOKEN || null;

  return { opts, bearerToken, sessionToken };
}

// Create headers with Bearer token for API calls
function createApiHeaders(accessToken) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  };

  if (CONFIG.accountId) {
    headers['chatgpt-account-id'] = CONFIG.accountId;
  }

  return headers;
}

// Fetch with error handling and retry
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 401 || response.status === 403) {
        verboseLog(`    Auth error: ${response.status} ${response.statusText} — ${url}`);
        const error = new Error(`Authentication failed (${response.status}). Your Bearer token may be expired.`);
        error.authError = true;
        throw error;
      }

      if (response.status === 429) {
        const waitTime = (i + 1) * 5000;
        console.log(`  Rate limited. Waiting ${waitTime / 1000}s before retry...`);
        await sleep(waitTime);
        continue;
      }

      if (!response.ok) {
        verboseLog(`    HTTP ${response.status} ${response.statusText} — ${url}`);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (error.authError) throw error;
      if (i === retries - 1) throw error;
      console.log(`  Request failed, retrying (${i + 1}/${retries})...`);
      verboseLog(`    Reason: ${error.message}`);
      await sleep(2000);
    }
  }
}

// Extract Teams account ID from a JWT bearer token (avoids manual entry)
function extractAccountIdFromJWT(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  } catch {
    return null;
  }
}

// Get access token from session (fallback method)
async function getAccessToken(sessionToken) {
  console.log('Getting access token from session...');

  const response = await fetchWithRetry(
    `${CONFIG.baseUrl}/api/auth/session`,
    {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Cookie': `__Secure-next-auth.session-token=${sessionToken}`,
      }
    }
  );

  const data = await response.json();

  if (!data.accessToken) {
    throw new Error('Could not get access token. Session token may be invalid.');
  }

  return data.accessToken;
}

// ── Index & Progress Helpers ──────────────────────────────────────────

function loadIndex() {
  if (fs.existsSync(PATHS.indexFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(PATHS.indexFile, 'utf8'));
      return new Map(data.map(c => [c.id, c]));
    } catch (e) {
      console.log('  Warning: Could not parse existing index, starting fresh');
    }
  }
  return new Map();
}

function saveIndex(indexMap) {
  const conversations = Array.from(indexMap.values());
  fs.writeFileSync(PATHS.indexFile, JSON.stringify(conversations, null, 2));
}

function loadProgress() {
  if (fs.existsSync(PATHS.progressFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(PATHS.progressFile, 'utf8'));
      // Ensure extended fields exist
      if (!data.projects) data.projects = {};
      if (!data.downloadedFileIds) data.downloadedFileIds = [];
      if (data.projectsIndexingComplete === undefined) data.projectsIndexingComplete = false;
      if (data.projectsLastCursor === undefined) data.projectsLastCursor = null;
      return data;
    } catch (e) {
      // Ignore
    }
  }
  return {
    indexingComplete: false,
    lastOffset: 0,
    downloadedIds: [],
    projectsIndexingComplete: false,
    projectsLastCursor: null,
    projects: {},
    downloadedFileIds: [],
  };
}

function saveProgress(progress) {
  fs.writeFileSync(PATHS.progressFile, JSON.stringify(progress, null, 2));
}

// ── Helper Functions ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

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

function sanitizeFilename(name) {
  if (!name) return 'untitled';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

function sanitizeProjectFolder(name) {
  if (!name) return 'untitled_project';
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .trim()
    .substring(0, 50);
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

// ── Conversation Fetching ─────────────────────────────────────────────

async function fetchConversation(accessToken, conversationId) {
  const url = `${CONFIG.apiBase}/conversation/${conversationId}`;
  const response = await fetchWithRetry(url, {
    headers: createApiHeaders(accessToken),
  });
  return response.json();
}

// ── Regular Conversation Indexing ─────────────────────────────────────

async function fetchConversationListIncremental(accessToken, existingIndex, progress) {
  console.log('Fetching conversation list...');

  if (progress.indexingComplete) {
    console.log(`  Index already complete (${existingIndex.size} conversations), skipping to downloads\n`);
    return existingIndex;
  }

  const startOffset = progress.lastOffset || 0;
  if (startOffset > 0) {
    console.log(`  Resuming from offset ${startOffset}...`);
  }

  let offset = startOffset;
  let hasMore = true;
  let newCount = 0;
  let pagesWithNoNew = 0;

  while (hasMore) {
    const url = `${CONFIG.apiBase}/conversations?offset=${offset}&limit=${CONFIG.conversationsPerPage}&order=updated`;

    try {
      const response = await fetchWithRetry(url, {
        headers: createApiHeaders(accessToken),
      });

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        let pageNewCount = 0;
        for (const conv of data.items) {
          if (!existingIndex.has(conv.id)) {
            existingIndex.set(conv.id, conv);
            newCount++;
            pageNewCount++;
          }
        }

        saveIndex(existingIndex);
        progress.lastOffset = offset + data.items.length;
        saveProgress(progress);

        console.log(`  Found ${existingIndex.size} conversations (${newCount} new)...`);
        offset += data.items.length;

        if (pageNewCount === 0) {
          pagesWithNoNew++;
          if (pagesWithNoNew >= 3) {
            console.log('  No new conversations found, index appears complete.');
            hasMore = false;
            break;
          }
        } else {
          pagesWithNoNew = 0;
        }

        hasMore = data.items.length === CONFIG.conversationsPerPage;

        if (hasMore) {
          await sleep(CONFIG.delayBetweenRequests);
        }
      } else {
        hasMore = false;
      }
    } catch (error) {
      if (error.authError) {
        console.log('\n  Token expired during indexing. Progress saved.');
        console.log(`   Run again with a fresh token to continue from offset ${offset}.\n`);
        throw error;
      }
      throw error;
    }
  }

  progress.indexingComplete = true;
  saveProgress(progress);

  console.log(`  Index complete: ${existingIndex.size} total conversations\n`);
  return existingIndex;
}

// ── Message Extraction ────────────────────────────────────────────────

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

// ── Content Extraction (Phase 5 & 6: Enhanced) ───────────────────────

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
          // Try to find extension from metadata
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
  // Try to guess extension from metadata
  if (assetPart.metadata) {
    if (assetPart.metadata.dalle) return '.png';
  }
  // Default to png for images
  return '.png';
}

// ── Tool Message Handling (Phase 5 & 6) ──────────────────────────────

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

// ── Markdown Conversion (Enhanced) ───────────────────────────────────

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

// ── File Download (Phase 4) ──────────────────────────────────────────

function extractFileReferences(conversationData) {
  const files = [];
  if (!conversationData.mapping) return files;

  for (const node of Object.values(conversationData.mapping)) {
    if (!node.message || !node.message.content) continue;
    const content = node.message.content;
    const conversationId = conversationData.id || conversationData.conversation_id;

    // Multimodal messages: images, canvas pointers, and other asset pointers
    if (content.content_type === 'multimodal_text' && content.parts) {
      for (const part of content.parts) {
        if (!part || !part.asset_pointer) continue;
        const fileId = part.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
        if (!fileId) continue;

        let type = 'attachment';
        if (part.content_type === 'image_asset_pointer') {
          type = 'image';
        } else if (part.content_type === 'canvas_asset_pointer' || part.content_type === 'canvas') {
          type = 'canvas';
        }

        files.push({ fileId, conversationId, type, metadata: part.metadata || {}, sizeBytes: part.size_bytes });
      }
    }

    // Standalone canvas content type
    if ((content.content_type === 'canvas' || content.content_type === 'canvas_asset_pointer') && content.asset_pointer) {
      const fileId = content.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
      if (fileId) {
        files.push({ fileId, conversationId, type: 'canvas', metadata: content.metadata || {}, sizeBytes: content.size_bytes });
      }
    }
  }

  return files;
}

async function getFileDownloadUrl(accessToken, fileId, conversationId) {
  const url = `${CONFIG.apiBase}/files/download/${fileId}?conversation_id=${conversationId}&inline=false`;
  const response = await fetchWithRetry(url, {
    headers: createApiHeaders(accessToken),
  });
  return response.json();
}

async function downloadFile(downloadUrl, outputPath, accessToken) {
  // Include auth headers — Teams download URLs require them (not pre-signed public CDN)
  const headers = accessToken ? createApiHeaders(accessToken) : {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(downloadUrl, { headers });
      if (!response.ok) {
        throw new Error(`File download failed: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      ensureDir(path.dirname(outputPath));
      fs.writeFileSync(outputPath, buffer);
      return buffer.length;
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(2000);
    }
  }
}

function getExtensionFromFilename(fileName) {
  if (!fileName) return '';
  const ext = path.extname(fileName);
  return ext || '';
}

async function downloadConversationFiles(accessToken, conversationData, filesDir, progress) {
  const allRefs = extractFileReferences(conversationData);
  const fileRefs = allRefs.filter(ref => {
    if (ref.type === 'image') return CONFIG.downloadImages;
    if (ref.type === 'canvas') return CONFIG.downloadCanvas;
    return CONFIG.downloadAttachments; // 'attachment' and any future types
  });
  if (fileRefs.length === 0) return 0;

  let downloadedCount = 0;

  for (const ref of fileRefs) {
    // Deduplicate
    if (progress.downloadedFileIds.includes(ref.fileId)) continue;

    try {
      verboseLog(`    Downloading ${ref.type}: ${ref.fileId}${ref.sizeBytes ? ` (${ref.sizeBytes} bytes)` : ''}`);
      const dlInfo = await getFileDownloadUrl(accessToken, ref.fileId, ref.conversationId);

      if (dlInfo.status !== 'success' || !dlInfo.download_url) {
        console.log(`    Warning: Could not get download URL for ${ref.fileId}`);
        verboseLog(`    Response: ${JSON.stringify(dlInfo)}`);
        continue;
      }

      const ext = getExtensionFromFilename(dlInfo.file_name) || guessFileExtension({ metadata: ref.metadata });
      const outputPath = path.join(filesDir, `${ref.fileId}${ext}`);

      verboseLog(`    Download URL: ${dlInfo.download_url}`);
      await downloadFile(dlInfo.download_url, outputPath, accessToken);

      progress.downloadedFileIds.push(ref.fileId);
      saveProgress(progress);
      downloadedCount++;

      await sleep(500); // Brief delay between file downloads
    } catch (error) {
      if (error.authError) throw error;
      console.log(`    Warning: Failed to download file ${ref.fileId}: ${error.message}`);
    }
  }

  return downloadedCount;
}

// ── Project Listing & Indexing (Phase 2) ─────────────────────────────

async function fetchProjectList(accessToken, progress) {
  console.log('Fetching project list...');

  if (progress.projectsIndexingComplete) {
    // Load existing project index
    if (fs.existsSync(PATHS.projectIndexFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
        console.log(`  Project index already complete (${data.length} projects)\n`);
        return data;
      } catch (e) {
        // Fall through to re-fetch
      }
    }
  }

  const projects = [];
  let cursor = progress.projectsLastCursor || null;

  if (cursor) {
    // Load existing partial index
    if (fs.existsSync(PATHS.projectIndexFile)) {
      try {
        const existing = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
        projects.push(...existing);
        console.log(`  Resuming from cursor (${projects.length} projects so far)...`);
      } catch (e) {
        // Start fresh
      }
    }
  }

  let hasMore = true;

  while (hasMore) {
    let url = `${CONFIG.apiBase}/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0`;
    if (cursor) {
      url += `&cursor=${encodeURIComponent(cursor)}`;
    }

    try {
      const response = await fetchWithRetry(url, {
        headers: createApiHeaders(accessToken),
      });

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        for (const item of data.items) {
          const g = item.gizmo?.gizmo || item.gizmo;
          if (!g || !g.id) continue;

          const project = {
            id: g.id,
            name: g.display?.name || 'Untitled Project',
            description: g.display?.description || '',
            instructions: g.instructions || '',
            workspace_id: g.workspace_id || null,
            created_at: g.created_at || null,
            updated_at: g.updated_at || null,
            num_interactions: g.num_interactions || 0,
            files: (item.gizmo?.files || []).map(f => ({
              id: f.id,
              file_id: f.file_id,
              name: f.name,
              type: f.type,
              size: f.size,
            })),
            conversation_count: 0, // Will be updated during conversation indexing
          };

          // Avoid duplicates
          if (!projects.find(p => p.id === project.id)) {
            projects.push(project);
          }
        }

        console.log(`  Found ${projects.length} projects...`);
      }

      cursor = data.cursor || null;
      progress.projectsLastCursor = cursor;

      // Save after each page
      ensureDir(PATHS.projectsDir);
      fs.writeFileSync(PATHS.projectIndexFile, JSON.stringify(projects, null, 2));
      saveProgress(progress);

      if (!cursor) {
        hasMore = false;
      } else {
        await sleep(CONFIG.delayBetweenRequests);
      }
    } catch (error) {
      if (error.authError) {
        console.log('\n  Token expired during project indexing. Progress saved.');
        throw error;
      }
      throw error;
    }
  }

  progress.projectsIndexingComplete = true;
  saveProgress(progress);

  console.log(`  Project index complete: ${projects.length} projects\n`);
  return projects;
}

// ── Project Conversation Listing (Phase 3) ───────────────────────────

async function fetchProjectConversations(accessToken, project, progress) {
  const projectId = project.id;

  // Initialize project progress if needed
  if (!progress.projects[projectId]) {
    progress.projects[projectId] = {
      name: project.name,
      indexingComplete: false,
      lastCursor: null,
      downloadedIds: [],
    };
    saveProgress(progress);
  }

  const projProgress = progress.projects[projectId];

  const folderName = sanitizeProjectFolder(project.name);
  const projectDir = path.join(PATHS.projectsDir, folderName);
  const projectConvIndexFile = path.join(projectDir, 'conversation-index.json');

  // Load existing conversation index for this project
  let conversations = [];
  if (fs.existsSync(projectConvIndexFile)) {
    try {
      conversations = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      // Start fresh
    }
  }

  if (projProgress.indexingComplete) {
    return conversations; // Already indexed, return loaded data
  }

  let cursor = projProgress.lastCursor || '0';
  let hasMore = true;

  while (hasMore) {
    const url = `${CONFIG.apiBase}/gizmos/${projectId}/conversations?cursor=${encodeURIComponent(cursor)}`;

    try {
      const response = await fetchWithRetry(url, {
        headers: createApiHeaders(accessToken),
      });

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        for (const conv of data.items) {
          if (!conversations.find(c => c.id === conv.id)) {
            conversations.push(conv);
          }
        }
      }

      cursor = data.cursor || null;
      projProgress.lastCursor = cursor;

      // Save after each page
      ensureDir(projectDir);
      fs.writeFileSync(projectConvIndexFile, JSON.stringify(conversations, null, 2));
      saveProgress(progress);

      if (!cursor) {
        hasMore = false;
      } else {
        await sleep(CONFIG.delayBetweenRequests);
      }
    } catch (error) {
      if (error.authError) {
        console.log(`\n  Token expired while indexing project "${project.name}". Progress saved.`);
        throw error;
      }
      throw error;
    }
  }

  projProgress.indexingComplete = true;

  // Update conversation count in project index
  project.conversation_count = conversations.length;
  if (fs.existsSync(PATHS.projectIndexFile)) {
    try {
      const projectIndex = JSON.parse(fs.readFileSync(PATHS.projectIndexFile, 'utf8'));
      const idx = projectIndex.findIndex(p => p.id === projectId);
      if (idx >= 0) {
        projectIndex[idx].conversation_count = conversations.length;
        fs.writeFileSync(PATHS.projectIndexFile, JSON.stringify(projectIndex, null, 2));
      }
    } catch (e) {
      // Ignore
    }
  }

  saveProgress(progress);
  return conversations;
}

// ── Project Conversation Export (Phase 3) ─────────────────────────────

async function exportProjectConversations(accessToken, project, progress) {
  const projectId = project.id;
  const projProgress = progress.projects[projectId];
  if (!projProgress) return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };

  const folderName = sanitizeProjectFolder(project.name);
  const projectDir = path.join(PATHS.projectsDir, folderName);
  const jsonDir = path.join(projectDir, 'json');
  const mdDir = path.join(projectDir, 'markdown');
  const filesDir = path.join(projectDir, 'files');
  const projectConvIndexFile = path.join(projectDir, 'conversation-index.json');

  // Load conversation index
  let conversations = [];
  if (fs.existsSync(projectConvIndexFile)) {
    try {
      conversations = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
    }
  }

  if (conversations.length === 0) {
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
  }

  // Ensure directories
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(mdDir);

  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const shortId = conv.id.substring(0, 8);

    // Check if already downloaded
    if (!CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id)) {
      skipCount++;
      continue;
    }

    const isUpdate = CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id);

    try {
      const action = isUpdate ? '  ~' : '  +';
      process.stdout.write(`${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      // Remove old files if updating
      if (isUpdate) {
        for (const dir of [jsonDir, mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      // Save JSON
      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      // Save Markdown
      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(mdDir, `${baseFilename}.md`), markdown);
      }

      // Download files if requested
      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, filesDir, progress);
        fileCount += fc;
      }

      // Mark as downloaded
      if (!projProgress.downloadedIds.includes(conv.id)) {
        projProgress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;

      if (i < conversations.length - 1) await sleep(CONFIG.delayBetweenRequests);

    } catch (error) {
      if (error.authError) {
        console.log(`\n  Token expired during project "${project.name}" export. Progress saved.`);
        throw error;
      }
      console.log(`error: ${error.message}`);
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
}

// ── Project-Level File Downloads (Phase 4) ───────────────────────────

async function downloadProjectFiles(accessToken, project, progress) {
  if (!project.files || project.files.length === 0) return 0;

  const folderName = sanitizeProjectFolder(project.name);
  const filesDir = path.join(PATHS.projectsDir, folderName, 'files');
  let count = 0;

  for (const file of project.files) {
    const fileId = file.file_id;
    if (!fileId || progress.downloadedFileIds.includes(fileId)) continue;

    try {
      // Project-level files may not have a conversation_id; try without it
      const url = `${CONFIG.apiBase}/files/download/${fileId}?inline=false`;
      const response = await fetchWithRetry(url, { headers: createApiHeaders(accessToken) });
      const dlInfo = await response.json();

      if (dlInfo.status !== 'success' || !dlInfo.download_url) continue;

      const ext = getExtensionFromFilename(dlInfo.file_name || file.name) || '';
      const outputPath = path.join(filesDir, `${fileId}${ext}`);

      verboseLog(`    Download URL: ${dlInfo.download_url}`);
      await downloadFile(dlInfo.download_url, outputPath, accessToken);
      progress.downloadedFileIds.push(fileId);
      saveProgress(progress);
      count++;

      await sleep(500);
    } catch (error) {
      if (error.authError) throw error;
      console.log(`    Warning: Failed to download project file ${file.name || fileId}: ${error.message}`);
    }
  }

  return count;
}

// ── Regular Conversation Export ───────────────────────────────────────

async function exportConversations(accessToken, progress) {
  // Ensure directories exist
  ensureDir(CONFIG.outputDir);
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(PATHS.jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(PATHS.mdDir);

  // Load existing state
  const existingIndex = loadIndex();

  if (existingIndex.size > 0) {
    console.log(`Found existing index with ${existingIndex.size} conversations`);
    console.log(`   Already downloaded: ${progress.downloadedIds.length}\n`);
  }

  // Fetch/update conversation list
  const conversationIndex = await fetchConversationListIncremental(accessToken, existingIndex, progress);

  if (conversationIndex.size === 0) {
    console.log('No conversations found.\n');
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
  }

  // Download conversations
  console.log('Downloading conversations...\n');

  const conversations = Array.from(conversationIndex.values());
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;
    const shortId = conv.id.substring(0, 8);

    // Check if already downloaded (unless --update flag is set)
    if (!CONFIG.updateExisting) {
      if (progress.downloadedIds.includes(conv.id)) {
        skipCount++;
        continue;
      }

      // Also check if files exist on disk
      if (fs.existsSync(PATHS.jsonDir)) {
        const existingFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId));
        if (existingFiles.length > 0) {
          progress.downloadedIds.push(conv.id);
          saveProgress(progress);
          skipCount++;
          continue;
        }
      }
    }

    const isUpdate = CONFIG.updateExisting && (
      progress.downloadedIds.includes(conv.id) ||
      (fs.existsSync(PATHS.jsonDir) && fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId)).length > 0)
    );

    try {
      const action = isUpdate ? '~' : '+';
      process.stdout.write(`${progress_display} ${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      // If updating, remove old files first
      if (isUpdate) {
        for (const dir of [PATHS.jsonDir, PATHS.mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      // Save JSON
      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      // Save Markdown
      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(PATHS.mdDir, `${baseFilename}.md`), markdown);
      }

      // Download files if requested
      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, PATHS.filesDir, progress);
        fileCount += fc;
      }

      // Mark as downloaded
      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;

      if (i < conversations.length - 1) await sleep(CONFIG.delayBetweenRequests);

    } catch (error) {
      if (error.authError) {
        console.log('\n\n  Token expired during download. Progress saved.');
        console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
        console.log('   Run again with a fresh token to continue.\n');
        throw error;
      }
      console.log(`error: ${error.message}`);
      verboseLog(`    Failed conversation ID: ${conv.id}`);
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
}

// ── Main Orchestration (Phase 7) ─────────────────────────────────────

async function run(accessToken) {
  const progress = loadProgress();

  console.log('Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`Teams Account ID: ${CONFIG.accountId}`);
  }
  if (CONFIG.updateExisting) {
    console.log('Update mode: Will re-download existing conversations');
  }
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`Project export: ${CONFIG.projectsOnly ? 'projects only' : 'included'}`);
  }
  if (CONFIG.downloadFiles) {
    console.log('File downloads: enabled');
  }
  if (CONFIG.verbose) {
    console.log('Verbose mode: on');
  }
  console.log('');

  const summary = {
    regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
    projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
  };

  try {
    // ── Regular conversation export ──
    if (!CONFIG.projectsOnly) {
      console.log('=== Regular Conversations ===\n');
      summary.regular = await exportConversations(accessToken, progress);
    }

    // ── Project export ──
    if (CONFIG.includeProjects || CONFIG.projectsOnly) {
      console.log('\n=== Project Conversations ===\n');

      const projects = await fetchProjectList(accessToken, progress);
      summary.projects.count = projects.length;

      for (const project of projects) {
        const folderName = sanitizeProjectFolder(project.name);
        console.log(`\nProject: "${project.name}" (${folderName}/)`);

        // Index project conversations
        const conversations = await fetchProjectConversations(accessToken, project, progress);
        if (!conversations || conversations.length === 0) {
          console.log('  No conversations.');
          continue;
        }
        console.log(`  ${conversations.length} conversations`);

        // Export project conversations
        const result = await exportProjectConversations(accessToken, project, progress);
        summary.projects.conversations += (result.success + result.skip + result.update + result.error);
        summary.projects.success += result.success;
        summary.projects.skip += result.skip;
        summary.projects.update += result.update;
        summary.projects.error += result.error;
        summary.projects.fileCount += result.fileCount;

        // Download project-level files
        if (CONFIG.downloadFiles && project.files && project.files.length > 0) {
          console.log(`  Downloading ${project.files.length} project-level files...`);
          const fc = await downloadProjectFiles(accessToken, project, progress);
          summary.projects.fileCount += fc;
        }
      }
    }
  } catch (error) {
    if (error.authError) {
      // Progress already saved
      printSummary(summary);
      process.exit(1);
    }
    throw error;
  }

  printSummary(summary);
}

function printSummary(summary) {
  console.log('\n' + '='.repeat(50));
  console.log('Export Complete!');
  console.log('='.repeat(50));

  if (!CONFIG.projectsOnly) {
    console.log('\nRegular Conversations:');
    console.log(`  + Downloaded (new): ${summary.regular.success}`);
    if (summary.regular.update > 0) console.log(`  ~ Updated: ${summary.regular.update}`);
    console.log(`  - Skipped: ${summary.regular.skip}`);
    if (summary.regular.error > 0) console.log(`  ! Errors: ${summary.regular.error}`);
    if (summary.regular.fileCount > 0) console.log(`  Files downloaded: ${summary.regular.fileCount}`);
  }

  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log('\nProjects:');
    console.log(`  Projects found: ${summary.projects.count}`);
    console.log(`  + Downloaded (new): ${summary.projects.success}`);
    if (summary.projects.update > 0) console.log(`  ~ Updated: ${summary.projects.update}`);
    console.log(`  - Skipped: ${summary.projects.skip}`);
    if (summary.projects.error > 0) console.log(`  ! Errors: ${summary.projects.error}`);
    if (summary.projects.fileCount > 0) console.log(`  Files downloaded: ${summary.projects.fileCount}`);
  }

  console.log(`\nOutput directory: ${path.resolve(CONFIG.outputDir)}`);
}

// ── Entry Point ──────────────────────────────────────────────────────

async function main() {
  let { opts, bearerToken, sessionToken } = setupCLI();

  // Apply Commander opts → CONFIG
  CONFIG.outputDir = opts.output;
  CONFIG.exportFormat = opts.format;
  CONFIG.delayBetweenRequests = parseInt(opts.delay, 10);
  CONFIG.updateExisting = !!opts.update;
  CONFIG.includeProjects = opts.projects !== false;
  CONFIG.projectsOnly = !!opts.projectsOnly;
  if (CONFIG.projectsOnly) CONFIG.includeProjects = true;
  const noFiles = opts.files === false;
  CONFIG.downloadImages = !noFiles && opts.images !== false;
  CONFIG.downloadCanvas = !noFiles && opts.canvas !== false;
  CONFIG.downloadAttachments = !noFiles && opts.attachments !== false;
  CONFIG.downloadFiles = CONFIG.downloadImages || CONFIG.downloadCanvas || CONFIG.downloadAttachments;
  if (opts.accountId) CONFIG.accountId = opts.accountId;
  CONFIG.verbose = !!opts.verbose;

  console.log('\n ChatGPT Conversation Exporter\n');
  console.log('='.repeat(50) + '\n');

  // Interactive prompt for bearer token if not provided
  if (!bearerToken && !sessionToken) {
    console.log('How to get your Bearer token:');
    console.log('  1. Open https://chatgpt.com with DevTools (F12) > Network tab');
    console.log('  2. Find any request to "backend-api/conversations"');
    console.log('  3. Copy "authorization: Bearer eyJ..." (just the eyJ... part)');
    console.log('');
    bearerToken = await prompt('Enter Bearer token: ');
    if (!bearerToken) {
      console.error('Error: No authentication token provided.');
      process.exit(1);
    }
  }

  // Auto-detect Teams account ID from JWT if not provided via flag
  if (!CONFIG.accountId && bearerToken) {
    const jwtAccountId = extractAccountIdFromJWT(bearerToken);
    if (jwtAccountId) {
      CONFIG.accountId = jwtAccountId;
    }
  }

  // Initialize paths after all config is final
  initPaths();

  let accessToken = bearerToken;

  if (!accessToken && sessionToken) {
    try {
      accessToken = await getAccessToken(sessionToken);
    } catch (error) {
      console.error('Failed to get access token from session:', error.message);
      process.exit(1);
    }
  }

  if (!accessToken) {
    console.error('Error: No authentication token provided.');
    process.exit(1);
  }

  console.log('');

  try {
    await run(accessToken);
  } catch (error) {
    if (error.authError) {
      process.exit(1);
    }
    console.error('\nExport failed:', error.message);
    process.exit(1);
  }
}

main();
