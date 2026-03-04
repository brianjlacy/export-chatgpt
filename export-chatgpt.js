#!/usr/bin/env node

/**
 * ChatGPT Conversation Exporter (Resumable)
 *
 * Bulk exports all your ChatGPT conversations using the backend API.
 * Supports resuming interrupted exports - just run again with a fresh token.
 *
 * Usage:
 *   node export-chatgpt.js --bearer "eyJ..." --account-id "f3ae362d-..."
 *
 * The script will:
 *   - Skip conversations already in the index
 *   - Skip conversations already downloaded
 *   - Resume from where it left off
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

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

async function promptSelect(question, options, defaultOption) {
  console.log(question);
  for (let i = 0; i < options.length; i++) {
    const marker = options[i] === defaultOption ? ' (default)' : '';
    console.log(`  ${i + 1}) ${options[i]}${marker}`);
  }
  const answer = await prompt(`Choose [1-${options.length}]: `);
  if (!answer) return defaultOption;
  const idx = parseInt(answer, 10) - 1;
  if (idx >= 0 && idx < options.length) return options[idx];
  return defaultOption;
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
  updateExisting: false, // Re-download conversations even if they exist
};

// File paths (set after outputDir is finalized)
let PATHS = {};

function initPaths() {
  PATHS = {
    indexFile: path.join(CONFIG.outputDir, 'conversation-index.json'),
    progressFile: path.join(CONFIG.outputDir, '.export-progress.json'),
    jsonDir: path.join(CONFIG.outputDir, 'json'),
    mdDir: path.join(CONFIG.outputDir, 'markdown'),
  };
}

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let bearerToken = process.env.CHATGPT_BEARER_TOKEN;
  let sessionToken = process.env.CHATGPT_SESSION_TOKEN;
  const explicit = { output: false, update: false, format: false };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--bearer' && args[i + 1]) {
      bearerToken = args[i + 1];
      i++;
    } else if (args[i] === '--token' && args[i + 1]) {
      sessionToken = args[i + 1];
      i++;
    } else if (args[i] === '--account-id' && args[i + 1]) {
      CONFIG.accountId = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      CONFIG.outputDir = args[i + 1];
      explicit.output = true;
      i++;
    } else if (args[i] === '--format' && args[i + 1]) {
      CONFIG.exportFormat = args[i + 1];
      explicit.format = true;
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      CONFIG.delayBetweenRequests = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--update') {
      explicit.update = true;
      // Check if next arg is a value (not another flag)
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        const val = next.toLowerCase();
        if (['yes', 'true'].includes(val)) {
          CONFIG.updateExisting = true;
        } else if (['no', 'false'].includes(val)) {
          CONFIG.updateExisting = false;
        }
        i++;
      } else {
        CONFIG.updateExisting = true;
      }
    } else if (args[i] === '--help') {
      printHelp();
      process.exit(0);
    }
  }

  return { bearerToken, sessionToken, explicit };
}

function printHelp() {
  console.log(`
ChatGPT Conversation Exporter (Resumable)

Usage: node export-chatgpt.js [options]

Options:
  --bearer <token>      Bearer/Access token (recommended for Teams)
  --account-id <id>     ChatGPT Account ID (required for Teams)
  --token <token>       Session token (alternative auth method)
  --output <dir>        Output directory (default: ./exports)
  --format <format>     Export format: json, markdown, or both (default: both)
  --delay <ms>          Delay between requests in ms (default: 1500)
  --update <yes|no>     Re-download existing conversations (yes/true/no/false)
  --help                Show this help message

Interactive:
  If --bearer, --account-id, --update, or --format are not provided,
  you will be prompted interactively. If --output is not specified,
  you will be asked to confirm the default output directory.

Resumable:
  If interrupted, just run again with a fresh Bearer token.
  The script will skip already-downloaded conversations.

How to get your Bearer token (for Teams):
  1. Open https://chatgpt.com with DevTools (F12) → Network tab
  2. Find a request to "backend-api/conversations"
  3. Copy "authorization: Bearer eyJ..." (just the eyJ... part)
  4. Copy "chatgpt-account-id" header value

Example:
  node export-chatgpt.js --bearer "eyJhbG..." --account-id "f3ae362d-0323-..."

  # Re-download all conversations (update existing):
  node export-chatgpt.js --bearer "eyJ..." --account-id "..." --update yes
`);
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

// Fetch with error handling
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);

      if (response.status === 401 || response.status === 403) {
        const error = new Error(`Authentication failed (${response.status}). Your Bearer token may be expired.`);
        error.authError = true;
        throw error;
      }

      if (response.status === 429) {
        const waitTime = (i + 1) * 5000;
        console.log(`  Rate limited. Waiting ${waitTime/1000}s before retry...`);
        await sleep(waitTime);
        continue;
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return response;
    } catch (error) {
      if (error.authError) throw error;
      if (i === retries - 1) throw error;
      console.log(`  Request failed, retrying (${i + 1}/${retries})...`);
      await sleep(2000);
    }
  }
}

// Get access token from session (fallback method)
async function getAccessToken(sessionToken) {
  console.log('🔑 Getting access token from session...');

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

// Load existing index or create empty one
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

// Save index to disk
function saveIndex(indexMap) {
  const conversations = Array.from(indexMap.values());
  fs.writeFileSync(PATHS.indexFile, JSON.stringify(conversations, null, 2));
}

// Load progress or create default
function loadProgress() {
  if (fs.existsSync(PATHS.progressFile)) {
    try {
      return JSON.parse(fs.readFileSync(PATHS.progressFile, 'utf8'));
    } catch (e) {
      // Ignore
    }
  }
  return {
    indexingComplete: false,
    lastOffset: 0,
    downloadedIds: [],
  };
}

// Save progress
function saveProgress(progress) {
  fs.writeFileSync(PATHS.progressFile, JSON.stringify(progress, null, 2));
}

// Check if conversation is already downloaded
function isDownloaded(convId, progress) {
  if (progress.downloadedIds.includes(convId)) return true;

  // Also check if files exist
  const jsonPath = path.join(PATHS.jsonDir, `*_${convId.substring(0, 8)}.json`);
  const files = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(convId.substring(0, 8)));
  return files.length > 0;
}

// Fetch conversation list incrementally
async function fetchConversationListIncremental(accessToken, existingIndex, progress) {
  console.log('📋 Fetching conversation list...');

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
        // Add new conversations to index
        let pageNewCount = 0;
        for (const conv of data.items) {
          if (!existingIndex.has(conv.id)) {
            existingIndex.set(conv.id, conv);
            newCount++;
            pageNewCount++;
          }
        }

        // Save index and progress after each page
        saveIndex(existingIndex);
        progress.lastOffset = offset + data.items.length;
        saveProgress(progress);

        console.log(`  Found ${existingIndex.size} conversations (${newCount} new)...`);
        offset += data.items.length;

        // Track pages with no new conversations to detect when we've seen everything
        if (pageNewCount === 0) {
          pagesWithNoNew++;
          // If we've gone 3 pages with no new conversations, we're probably done
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
        console.log('\n⚠️  Token expired during indexing. Progress saved.');
        console.log(`   Run again with a fresh token to continue from offset ${offset}.\n`);
        throw error;
      }
      throw error;
    }
  }

  // Mark indexing complete
  progress.indexingComplete = true;
  saveProgress(progress);

  console.log(`✓ Index complete: ${existingIndex.size} total conversations\n`);
  return existingIndex;
}

// Fetch full conversation content
async function fetchConversation(accessToken, conversationId) {
  const url = `${CONFIG.apiBase}/conversation/${conversationId}`;

  const response = await fetchWithRetry(url, {
    headers: createApiHeaders(accessToken),
  });

  return response.json();
}

// Convert conversation to Markdown
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
  lines.push('---');
  lines.push('');
  lines.push(`# ${conversation.title || 'Untitled'}`);
  lines.push('');

  const messages = extractMessagesInOrder(conversation);

  for (const msg of messages) {
    const role = msg.author?.role || 'unknown';
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

// Extract messages in chronological order
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

// Extract text content from a message
function extractMessageContent(message) {
  if (!message.content) return '';

  const content = message.content;

  if (content.content_type === 'text' && content.parts) {
    return content.parts.filter(p => typeof p === 'string').join('\n');
  }

  if (content.content_type === 'code' && content.text) {
    return '```\n' + content.text + '\n```';
  }

  if (typeof content === 'string') {
    return content;
  }

  return '';
}

// Helper functions
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

// Main export function
async function exportConversations(accessToken) {
  // Ensure directories exist
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
    if (!fs.existsSync(PATHS.jsonDir)) fs.mkdirSync(PATHS.jsonDir, { recursive: true });
  }
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
    if (!fs.existsSync(PATHS.mdDir)) fs.mkdirSync(PATHS.mdDir, { recursive: true });
  }

  console.log('🔑 Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`📋 Teams Account ID: ${CONFIG.accountId}`);
  }
  if (CONFIG.updateExisting) {
    console.log('🔄 Update mode: Will re-download existing conversations');
  }
  console.log('');

  // Load existing state
  const existingIndex = loadIndex();
  const progress = loadProgress();

  if (existingIndex.size > 0) {
    console.log(`📂 Found existing index with ${existingIndex.size} conversations`);
    console.log(`   Already downloaded: ${progress.downloadedIds.length}`);
    console.log('');
  }

  // Fetch/update conversation list
  const conversationIndex = await fetchConversationListIncremental(accessToken, existingIndex, progress);

  if (conversationIndex.size === 0) {
    console.log('No conversations found.');
    return;
  }

  // Download conversations
  console.log('📥 Downloading conversations...\n');

  const conversations = Array.from(conversationIndex.values());
  let successCount = 0;
  let skipCount = 0;
  let updateCount = 0;
  let errorCount = 0;

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
      const existingFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId));
      if (existingFiles.length > 0) {
        progress.downloadedIds.push(conv.id);
        saveProgress(progress);
        skipCount++;
        continue;
      }
    }

    // Check if this is an update (file exists but we're re-downloading)
    const isUpdate = CONFIG.updateExisting && (
      progress.downloadedIds.includes(conv.id) ||
      fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId)).length > 0
    );

    try {
      const action = isUpdate ? '↻' : '→';
      process.stdout.write(`${progress_display} ${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      // If updating, remove old files with this shortId first
      if (isUpdate) {
        const oldJsonFiles = fs.readdirSync(PATHS.jsonDir).filter(f => f.includes(shortId));
        for (const f of oldJsonFiles) {
          fs.unlinkSync(path.join(PATHS.jsonDir, f));
        }
        if (fs.existsSync(PATHS.mdDir)) {
          const oldMdFiles = fs.readdirSync(PATHS.mdDir).filter(f => f.includes(shortId));
          for (const f of oldMdFiles) {
            fs.unlinkSync(path.join(PATHS.mdDir, f));
          }
        }
      }

      // Save JSON
      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        const jsonPath = path.join(PATHS.jsonDir, `${baseFilename}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(fullConversation, null, 2));
      }

      // Save Markdown
      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        const mdPath = path.join(PATHS.mdDir, `${baseFilename}.md`);
        fs.writeFileSync(mdPath, markdown);
      }

      // Mark as downloaded
      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('✓');
      if (isUpdate) {
        updateCount++;
      } else {
        successCount++;
      }

      // Delay between requests
      if (i < conversations.length - 1) {
        await sleep(CONFIG.delayBetweenRequests);
      }

    } catch (error) {
      if (error.authError) {
        console.log('\n\n⚠️  Token expired during download. Progress saved.');
        console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
        console.log('   Run again with a fresh token to continue.\n');
        throw error;
      }
      console.log(`✗ Error: ${error.message}`);
      errorCount++;
    }
  }

  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('Export Complete!');
  console.log('='.repeat(50));
  console.log(`✓ Downloaded (new): ${successCount}`);
  if (updateCount > 0) {
    console.log(`↻ Updated: ${updateCount}`);
  }
  console.log(`⏭ Skipped (already done): ${skipCount}`);
  if (errorCount > 0) {
    console.log(`✗ Errors: ${errorCount}`);
  }
  console.log(`📁 Total exported: ${progress.downloadedIds.length}/${conversationIndex.size}`);
  console.log(``);
  console.log(`📁 Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

// Entry point
async function main() {
  console.log('\n🤖 ChatGPT Conversation Exporter (Resumable)\n');
  console.log('='.repeat(50) + '\n');

  let { bearerToken, sessionToken, explicit } = parseArgs();

  // Interactive prompt for bearer token if not provided
  if (!bearerToken && !sessionToken) {
    bearerToken = await prompt('Enter Bearer token: ');
    if (!bearerToken) {
      console.error('Error: No authentication token provided.');
      process.exit(1);
    }
  }

  // Interactive prompt for account ID if not provided
  if (!CONFIG.accountId) {
    const accountId = await prompt('Enter Account ID (leave blank to skip): ');
    if (accountId) {
      CONFIG.accountId = accountId;
    }
  }

  // Confirm output directory if not explicitly specified
  if (!explicit.output) {
    const resolvedDir = path.resolve(CONFIG.outputDir);
    const answer = await prompt(`Output directory: ${resolvedDir}\nContinue? (Y/n): `);
    if (answer && answer.toLowerCase() === 'n') {
      console.log('Aborted.');
      process.exit(0);
    }
  }

  // Interactive selection for --update if not specified
  if (!explicit.update) {
    const updateChoice = await promptSelect('Re-download existing conversations?', ['yes', 'no'], 'yes');
    CONFIG.updateExisting = updateChoice === 'yes';
  }

  // Interactive selection for --format if not specified
  if (!explicit.format) {
    CONFIG.exportFormat = await promptSelect('Export format?', ['both', 'json', 'markdown'], 'both');
  }

  // Initialize paths after parsing args (in case --output was used)
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

  try {
    await exportConversations(accessToken);
  } catch (error) {
    if (error.authError) {
      process.exit(1); // Already logged above
    }
    console.error('\n❌ Export failed:', error.message);
    process.exit(1);
  }
}

main();