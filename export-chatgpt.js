#!/usr/bin/env node

/**
 * ChatGPT Conversation Exporter
 * 
 * Bulk exports all your ChatGPT conversations using the backend API.
 * Works with ChatGPT Teams accounts by using the Bearer token from DevTools.
 * 
 * Usage:
 *   1. Get your Bearer token from browser:
 *      - Open https://chatgpt.com
 *      - DevTools (F12) → Network tab
 *      - Look for any request to "backend-api/conversations"
 *      - Right-click → Copy as cURL
 *      - Find the "Authorization: Bearer eyJ..." header and copy the token part
 *   
 *   2. Run with the token:
 *      node export-chatgpt.js --bearer "eyJ..."
 *      
 *      For Teams accounts, also include your account ID:
 *      node export-chatgpt.js --bearer "eyJ..." --account-id "f3ae362d-..."
 * 
 *   3. Conversations will be saved to ./exports/
 */

const fs = require('fs');
const path = require('path');

// Configuration
const CONFIG = {
  baseUrl: 'https://chatgpt.com',
  apiBase: 'https://chatgpt.com/backend-api',
  outputDir: './exports',
  delayBetweenRequests: 1500, // ms - be nice to their servers
  conversationsPerPage: 28,
  exportFormat: 'both', // 'json', 'markdown', or 'both'
  accountId: null, // For Teams accounts
};

// Parse command line arguments
function parseArgs() {
  const args = process.argv.slice(2);
  let bearerToken = process.env.CHATGPT_BEARER_TOKEN;
  let sessionToken = process.env.CHATGPT_SESSION_TOKEN;
  
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
      i++;
    } else if (args[i] === '--format' && args[i + 1]) {
      CONFIG.exportFormat = args[i + 1];
      i++;
    } else if (args[i] === '--delay' && args[i + 1]) {
      CONFIG.delayBetweenRequests = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--help') {
      printHelp();
      process.exit(0);
    }
  }
  
  return { bearerToken, sessionToken };
}

function printHelp() {
  console.log(`
ChatGPT Conversation Exporter

Usage: node export-chatgpt.js [options]

Options:
  --bearer <token>      Bearer/Access token (recommended for Teams)
  --account-id <id>     ChatGPT Account ID (required for Teams)
  --token <token>       Session token (alternative auth method)
  --output <dir>        Output directory (default: ./exports)
  --format <format>     Export format: json, markdown, or both (default: both)
  --delay <ms>          Delay between requests in ms (default: 1500)
  --help                Show this help message

How to get your Bearer token (for Teams):
  1. Open https://chatgpt.com in your browser
  2. Open DevTools (F12) → Network tab
  3. Refresh the page or click on a conversation
  4. Find a request to "backend-api/conversations"
  5. Look in Request Headers for "authorization: Bearer eyJ..."
  6. Copy the token (starts with "eyJ")
  7. Also copy "chatgpt-account-id" header value for Teams accounts

Example:
  node export-chatgpt.js --bearer "eyJhbG..." --account-id "f3ae362d-0323-..."
`);
}

// Create headers for API requests
function createHeaders(sessionToken) {
  return {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Cookie': `__Secure-next-auth.session-token=${sessionToken}`,
    'Origin': CONFIG.baseUrl,
    'Referer': CONFIG.baseUrl,
  };
}

// Fetch with error handling
async function fetchWithRetry(url, options, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      
      if (response.status === 401 || response.status === 403) {
        throw new Error(`Authentication failed (${response.status}). Your session token may be expired or invalid.`);
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
      if (i === retries - 1) throw error;
      console.log(`  Request failed, retrying (${i + 1}/${retries})...`);
      await sleep(2000);
    }
  }
}

// Get access token from session
async function getAccessToken(sessionToken) {
  console.log('🔑 Getting access token...');
  
  const response = await fetchWithRetry(
    `${CONFIG.baseUrl}/api/auth/session`,
    { headers: createHeaders(sessionToken) }
  );
  
  const data = await response.json();
  
  if (!data.accessToken) {
    throw new Error('Could not get access token. Session token may be invalid.');
  }
  
  console.log('✓ Access token obtained\n');
  return data.accessToken;
}

// Create headers with Bearer token for API calls
function createApiHeaders(accessToken) {
  const headers = {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
  };
  
  // Add account ID header for Teams
  if (CONFIG.accountId) {
    headers['chatgpt-account-id'] = CONFIG.accountId;
  }
  
  return headers;
}

// Fetch all conversation metadata
async function fetchConversationList(accessToken) {
  console.log('📋 Fetching conversation list...');
  
  const conversations = [];
  let offset = 0;
  let hasMore = true;
  
  while (hasMore) {
    const url = `${CONFIG.apiBase}/conversations?offset=${offset}&limit=${CONFIG.conversationsPerPage}&order=updated`;
    
    const response = await fetchWithRetry(url, {
      headers: createApiHeaders(accessToken),
    });
    
    const data = await response.json();
    
    if (data.items && data.items.length > 0) {
      conversations.push(...data.items);
      console.log(`  Found ${conversations.length} conversations so far...`);
      offset += data.items.length;
      
      // Check if there are more
      hasMore = data.items.length === CONFIG.conversationsPerPage;
      
      if (hasMore) {
        await sleep(CONFIG.delayBetweenRequests);
      }
    } else {
      hasMore = false;
    }
  }
  
  console.log(`✓ Found ${conversations.length} total conversations\n`);
  return conversations;
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
  
  // Header
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
  
  // Extract messages in order
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

// Extract messages in chronological order from the mapping structure
function extractMessagesInOrder(conversation) {
  if (!conversation.mapping) return [];
  
  const messages = [];
  const mapping = conversation.mapping;
  
  // Find the root node (has no parent)
  let rootId = null;
  for (const [id, node] of Object.entries(mapping)) {
    if (!node.parent) {
      rootId = id;
      break;
    }
  }
  
  if (!rootId) return [];
  
  // Traverse the tree following children
  function traverse(nodeId) {
    const node = mapping[nodeId];
    if (!node) return;
    
    if (node.message && node.message.content) {
      messages.push(node.message);
    }
    
    // Follow children (take the first/main branch)
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
  const date = new Date(timestamp * 1000);
  return date.toISOString();
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

// Main export function
async function exportConversations(accessToken) {
  // Ensure output directory exists
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  // Create subdirectories
  const jsonDir = path.join(CONFIG.outputDir, 'json');
  const mdDir = path.join(CONFIG.outputDir, 'markdown');
  
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
    if (!fs.existsSync(jsonDir)) fs.mkdirSync(jsonDir, { recursive: true });
  }
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
    if (!fs.existsSync(mdDir)) fs.mkdirSync(mdDir, { recursive: true });
  }
  
  console.log('🔑 Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`📋 Teams Account ID: ${CONFIG.accountId}`);
  }
  console.log('');
  
  // Fetch conversation list
  const conversationList = await fetchConversationList(accessToken);
  
  if (conversationList.length === 0) {
    console.log('No conversations found. This could mean:');
    console.log('  - Your account has no conversations');
    console.log('  - Teams workspace conversations are not accessible via API');
    console.log('  - Your session token is for a different workspace');
    return;
  }
  
  // Save conversation index
  const indexPath = path.join(CONFIG.outputDir, 'conversation-index.json');
  fs.writeFileSync(indexPath, JSON.stringify(conversationList, null, 2));
  console.log(`📁 Saved conversation index to ${indexPath}\n`);
  
  // Export each conversation
  console.log('📥 Downloading conversations...\n');
  
  let successCount = 0;
  let errorCount = 0;
  
  for (let i = 0; i < conversationList.length; i++) {
    const conv = conversationList[i];
    const progress = `[${i + 1}/${conversationList.length}]`;
    
    try {
      process.stdout.write(`${progress} "${conv.title || 'Untitled'}"... `);
      
      const fullConversation = await fetchConversation(accessToken, conv.id);
      
      const filename = sanitizeFilename(conv.title || conv.id);
      let datePrefix = 'unknown';
      try {
        if (conv.create_time) {
          const date = new Date(conv.create_time * 1000);
          if (!isNaN(date.getTime())) {
            datePrefix = date.toISOString().split('T')[0];
          }
        }
      } catch (e) {
        datePrefix = 'unknown';
      }
      const baseFilename = `${datePrefix}_${filename}_${conv.id.substring(0, 8)}`;
      
      // Save JSON
      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        const jsonPath = path.join(jsonDir, `${baseFilename}.json`);
        fs.writeFileSync(jsonPath, JSON.stringify(fullConversation, null, 2));
      }
      
      // Save Markdown
      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        const mdPath = path.join(mdDir, `${baseFilename}.md`);
        fs.writeFileSync(mdPath, markdown);
      }
      
      console.log('✓');
      successCount++;
      
      // Delay between requests
      if (i < conversationList.length - 1) {
        await sleep(CONFIG.delayBetweenRequests);
      }
      
    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
      errorCount++;
    }
  }
  
  // Summary
  console.log('\n' + '='.repeat(50));
  console.log('Export Complete!');
  console.log('='.repeat(50));
  console.log(`✓ Successfully exported: ${successCount}`);
  if (errorCount > 0) {
    console.log(`✗ Errors: ${errorCount}`);
  }
  console.log(`📁 Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

// Entry point
async function main() {
  console.log('\n🤖 ChatGPT Conversation Exporter\n');
  console.log('='.repeat(50) + '\n');
  
  const { bearerToken, sessionToken } = parseArgs();
  
  let accessToken = bearerToken;
  
  // If no bearer token, try to get one from session token
  if (!accessToken && sessionToken) {
    try {
      accessToken = await getAccessToken(sessionToken);
    } catch (error) {
      console.error('Failed to get access token from session:', error.message);
      process.exit(1);
    }
  }
  
  if (!accessToken) {
    console.error('Error: No authentication token provided.\n');
    console.error('For ChatGPT Teams, provide your Bearer token:');
    console.error('  node export-chatgpt.js --bearer "eyJ..." --account-id "your-account-id"');
    console.error('\nHow to get these values:');
    console.error('  1. Open https://chatgpt.com with DevTools Network tab open');
    console.error('  2. Find a request to "backend-api/conversations"');
    console.error('  3. Copy the "authorization: Bearer eyJ..." value (just the eyJ... part)');
    console.error('  4. Copy the "chatgpt-account-id" header value');
    console.error('\nRun with --help for more information.');
    process.exit(1);
  }
  
  try {
    await exportConversations(accessToken);
  } catch (error) {
    console.error('\n❌ Export failed:', error.message);
    
    if (error.message.includes('Authentication') || error.message.includes('401') || error.message.includes('403')) {
      console.error('\nTroubleshooting:');
      console.error('  1. Bearer tokens expire quickly - get a fresh one from DevTools');
      console.error('  2. Make sure you copied the entire token (starts with "eyJ")');
      console.error('  3. For Teams accounts, make sure to include --account-id');
    }
    
    process.exit(1);
  }
}

main();
