# ChatGPT Conversation Exporter

Bulk export all your ChatGPT conversations using the backend API. Works with both personal and Teams accounts. **Resumable** — if your token expires mid-export, just run again with a fresh token and it picks up where it left off.

Supports:
- **Regular conversations** — your main ChatGPT history
- **Project conversations** — conversations inside ChatGPT Projects
- **File downloads** — DALL-E images, user uploads, attachments
- **Deep research** — captures async research task results
- **Enhanced Markdown** — browsing results, reasoning/thinking, tool usage

## Requirements

- Node.js 18+ (uses native `fetch`)

## Quick Start

### 1. Get Your Bearer Token

1. Open https://chatgpt.com in your browser and make sure you're logged in
2. Open DevTools (F12) → **Network** tab
3. Refresh the page or click on a conversation
4. Find a request to `backend-api/conversations`
5. Copy the `authorization: Bearer eyJ...` header value (just the `eyJ...` part)

For **Teams accounts**, also copy the `chatgpt-account-id` header value from the same request.

> **Warning:** Bearer tokens expire quickly — get a fresh one each time you run the export.

### 2. Run the Export

```bash
# Personal account
node export-chatgpt.js --bearer "eyJ..."

# Teams account
node export-chatgpt.js --bearer "eyJ..." --account-id "cc47585e-..."
```

### 3. Find Your Exports

Conversations are saved to `./exports/`:

```
exports/
├── json/                          # Regular conversation JSON
│   └── {date}_{title}_{id}.json
├── markdown/                      # Regular conversation Markdown
│   └── {date}_{title}_{id}.md
├── files/                         # Files from regular conversations
│   └── {file_id}.{ext}
├── projects/                      # Project-scoped exports
│   ├── {ProjectName}/
│   │   ├── json/
│   │   ├── markdown/
│   │   └── files/
│   └── project-index.json
├── conversation-index.json
└── .export-progress.json          # Resumption state
```

Files are named with the pattern `{date}_{title}_{id}.{ext}`.

## Resumable Exports

The script tracks progress automatically:
- `exports/.export-progress.json` stores which conversations have been downloaded and where indexing left off
- If your token expires mid-export, the script saves progress and exits gracefully
- Just run again with a fresh Bearer token — already-downloaded conversations are skipped
- The conversation index is also built incrementally, resuming from the last page fetched

## Options

```
--bearer <token>        Bearer/Access token (recommended, required for Teams)
--account-id <id>       ChatGPT Account ID (required for Teams)
--token <token>         Session token (alternative auth, personal accounts only)
--output <dir>          Output directory (default: ./exports)
--format <format>       Export format: json, markdown, or both (default: both)
--delay <ms>            Delay between API requests in ms (default: 1500)
--update <yes|no>       Re-download existing conversations
--include-projects      Also export project conversations
--projects-only         Export only project conversations (skip regular)
--download-files        Download images/attachments from conversations
--help                  Show help message
```

You can also set the token via environment variables: `CHATGPT_BEARER_TOKEN` or `CHATGPT_SESSION_TOKEN`.

### Interactive Mode

When flags are omitted, the script prompts interactively for:
- Bearer token and account ID
- Output directory
- Update mode
- Export format
- Whether to include project conversations
- Whether to download files/images

## Examples

```bash
# Regular conversations only (default)
node export-chatgpt.js --bearer "eyJ..."

# Include project conversations
node export-chatgpt.js --bearer "eyJ..." --include-projects

# Only project conversations
node export-chatgpt.js --bearer "eyJ..." --projects-only

# Download all images and attachments
node export-chatgpt.js --bearer "eyJ..." --include-projects --download-files

# Export only JSON
node export-chatgpt.js --bearer "eyJ..." --format json

# Export to custom directory
node export-chatgpt.js --bearer "eyJ..." --output ~/Documents/chatgpt-backup

# Slower requests to avoid rate limiting
node export-chatgpt.js --bearer "eyJ..." --delay 3000

# Re-download all conversations
node export-chatgpt.js --bearer "eyJ..." --update yes

# Resume after token expiry — just run again
node export-chatgpt.js --bearer "fresh-eyJ..."
```

## Markdown Output

The Markdown output includes YAML frontmatter and handles multiple content types:

| Content Type | Rendering |
|---|---|
| Text messages | Standard Markdown |
| Code results | Fenced code blocks |
| Images/files | `![image](files/{id}.ext)` links (with `--download-files`) or `[Image: {id}]` |
| Browsing results | Blockquote with "Browsing Result" header |
| Thinking/reasoning (o1/o3) | Collapsible `<details>` block |
| Reasoning recap | Italic summary |
| Deep research results | "Assistant (Deep Research: title)" header |
| Tool messages | Blockquote with tool name |

## Troubleshooting

### "Authentication failed" / token expired mid-export
- Bearer tokens expire quickly — get a fresh one from DevTools
- Make sure you copied the **entire** token (starts with `eyJ`)
- For Teams accounts, make sure to include `--account-id`
- Progress is saved automatically, so just re-run with a new token

### "No conversations found"
This likely means one of:
- **Teams account without `--account-id`**: You need to pass your account ID for Teams workspaces
- You're logged into a different workspace than expected
- The account genuinely has no conversations

### Rate limiting
If you see 429 errors, the script will automatically wait and retry. You can also increase the delay:
```bash
node export-chatgpt.js --bearer "eyJ..." --delay 3000
```

## How It Works

1. Uses your Bearer token directly for API authentication (or exchanges a session token for one)
2. Incrementally fetches the conversation list via `/backend-api/conversations` (28 per page), saving progress after each page
3. Downloads each conversation's full content via `/backend-api/conversation/{id}`, tracking completed downloads
4. If `--include-projects` or `--projects-only`: fetches project list via `/backend-api/gizmos/snorlax/sidebar`, then indexes and downloads each project's conversations
5. If `--download-files`: scans conversation data for `image_asset_pointer` references and downloads via `/backend-api/files/download/{id}`
6. Saves to JSON and/or Markdown files
7. On auth failure, saves all progress and exits — re-running skips already-completed work

## License

MIT
