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
- Optional: Playwright + Chromium for the `--browser-fetch` Cloudflare bypass — `npm install playwright && npx playwright install chromium`

## Quick Start

> **Important:** If you have multiple ChatGPT accounts, make sure you're only logged into the one you want to export. Being logged into more than one account at the same time can cause ChatGPT to return data from the wrong account.

### 1. Get Your Bearer Token

1. Open https://chatgpt.com in your browser and make sure you're logged in
2. Open DevTools (F12) → **Network** tab
3. Refresh the page or click on a conversation
4. Filter requests: `backend-api/conversations`
5. Click on a matching request, find the **Authorization** header under Request Headers, and copy the token (just the `eyJ...` part after `Bearer`)

> **Warning:** Bearer tokens can expire quickly — you may want to get a fresh one each time you run the export.

### 2. Using the Exporter

**Setup:**

```bash
npm install
```

**Run:**

```bash
npx export-chatgpt
```

### 3. Find Your Exports

By default, conversations are saved to `./exports/{user_id}`:

```
exports/{user_id}
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
- `exports/{user_id}/.export-progress.json` stores which conversations have been downloaded and where indexing left off
- If your token expires mid-export (or Cloudflare interrupts you), the script saves progress and exits gracefully
- Just run again with a fresh Bearer token — already-downloaded conversations are skipped
- The conversation index is also built incrementally, resuming from the last page fetched
- Adaptive pacing snapshots are persisted alongside progress and restored on resume (with time-decay so a long pause doesn't strand you at yesterday's high interval). Pass `--reset-pacing` to ignore the snapshot and start at baseline.

## Options

```
--bearer <token>        Bearer/access token (or set CHATGPT_BEARER_TOKEN env var; prompted if omitted)
--token <token>         Session token (alternative auth, personal accounts only; or set CHATGPT_SESSION_TOKEN)
--account-id <id>       ChatGPT Teams account ID (auto-detected from token when possible)
-o, --output <dir>      Output directory (default: ./exports)
--format <format>       Export format: json | markdown | both (default: both)
--throttle <seconds>    Minimum interval between requests, in seconds. Acts as a floor for
                        adaptive pacing — pacing may climb above it on 429s but never below.
                        0 disables pacing entirely. Omit for pure adaptive (payload 2s /
                        indexing 5s baseline, climbs on 429s).
--include-archived      Also fetch archived conversations. OpenAI's listing defaults to
                        is_archived=false; accounts that have bulk-archived may be missing
                        a significant chunk of history without this flag.
--update                Re-download and overwrite existing conversations
--no-projects           Skip project conversations (projects are exported by default)
--projects-only         Export only project conversations (skip regular)
--no-files              Skip ALL file downloads (overrides --no-images / --no-canvas / --no-attachments)
--no-images             Skip downloading DALL-E images
--no-canvas             Skip downloading canvas documents
--no-attachments        Skip downloading other file attachments
--no-user-dir           Do not nest exports inside a user ID subdirectory
--max <n>               Only download the next N conversations this session (also -N, e.g. -7)
--conv <ids>            Only download specific conversation ID(s), comma-separated
--proj <ids>            Only download specific project ID(s), comma-separated
--reset-pacing          Ignore the persisted pacing snapshot from the previous run and
                        start at baseline. Useful when resuming after a long pause — the
                        rate-limit bucket has likely drained, and inheriting a high
                        interval strands throughput.
--verify                Dry-run: scan progress + disk and report any conversations marked
                        downloaded but missing from disk, then exit. No network calls.
--refetch-missing       Before running, remove from progress any downloaded IDs that have
                        no corresponding file on disk, so the main loop re-fetches them.
                        Useful for recovering from silent skips caused by filename
                        collisions or mid-run write failures.
--browser-fetch         Route all API calls through a headless Chrome (Playwright) to
                        bypass Cloudflare IP reputation blocks. Requires Playwright +
                        Chromium installed. See "Cloudflare challenge" below.
-n, --non-interactive   Run without any interactive prompts (requires --bearer or --token)
--no-summary            Suppress the export summary at the end
--no-donate             Suppress the donation message/prompt
--verbose               Show detailed request/response info and full error messages
-v, --version           Output the version number
--help                  Show help message
```

### Token via Environment Variables

To avoid having to paste your token each time:
```bash
export CHATGPT_BEARER_TOKEN="eyJ..."
npx export-chatgpt
```

### Interactive Mode

The only interactive prompt is the bearer token — if neither `--bearer`, `--token`, nor the corresponding environment variables are provided, the script will prompt you to enter a token.

## Examples

```bash
# Export everything (conversations, projects, images, canvas, attachments)
npx export-chatgpt

# Skip project conversations
npx export-chatgpt --no-projects

# Only project conversations, skip file downloads
npx export-chatgpt --projects-only --no-files

# Export only JSON format (default is both json and markdown)
npx export-chatgpt --format json

# Export to custom directory
npx export-chatgpt --output ~/Documents/chatgpt-backup

# Floor adaptive pacing at 90s/request (pacing may still climb higher on 429s)
npx export-chatgpt --throttle 90

# Re-download all conversations (overwrite existing)
npx export-chatgpt --update

# Skip images but keep canvas and attachments
npx export-chatgpt --no-images

# Resume after token expiry — just run again with a fresh token
npx export-chatgpt

# Resume after a long pause without inheriting yesterday's slow pacing
npx export-chatgpt --reset-pacing

# Include archived conversations (off by default)
npx export-chatgpt --include-archived

# Cloudflare blocking your IP? Route through headless Chrome
npx export-chatgpt --browser-fetch

# Audit existing exports — flag downloaded-but-missing-from-disk conversations
npx export-chatgpt --verify

# Recover from silent skips: re-fetch any IDs marked done but missing on disk
npx export-chatgpt --refetch-missing

# Limit to 10 conversations this session
npx export-chatgpt --max 10

# Non-interactive mode (for scripts/CI — requires --bearer or ENV variable as below)
CHATGPT_BEARER_TOKEN="eyJ..." npx export-chatgpt --non-interactive
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
- **If a fresh token still fails with 403,** the problem may be Cloudflare, not auth — see [Cloudflare challenge (looks like an auth failure)](#cloudflare-challenge-looks-like-an-auth-failure) below before rotating tokens again.

### Cloudflare challenge (looks like an auth failure)
On long-running exports (multi-hour, many thousands of conversations) it's possible to trip Cloudflare's IP reputation heuristic. The exporter currently maps every 403 response to "Authentication failed," but Cloudflare's challenge page is also a 403 — so the error message is misleading.

**Symptoms:**
- "Token expired during download" appears mid-run even though the JWT's `exp` claim is hours or days away
- A freshly copied token from DevTools fails immediately with the same error
- Running `curl -I https://chatgpt.com/` from the same machine returns `HTTP/2 403` with a `cf-mitigated: challenge` response header (this is the diagnostic — if you see that header, it's Cloudflare, not OpenAI)

**What it is:** Cloudflare has flagged your machine's IP based on traffic pattern and is serving an anti-bot interstitial instead of passing requests through to OpenAI. Your token is irrelevant to the 403 at this point.

**What doesn't work:**
- Rotating your bearer token (it wasn't an auth issue)
- Copying `cf_clearance` / `__cf_bm` cookies from your browser — Cloudflare binds `cf_clearance` to the browser's TLS fingerprint (JA3/JA4), so cookies transplanted into `curl` or Node's `fetch` are rejected even when valid in the browser
- Running from a different machine on the same NAT (same public IP → same reputation)
- Most datacenter VPN exits (GCP/AWS, many commercial VPN providers' bulk ranges) — Cloudflare blocks those for ChatGPT regardless of reputation

**What works:**
- **`--browser-fetch` (built-in bypass).** Routes every API call through a headless Chromium instance via Playwright. The browser solves the Cloudflare managed challenge once at startup, then API calls ride the same session as `page.goto()` navigations (which Cloudflare's WAF treats more leniently than `fetch()`). One-time setup:
  ```bash
  npm install playwright
  npx playwright install chromium     # full Chromium, NOT chromium-headless-shell
  npx export-chatgpt --browser-fetch --reset-pacing
  ```
  Note: the bundled `chromium-headless-shell` build fails the managed challenge — the exporter explicitly uses Playwright's full Chromium binary via `chromium.executablePath()`. If you see "Incompatible browser extension or network configuration" from Cloudflare, you're on the headless shell; reinstall with `npx playwright install chromium`.
- **Wait it out.** Cloudflare does not publish an IP-reputation TTL, but community reports place recovery in the hours-to-~24h range. Probe with `curl -o /dev/null -w '%{http_code}\n' https://chatgpt.com/` every 30 min; a 200 (or a redirect) means you're clear.
- **Run from a different public IP** (different residential network / mobile hotspot / consumer VPN endpoint). Mid-run, progress is portable via `.export-progress.json`, so you can `rsync` the output directory to another machine and resume there.
- **Finish the last stretch from your browser** via a DevTools Console snippet that uses `fetch('/backend-api/conversation/<id>', { credentials: 'include' })`. Your browser already has a valid Cloudflare session, so it bypasses the block. Useful when you're at 90%+ and just need a handful more.

**Detection:**
- The exporter distinguishes Cloudflare 403s from auth 403s by inspecting the `cf-mitigated: challenge` response header. If it sees that header, the error message says "Cloudflare challenge detected (IP reputation flag)" rather than "Authentication failed" — saves you from chasing token rotations that wouldn't have helped.

**Prevention:**
- The adaptive pacing (default) already self-limits on 429s, which reduces the chance of tripping the CF heuristic — don't override it with `--throttle 0` on long runs
- Avoid tight restart loops (kill + relaunch + kill within minutes) — each restart's initial burst looks bot-like
- If you must run overnight unattended, expect at least one interruption; the resumable-progress design is there for exactly this reason
- After a long pause (hours), pair the resume with `--reset-pacing` so you don't inherit yesterday's high interval against a fresh rate-limit bucket

### "No conversations found"
This likely means one of:
- **Teams account without `--account-id`**: You need to pass your account ID for Teams workspaces
- You're logged into a different workspace than expected
- The account genuinely has no conversations

### Rate limiting
If you see 429 errors, the script will automatically wait and retry. You can also increase the throttle:
```bash
npx export-chatgpt --throttle 90
```

## How It Works

1. Uses your Bearer token directly for API authentication (or exchanges a session token for one)
2. Incrementally fetches the conversation list via `/backend-api/conversations` (28 per page), saving progress after each page
3. Downloads each conversation's full content via `/backend-api/conversation/{id}`, tracking completed downloads
4. Fetches the project list via `/backend-api/gizmos/snorlax/sidebar`, then indexes and downloads each project's conversations (use `--no-projects` to skip)
5. Scans conversation data for file references (`image_asset_pointer`, `canvas_asset_pointer`) and downloads via `/backend-api/files/download/{id}` (use `--no-files` to skip)
6. Saves to JSON and/or Markdown files
7. On auth failure or Cloudflare challenge, saves all progress and exits — re-running skips already-completed work

**Adaptive pacing.** Rather than a fixed sleep between requests, the exporter maintains separate intervals for indexing (paginated list calls) and payload (per-conversation detail) phases. On a 429, it raises the interval; after a streak of clean responses, it eases back down. The current snapshot is persisted to `.export-progress.json` so a resume picks up at roughly the same throughput. `--throttle <s>` sets a floor (pacing may climb above it but never below); `--throttle 0` disables pacing entirely (don't do this on long runs).

**Cloudflare bypass.** With `--browser-fetch`, the exporter launches a Playwright-driven headless Chromium, navigates to chatgpt.com to clear the Cloudflare managed challenge, then proxies all API calls through `page.goto()` rather than `fetch()`. This is necessary on long runs because Cloudflare's WAF challenges in-page `fetch()` (Sec-Fetch-Mode: cors) more aggressively than navigations. Auth headers are injected via `page.setExtraHTTPHeaders()` before each call.

## License

MIT
