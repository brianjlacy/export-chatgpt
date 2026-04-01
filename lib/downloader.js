'use strict';

const fs = require('fs');
const path = require('path');
const { CONFIG, PATHS, verboseLog, sleep } = require('./config');
const { createApiHeaders, fetchWithRetry } = require('./auth');
const { saveProgress, ensureDir } = require('./storage');
const { sanitizeProjectFolder, guessFileExtension, mimeToExtension } = require('./formatter');

function extractFileReferences(conversationData) {
  const files = [];
  if (!conversationData.mapping) return files;

  for (const node of Object.values(conversationData.mapping)) {
    if (!node.message || !node.message.content) continue;
    const content = node.message.content;
    const conversationId = conversationData.id || conversationData.conversation_id;

    // Multimodal messages: images, canvas pointers, and other asset pointers
    if (content.content_type === 'multimodal_text' && content.parts) {
      for (const part of content.parts) {
        if (!part || !part.asset_pointer) continue;
        const fileId = part.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
        if (!fileId) continue;

        let type = 'attachment';
        if (part.content_type === 'image_asset_pointer') {
          type = 'image';
        } else if (part.content_type === 'canvas_asset_pointer' || part.content_type === 'canvas') {
          type = 'canvas';
        }

        files.push({ fileId, conversationId, type, metadata: part.metadata || {}, sizeBytes: part.size_bytes });
      }
    }

    // Standalone canvas content type
    if ((content.content_type === 'canvas' || content.content_type === 'canvas_asset_pointer') && content.asset_pointer) {
      const fileId = content.asset_pointer.replace(/^(sediment|file-service):\/\//, '');
      if (fileId) {
        files.push({ fileId, conversationId, type: 'canvas', metadata: content.metadata || {}, sizeBytes: content.size_bytes });
      }
    }
  }

  return files;
}

async function getFileDownloadUrl(accessToken, fileId, conversationId) {
  const url = `${CONFIG.apiBase}/files/download/${fileId}?conversation_id=${conversationId}&inline=false`;
  const response = await fetchWithRetry(url, {
    headers: createApiHeaders(accessToken),
  });
  return response.json();
}

async function downloadFile(downloadUrl, outputPath, accessToken) {
  // Include auth headers — Teams download URLs require them (not pre-signed public CDN)
  const headers = accessToken ? createApiHeaders(accessToken) : {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(downloadUrl, { headers });
      if (!response.ok) {
        throw new Error(`File download failed: HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') || '';
      const buffer = Buffer.from(await response.arrayBuffer());
      ensureDir(path.dirname(outputPath));
      fs.writeFileSync(outputPath, buffer);
      return { bytes: buffer.length, contentType };
    } catch (error) {
      if (attempt === 2) throw error;
      await sleep(2000);
    }
  }
}

function getExtensionFromFilename(fileName) {
  if (!fileName) return '';
  const ext = path.extname(fileName);
  return ext || '';
}

async function downloadConversationFiles(accessToken, conversationData, filesDir, progress) {
  const allRefs = extractFileReferences(conversationData);
  const fileRefs = allRefs.filter(ref => {
    if (ref.type === 'image') return CONFIG.downloadImages;
    if (ref.type === 'canvas') return CONFIG.downloadCanvas;
    return CONFIG.downloadAttachments;
  });
  if (fileRefs.length === 0) return 0;

  let downloadedCount = 0;

  for (const ref of fileRefs) {
    if (progress.downloadedFileIds.includes(ref.fileId)) continue;

    try {
      verboseLog(`    Downloading ${ref.type}: ${ref.fileId}${ref.sizeBytes ? ` (${ref.sizeBytes} bytes)` : ''}`);
      const dlInfo = await getFileDownloadUrl(accessToken, ref.fileId, ref.conversationId);

      if (dlInfo.status !== 'success' || !dlInfo.download_url) {
        console.log(`    Warning: Could not get download URL for ${ref.fileId}`);
        verboseLog(`    Response: ${JSON.stringify(dlInfo)}`);
        continue;
      }

      const filenameExt = getExtensionFromFilename(dlInfo.file_name);
      const ext = filenameExt || guessFileExtension({ metadata: ref.metadata });
      const outputPath = path.join(filesDir, `${ref.fileId}${ext}`);

      // Security fix S2: log only the base URL, not the signed query params.
      verboseLog(`    Download URL: ${dlInfo.download_url.split('?')[0]} [+signature]`);
      const result = await downloadFile(dlInfo.download_url, outputPath, accessToken);

      // If we guessed the extension, check if Content-Type gives a more accurate one
      if (!filenameExt && result.contentType) {
        const ctExt = mimeToExtension(result.contentType);
        if (ctExt && ctExt !== ext) {
          const betterPath = path.join(filesDir, `${ref.fileId}${ctExt}`);
          fs.renameSync(outputPath, betterPath);
        }
      }

      progress.downloadedFileIds.push(ref.fileId);
      saveProgress(progress);
      downloadedCount++;

      await sleep(500);
    } catch (error) {
      if (error.authError) throw error;
      console.log(`    Warning: Failed to download file ${ref.fileId}: ${error.message}`);
    }
  }

  return downloadedCount;
}

async function downloadProjectFiles(accessToken, project, progress) {
  if (!project.files || project.files.length === 0) return 0;

  const folderName = sanitizeProjectFolder(project.name);
  const filesDir = path.join(PATHS.projectsDir, folderName, 'files');
  let count = 0;

  for (const file of project.files) {
    const fileId = file.file_id;
    if (!fileId || progress.downloadedFileIds.includes(fileId)) continue;

    try {
      const url = `${CONFIG.apiBase}/files/download/${fileId}?inline=false`;
      const response = await fetchWithRetry(url, { headers: createApiHeaders(accessToken) });
      const dlInfo = await response.json();

      if (dlInfo.status !== 'success' || !dlInfo.download_url) continue;

      const filenameExt = getExtensionFromFilename(dlInfo.file_name || file.name);
      const ext = filenameExt || mimeToExtension(file.type) || '';
      const outputPath = path.join(filesDir, `${fileId}${ext}`);

      // Security fix S2: log only the base URL, not the signed query params.
      verboseLog(`    Download URL: ${dlInfo.download_url.split('?')[0]} [+signature]`);
      const result = await downloadFile(dlInfo.download_url, outputPath, accessToken);

      // If we guessed the extension, check if Content-Type gives a more accurate one
      if (!filenameExt && result.contentType) {
        const ctExt = mimeToExtension(result.contentType);
        if (ctExt && ctExt !== ext) {
          const betterPath = path.join(filesDir, `${fileId}${ctExt}`);
          fs.renameSync(outputPath, betterPath);
        }
      }
      progress.downloadedFileIds.push(fileId);
      saveProgress(progress);
      count++;

      await sleep(500);
    } catch (error) {
      if (error.authError) throw error;
      console.log(`    Warning: Failed to download project file ${file.name || fileId}: ${error.message}`);
    }
  }

  return count;
}

module.exports = {
  extractFileReferences,
  getFileDownloadUrl,
  downloadFile,
  getExtensionFromFilename,
  downloadConversationFiles,
  downloadProjectFiles,
};
