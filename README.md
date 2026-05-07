# pi-md-knowledge

> Markdown knowledge base generator for the [Pi coding agent](https://pi.dev).

Scans your codebase and creates a navigable `.kb/` folder of markdown documents that AI agents can use to quickly understand your project — without reading every file.

## Features

- 🔍 **Smart scanning** — Classifies files by type (API, config, data models, tests, etc.)
- 📝 **Agent-friendly markdown** — Each entry has YAML frontmatter with tags, descriptions, and cross-references
- 🔒 **Secret redaction** — Automatically detects and redacts passwords, API keys, tokens, and private keys
- 🧩 **Token-efficient** — Entries are concise; agents fetch only what they need via `kb_query`
- 🔄 **Incremental updates** — Detects changes via git diff or file hashes
- ➕ **Manual additions** — Capture assistant output into the knowledge base
- 🤖 **Auto-discovery** — The agent is automatically notified when a `.kb/` exists

## Installation

```bash
pi install npm:pi-md-knowledge
```

Or install locally:

```bash
pi install ./path/to/pi-md-knowledge
```

Or try without installing:

```bash
pi -e ./path/to/pi-md-knowledge
```

## Usage

### Initialize

```bash
/md-knowledge init
```

Scans your codebase and creates `.kb/` with:
- `state.json` — Metadata, file hashes, timestamps
- `index.md` — Navigable index grouped by category
- `*.md` — Individual knowledge entries

### Update

```bash
/md-knowledge update
```

Re-scans the codebase, detects changes, and updates only affected entries.

### Add

```bash
/md-knowledge add
```

Captures the latest assistant output and saves it as a new entry (or merges into an existing one).

### Agent Tool

The `kb_query` tool is automatically available to the agent:

```
kb_query(query="authentication", category="api")
```

Returns matching entries with relevance scores, so the agent can find project information efficiently.

## Knowledge Base Structure

```
.kb/
├── state.json                    # Metadata & file hashes
├── index.md                      # Navigable index
├── module_src_auth.md            # Auth module entry
├── api_routes.md                 # API routes entry
├── config_tsconfig.md            # Configuration entry
├── data-model_prisma.md          # Data model entry
├── testing_tests.md              # Testing entry
└── ...
```

Each entry looks like:

```markdown
---
title: "src/auth"
description: "TypeScript file — exports: authenticate, validateToken, hashPassword"
category: module
tags:
  - typescript
  - module
related:
  - ./src/users
updatedAt: "2025-01-15T10:30:00.000Z"
sourceFiles:
  - src/auth/index.ts
  - src/auth/tokens.ts
---

## Overview
This entry covers **2 file(s)** in the `src/auth` directory.

## Files
| File | Lines | Language | Key Exports |
|------|-------|----------|-------------|
| `src/auth/index.ts` | 45 | TypeScript | authenticate, validateToken |
| `src/auth/tokens.ts` | 32 | TypeScript | hashPassword |

## Key Exports
- `authenticate`
- `validateToken`
- `hashPassword`

## Source
### `src/auth/index.ts`
```typescript
// ... truncated for tokens ...
```
```

## Categories

| Category | Description |
|----------|-------------|
| `architecture` | High-level project structure and design decisions |
| `module` | Source code modules and their responsibilities |
| `api` | API endpoints, routes, controllers, handlers |
| `config` | Project configuration files and settings |
| `data-model` | Database schemas, models, data structures |
| `testing` | Test files and test configurations |
| `build` | Build scripts, Dockerfiles, CI/CD |
| `documentation` | README files, guides, docs |
| `scripts` | Utility scripts and automation |
| `styles` | CSS, SCSS, and styling files |
| `infrastructure` | Infrastructure as code, deployment configs |
| `general` | Miscellaneous project files |

## Configuration

Create an optional `.kbrc.json` in your project root:

```json
{
  "ignorePatterns": ["custom-dir", "generated"],
  "maxEntryLines": 200,
  "maxSourceLines": 100,
  "includeExtensions": [],
  "includeContent": true
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `ignorePatterns` | `[]` | Additional directories/patterns to exclude |
| `maxEntryLines` | `200` | Max lines per knowledge entry |
| `maxSourceLines` | `100` | Max source lines to include per file |
| `includeExtensions` | `[]` | Only include these file extensions (empty = all) |
| `includeContent` | `true` | Include source code in entries (false = structure only) |

## Secret Detection

All content passes through a secret detection engine that redacts:

- Password assignments (`password = "..."`)
- API keys (`api_key = "..."`, `secret_key = "..."`)
- Connection strings with credentials (`mongodb://user:pass@...`)
- Bearer/Basic auth headers
- PEM private key blocks
- Well-known token formats (AWS, GitHub, Slack, Stripe, Google, etc.)
- Environment variable secrets (`DATABASE_URL`, `JWT_SECRET`, etc.)

Files with sensitive names are excluded entirely:
- `.env`, `.env.local`, `.env.production`
- `credentials.json`, `serviceAccountKey.json`
- `*.pem`, `*.key`, `id_rsa`, `id_ed25519`
- `.npmrc`, `.netrc`

## Package Structure

```
pi-md-knowledge/
├── package.json
├── README.md
├── extensions/
│   ├── index.ts              # Main extension (commands + kb_query tool)
│   └── src/
│       ├── types.ts          # Type definitions and constants
│       ├── config.ts         # Configuration loader
│       ├── scanner.ts        # Codebase scanner & classifier
│       ├── writer.ts         # KB I/O (read/write entries, state, index)
│       └── sanitize.ts       # Secret detection & redaction
├── skills/
│   └── md-knowledge/
│       └── SKILL.md          # Skill definition for auto-discovery
└── test/
    └── md-knowledge.test.ts  # Tests
```

## License

MIT
