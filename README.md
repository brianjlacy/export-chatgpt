# ChatGPT Conversation Exporter

Bulk export all your ChatGPT conversations using the backend API. Works with both personal and Teams accounts by using the Bearer token from DevTools.

## Requirements

- Node.js 18+ (uses native `fetch`)

## Quick Start

### 1. Get Your Bearer Token

1. Open https://chatgpt.com in your browser and make sure you're logged in
2. Open DevTools (F12) → **Network** tab
3. Refresh the page or click on a conversation
4. Find a request to `backend-api/conversations`
5. Look in the Request Headers for `authorization: Bearer eyJ...`
6. Copy the token (the part starting with `eyJ`)

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
```

## Troubleshooting

### "Authentication failed"
- Bearer tokens expire quickly — get a fresh one from DevTools
- Make sure you copied the **entire** token (starts with `eyJ`)
- For Teams accounts, make sure to include `--account-id`

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
2. Fetches the list of all conversations via `/backend-api/conversations` (paginated, 28 per page)
3. Downloads each conversation's full content via `/backend-api/conversation/{id}`
4. Saves to JSON and/or Markdown files

## License

MIT
