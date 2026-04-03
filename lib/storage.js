'use strict';

const fs = require('fs');
const { PATHS, verboseLog } = require('./config');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

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
      verboseLog('  Warning: Could not parse progress file, starting fresh');
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

function mergeFileRefsIntoIndexEntry(conv, newRefs) {
  if (!conv.files) conv.files = [];
  for (const ref of newRefs) {
    if (!conv.files.some(f => f.fileId === ref.fileId)) {
      const { conversationId: _, ...stored } = ref;
      conv.files.push(stored);
    }
  }
  return conv;
}

module.exports = { ensureDir, loadIndex, saveIndex, loadProgress, saveProgress, mergeFileRefsIntoIndexEntry };
