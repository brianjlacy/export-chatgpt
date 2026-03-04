# TODO — Projects, Files & Research Support

Implementation plan for adding Projects, Files, and Deep Research export capabilities to the ChatGPT Conversation Exporter.

---

## Phase 1: CLI & Configuration

- [ ] Add `--include-projects` flag to `parseArgs()`
- [ ] Add `--projects-only` flag to `parseArgs()`
- [ ] Add `--download-files` flag to `parseArgs()`
- [ ] Add interactive prompt: "Export project conversations?" (when flags not provided)
- [ ] Add interactive prompt: "Download images/attachments?" (when flag not provided)
- [ ] Update `printHelp()` with new options and examples
- [ ] Add `projects/` and `files/` paths to `initPaths()` and `PATHS` object
- [ ] Ensure `--projects-only` skips regular conversation export

---

## Phase 2: Project Listing & Indexing

- [ ] Implement `fetchProjectList(accessToken, progress)` function
  - Paginate `GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0`
  - Use cursor-based pagination (not offset)
  - Save progress after each page (`projectsLastCursor`)
  - Mark `projectsIndexingComplete` when cursor is null
- [ ] Save `project-index.json` to `exports/projects/`
  - Schema: array of `{ id, name, description, instructions, workspace_id, created_at, updated_at, num_interactions, files[], conversation_count }`
- [ ] Extend `.export-progress.json` with project tracking fields
  - `projectsIndexingComplete`, `projectsLastCursor`, `projects: {}`

---

## Phase 3: Project Conversation Export

- [ ] Implement `fetchProjectConversations(accessToken, gizmoId, progress)` function
  - Paginate `GET /backend-api/gizmos/{gizmo_id}/conversations?cursor={cursor}`
  - Start with `cursor=0`, paginate until null
  - Track per-project: `indexingComplete`, `lastCursor`, `downloadedIds`
- [ ] Create project directory structure: `exports/projects/{SanitizedProjectName}/json/` and `markdown/`
- [ ] Implement `exportProjectConversations(accessToken, project, progress)` function
  - Reuse existing `fetchConversation()` for full conversation data
  - Reuse existing `conversationToMarkdown()` for Markdown conversion
  - Reuse existing file-naming logic (`{date}_{title}_{shortId}`)
  - Save to project-specific subdirectories
  - Track downloads per-project in progress file
- [ ] Add project folder name sanitization (max 50 chars)

---

## Phase 4: File Downloads

- [ ] Implement `extractFileReferences(conversationData)` function
  - Traverse message mapping tree
  - Find messages with `content_type: "multimodal_text"`
  - Extract `asset_pointer` values from `image_asset_pointer` parts
  - Return array of `{ fileId, conversationId, metadata }` objects
- [ ] Implement `getFileDownloadUrl(accessToken, fileId, conversationId)` function
  - `GET /backend-api/files/download/{file_id}?conversation_id={id}&inline=false`
  - Return `{ download_url, file_name, file_size_bytes }`
- [ ] Implement `downloadFile(downloadUrl, outputPath)` function
  - Fetch binary content from signed URL
  - Save to disk
  - Determine file extension from response `file_name` or content-type
- [ ] Implement file download orchestration in export flow
  - After downloading conversation JSON, scan for file references
  - For regular conversations: save to `exports/files/{file_id}.{ext}`
  - For project conversations: save to `exports/projects/{name}/files/{file_id}.{ext}`
  - Track downloaded file IDs in `progress.downloadedFileIds[]` for deduplication
- [ ] Handle project-level files (attached to project, not conversation)
  - Extract from `gizmo.files[]` in sidebar response
  - Download using same mechanism with `file_id` field

---

## Phase 5: Deep Research Handling

- [ ] Detect deep research messages during Markdown conversion
  - Identify initiation: `author.name === "research_kickoff_tool.start_research_task"`
  - Identify results: `metadata.is_async_task_result_message === true`
- [ ] Format research results in Markdown output
  - Add metadata header (task title, prompt) before research content
  - Render the research result text (already in `content.parts[]`)
- [ ] *(Optional)* Implement research process capture via SSE stream
  - `GET /backend-api/tasks/{task_id}/stream`
  - Parse SSE events for `summary`, `search`, `website_open`, `file_open` rows
  - Save as supplementary `{conversation_id}_research_{task_id}.json`

---

## Phase 6: Markdown Enhancements

- [ ] Handle `multimodal_text` content type in `extractMessageContent()`
  - Extract text parts (strings) from `parts[]`
  - For `image_asset_pointer` parts: render as `![image](files/{file_id}.{ext})` if files downloaded, or note as `[Image: {file_id}]`
- [ ] Handle `tether_browsing_display` content type
  - Extract browsing result summary text
- [ ] Handle `thoughts` content type (o1/o3 reasoning)
  - Render under a "Thinking" subsection or collapsible block
- [ ] Handle `reasoning_recap` content type
  - Render as brief reasoning summary
- [ ] Handle tool messages in Markdown output
  - `research_kickoff_tool` → "Deep Research: {task_title}"
  - `file_search` → "Searched files: ..."
  - Other tools → generic "Tool: {name}" with content

---

## Phase 7: Integration & Orchestration

- [ ] Wire project export into `main()` flow
  - If `--include-projects` or `--projects-only`: run project export
  - Unless `--projects-only`: run regular export
  - If `--download-files`: run file downloads for all exported conversations
- [ ] Implement unified progress save on auth error
  - Save regular progress, project progress, and file progress atomically
- [ ] Print combined summary at end
  - Regular conversations: downloaded / skipped / errors
  - Projects: count, conversations per project
  - Files: downloaded / skipped / errors

---

## Phase 8: Documentation & Testing

- [ ] Update README.md with new features
  - New CLI flags and examples
  - Project export usage
  - File download usage
  - Updated output structure diagram
- [ ] End-to-end manual testing
  - Regular-only export (backward compatibility)
  - `--include-projects` export
  - `--projects-only` export
  - `--download-files` with regular conversations
  - `--download-files` with project conversations
  - Resumption after token expiry mid-project-export
  - Empty projects (no conversations)
  - Conversations with deep research results
