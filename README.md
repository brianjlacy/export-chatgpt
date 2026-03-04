# ChatGPT Conversation Exporter

Bulk export all your ChatGPT conversations using the backend API. Works by authenticating with your browser session token.

## Requirements

- Node.js 18+ (uses native `fetch`)

## Quick Start

### 1. Get Your Session Token

1. Open https://chatgpt.com in your browser and make sure you're logged in
2. Open DevTools (F12 or Cmd+Option+I)
3. Go to **Application** tab → **Cookies** → **https://chatgpt.com**
4. Find `__Secure-next-auth.session-token` and copy its **entire** value

> ⚠️ This token is like a password - don't share it with anyone!

### 2. Run the Export

```bash
# Option A: Set environment variable
export CHATGPT_SESSION_TOKEN="your-token-here"
node export-chatgpt.js

# Option B: Pass as argument
node export-chatgpt.js --token "your-token-here"
```

### 3. Find Your Exports

Conversations are saved to `./exports/`:
- `exports/json/` - Full conversation data in JSON format
- `exports/markdown/` - Human-readable Markdown files
- `exports/conversation-index.json` - List of all conversations with metadata

## Options

```
--token <token>    Session token (or set CHATGPT_SESSION_TOKEN env var)
--output <dir>     Output directory (default: ./exports)
--format <format>  Export format: json, markdown, or both (default: both)
--delay <ms>       Delay between API requests in ms (default: 1500)
--help             Show help message
```

## Examples

```bash
# Export only JSON
node export-chatgpt.js --format json

# Export to custom directory
node export-chatgpt.js --output ~/Documents/chatgpt-backup

# Slower requests to avoid rate limiting
node export-chatgpt.js --delay 3000
```

## Troubleshooting

### "Authentication failed"
- Your session token may have expired - get a fresh one from the browser
- Make sure you copied the **entire** token (they're very long)
- Verify you're logged into the correct ChatGPT account

### "No conversations found"
This likely means one of:
- **ChatGPT Teams limitation**: Teams workspace conversations may not be accessible via the API (this is the same restriction that blocks the UI export)
- You're logged into a different workspace than expected
- The account genuinely has no conversations

### Rate limiting
If you see 429 errors, the script will automatically wait and retry. You can also increase the delay:
```bash
node export-chatgpt.js --delay 3000
```

## For ChatGPT Teams Users

If this script returns no conversations or only returns your personal workspace conversations (not Teams), then unfortunately OpenAI is blocking API access the same way they block the UI export.

In that case, your remaining options are:
1. **GDPR/CCPA request** - Email privacy@openai.com requesting your data (if you're in a covered jurisdiction)
2. **Contact your Teams admin** - They may have access to compliance/audit exports
3. **Contact OpenAI support** - Explain your need for data portability

## How It Works

1. Uses your session token to get an API access token
2. Fetches the list of all conversations via `/backend-api/conversations`
3. Downloads each conversation's full content via `/backend-api/conversation/{id}`
4. Saves to JSON and/or Markdown files

## License

MIT
