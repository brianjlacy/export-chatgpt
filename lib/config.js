'use strict';

// Shared mutable configuration object — populated by cli.js after arg parsing.
// All other modules import this reference; mutations in cli.js are visible everywhere.
const CONFIG = {
  baseUrl: 'https://chatgpt.com',
  apiBase: 'https://chatgpt.com/backend-api',
  outputDir: './exports',
  throttleMs: 60000,
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
  nonInteractive: false,
  showSummary: true,
  showDonate: true,
  maxConversations: null,
  convFilter: null,
  projFilter: null,
  // Adaptive throttle auto-tunes throttleMs between [minThrottleMs, maxThrottleMs]
  // based on observed 429 responses. Starts at user-provided --throttle value.
  adaptiveThrottle: true,
  minThrottleMs: 5000,
  maxThrottleMs: 300000,
};

function verboseLog(msg) {
  if (CONFIG.verbose) console.log(msg);
}

// File paths — populated by initPaths() after outputDir is finalized.
const PATHS = {};

function initPaths() {
  const path = require('path');
  Object.assign(PATHS, {
    indexFile: path.join(CONFIG.outputDir, 'conversation-index.json'),
    progressFile: path.join(CONFIG.outputDir, '.export-progress.json'),
    jsonDir: path.join(CONFIG.outputDir, 'json'),
    mdDir: path.join(CONFIG.outputDir, 'markdown'),
    filesDir: path.join(CONFIG.outputDir, 'files'),
    projectsDir: path.join(CONFIG.outputDir, 'projects'),
    projectIndexFile: path.join(CONFIG.outputDir, 'projects', 'project-index.json'),
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { CONFIG, PATHS, initPaths, verboseLog, sleep };
