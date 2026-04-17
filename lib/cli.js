'use strict';

const path = require('path');
const readline = require('readline');
const { Command } = require('commander');
const { CONFIG, initPaths } = require('./config');
const { extractUserIdFromJWT, extractAccountIdFromJWT, getAccessToken } = require('./auth');
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
    .option('--throttle <seconds>', 'Minimum time between requests in seconds — ChatGPT rate-limits excessive requests, so a higher value reduces errors (default: 60)', '60')
    .option('--no-adaptive-throttle', 'Disable adaptive throttle. By default, throttle auto-adjusts upward on 429 responses and gently back down after sustained success, clamped to [--min-throttle, --max-throttle].')
    .option('--min-throttle <seconds>', 'Floor for adaptive throttle (default: 5). Ignored if --no-adaptive-throttle.', '5')
    .option('--max-throttle <seconds>', 'Ceiling for adaptive throttle (default: 300). Ignored if --no-adaptive-throttle.', '300')
    .option('--update', 'Re-download existing conversations', false)
    .option('--no-projects', 'Skip project conversations')
    .option('--projects-only', 'Export only project conversations (skip regular)')
    .option('--no-images', 'Skip downloading images')
    .option('--no-canvas', 'Skip downloading canvas documents')
    .option('--no-attachments', 'Skip downloading other file attachments')
    .option('--no-files', 'Skip ALL file downloads (overrides --no-images / --no-canvas / --no-attachments)')
    .option('--no-user-dir', 'Do not nest exports inside a user ID subdirectory')
    .option('--max <n>', 'Only download the next N conversations this session (can also use -N, e.g. -7)')
    .option('--conv <ids>', 'Only download specific conversation ID(s), comma-separated')
    .option('--proj <ids>', 'Only download specific project ID(s), comma-separated')
    .option('--verbose', 'Show detailed request/response info and full error messages')
    .option('-n, --non-interactive', 'Run without any interactive prompts (requires --bearer or --token)')
    .option('--no-summary', 'Suppress the export summary at the end')
    .option('--no-donate', 'Suppress the donation message/prompt')
    .addHelpText('after', `
Important:
  If you have multiple ChatGPT accounts, make sure you're only logged into the
  one you want to export. Being logged into more than one account at the same
  time can cause ChatGPT to return data from the wrong account.

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

  # Non-interactive (for scripts/CI):
  export-chatgpt --bearer "eyJ..." --non-interactive
`);

  // Pre-process argv: convert -N shorthand (e.g. -7) to --max 7
  const argv = process.argv.slice(2).flatMap(arg => {
    const m = arg.match(/^-(\d+)$/);
    return m ? ['--max', m[1]] : [arg];
  });
  program.parse(['node', 'script', ...argv]);
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
  const validFormats = ['json', 'markdown', 'both'];
  if (!validFormats.includes(CONFIG.exportFormat)) {
    console.error(`Error: --format must be one of: ${validFormats.join(', ')}`);
    process.exit(1);
  }
  const throttleSec = parseFloat(opts.throttle);
  if (isNaN(throttleSec) || throttleSec < 0) {
    console.warn(`Warning: Invalid --throttle value "${opts.throttle}", using default 60s`);
    CONFIG.throttleMs = 60000;
  } else {
    CONFIG.throttleMs = Math.round(throttleSec * 1000);
  }
  CONFIG.adaptiveThrottle = opts.adaptiveThrottle !== false;
  const minThrottleSec = parseFloat(opts.minThrottle);
  if (!isNaN(minThrottleSec) && minThrottleSec >= 0) {
    CONFIG.minThrottleMs = Math.round(minThrottleSec * 1000);
  }
  const maxThrottleSec = parseFloat(opts.maxThrottle);
  if (!isNaN(maxThrottleSec) && maxThrottleSec * 1000 >= CONFIG.minThrottleMs) {
    CONFIG.maxThrottleMs = Math.round(maxThrottleSec * 1000);
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
  CONFIG.nonInteractive = !!opts.nonInteractive;
  CONFIG.showSummary = opts.summary !== false;
  CONFIG.showDonate = opts.donate !== false && !CONFIG.nonInteractive;
  if (opts.max !== undefined) {
    const n = parseInt(opts.max, 10);
    if (isNaN(n) || n < 1) {
      console.warn(`Warning: Invalid --max value "${opts.max}", ignoring`);
    } else {
      CONFIG.maxConversations = n;
    }
  }
  if (opts.conv) {
    CONFIG.convFilter = new Set(opts.conv.split(',').map(s => s.trim()).filter(Boolean));
  }
  if (opts.proj) {
    CONFIG.projFilter = new Set(opts.proj.split(',').map(s => s.trim()).filter(Boolean));
  }

  console.log('\n ChatGPT Conversation Exporter\n');
  console.log('='.repeat(50) + '\n');

  if (!CONFIG.nonInteractive) {
    console.log('Note: If you have multiple ChatGPT accounts, make sure you\'re only');
    console.log('logged into the one you want to export — being logged into more than');
    console.log('one at the same time can cause ChatGPT to return the wrong data.\n');
  }

  // Non-interactive mode requires an explicit auth token
  if (CONFIG.nonInteractive && !bearerToken && !sessionToken) {
    console.error('Error: --non-interactive requires --bearer or --token (or their env vars).');
    process.exit(1);
  }

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

  // Nest exports under user ID subdirectory unless suppressed with --no-user-dir
  if (opts.userDir !== false) {
    const userId = extractUserIdFromJWT(accessToken);
    if (userId) {
      const safeUserId = userId.replace(/[<>:"/\\|?*]/g, '-');
      CONFIG.outputDir = path.join(CONFIG.outputDir, safeUserId);
    }
  }

  // Initialize paths after outputDir is fully finalized
  initPaths();

  console.log('');

  try {
    await run(accessToken);
    if (CONFIG.showDonate) await showDonationPrompt();
  } catch (error) {
    if (error.authError) {
      process.exit(1);
    }
    console.error('\nExport failed:', error.message);
    process.exit(1);
  }
}

function openUrl(url) {
  const { execFile } = require('child_process');
  const platform = process.platform;
  if (platform === 'darwin') execFile('open', [url], () => {});
  else if (platform === 'win32') execFile('cmd', ['/c', 'start', '', url], () => {});
  else execFile('xdg-open', [url], () => {});
}

async function showDonationPrompt() {
  if (!process.stdin.isTTY) return;

  const url = 'https://buymeacoffee.com/qwanderer';

  console.log('');
  console.log('  ' + '-'.repeat(46));
  console.log('  Your export is done -- your data now belongs');
  console.log('  to you again! I hope this was as helpful for');
  console.log('  you as it was for me. If it was, I\'d be super');
  console.log('  grateful if you wanted to support my work by');
  console.log('  buying me a coke!');
  console.log('');
  console.log(`  ${url}`);
  console.log('  ' + '-'.repeat(46));
  console.log('');

  const answer = await prompt('  Buy me a coke now? [y/N] ');

  if (answer.toLowerCase() === 'y') {
    openUrl(url);
    console.log('\n  Thanks so much -- enjoy your data!\n');
  }
}

module.exports = { main };
