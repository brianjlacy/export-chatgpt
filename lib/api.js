'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS } = require('./config');
const { createApiHeaders, fetchWithRetry, throttle } = require('./auth');
const { saveIndex, saveProgress, ensureDir } = require('./storage');
const { sanitizeProjectFolder } = require('./formatter');


async function fetchConversation(accessToken, conversationId) {
  const url = `${CONFIG.apiBase}/conversation/${conversationId}`;
  const response = await fetchWithRetry(url, {
    headers: createApiHeaders(accessToken),
  });
  return response.json();
}

// Paginate a single is_archived bucket. Separate resume offsets per bucket
// ensure archived + active don't clobber each other's progress state.
async function fetchConversationListBucket(accessToken, existingIndex, progress, isArchived) {
  const archivedFlag = isArchived ? 'true' : 'false';
  const bucketLabel = isArchived ? 'archived' : 'active';
  const offsetKey = isArchived ? 'lastArchivedOffset' : 'lastOffset';
  const completeKey = isArchived ? 'archivedIndexingComplete' : 'indexingComplete';

  const startOffset = progress[completeKey] ? 0 : (progress[offsetKey] || 0);
  if (startOffset > 0) {
    console.log(`  [${bucketLabel}] Resuming from offset ${startOffset}...`);
  }

  let offset = startOffset;
  let hasMore = true;
  let newCount = 0;
  let pagesWithNoNew = 0;

  while (hasMore) {
    const url = `${CONFIG.apiBase}/conversations?offset=${offset}&limit=${CONFIG.conversationsPerPage}&order=updated&is_archived=${archivedFlag}`;

    try {
      await throttle();
      const response = await fetchWithRetry(url, {
        headers: createApiHeaders(accessToken),
      });

      const data = await response.json();

      if (data.items && data.items.length > 0) {
        let pageNewCount = 0;
        for (const conv of data.items) {
          if (!existingIndex.has(conv.id)) {
            // Tag so downstream can distinguish if needed.
            existingIndex.set(conv.id, { ...conv, _archived: isArchived });
            newCount++;
            pageNewCount++;
          }
        }

        saveIndex(existingIndex);
        progress[offsetKey] = offset + data.items.length;
        saveProgress(progress);

        console.log(`  [${bucketLabel}] Found ${existingIndex.size} conversations (${newCount} new)...`);
        offset += data.items.length;

        if (pageNewCount === 0) {
          pagesWithNoNew++;
          if (pagesWithNoNew >= 3) {
            console.log(`  [${bucketLabel}] No new conversations found, bucket appears complete.`);
            hasMore = false;
            break;
          }
        } else {
          pagesWithNoNew = 0;
        }

        hasMore = data.items.length === CONFIG.conversationsPerPage;
      } else {
        hasMore = false;
      }
    } catch (error) {
      if (error.authError) {
        console.log(`\n  Token expired during ${bucketLabel} indexing. Progress saved.`);
        console.log(`   Run again with a fresh token to continue from offset ${offset}.\n`);
        throw error;
      }
      throw error;
    }
  }

  progress[completeKey] = true;
  saveProgress(progress);

  return newCount;
}

async function fetchConversationListIncremental(accessToken, existingIndex, progress) {
  console.log('Fetching conversation list...');

  // Always fetch the active (non-archived) bucket first — matches upstream
  // behaviour exactly when --include-archived is not set.
  await fetchConversationListBucket(accessToken, existingIndex, progress, false);

  // OpenAI's conversation listing defaults to is_archived=false, so
  // archived chats are silently excluded unless we ask explicitly.
  // Users on accounts that have ever bulk-archived can be missing a
  // significant chunk of history without any error surface.
  if (CONFIG.includeArchived) {
    console.log('\nFetching archived conversation list...');
    await fetchConversationListBucket(accessToken, existingIndex, progress, true);
  }

  console.log(`  Index complete: ${existingIndex.size} total conversations\n`);
  return existingIndex;
}

async function fetchProjectList(accessToken, progress) {
  console.log('Fetching project list...');

  if (progress.projectsIndexingComplete) {
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
      await throttle();
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
            conversation_count: 0,
          };

          if (!projects.find(p => p.id === project.id)) {
            projects.push(project);
          }
        }

        console.log(`  Found ${projects.length} projects...`);
      }

      cursor = data.cursor || null;
      progress.projectsLastCursor = cursor;

      ensureDir(PATHS.projectsDir);
      fs.writeFileSync(PATHS.projectIndexFile, JSON.stringify(projects, null, 2));
      saveProgress(progress);

      if (!cursor) {
        hasMore = false;
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

async function fetchProjectConversations(accessToken, project, progress) {
  const projectId = project.id;

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

  let conversations = [];
  if (fs.existsSync(projectConvIndexFile)) {
    try {
      conversations = JSON.parse(fs.readFileSync(projectConvIndexFile, 'utf8'));
    } catch (e) {
      // Start fresh
    }
  }

  if (projProgress.indexingComplete) {
    return conversations;
  }

  let cursor = projProgress.lastCursor || '0';
  let hasMore = true;

  while (hasMore) {
    const url = `${CONFIG.apiBase}/gizmos/${projectId}/conversations?cursor=${encodeURIComponent(cursor)}`;

    try {
      await throttle();
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

      ensureDir(projectDir);
      fs.writeFileSync(projectConvIndexFile, JSON.stringify(conversations, null, 2));
      saveProgress(progress);

      if (!cursor) {
        hasMore = false;
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

module.exports = {
  fetchConversation,
  fetchConversationListIncremental,
  fetchProjectList,
  fetchProjectConversations,
};
