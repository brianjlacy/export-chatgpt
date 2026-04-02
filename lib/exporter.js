'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog } = require('./config');
const { loadIndex, loadProgress, saveProgress, ensureDir } = require('./storage');
const { sanitizeFilename, sanitizeProjectFolder, getDatePrefix, conversationToMarkdown } = require('./formatter');
const { fetchConversation, fetchConversationListIncremental, fetchProjectList, fetchProjectConversations } = require('./api');
const { downloadConversationFiles, downloadProjectFiles } = require('./downloader');

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

  const conversations = Array.from(conversationIndex.values());
  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const progress_display = `[${i + 1}/${conversations.length}]`;
    const shortId = conv.id.substring(0, 8);

    if (!CONFIG.updateExisting) {
      if (progress.downloadedIds.includes(conv.id)) {
        skipCount++;
        continue;
      }

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
        const fc = await downloadConversationFiles(accessToken, fullConversation, PATHS.filesDir, progress);
        fileCount += fc;
      }

      if (!progress.downloadedIds.includes(conv.id)) {
        progress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
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

  let successCount = 0, skipCount = 0, updateCount = 0, errorCount = 0, fileCount = 0;

  for (let i = 0; i < conversations.length; i++) {
    const conv = conversations[i];
    const shortId = conv.id.substring(0, 8);

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
        const fc = await downloadConversationFiles(accessToken, fullConversation, filesDir, progress);
        fileCount += fc;
      }

      if (!projProgress.downloadedIds.includes(conv.id)) {
        projProgress.downloadedIds.push(conv.id);
      }
      saveProgress(progress);

      console.log('done');
      if (isUpdate) updateCount++;
      else successCount++;
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

      const projects = await fetchProjectList(accessToken, progress);
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

  // Files line (only if file downloads were enabled and any were downloaded)
  if (CONFIG.downloadFiles && files > 0) {
    console.log(`  Files:          ${files} downloaded`);
  }

  console.log(`\n  Output directory: ${path.resolve(CONFIG.outputDir)}`);
}

module.exports = { exportConversations, exportProjectConversations, run, printSummary };
