'use strict';

const readline = require('readline');
const { Command } = require('commander');
const { CONFIG, initPaths } = require('./config');
const { extractAccountIdFromJWT, getAccessToken } = require('./auth');
const { run } = require('./exporter');

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function setupCLI() {
  const pkg = require('../package.json');
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
  1. Open https://chatgpt.com with DevTools (F12) > Network tab.
  2. Filter for "backend-api/conversations" -- you may need to refresh the page!
  3. Click on one of the Url entries, go to the "Headers" section, and find the "Authorization" header under "Request Headers".
  4. Copy the Bearer token from the "Authorization" header (just the part AFTER 'Bearer' -- the long string of characters starting with 'eyJ...').
  5. If you're a Teams/Business user, you will need your Account Id as well; however, by default the script will attempt to extract it from your. If that fails you can also copy it from the "Chatgpt-Account-Id" Header and provide it with the --account-id option.

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
  export-chatgpt --bearer "eyJ..." --account-id "cc47585e-..."
`);

  program.parse();
  const opts = program.opts();

  const bearerToken = opts.bearer || process.env.CHATGPT_BEARER_TOKEN || null;
  const sessionToken = opts.token || process.env.CHATGPT_SESSION_TOKEN || null;

  return { opts, bearerToken, sessionToken };
}

async function main() {
  let { opts, bearerToken, sessionToken } = setupCLI();

  // Apply Commander opts → CONFIG
  CONFIG.outputDir = opts.output;
  CONFIG.exportFormat = opts.format;
  // Security fix S3: validate --delay to prevent NaN → 0ms (API hammer)
  CONFIG.delayBetweenRequests = parseInt(opts.delay, 10);
  if (isNaN(CONFIG.delayBetweenRequests) || CONFIG.delayBetweenRequests < 0) {
    console.warn(`Warning: Invalid --delay value "${opts.delay}", using default 1500ms`);
    CONFIG.delayBetweenRequests = 1500;
  }
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

module.exports = { main };
