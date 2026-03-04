# ChatGPT Conversation Exporter

Bulk export all your ChatGPT conversations using the backend API. Works with both personal and Teams accounts. **Resumable** — if your token expires mid-export, just run again with a fresh token and it picks up where it left off.

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
node export-chatgpt.js --bearer "eyJ..." --account-id "f3ae362d-..."
```

### 3. Find Your Exports

Conversations are saved to `./exports/`:
- `exports/json/` — Full conversation data in JSON format
- `exports/markdown/` — Human-readable Markdown files with YAML frontmatter
- `exports/conversation-index.json` — List of all conversations with metadata

Files are named with the pattern `{date}_{title}_{id}.{ext}`.

## Resumable Exports

The script tracks progress automatically:
- `exports/.export-progress.json` stores which conversations have been downloaded and where indexing left off
- If your token expires mid-export, the script saves progress and exits gracefully
- Just run again with a fresh Bearer token — already-downloaded conversations are skipped
- The conversation index is also built incrementally, resuming from the last page fetched

## Options

```
--bearer <token>      Bearer/Access token (recommended, required for Teams)
--account-id <id>     ChatGPT Account ID (required for Teams)
--token <token>       Session token (alternative auth method, personal accounts only)
--output <dir>        Output directory (default: ./exports)
--format <format>     Export format: json, markdown, or both (default: both)
--delay <ms>          Delay between API requests in ms (default: 1500)
--help                Show help message
```

You can also set the token via environment variables: `CHATGPT_BEARER_TOKEN` or `CHATGPT_SESSION_TOKEN`.

## Examples

```bash
# Export only JSON
node export-chatgpt.js --bearer "eyJ..." --format json

# Export to custom directory
node export-chatgpt.js --bearer "eyJ..." --output ~/Documents/chatgpt-backup

# Slower requests to avoid rate limiting
node export-chatgpt.js --bearer "eyJ..." --delay 3000

# Resume after token expiry — just run again
node export-chatgpt.js --bearer "fresh-eyJ..."
```

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
4. Saves to JSON and/or Markdown files
5. On auth failure, saves progress and exits — re-running skips already-completed work

## License

MIT
