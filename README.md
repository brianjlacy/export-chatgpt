# ChatGPT Conversation Exporter

> **Disclaimer:** This is an experimental tool provided as-is, with no guarantees of correctness, reliability, or fitness for any purpose. It accesses ChatGPT's unofficial backend API, which may change or break at any time. By using this tool, you accept all responsibility for how you use it. I make no representations about the legality of exporting your own data in your jurisdiction, whether this use complies with OpenAI's Terms of Service, or any other legal or compliance matters. **Use at your own risk.**

Bulk export all your ChatGPT conversations using the backend API. Works with both personal and Teams accounts. **Resumable** — if your token expires mid-export, just run again with a fresh token and it picks up where it left off.

Supports:
- **Regular conversations** — your main ChatGPT history
- **Project conversations** — conversations inside ChatGPT Projects
- **File downloads** — DALL-E images, canvas documents, user uploads, attachments
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

> **Security tip:** To avoid your token appearing in shell history or process listings, use an environment variable instead:
> ```bash
> export CHATGPT_BEARER_TOKEN="eyJ..."
> node export-chatgpt.js
> ```

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
--bearer <token>        Bearer/access token (recommended; or set CHATGPT_BEARER_TOKEN env var)
--token <token>         Session token (alternative auth, personal accounts only; or set CHATGPT_SESSION_TOKEN)
--account-id <id>       ChatGPT Teams account ID (auto-detected from token when possible)
-o, --output <dir>      Output directory (default: ./exports)
--format <format>       Export format: json | markdown | both (default: both)
--delay <ms>            Delay between API requests in ms (default: 1500)
--update                Re-download and overwrite existing conversations
--no-projects           Skip project conversations (projects are exported by default)
--projects-only         Export only project conversations (skip regular)
--no-files              Skip ALL file downloads
--no-images             Skip downloading DALL-E images
--no-canvas             Skip downloading canvas documents
--no-attachments        Skip downloading other file attachments
--verbose               Show detailed request/response info
--help                  Show help message
```

### Token via Environment Variables

To avoid tokens appearing in shell history:
```bash
export CHATGPT_BEARER_TOKEN="eyJ..."
export CHATGPT_SESSION_TOKEN="..."   # alternative auth
node export-chatgpt.js
```

### Interactive Mode

The only interactive prompt is the bearer token — if neither `--bearer`, `--token`, nor the corresponding environment variables are provided, the script will prompt you to enter a token.

## Examples

```bash
# Export everything (conversations, projects, images, canvas, attachments)
node export-chatgpt.js --bearer "eyJ..."

# Skip project conversations
node export-chatgpt.js --bearer "eyJ..." --no-projects

# Only project conversations, skip file downloads
node export-chatgpt.js --bearer "eyJ..." --projects-only --no-files

# Export only JSON format
node export-chatgpt.js --bearer "eyJ..." --format json

# Export to custom directory
node export-chatgpt.js --bearer "eyJ..." --output ~/Documents/chatgpt-backup

# Slower requests to avoid rate limiting
node export-chatgpt.js --bearer "eyJ..." --delay 3000

# Re-download all conversations (overwrite existing)
node export-chatgpt.js --bearer "eyJ..." --update

# Skip images but keep canvas and attachments
node export-chatgpt.js --bearer "eyJ..." --no-images

# Resume after token expiry — just run again with a fresh token
node export-chatgpt.js --bearer "fresh-eyJ..."

# Teams account
node export-chatgpt.js --bearer "eyJ..." --account-id "cc47585e-..."
```

## Markdown Output

The Markdown output includes YAML frontmatter and handles multiple content types:

| Content Type | Rendering |
|---|---|
| Text messages | Standard Markdown |
| Code results | Fenced code blocks |
| Images/files | `![image](files/{id}.ext)` links or `[Image: {id}]` |
| Canvas documents | `![image](files/{id}.ext)` links |
| Browsing results | Blockquote with "Browsing Result" header |
| Thinking/reasoning (o1/o3) | Collapsible `<details>` block |
| Reasoning recap | Italic summary |
| Deep research results | "Assistant (Deep Research: title)" header |
| Tool messages | Blockquote with tool name |

Example frontmatter:
```yaml
---
title: "My conversation title"
id: abc123...
create_time: 2025-01-15T10:30:00.000Z
update_time: 2025-01-15T11:00:00.000Z
model: gpt-4o
project_id: g-abc123...
---
```

## Troubleshooting

### "Authentication failed" / token expired mid-export
- Bearer tokens expire quickly — get a fresh one from DevTools
- Make sure you copied the **entire** token (starts with `eyJ`)
- For Teams accounts, make sure to include `--account-id` (or let the tool auto-detect it)
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
4. Fetches the project list via `/backend-api/gizmos/snorlax/sidebar`, then indexes and downloads each project's conversations (use `--no-projects` to skip)
5. Scans conversation data for file references (`image_asset_pointer`, `canvas_asset_pointer`) and downloads via `/backend-api/files/download/{id}` (use `--no-files` to skip)
6. Saves to JSON and/or Markdown files
7. On auth failure, saves all progress and exits — re-running skips already-completed work

## License

MIT
