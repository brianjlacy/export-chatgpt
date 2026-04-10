'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { loadIndex, saveIndex, loadProgress, saveProgress, ensureDir } = require('./storage');
const { sanitizeFilename, sanitizeProjectFolder, getDatePrefix, conversationToMarkdown } = require('./formatter');
const { fetchConversation, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('./api');
const { downloadConversationFiles, downloadProjectFiles, retryPendingFiles } = require('./downloader');
const { throttle } = require('./auth');

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
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
    }
    const shortId = conv.id.substring(0, 8);

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
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
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
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;
  let sessionDownloads = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const shortId = conv.id.substring(0, 8);

    if (CONFIG.maxConversations !== null && sessionDownloads >= CONFIG.maxConversations) {
      skipCount += conversations.length - i;
      break;
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
      errorCount++;
    }
  }

  return { success: successCount, skip: skipCount, update: updateCount, error: errorCount, fileCount };
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
  console.log(`Throttle: ${CONFIG.throttleMs / 1000}s between requests (to reduce rate-limiting errors)`);
  if (CONFIG.maxConversations !== null) console.log(`Max this session: ${CONFIG.maxConversations} conversations`);
  if (CONFIG.convFilter) console.log(`Conversation filter: ${[...CONFIG.convFilter].join(', ')}`);
  if (CONFIG.projFilter) console.log(`Project filter: ${[...CONFIG.projFilter].join(', ')}`);
  console.log('');

  const summary = {
    regular: { success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
    projects: { count: 0, conversations: 0, success: 0, skip: 0, update: 0, error: 0, fileCount: 0 },
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
          continue;
        }
        console.log(`  ${conversations.length} conversations`);

        const result = await exportProjectConversations(accessToken, project, progress);
        summary.projects.conversations += (result.success + result.skip + result.update + result.error);
        summary.projects.success += result.success;
        summary.projects.skip += result.skip;
        summary.projects.update += result.update;
        summary.projects.error += result.error;
        summary.projects.fileCount += result.fileCount;

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
      // Count permanently failed files for the summary
      const failedCount = Object.keys(progress.failedFileIds).length;
      if (failedCount > 0) summary.failedFiles = failedCount;
    }
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
  let convParts = [`${downloaded} downloaded`];
  if (skipped > 0) convParts.push(`${skipped} skipped`);
  if (errors > 0) convParts.push(`${errors} errors`);
  console.log(`\n  Conversations:  ${convParts.join('    ')}`);

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

module.exports = { exportConversations, exportProjectConversations, run, printSummary };
