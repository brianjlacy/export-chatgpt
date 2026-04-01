# ChatGPT Conversation Exporter — Engineering Specification

## 1. Overview

A Node.js CLI tool that bulk-exports all ChatGPT conversations via the ChatGPT backend API. Supports personal and Teams accounts, resumable exports, and dual-format output (JSON + Markdown).

### Goals

- Export **all** ChatGPT conversations (regular + project-scoped)
- Download conversation **files** (DALL-E images, user uploads, PDFs)
- Capture **deep research** task results embedded in conversations
- Provide **resumable** exports that survive token expiration
- Produce both raw JSON and human-readable Markdown output

### Non-Goals

- Real-time sync or watching for new conversations
- Modifying or deleting conversations via the API
- Supporting custom GPTs (gizmo_type != "snorlax")

---

## 2. Requirements

| Requirement | Detail |
|-------------|--------|
| Runtime | Node.js >= 18.0.0 (native `fetch`) |
| Dependencies | `commander ^12.0.0` (CLI arg parsing) |
| Platform | Cross-platform (Windows, macOS, Linux) |
| Auth | Bearer token or session token |

---

## 3. Authentication

### 3.1 Bearer Token (Primary)

- Header: `Authorization: Bearer {token}`
- Source: DevTools Network tab → `backend-api/conversations` request
- Format: JWT starting with `eyJ...`
- Tokens expire quickly; user must refresh between sessions

### 3.2 Session Token (Fallback)

- Cookie: `__Secure-next-auth.session-token={token}`
- Exchanged for Bearer token via `GET /api/auth/session`
- Only works for personal accounts

### 3.3 Teams Account ID

- Header: `chatgpt-account-id: {account_id}`
- Required for Teams workspaces, optional for personal accounts
- Format: UUID (e.g., `cc47585e-b2fe-4e7d-ac6a-ced32852f07b`)

### 3.4 Token Sources (Priority Order)

1. CLI flag: `--bearer` or `--token`
2. Environment variable: `CHATGPT_BEARER_TOKEN` or `CHATGPT_SESSION_TOKEN`
3. Interactive prompt (if neither provided)

---

## 4. CLI Interface

### 4.1 Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--bearer <token>` | string | — | Bearer/access token (or `CHATGPT_BEARER_TOKEN` env var) |
| `--token <token>` | string | — | Session token (alt auth, or `CHATGPT_SESSION_TOKEN` env var) |
| `--account-id <id>` | string | — | Teams account ID (auto-detected from JWT when not provided) |
| `-o, --output <dir>` | string | `./exports` | Output directory |
| `--format <fmt>` | string | `both` | `json`, `markdown`, or `both` |
| `--delay <ms>` | number | `1500` | Delay between API requests in ms |
| `--update` | boolean flag | `false` | Re-download and overwrite existing conversations |
| `--no-projects` | boolean flag | — | Skip project conversations (projects are exported by default) |
| `--projects-only` | boolean flag | `false` | Export only project conversations (skip regular) |
| `--no-files` | boolean flag | — | Skip ALL file downloads (overrides granular flags below) |
| `--no-images` | boolean flag | — | Skip downloading DALL-E images |
| `--no-canvas` | boolean flag | — | Skip downloading canvas documents |
| `--no-attachments` | boolean flag | — | Skip downloading other file attachments |
| `--verbose` | boolean flag | `false` | Show detailed request/response info |
| `--help` | flag | — | Show help message |

### 4.2 Flag Interactions

- **Projects:** Exported by default. Use `--no-projects` to skip, or `--projects-only` to export only projects.
- `--projects-only` implies project export and skips the regular conversation export.
- **Files:** All file types downloaded by default. `--no-files` overrides all granular flags (`--no-images`, `--no-canvas`, `--no-attachments`).
- `--delay` must be a non-negative integer; invalid values fall back to the default of 1500ms with a warning.
- `--account-id` is auto-detected from the JWT payload when not provided explicitly.

### 4.3 Interactive Prompts

The only interactive prompt is the **bearer token**: if neither `--bearer`, `--token`, `CHATGPT_BEARER_TOKEN`, nor `CHATGPT_SESSION_TOKEN` is provided, the script prompts the user to enter a token. All other configuration is controlled via CLI flags with sensible defaults.

---

## 5. API Endpoints

### 5.1 Regular Conversations

#### List Conversations

```
GET /backend-api/conversations?offset={offset}&limit=28&order=updated
```

- Pagination: numeric `offset`, 28 per page
- Stop condition: 3 consecutive pages with no new conversations, or page returns fewer than 28

#### Fetch Conversation

```
GET /backend-api/conversation/{conversation_id}
```

- Returns full conversation data with message mapping tree

#### Exchange Session Token

```
GET /api/auth/session
Cookie: __Secure-next-auth.session-token={token}
```

- Returns `{ accessToken: "..." }`

### 5.2 Projects

#### List All Projects

```
GET /backend-api/gizmos/snorlax/sidebar?owned_only=true&conversations_per_gizmo=0
```

- Pagination: cursor-based (opaque string), `null` = last page
- Returns: project metadata, attached files, workspace info
- Project IDs: format `g-p-{32_hex_chars}`

**Response shape:**
```
{
  items: [{
    gizmo: {
      gizmo: { id, display: { name, description }, instructions, workspace_id, created_at, updated_at, num_interactions },
      files: [{ id, file_id, name, type, size }],
      conversations: { items: [], cursor }
    }
  }],
  cursor: string | null
}
```

#### List Project Conversations

```
GET /backend-api/gizmos/{gizmo_id}/conversations?cursor={cursor}
```

- Start with `cursor=0`, paginate until `cursor` is `null`
- Returns same conversation metadata as regular list (id, title, timestamps, snippet)

#### Fetch Project Conversation

Same as regular: `GET /backend-api/conversation/{conversation_id}`

### 5.3 Files

#### Get Signed Download URL

```
GET /backend-api/files/download/{file_id}?conversation_id={conversation_id}&inline=false
```

- Returns `{ status, download_url, file_name, file_size_bytes }`
- `download_url` is a signed, time-limited URL

#### Download File Content

```
GET {download_url}
```

- Returns binary file content
- Do NOT cache signed URLs; fetch fresh for each download

### 5.4 Deep Research (Optional)

#### Stream Research Task Progress

```
GET /backend-api/tasks/{task_id}/stream?parent_conversation_id={id}&message_id={id}
```

- Server-Sent Events (SSE) format
- Row types: `summary`, `search`, `website_open`, `file_open`
- Ends with `final_message` object then `[DONE]`
- **Note:** The final research result is already embedded in the conversation data as a message with `is_async_task_result_message: true`. Streaming is optional for capturing the research process.

---

## 6. Data Flow

### 6.1 Regular Conversation Export

```
1. Authenticate (bearer or session → bearer)
2. Load existing index + progress
3. Paginate /conversations, build index (save after each page)
4. For each un-downloaded conversation:
   a. GET /conversation/{id}
   b. Save JSON to exports/json/
   c. Convert to Markdown, save to exports/markdown/
   d. If --download-files: extract & download file references
   e. Mark downloaded in progress
5. Print summary
```

### 6.2 Project Export

```
1. Paginate /gizmos/snorlax/sidebar, build project index
2. Save project-index.json
3. For each project:
   a. Paginate /gizmos/{id}/conversations
   b. For each un-downloaded conversation:
      i.   GET /conversation/{id}
      ii.  Save JSON to exports/projects/{ProjectName}/json/
      iii. Convert to Markdown, save to exports/projects/{ProjectName}/markdown/
      iv.  If --download-files: extract & download files
      v.   Mark downloaded in progress
4. Print summary
```

### 6.3 File Download Flow

```
1. Scan conversation JSON for asset_pointer references in multimodal_text parts
2. Extract file ID: strip "sediment://" prefix
3. For each unique file ID (not already downloaded):
   a. GET /files/download/{file_id}?conversation_id={id}&inline=false
   b. Fetch the signed download_url
   c. Save binary to appropriate files/ directory
   d. Track file ID as downloaded
```

---

## 7. Output Structure

### 7.1 Directory Layout

```
{outputDir}/
├── json/                                    # Regular conversation JSON
│   └── {date}_{title}_{shortId}.json
├── markdown/                                # Regular conversation Markdown
│   └── {date}_{title}_{shortId}.md
├── files/                                   # Files from regular conversations
│   └── {file_id}.{ext}
├── projects/                                # Project-scoped exports
│   ├── {ProjectName}/
│   │   ├── json/
│   │   │   └── {date}_{title}_{shortId}.json
│   │   ├── markdown/
│   │   │   └── {date}_{title}_{shortId}.md
│   │   ├── files/
│   │   │   └── {file_id}.{ext}
│   │   └── conversation-index.json          # Per-project conversation metadata
│   └── project-index.json
├── conversation-index.json                  # Regular conversation metadata
└── .export-progress.json                    # Resumption state
```

### 7.2 File Naming

- **Date prefix:** ISO date from `create_time` (e.g., `2025-07-23`)
- **Title:** Sanitized conversation title (max 100 chars)
- **Short ID:** First 8 characters of conversation UUID
- **Pattern:** `{date}_{title}_{shortId}.{ext}`
- **Project folders:** Sanitized project name (illegal chars → `_`, spaces → `_`, max 50 chars)

### 7.3 Filename Sanitization

```javascript
function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}
```

For project folder names, limit to 50 characters.

---

## 8. Export Formats

### 8.1 JSON

Raw API response saved as-is with `JSON.stringify(data, null, 2)`. Contains the full conversation object including:

- `id`, `title`, `create_time`, `update_time`
- `mapping` — message tree (nodes with parent/children relationships)
- `gizmo_id` — project association (null for regular conversations)
- `is_archived`, `conversation_template_id`
- Full message content, metadata, and author information

### 8.2 Markdown

Human-readable format with YAML frontmatter:

```markdown
---
title: "Conversation Title"
id: {uuid}
create_time: {ISO timestamp}
update_time: {ISO timestamp}
model: {model name, if available}
project_id: {gizmo_id, if project conversation}
---

# Conversation Title

## User

[message content]

## Assistant

[message content]
```

#### Enhanced Content Type Rendering

| Content Type | Markdown Rendering |
|---|---|
| `text` | Plain text |
| `code` | Fenced code block |
| `multimodal_text` | Text parts inline; images as `![image](files/{id}.ext)` (with `--download-files`) or `[Image: {id}]` |
| `tether_browsing_display` | Blockquote: `> **Browsing Result:** ...` |
| `thoughts` | Collapsible `<details><summary>Thinking</summary>` block |
| `reasoning_recap` | Italic: `*Reasoning recap: ...*` |
| `model_editable_context` | Omitted from Markdown output |

#### Tool Message Rendering

| Tool Name | Markdown Rendering |
|---|---|
| `research_kickoff_tool.start_research_task` | `> **Deep Research:** {title}` |
| `research_kickoff_tool.clarify_with_text` | `> **Research Clarification:** {text}` |
| `file_search` | `> **Searched files:** {text}` |
| Other tools | `> **Tool ({name}):** {text}` |

#### Deep Research Result Messages

Messages with `metadata.is_async_task_result_message: true` are rendered with a special header:
`## Assistant (Deep Research: {task_title})`

---

## 9. Conversation Parsing

### 9.1 Message Tree Traversal

Conversations use a tree structure via the `mapping` field. Each node has:
- `id` — node identifier
- `message` — message content (may be null for root)
- `parent` — parent node ID (null for root)
- `children` — array of child node IDs

Traversal: find root (no parent), follow first child recursively to extract linear message order.

### 9.2 Content Types

| `content_type` | Description | Handling |
|----------------|-------------|----------|
| `text` | Standard text messages | Extract `parts[]` strings |
| `code` | Code execution results | Wrap in code block |
| `multimodal_text` | Messages with images/files | Extract text parts; reference files via `asset_pointer` |
| `tether_browsing_display` | Web browsing results | Extract browsing summary |
| `model_editable_context` | System context | Omitted from Markdown output |
| `thoughts` | Reasoning/thinking (o1/o3) | Include in Markdown under "Thinking" section |
| `reasoning_recap` | Summary of reasoning | Include as assistant recap |

### 9.3 Message Roles

| `author.role` | Description |
|---------------|-------------|
| `user` | User messages |
| `assistant` | AI responses |
| `system` | System prompts/context |
| `tool` | Tool invocations and results |

### 9.4 Tool Messages

Tool messages have `author.role: "tool"` and `author.name` values including:
- `file_search` — File/document search
- `research_kickoff_tool.start_research_task` — Deep research initiation
- `research_kickoff_tool.clarify_with_text` — Research clarification
- Various code interpreter and browsing tool names

### 9.5 Special Metadata Flags

| Flag | Description |
|------|-------------|
| `is_visually_hidden_from_conversation` | System messages not shown in UI |
| `is_async_task_result_message` | Deep research final result |
| `async_task_id` | Links message to an async research task |
| `async_task_title` | Human-readable research task title |

---

## 10. File Handling

### 10.1 Identifying Files in Conversations

Files appear in messages with `content_type: "multimodal_text"`. Scan `parts[]` for objects with `content_type: "image_asset_pointer"`:

```json
{
  "content_type": "image_asset_pointer",
  "asset_pointer": "sediment://file_00000000842871f5b6a1bab8e3499232",
  "size_bytes": 305531,
  "width": 1024,
  "height": 1024,
  "metadata": { "dalle": {...}, "generation": {...} }
}
```

### 10.2 File ID Extraction

```javascript
const fileId = assetPointer.replace('sediment://', '');
// "sediment://file_abc123" → "file_abc123"
```

### 10.3 Download Process

1. Get signed URL: `GET /files/download/{fileId}?conversation_id={convId}&inline=false`
2. Fetch binary content from `download_url`
3. Determine file extension from `file_name` in response or content-type
4. Save to disk

### 10.4 File Types

- DALL-E generated images (PNG, optional transparency)
- User-uploaded images (PNG, JPG, GIF, WebP)
- User-uploaded documents (PDF, etc.)
- Code interpreter outputs

### 10.5 Deduplication

The same file may be referenced in multiple conversations. Track downloaded file IDs to avoid re-downloading. Use the file ID as the unique key.

### 10.6 Project-Level Files

Projects also have files attached at the project level (visible in the sidebar response under `gizmo.files[]`). These are metadata-only in the listing — they use the same download endpoint with the `file_id` field.

---

## 11. Deep Research

### 11.1 Identification

Deep research tasks are identified by metadata on messages within the conversation:

**Initiation message:**
- `author.name`: `"research_kickoff_tool.start_research_task"`
- `metadata.async_task_id`: `"deepresch_{32_hex_chars}"`
- `metadata.async_task_type`: `"research"`
- `metadata.async_task_title`: human-readable title

**Result message:**
- `metadata.is_async_task_result_message`: `true`
- `metadata.async_task_id`: links to the initiation message
- `content.parts[]`: contains the full research output as text

### 11.2 Export Behavior

The research result is already embedded in the conversation as a regular message. No special handling is needed for basic export — the result will appear in both JSON and Markdown output.

### 11.3 Optional: Research Process Capture

The SSE stream at `/backend-api/tasks/{task_id}/stream` provides the research process steps:

| Row Type | Description | Key Fields |
|----------|-------------|------------|
| `summary` | Thinking/progress | `summary`, `title` |
| `search` | Web search performed | `query`, `urls` |
| `website_open` | Website being read | `url`, `row_text` |
| `file_open` | File being analyzed | `file_name`, `file_ext` |

This is optional and can be captured as supplementary metadata alongside the conversation export.

---

## 12. Progress Tracking

### 12.1 Current Schema

```json
{
  "indexingComplete": false,
  "lastOffset": 0,
  "downloadedIds": []
}
```

### 12.2 Extended Schema (with Projects & Files)

```json
{
  "indexingComplete": false,
  "lastOffset": 0,
  "downloadedIds": [],

  "projectsIndexingComplete": false,
  "projectsLastCursor": null,
  "projects": {
    "g-p-{hex}": {
      "name": "Project Name",
      "indexingComplete": false,
      "lastCursor": null,
      "downloadedIds": []
    }
  },

  "downloadedFileIds": []
}
```

### 12.3 Resumption Logic

1. If `indexingComplete: false` → resume regular conversation indexing from `lastOffset`
2. If `projectsIndexingComplete: false` → resume project listing from `projectsLastCursor`
3. For each project: if `indexingComplete: false` → resume from project's `lastCursor`
4. Skip conversations in `downloadedIds` (unless `--update`)
5. Skip files in `downloadedFileIds`
6. On auth error → save all progress, exit with message to refresh token

---

## 13. Error Handling

### 13.1 Authentication Errors (401/403)

- Set `error.authError = true`
- Save all progress to disk
- Log clear message about token expiration
- Exit with code 1
- User re-runs with fresh token to resume

### 13.2 Rate Limiting (429)

- Exponential backoff: `(attempt + 1) * 5000ms`
- Maximum 3 retries per request
- Global configurable delay via `--delay` flag

### 13.3 Network Errors

- Retry 3 times with 2-second delay between attempts
- File downloads also retry 3 times with 2-second delay; auth headers are included when an access token is available (required for Teams accounts whose download URLs are not pre-signed CDN URLs)
- Non-auth errors fail after exhausting retries

### 13.4 File System Errors

- Auto-create directories with `{ recursive: true }`
- Graceful handling of corrupted index files (start fresh)

---

## 14. Project Metadata

### 14.1 project-index.json Schema

```json
[
  {
    "id": "g-p-{hex}",
    "name": "Project Name",
    "description": "",
    "instructions": "Project instructions text...",
    "workspace_id": "uuid",
    "created_at": "ISO timestamp",
    "updated_at": "ISO timestamp",
    "num_interactions": 26,
    "files": [
      {
        "id": "hex",
        "file_id": "file-{id}",
        "name": "Document.pdf",
        "type": "application/pdf",
        "size": 1404959
      }
    ],
    "conversation_count": 12
  }
]
```

---

## 15. Request Headers

All API requests include:

```
Accept: application/json
Content-Type: application/json
Authorization: Bearer {token}
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
```

Teams accounts additionally include:
```
chatgpt-account-id: {account_id}
```

---

## 16. Constraints & Notes

1. **Modular architecture** — The tool is split into `export-chatgpt.js` (shim entry point) and focused modules in `lib/` (`config`, `cli`, `auth`, `storage`, `formatter`, `api`, `downloader`, `exporter`). No build step required.
2. **Signed URLs are ephemeral** — File download URLs must be fetched fresh; never cache them
3. **Backward compatibility** — Default behavior (no new flags) is identical to current behavior
4. **Project IDs** — Always format `g-p-{32_hex_chars}`
5. **Async Task IDs** — Format `deepresch_{32_hex_chars}`
6. **Timestamps** — ISO 8601 (same across regular and project conversations)
7. **Conversation data is identical** — Project conversations use the same data structure as regular ones
8. **The `chatgpt-account-id` header** is required for Teams, optional for personal
9. **Hidden messages** — Messages with `is_visually_hidden_from_conversation: true` are included in JSON export but omitted from Markdown output

---

### Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| v0.1.0 | 2025-03-04 | user | Initial specification |
| v0.1.1 | 2026-03-04 | audit-docs | Synced with implementation: updated interactive prompt defaults (y/N), added per-project conversation-index.json to output structure, documented enhanced Markdown rendering (content types, tool messages, deep research headers, project_id frontmatter), clarified model_editable_context is always omitted from Markdown, added file download retry behavior, made hidden-message handling definitive |
| v0.1.2 | 2026-03-31 | audit-docs | Corrected CLI flags (§4.1–4.3): replaced planned `--include-projects`/`--download-files` with actual implemented flags (`--no-projects`, `--projects-only`, `--no-files`, `--no-images`, `--no-canvas`, `--no-attachments`, `--verbose`, boolean `--update`); replaced 7 interactive prompts with single bearer token prompt (§4.3); corrected dependencies from "zero" to `commander ^12.0.0` (§2); corrected file download auth header behavior (§13.3); updated architecture description to modular `lib/` layout (§16). |
| v0.2.0 | 2026-03-31 | user | Software release: projects, files, and deep research export fully implemented; modular `lib/` architecture; Commander.js CLI; enhanced Markdown rendering. Spec reflects shipped state. |
