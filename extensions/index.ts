/**
 * pi-md-knowledge — Markdown Knowledge Base for Pi Coding Agent
 *
 * Provides:
 *   /md-knowledge init    — Scan codebase and create .kb knowledge base
 *   /md-knowledge update  — Re-scan and update the knowledge base
 *   /md-knowledge add     — Add latest assistant output to the knowledge base
 *
 * Registers a `kb_query` tool so the agent can search the KB on demand.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { join, basename } from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { loadConfig } from "./src/config.js";
import { scanCodebase, scanChangedFiles } from "./src/scanner.js";
import {
	KB_DIR,
	kbExists,
	readState,
	writeKnowledgeBase,
	updateKnowledgeBase,
	ensureKbDir,
	readEntry,
	listEntries,
	generateIndex,
	writeEntry,
} from "./src/writer.js";
import type { KbEntry, KbEntryFrontmatter, AddResult } from "./src/types.js";
import { sanitizeContent } from "./src/sanitize.js";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

async function getHeadCommit(cwd: string, execFn: ExtensionAPI["exec"]): Promise<string | undefined> {
	try {
		const result = await execFn("git", ["rev-parse", "HEAD"], { cwd, timeout: 5000 });
		if (result.code === 0) return result.stdout.trim();
	} catch {
		// Not a git repo
	}
	return undefined;
}

async function getChangedFilesSince(
	cwd: string,
	commitHash: string,
	execFn: ExtensionAPI["exec"],
): Promise<string[]> {
	try {
		const result = await execFn("git", ["diff", "--name-only", commitHash + "..HEAD"], {
			cwd,
			timeout: 10000,
		});
		if (result.code === 0) {
			return result.stdout
				.trim()
				.split("\n")
				.filter((l) => l.length > 0);
		}
	} catch {
		// Fall through
	}
	return [];
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleInit(pi: ExtensionAPI, cwd: string, ctx: any): Promise<void> {
	// Check if KB already exists
	if (await kbExists(cwd)) {
		const overwrite = await ctx.ui.confirm(
			"Knowledge base exists",
			"A .kb folder already exists. Re-initialize from scratch?",
		);
		if (!overwrite) {
			ctx.ui.notify("Init cancelled.", "info");
			return;
		}
	}

	ctx.ui.setStatus("md-knowledge", "Scanning codebase...");

	const config = await loadConfig(cwd);
	const { entries, fileHashes, totalFilesScanned } = await scanCodebase(cwd, config);
	const lastCommit = await getHeadCommit(cwd, pi.exec);

	const result = await writeKnowledgeBase(cwd, entries, fileHashes, lastCommit);

	ctx.ui.setStatus("md-knowledge", undefined);

	const catList = Object.entries(result.categories)
		.map(([cat, n]) => `${cat}: ${n}`)
		.join(", ");

	ctx.ui.notify(
		`Knowledge base created!\n` +
			`  Files scanned: ${result.filesScanned}\n` +
			`  Entries created: ${result.entriesCreated}\n` +
			`  Categories: ${catList}\n` +
			`  Duration: ${result.durationMs}ms\n` +
			`  Location: .kb/`,
		"info",
	);
}

async function handleUpdate(pi: ExtensionAPI, cwd: string, ctx: any): Promise<void> {
	if (!(await kbExists(cwd))) {
		ctx.ui.notify("No knowledge base found. Run /md-knowledge init first.", "error");
		return;
	}

	const state = await readState(join(cwd, KB_DIR));
	if (!state) {
		ctx.ui.notify("Invalid knowledge base state. Run /md-knowledge init to re-create.", "error");
		return;
	}

	ctx.ui.setStatus("md-knowledge", "Detecting changes...");

	const config = await loadConfig(cwd);

	// Try git-based diff first
	let changedFiles: string[] | null = null;
	if (state.lastCommitHash) {
		const gitChanged = await getChangedFilesSince(cwd, state.lastCommitHash, pi.exec);
		if (gitChanged.length > 0) {
			changedFiles = gitChanged;
		}
	}

	// Fall back to hash-based change detection
	const { changed, removed, added } = await scanChangedFiles(cwd, config, state.fileHashes);

	const allChanged = new Set([...changed, ...added]);
	if (changedFiles) {
		for (const f of changedFiles) allChanged.add(f);
	}

	if (allChanged.size === 0 && removed.length === 0) {
		ctx.ui.setStatus("md-knowledge", undefined);
		ctx.ui.notify("Knowledge base is up to date. No changes detected.", "info");
		return;
	}

	ctx.ui.setStatus("md-knowledge", `Updating ${allChanged.size} changed, ${removed.length} removed...`);

	// Re-scan fully to regenerate entries
	const { entries, fileHashes, totalFilesScanned } = await scanCodebase(cwd, config);
	const lastCommit = await getHeadCommit(cwd, pi.exec);

	// Determine which entries to remove (files that no longer exist)
	const existingEntries = await listEntries(join(cwd, KB_DIR));
	const entriesToRemove: string[] = [];

	for (const entryFile of existingEntries) {
		const entry = await readEntry(join(cwd, KB_DIR), entryFile);
		if (entry) {
			const sourceExists = entry.frontmatter.sourceFiles.some((sf) => allChanged.has(sf) || removed.includes(sf));
			if (sourceExists || entry.frontmatter.sourceFiles.every((sf) => removed.includes(sf))) {
				// This entry touches changed or removed files — it will be regenerated
				entriesToRemove.push(entryFile);
			}
		}
	}

	const result = await updateKnowledgeBase(cwd, entries, fileHashes, entriesToRemove, lastCommit);

	ctx.ui.setStatus("md-knowledge", undefined);
	ctx.ui.notify(
		`Knowledge base updated!\n` +
			`  Files scanned: ${result.filesScanned}\n` +
			`  Entries updated: ${result.entriesUpdated}\n` +
			`  Entries removed: ${result.entriesRemoved}\n` +
			`  Duration: ${result.durationMs}ms`,
		"info",
	);
}

async function handleAdd(pi: ExtensionAPI, cwd: string, ctx: any): Promise<void> {
	// Get the latest assistant message from the session
	const entries = ctx.sessionManager.getBranch();
	let latestAssistantContent = "";
	let latestAssistantId = "";

	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "message" && entry.message.role === "assistant") {
			const msg = entry.message;
			if (msg.content && Array.isArray(msg.content)) {
				for (const block of msg.content) {
					if (block.type === "text" && block.text) {
						latestAssistantContent = block.text;
						latestAssistantId = entry.id;
						break;
					}
				}
			}
			if (latestAssistantContent) break;
		}
	}

	if (!latestAssistantContent) {
		ctx.ui.notify("No assistant output found in the current session.", "error");
		return;
	}

	if (!(await kbExists(cwd))) {
		// Auto-init if no KB exists
		await handleInit(pi, cwd, ctx);
	}

	const kbDir = await ensureKbDir(cwd);
	const now = new Date().toISOString();

	// Sanitize the content
	const { content: sanitizedContent, redactionCount } = sanitizeContent(latestAssistantContent);

	// Ask user for metadata
	const title = await ctx.ui.input("Entry title:", "Assistant Output");
	if (!title) {
		ctx.ui.notify("Add cancelled.", "info");
		return;
	}

	const category = await ctx.ui.select("Category:", [
		"architecture",
		"module",
		"api",
		"config",
		"data-model",
		"testing",
		"build",
		"documentation",
		"scripts",
		"styles",
		"infrastructure",
		"general",
	]);

	if (!category) {
		ctx.ui.notify("Add cancelled.", "info");
		return;
	}

	const description = await ctx.ui.input("Short description:", "Knowledge captured from assistant output");
	if (!description) {
		ctx.ui.notify("Add cancelled.", "info");
		return;
	}

	// Check if we should update an existing entry or create new
	const existingFiles = await listEntries(kbDir);
	const shouldUpdate = await ctx.ui.confirm("Update existing entry?", "Merge into an existing entry instead of creating new?");

	let filename: string;
	let created: boolean;

	if (shouldUpdate) {
		const selected = await ctx.ui.select("Select entry to update:", existingFiles);
		if (!selected) {
			ctx.ui.notify("Add cancelled.", "info");
			return;
		}

		const existing = await readEntry(kbDir, selected);
		if (!existing) {
			ctx.ui.notify("Could not read entry.", "error");
			return;
		}

		// Append content
		existing.content += `\n\n---\n\n## Assistant Output (${now})\n\n${sanitizedContent}`;
		existing.frontmatter.updatedAt = now;
		existing.frontmatter.tags = [...new Set([...existing.frontmatter.tags, "assistant-output"])];
		await writeEntry(kbDir, existing);
		filename = selected;
		created = false;
	} else {
		// Create new entry
		const safeName = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
		filename = `assistant-${safeName}.md`;

		const frontmatter: KbEntryFrontmatter = {
			title,
			description,
			category: category as KbEntryFrontmatter["category"],
			tags: ["assistant-output", "manually-added"],
			related: [],
			updatedAt: now,
			sourceFiles: [],
		};

		const content = `## Assistant Output\n\nCaptured from assistant session on ${now}.\n\n${sanitizedContent}`;
		const entry: KbEntry = { filename, frontmatter, content };
		await writeEntry(kbDir, entry);
		created = true;
	}

	// Re-generate index
	const allEntryFiles = await listEntries(kbDir);
	const allEntries: KbEntry[] = [];
	for (const f of allEntryFiles) {
		const e = await readEntry(kbDir, f);
		if (e) allEntries.push(e);
	}
	await generateIndex(kbDir, allEntries);

	// Update state
	const state = await readState(kbDir);
	if (state) {
		state.updatedAt = now;
		state.summary.totalEntries = allEntries.length;
		await writeFile(join(kbDir, "state.json"), JSON.stringify(state, null, 2), "utf-8");
	}

	const redactionMsg = redactionCount > 0 ? `\n  ⚠ ${redactionCount} potential secret(s) redacted` : "";
	ctx.ui.notify(
		`${created ? "Created" : "Updated"} entry: ${filename}${redactionMsg}`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function mdKnowledgeExtension(pi: ExtensionAPI) {
	// Register the main command with subcommand completion
	pi.registerCommand("md-knowledge", {
		description: "Manage the markdown knowledge base (.kb/)",
		getArgumentCompletions: (prefix: string) => {
			const subcommands = [
				{ value: "init", label: "init — Scan codebase and create knowledge base" },
				{ value: "update", label: "update — Re-scan and update knowledge base" },
				{ value: "add", label: "add — Add latest assistant output to knowledge base" },
			];
			const filtered = subcommands.filter((s) => s.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const subcommand = (args || "").trim().split(/\s+/)[0] || "";
			const cwd = ctx.cwd;

			switch (subcommand) {
				case "init":
					await handleInit(pi, cwd, ctx);
					break;
				case "update":
					await handleUpdate(pi, cwd, ctx);
					break;
				case "add":
					await handleAdd(pi, cwd, ctx);
					break;
				default:
					ctx.ui.notify(
						"Usage: /md-knowledge <init|update|add>\n" +
							"  init    — Scan codebase and create .kb/ knowledge base\n" +
							"  update  — Re-scan and update the knowledge base\n" +
							"  add     — Add latest assistant output to the knowledge base",
						"info",
					);
			}
		},
	});

	// Register kb_query tool — lets the agent search the KB on demand
	pi.registerTool({
		name: "kb_query",
		label: "Query Knowledge Base",
		description:
			"Search the project's markdown knowledge base (.kb/) for information about the codebase. " +
			"Use when you need to understand project structure, find modules, APIs, or configuration. " +
			"Returns matching entry content. If the .kb/ folder doesn't exist, suggest running /md-knowledge init.",
		promptSnippet: "Search the project knowledge base for architecture, modules, or APIs",
		promptGuidelines: [
			"Use kb_query to look up project information in the .kb/ knowledge base before reading many files individually.",
			"If kb_query reports no knowledge base, suggest the user run /md-knowledge init to create one.",
		],
		parameters: Type.Object({
			query: Type.String({
				description:
					"Search query: a keyword, category name, module path, tag, or filename to look up in the knowledge base",
			}),
			category: Type.Optional(
				Type.String({
					description: "Optional category filter: architecture, module, api, config, data-model, testing, build, documentation, scripts, styles, infrastructure, general",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const kbDir = join(ctx.cwd, KB_DIR);

			// Check if KB exists
			try {
				const { stat } = await import("node:fs/promises");
				await stat(join(kbDir, "state.json"));
			} catch {
				return {
					content: [
						{
							type: "text",
							text: "No knowledge base found. The .kb/ folder does not exist or has no state.json. " +
								"Ask the user to run `/md-knowledge init` to create one.",
						},
					],
					details: { exists: false },
				};
			}

			// Read all entries
			const entryFiles = await listEntries(kbDir);
			const allEntries: KbEntry[] = [];

			for (const f of entryFiles) {
				const entry = await readEntry(kbDir, f);
				if (entry) allEntries.push(entry);
			}

			if (allEntries.length === 0) {
				return {
					content: [{ type: "text", text: "Knowledge base is empty. No entries found." }],
					details: { exists: true, entryCount: 0 },
				};
			}

			const query = params.query.toLowerCase();
			const categoryFilter = params.category?.toLowerCase();

			// Score entries by relevance
			const scored = allEntries.map((entry) => {
				let score = 0;
				const fm = entry.frontmatter;

				// Title match (high weight)
				if (fm.title.toLowerCase().includes(query)) score += 10;

				// Category match
				if (fm.category.toLowerCase().includes(query)) score += 5;
				if (categoryFilter && fm.category === categoryFilter) score += 20;

				// Tag match
				for (const tag of fm.tags) {
					if (tag.toLowerCase().includes(query)) score += 3;
				}

				// Source file match
				for (const sf of fm.sourceFiles) {
					if (sf.toLowerCase().includes(query)) score += 4;
				}

				// Description match
				if (fm.description.toLowerCase().includes(query)) score += 3;

				// Content match
				if (entry.content.toLowerCase().includes(query)) score += 2;

				// Related match
				for (const rel of fm.related) {
					if (rel.toLowerCase().includes(query)) score += 2;
				}

				return { entry, score };
			});

			// Filter to matching entries
			const matching = scored
				.filter((s) => s.score > 0 || !categoryFilter)
				.sort((a, b) => b.score - a.score)
				.slice(0, 5);

			if (matching.length === 0) {
				// Return available categories and tags for guidance
				const categories = [...new Set(allEntries.map((e) => e.frontmatter.category))];
				const tags = [...new Set(allEntries.flatMap((e) => e.frontmatter.tags))].slice(0, 20);
				const titles = allEntries.map((e) => e.frontmatter.title).slice(0, 15);

				return {
					content: [
						{
							type: "text",
							text: `No entries matched "${params.query}".\n\n` +
								`Available categories: ${categories.join(", ")}\n` +
								`Popular tags: ${tags.join(", ")}\n` +
								`Entry titles: ${titles.join(", ")}`,
						},
					],
					details: { exists: true, entryCount: allEntries.length, matched: 0 },
				};
			}

			// Build result with matching entries
			const resultParts = matching.map(({ entry, score }) => {
				return `### ${entry.frontmatter.title}\n` +
					`Category: ${entry.frontmatter.category} | Files: ${entry.frontmatter.sourceFiles.length} | Score: ${score}\n` +
					`${entry.frontmatter.description}\n\n` +
					`${entry.content.slice(0, 2000)}${entry.content.length > 2000 ? "\n...(truncated)" : ""}`;
			});

			return {
				content: [
					{
						type: "text",
						text: `Found ${matching.length} matching entries (of ${allEntries.length} total):\n\n` +
							resultParts.join("\n\n---\n\n"),
					},
				],
				details: {
					exists: true,
					entryCount: allEntries.length,
					matched: matching.length,
					matches: matching.map((m) => ({
						filename: m.entry.filename,
						title: m.entry.frontmatter.title,
						score: m.score,
					})),
				},
			};
		},
	});

	// Auto-notify agent about existing KB on session start
	pi.on("before_agent_start", async (_event, ctx) => {
		const kbDir = join(ctx.cwd, KB_DIR);
		try {
			const { stat } = await import("node:fs/promises");
			await stat(join(kbDir, "state.json"));
		} catch {
			return; // No KB — nothing to inject
		}

		const state = await readState(kbDir);
		if (!state) return;

		const entryFiles = await listEntries(kbDir);
		const titles = entryFiles.slice(0, 10).join(", ");

		return {
			message: {
				customType: "md-knowledge-context",
				content:
					`This project has a markdown knowledge base at .kb/ (${state.summary.totalEntries} entries, ` +
					`last updated ${state.updatedAt}). Use the kb_query tool to search it for project information. ` +
					`Top entries: ${titles}`,
				display: false,
			},
		};
	});
}
