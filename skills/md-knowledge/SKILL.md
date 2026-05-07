---
name: md-knowledge
description: Markdown knowledge base for codebase documentation. Use when the user wants to understand project structure, find modules, APIs, configuration, or search the knowledge base. Also use when the user mentions .kb, knowledge base, or wants to document their codebase.
---

# Markdown Knowledge Base

This skill manages a markdown-based knowledge base stored in the `.kb/` directory of the project.

## Commands

### Initialize

```
/md-knowledge init
```

Scans the entire codebase and creates a `.kb/` folder containing:
- **state.json** — metadata, file hashes, timestamps
- **index.md** — navigable index grouped by category
- **\*.md entries** — one markdown file per logical group of files

Each entry has YAML frontmatter with:
- `title` — human-readable name
- `description` — one-line summary for quick scanning
- `category` — one of: architecture, module, api, config, data-model, testing, build, documentation, scripts, styles, infrastructure, general
- `tags` — language, technology, and topic tags
- `related` — links to related entries
- `sourceFiles` — the original source files this entry covers
- `updatedAt` — ISO timestamp

### Update

```
/md-knowledge update
```

Re-scans the codebase, detects changes (via git diff or file hashes), and updates only the affected entries.

### Add

```
/md-knowledge add
```

Captures the latest assistant output and saves it as a new knowledge base entry (or merges into an existing one). The user is prompted for title, category, and description.

## Agent Tool

The `kb_query` tool is available for searching the knowledge base:

```
kb_query(query="authentication", category="api")
```

This returns matching entries with relevance scores.

## Configuration

Optional `.kbrc.json` in the project root:

```json
{
  "ignorePatterns": ["custom-dir"],
  "maxEntryLines": 80,
  "maxSourceLines": 40,
  "includeExtensions": [],
  "includeContent": true
}
```

## Security

All content passes through a secret detection engine that redacts:
- Passwords and API keys
- Connection strings with credentials
- PEM private keys
- Bearer/Basic auth headers
- Environment variable secrets
- Well-known token formats (AWS, GitHub, Slack, Stripe, Google, etc.)

Files with sensitive names (`.env`, `credentials.json`, `*.pem`, etc.) are excluded entirely.
