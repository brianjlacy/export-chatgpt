'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { loadIndex, saveIndex, loadProgress, saveProgress, ensureDir } = require('./storage');
const { sanitizeFilename, sanitizeProjectFolder, getDatePrefix, conversationToMarkdown } = require('./formatter');
const { fetchConversation, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('./api');
const { downloadConversationFiles, downloadProjectFiles, retryPendingFiles } = require('./downloader');
const { throttle } = require('./auth');

// A conversation that answers 404 is gone server-side — deleted, purged by
// workspace retention, or never fully materialized. The listing endpoint keeps
// returning its row regardless, and the index is append-only, so without a
// record of the failure every later run re-requests it forever (one throttled
// request each, permanently). Mirrors progress.failedFileIds for files.
function recordConversationFailure(progress, conv, error) {
  if (!error.notFound) return false;
  if (!progress.failedConversationIds) progress.failedConversationIds = {};

  const prior = progress.failedConversationIds[conv.id];
  const now = new Date().toISOString();
  progress.failedConversationIds[conv.id] = {
    status: error.status || 404,
    reason: 'not_found',
    title: conv.title || null,
    attempts: (prior && prior.attempts ? prior.attempts : 0) + 1,
    firstFailedAt: (prior && prior.firstFailedAt) || now,
    lastFailedAt: now,
  };
  saveProgress(progress);
  return true;
}

// True when this ID already failed permanently and --retry-failed wasn't passed.
function isKnownDeadConversation(progress, id) {
  if (CONFIG.retryFailedConversations) return false;
  return !!(progress.failedConversationIds && progress.failedConversationIds[id]);
}

async function exportConversations(accessToken, progress) {
  ensureDir(CONFIG.outputDir);
  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(PATHS.jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(PATHS.mdDir);

  const existingIndex = loadIndex();

  if (existingIndex.size > 0) {
    console.log(`Found existing index with ${existingIndex.size} conversations`);
    console.log(`   Already downloaded: ${progress.downloadedIds.length}\n`);
  }

  const conversationIndex = await fetchConversationListIncremental(accessToken, existingIndex, progress);

  if (conversationIndex.size === 0) {
    console.log('No conversations found.\n');
    return { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 };
  }

  console.log('Downloading conversations...\n');

  let conversations = Array.from(conversationIndex.values());
  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0, deadCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }

    if (isKnownDeadConversation(progress, conv.id)) {
      verboseLog(`${progress_display} skipping "${(conv.title || 'Untitled').substring(0, 50)}" — previously 404 (use --retry-failed to re-attempt)`);
      deadCount++;
      continue;
    }
    // 13-char prefix spans the full first UUID segment + dash + start of
    // second segment. 8 chars collided silently when many conversations
    // shared a timestamp-encoded prefix (bulk-archive assigns many IDs in
    // the same second), causing the existence check below to match any
    // collision-sharing file and silently skip all but one.
    const shortId = conv.id.substring(0, 13);

    if (!CONFIG.updateExisting) {
      if (progress.downloadedIds.includes(conv.id)) {
        skipCount++;
        continue;
      }

      const jsonDirExists = fs.existsSync(PATHS.jsonDir);
      if (jsonDirExists) {
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
      await throttle();
      const action = isUpdate ? '~' : '+';
      process.stdout.write(`${progress_display} ${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [PATHS.jsonDir, PATHS.mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(PATHS.jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(PATHS.mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, PATHS.filesDir, progress, conv);
        fileCount += fc;
        saveIndex(conversationIndex);
      }

      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      // A previously dead conversation that fetches again (restored, or a
      // different account/workspace) should stop being reported as failed.
      if (progress.failedConversationIds) delete progress.failedConversationIds[conv.id];
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        console.log('\n\n  Token expired during download. Progress saved.');
        console.log(`   Downloaded ${successCount} this session (${progress.downloadedIds.length} total).`);
        console.log('   Run again with a fresh token to continue.\n');
        throw error;
      }
      console.log(`error: ${error.message}`);
      verboseLog(`    Failed conversation ID: ${conv.id}`);
      if (recordConversationFailure(progress, conv, error)) {
        verboseLog(`    Recorded as permanently unavailable; skipped on future runs.`);
      }
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount, dead: deadCount };
}

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

  if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') ensureDir(jsonDir);
  if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') ensureDir(mdDir);

  if (CONFIG.convFilter) {
    conversations = conversations.filter(c => CONFIG.convFilter.has(c.id));
  }
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0, deadCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    // 13-char prefix — see comment in exportConversations above for rationale.
    const shortId = conv.id.substring(0, 13);

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }

    if (isKnownDeadConversation(progress, conv.id)) {
      verboseLog(`  skipping "${(conv.title || 'Untitled').substring(0, 50)}" — previously 404 (use --retry-failed to re-attempt)`);
      deadCount++;
      continue;
    }

    if (!CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id)) {
      skipCount++;
      continue;
    }

    const isUpdate = CONFIG.updateExisting && projProgress.downloadedIds.includes(conv.id);

    try {
      await throttle();
      const action = isUpdate ? '  ~' : '  +';
      process.stdout.write(`${action} "${(conv.title || 'Untitled').substring(0, 50)}"... `);

      const fullConversation = await fetchConversation(accessToken, conv.id);

      const filename = sanitizeFilename(conv.title || conv.id);
      const datePrefix = getDatePrefix(conv.create_time);
      const baseFilename = `${datePrefix}_${filename}_${shortId}`;

      if (isUpdate) {
        for (const dir of [jsonDir, mdDir]) {
          if (fs.existsSync(dir)) {
            const oldFiles = fs.readdirSync(dir).filter(f => f.includes(shortId));
            for (const f of oldFiles) fs.unlinkSync(path.join(dir, f));
          }
        }
      }

      if (CONFIG.exportFormat === 'json' || CONFIG.exportFormat === 'both') {
        fs.writeFileSync(path.join(jsonDir, `${baseFilename}.json`), JSON.stringify(fullConversation, null, 2));
      }

      if (CONFIG.exportFormat === 'markdown' || CONFIG.exportFormat === 'both') {
        const markdown = conversationToMarkdown(fullConversation);
        fs.writeFileSync(path.join(mdDir, `${baseFilename}.md`), markdown);
      }

      if (CONFIG.downloadFiles) {
        const fc = await downloadConversationFiles(accessToken, fullConversation, filesDir, progress, conv);
        fileCount += fc;
        fs.writeFileSync(projectConvIndexFile, JSON.stringify(conversations, null, 2));
      }

      if (!projProgress.downloadedIds.includes(conv.id)) {
        projProgress.downloadedIds.push(conv.id);
      }
      // See note in exportConversations: recovery clears the failure record.
      if (progress.failedConversationIds) delete progress.failedConversationIds[conv.id];
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
      sessionDownloads++;
    } catch (error) {
      if (error.authError) {
        console.log(`\n  Token expired during project "${project.name}" export. Progress saved.`);
        throw error;
      }
      console.log(`error: ${error.message}`);
      if (recordConversationFailure(progress, conv, error)) {
        verboseLog(`    Recorded as permanently unavailable; skipped on future runs.`);
      }
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount, dead: deadCount };
}

async function mergeProjectConversationsIntoMainIndex(projects) {
  const mainIndex = loadIndex();
  let addedCount = 0;

  for (const project of projects) {
    const folderName = sanitizeProjectFolder(project.name);
    const projectConvIndexFile = path.join(PATHS.projectsDir, folderName, 'conversation-index.json');

    if (!fs.existsSync(projectConvIndexFile)) continue;

    let projectConvs;
    try {
      projectConvs = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      verboseLog(`  Warning: could not read project index for "${project.name}", skipping merge`);
      continue;
    }

    for (const conv of projectConvs) {
      if (!mainIndex.has(conv.id)) {
        mainIndex.set(conv.id, { ...conv, _project_id: project.id });
        addedCount++;
      }
    }
  }

  if (addedCount > 0) {
    saveIndex(mainIndex);
    console.log(`  Merged ${addedCount} project conversation(s) into main index`);
  } else {
    verboseLog('  No new project conversations to merge into main index');
  }
}

// Scans every JSON file on disk (regular + project dirs) and returns the set
// of conversation IDs actually present.
function collectIdsOnDisk() {
  const onDisk = new Set();
  const scanJsonDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const id = data.id || data.conversation_id;
        if (id) onDisk.add(id);
      } catch {}
    }
  };
  scanJsonDir(PATHS.jsonDir);
  if (fs.existsSync(PATHS.projectsDir)) {
    for (const projFolder of fs.readdirSync(PATHS.projectsDir)) {
      scanJsonDir(path.join(PATHS.projectsDir, projFolder, 'json'));
    }
  }
  return onDisk;
}

// Returns IDs in progress.downloadedIds that have no corresponding file on disk.
function findSilentlySkippedConversations(progress) {
  const onDisk = collectIdsOnDisk();
  return (progress.downloadedIds || []).filter(id => !onDisk.has(id));
}

// Removes any IDs from progress.downloadedIds (and per-project arrays) that don't have a file
// on disk so the main export loop re-fetches them. Mutates progress; saves to disk.
function refetchMissing(progress) {
  const onDisk = collectIdsOnDisk();

  const topMissing = (progress.downloadedIds || []).filter(id => !onDisk.has(id));
  progress.downloadedIds = (progress.downloadedIds || []).filter(id => onDisk.has(id));

  let projMissingCount = 0;
  if (progress.projects) {
    for (const pid of Object.keys(progress.projects)) {
      const pp = progress.projects[pid];
      if (pp && Array.isArray(pp.downloadedIds)) {
        const before = pp.downloadedIds.length;
        pp.downloadedIds = pp.downloadedIds.filter(id => onDisk.has(id));
        projMissingCount += before - pp.downloadedIds.length;
      }
    }
  }

  const total = topMissing.length + projMissingCount;
  if (total === 0) {
    console.log('  No missing conversations — progress and disk are in sync.\n');
    return 0;
  }
  saveProgress(progress);
  console.log(`  Marked ${total} silently-skipped conversation(s) for re-download.\n`);
  return total;
}

async function runVerify(progress) {
  console.log('=== Verify mode (dry run) ===\n');
  const missing = findSilentlySkippedConversations(progress);
  const index = loadIndex();
  console.log(`Index entries:           ${index.size}`);
  console.log(`Progress "downloaded":   ${(progress.downloadedIds || []).length}`);
  console.log(`Silently skipped:        ${missing.length}`);

  const dead = Object.entries(progress.failedConversationIds || {});
  if (dead.length > 0) {
    console.log(`Permanently unavailable: ${dead.length} (HTTP 404 — deleted or purged server-side)`);
    for (const [id, info] of dead.slice(0, 10)) {
      const title = info.title || index.get(id)?.title || '';
      console.log(`    - ${id}  ${info.attempts}x since ${(info.firstFailedAt || '').substring(0, 10)}  ${title ? `"${title.substring(0, 40)}"` : ''}`);
    }
    if (dead.length > 10) console.log(`    ... and ${dead.length - 10} more`);
    console.log('  Re-attempt these with --retry-failed.');
  }

  if (missing.length === 0) {
    console.log('\n  ✓ No silent skips detected. Export is clean.\n');
    return;
  }
  console.log('\n  ⚠ Conversation IDs marked downloaded but not present on disk:\n');
  const preview = missing.slice(0, 10);
  for (const id of preview) {
    const entry = index.get(id);
    console.log(`    - ${id}  ${entry?.title ? `"${entry.title.substring(0, 50)}"` : ''}`);
  }
  if (missing.length > 10) console.log(`    ... and ${missing.length - 10} more`);
  console.log('');
}

async function run(accessToken) {
  const progress = loadProgress();

  console.log('Using provided Bearer token');
  if (CONFIG.accountId) {
    console.log(`Teams Account ID: ${CONFIG.accountId}`);
  }

  // --verify short-circuits: dry-run report, no network calls.
  if (CONFIG.verifyMode) {
    await runVerify(progress);
    return { verified: true };
  }

  // Refetch-missing runs before the main export loop so the main loop
  // treats the cleared IDs as first-time downloads.
  if (CONFIG.refetchMissing) {
    console.log('Refetch-missing: scanning for silent skips...');
    refetchMissing(progress);
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
  console.log(`Throttle: ${CONFIG.throttleMs / 1000}s between requests (to reduce rate-limiting errors)`);
  if (CONFIG.maxConversations !== null) console.log(`Max this session: ${CONFIG.maxConversations} conversations`);
  if (CONFIG.convFilter) console.log(`Conversation filter: ${[...CONFIG.convFilter].join(', ')}`);
  if (CONFIG.projFilter) console.log(`Project filter: ${[...CONFIG.projFilter].join(', ')}`);
  console.log('');

  const summary = {
    regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0, dead: 0 },
    projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0, dead: 0 },
  };

  try {
    if (!CONFIG.projectsOnly) {
      console.log('=== Regular Conversations ===\n');
      summary.regular = await exportConversations(accessToken, progress);
    }

    if (CONFIG.includeProjects || CONFIG.projectsOnly) {
      console.log('\n=== Project Conversations ===\n');

      let projects = await fetchProjectList(accessToken, progress);
      if (CONFIG.projFilter) {
        projects = projects.filter(p => CONFIG.projFilter.has(p.id));
      }
      summary.projects.count = projects.length;

      for (const project of projects) {
        const folderName = sanitizeProjectFolder(project.name);
        console.log(`\nProject: "${project.name}" (${folderName}/)`);

        const conversations = await fetchProjectConversations(accessToken, project, progress);
        if (!conversations || conversations.length === 0) {
          console.log('  No conversations.');
        } else {
          console.log(`  ${conversations.length} conversations`);

          const result = await exportProjectConversations(accessToken, project, progress);
          summary.projects.conversations += (result.success + result.skip + result.update + result.error + (result.dead || 0));
          summary.projects.success += result.success;
          summary.projects.skip += result.skip;
          summary.projects.update += result.update;
          summary.projects.error += result.error;
          summary.projects.fileCount += result.fileCount;
          summary.projects.dead += result.dead || 0;
        }

        if (CONFIG.downloadFiles && project.files && project.files.length > 0) {
          console.log(`  Downloading ${project.files.length} project-level files...`);
          const fc = await downloadProjectFiles(accessToken, project, progress);
          summary.projects.fileCount += fc;
        }
      }

      await mergeProjectConversationsIntoMainIndex(projects);
    }

    if (CONFIG.downloadFiles) {
      const retried = await retryPendingFiles(accessToken, progress);
      if (retried > 0) summary.retriedFiles = retried;
      const failedCount = Object.keys(progress.failedFileIds).length;
      if (failedCount > 0) summary.failedFiles = failedCount;
    }

    const deadConvCount = Object.keys(progress.failedConversationIds || {}).length;
    if (deadConvCount > 0) summary.failedConversations = deadConvCount;
  } catch (error) {
    if (error.authError) {
      printSummary(summary);
      process.exit(1);
    }
    throw error;
  }

  printSummary(summary);
  return summary;
}

function printSummary(summary) {
  if (!CONFIG.showSummary) return;

  const r = summary.regular;
  const p = summary.projects;

  const downloaded = r.success + r.update + p.success + p.update;
  const skipped = r.skip + p.skip;
  const errors = r.error + p.error;
  const files = r.fileCount + p.fileCount;
  const projects = p.count;

  console.log('\n' + '='.repeat(50));
  console.log('  Export Complete!');
  console.log('='.repeat(50));

  // Conversations line (always shown)
  const dead = (r.dead || 0) + (p.dead || 0);
  let convParts = [`${downloaded} downloaded`];
  if (skipped > 0) convParts.push(`${skipped} skipped`);
  if (errors > 0) convParts.push(`${errors} errors`);
  if (dead > 0) convParts.push(`${dead} unavailable`);
  console.log(`\n  Conversations:  ${convParts.join('    ')}`);

  // Permanently unavailable conversations (404 on the detail endpoint while
  // still present in the listing). Total across all runs, not just this one.
  const deadTotal = summary.failedConversations || 0;
  if (deadTotal > 0) {
    console.log(`  Unavailable:    ${deadTotal} conversation(s) return HTTP 404 (deleted or purged server-side)`);
    console.log(`                  Listed in .export-progress.json → failedConversationIds`);
    console.log(`                  Re-attempt with --retry-failed`);
  }

  // Projects line (only if projects were included)
  if (CONFIG.includeProjects || CONFIG.projectsOnly) {
    console.log(`  Projects:       ${projects} found`);
  }

  // Files line (only if file downloads were enabled and any were downloaded, retried, or failed)
  if (CONFIG.downloadFiles && (files > 0 || summary.retriedFiles > 0 || summary.failedFiles > 0)) {
    let fileParts = [`${files} downloaded`];
    if (summary.retriedFiles > 0) fileParts.push(`${summary.retriedFiles} retried`);
    if (summary.failedFiles > 0) fileParts.push(`${summary.failedFiles} permanently failed`);
    console.log(`  Files:          ${fileParts.join('    ')}`);
  }

  console.log(`\n  Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

module.exports = { exportConversations, exportProjectConversations, run, printSummary, collectIdsOnDisk, findSilentlySkippedConversations, refetchMissing };
