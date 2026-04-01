# Changelog

All notable changes to the ChatGPT Conversation Exporter.

---

## v0.2.0 — 2026-03-31

Major feature release adding project, file, and deep research export support.

### New Features
- **Projects** — export all ChatGPT Project conversations; cursor-based pagination via sidebar API; per-project `conversation-index.json` and directory layout
- **Files** — download DALL-E images, canvas documents, and user-uploaded attachments; deduplication via file ID tracking
- **Deep research** — captures async research task results embedded in conversations (initiation + result messages)
- **Enhanced Markdown** — browsing results, reasoning/thinking collapsible `<details>` blocks, tool message rendering, deep research result headers, `project_id` frontmatter

### Architecture
- Refactored from single-file script to modular `lib/` layout (`config`, `cli`, `auth`, `storage`, `formatter`, `api`, `downloader`, `exporter`)
- Switched CLI argument parsing to `commander ^12.0.0`

### CLI Changes
- Added `--no-projects` / `--projects-only` flags for project export control
- Added `--no-files` / `--no-images` / `--no-canvas` / `--no-attachments` granular file download flags
- Added `--verbose` flag
- Reduced interactive prompts to bearer token input only (all other config via flags)

---

## v0.1.1 — 2026-03-04

**Audit sync** — Aligned SPECIFICATION.md and TODO.md with the implemented codebase.

### SPECIFICATION.md changes
- Updated interactive prompt defaults from `(Y/n)` to `(y/N)` for update mode, projects, and files prompts (sections 4.4)
- Added per-project `conversation-index.json` to output structure diagram (section 7.1)
- Added `project_id` frontmatter field to Markdown example (section 8.2)
- Added enhanced content type rendering table (section 8.2): multimodal_text, tether_browsing_display, thoughts, reasoning_recap, model_editable_context
- Added tool message rendering table (section 8.2): research_kickoff_tool, file_search, generic tools
- Added deep research result message rendering documentation (section 8.2)
- Changed `model_editable_context` handling from "Skip or include" to "Omitted from Markdown output" (section 9.2)
- Added file download retry documentation (section 13.3)
- Made hidden message handling definitive: "omitted from Markdown output" (section 16, constraint 9)

### TODO.md changes
- Marked Phases 1–7 and documentation update tasks as complete
- Remaining open items: optional SSE research stream capture, end-to-end manual testing

---

## v0.1.0 — 2025-03-04

Initial SPECIFICATION.md and TODO.md created.
