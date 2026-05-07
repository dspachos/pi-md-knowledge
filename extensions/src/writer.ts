/**
 * Knowledge base writer — reads and writes .kb/ folder contents.
 *
 * Handles:
 * - state.json (metadata, file hashes, timestamps)
 * - *.md entries with YAML frontmatter
 * - Index generation
 */

import { readFile, writeFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { KbState, KbEntry, KbEntryFrontmatter, InitResult, UpdateResult, AddResult } from "./types.js";
import { CATEGORY_META } from "./types.js";
import { sanitizeContent } from "./sanitize.js";

export const KB_DIR = ".kb";
const STATE_FILE = "state.json";
const INDEX_FILE = "index.md";

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/** Generate a project overview from the collected entries. */
function generateProjectOverview(entries: KbEntry[]): string {
	const parts: string[] = [];

	// Collect stats
	const totalFiles = entries.reduce((sum, e) => sum + e.frontmatter.sourceFiles.length, 0);
	const categories = [...new Set(entries.map((e) => e.frontmatter.category))];
	const allTags = [...new Set(entries.flatMap((e) => e.frontmatter.tags))];
	const languages = allTags.filter((t) =>
		["typescript", "javascript", "python", "go", "rust", "ruby", "java", "kotlin", "swift", "c", "c++", "php"].includes(t),
	);

	// Build overview
	parts.push(`This project has **${entries.length} knowledge base entries** covering **${totalFiles} files** across ${categories.length} categories.`);
	parts.push("");

	if (languages.length > 0) {
		parts.push(`**Languages**: ${languages.map((l) => l.charAt(0).toUpperCase() + l.slice(1)).join(", ")}`);
	}

	// Summarize what each category covers
	const categoryDescriptions: string[] = [];
	for (const cat of categories) {
		const catEntries = entries.filter((e) => e.frontmatter.category === cat);
		const fileCount = catEntries.reduce((s, e) => s + e.frontmatter.sourceFiles.length, 0);
		const meta = CATEGORY_META[cat as keyof typeof CATEGORY_META];
		const label = meta?.label ?? cat;
		categoryDescriptions.push(`- **${label}**: ${fileCount} file(s) in ${catEntries.length} entry(ies)`);
	}

	if (categoryDescriptions.length > 0) {
		parts.push("");
		parts.push("**Categories**:");
		parts.push(...categoryDescriptions);
	}

	parts.push("");
	parts.push("> 💡 Use `kb_query` to search entries by keyword, category, or tag. Each entry includes agent guidance on when to reference it.");

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

export async function readState(kbDir: string): Promise<KbState | null> {
	try {
		const raw = await readFile(join(kbDir, STATE_FILE), "utf-8");
		return JSON.parse(raw) as KbState;
	} catch {
		return null;
	}
}

export async function writeState(kbDir: string, state: KbState): Promise<void> {
	await writeFile(join(kbDir, STATE_FILE), JSON.stringify(state, null, 2), "utf-8");
}

export function createInitialState(fileHashes: Record<string, string>, totalEntries: number): KbState {
	const categories: Record<string, number> = {};
	return {
		version: 1,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		fileHashes,
		summary: { totalFiles: Object.keys(fileHashes).length, totalEntries, categories },
	};
}

// ---------------------------------------------------------------------------
// Entry I/O
// ---------------------------------------------------------------------------

/** Serialize a frontmatter object to YAML string (no dependencies). */
function toYaml(obj: KbEntryFrontmatter): string {
	const lines: string[] = ["---"];
	lines.push(`title: "${obj.title.replace(/"/g, '\\"')}"`);
	lines.push(`description: "${obj.description.replace(/"/g, '\\"')}"`);
	lines.push(`category: ${obj.category}`);
	lines.push(`tags:`);
	for (const tag of obj.tags) lines.push(`  - ${tag}`);
	lines.push(`related:`);
	for (const rel of obj.related.slice(0, 10)) lines.push(`  - ${rel}`);
	lines.push(`updatedAt: "${obj.updatedAt}"`);
	lines.push(`sourceFiles:`);
	for (const sf of obj.sourceFiles) lines.push(`  - ${sf}`);
	lines.push("---");
	return lines.join("\n");
}

/** Write a single entry to disk. */
export async function writeEntry(kbDir: string, entry: KbEntry): Promise<void> {
	const frontmatter = toYaml(entry.frontmatter);
	const body = sanitizeContent(entry.content).content; // Double-check no secrets
	const full = `${frontmatter}\n\n${body}\n`;
	await writeFile(join(kbDir, entry.filename), full, "utf-8");
}

/** Read a single entry from disk. */
export async function readEntry(kbDir: string, filename: string): Promise<KbEntry | null> {
	try {
		const raw = await readFile(join(kbDir, filename), "utf-8");
		return parseEntry(raw, filename);
	} catch {
		return null;
	}
}

/** Parse raw markdown with frontmatter into a KbEntry. */
export function parseEntry(raw: string, filename: string): KbEntry | null {
	if (!raw.startsWith("---")) return null;

	const endOfFrontmatter = raw.indexOf("---", 3);
	if (endOfFrontmatter === -1) return null;

	const yaml = raw.slice(3, endOfFrontmatter).trim();
	const content = raw.slice(endOfFrontmatter + 3).trim();

	// Simple YAML parser for our known structure
	const frontmatter: KbEntryFrontmatter = {
		title: extractYamlString(yaml, "title") ?? filename,
		description: extractYamlString(yaml, "description") ?? "",
		category: (extractYamlString(yaml, "category") as KbEntryFrontmatter["category"]) ?? "general",
		tags: extractYamlList(yaml, "tags"),
		related: extractYamlList(yaml, "related"),
		updatedAt: extractYamlString(yaml, "updatedAt") ?? new Date().toISOString(),
		sourceFiles: extractYamlList(yaml, "sourceFiles"),
	};

	return { filename, frontmatter, content };
}

// Minimal YAML helpers (no dependency)
function extractYamlString(yaml: string, key: string): string | null {
	const match = yaml.match(new RegExp(`^${key}:\\s*"?([^"]*)"?\\s*$`, "m"));
	return match ? match[1].trim() : null;
}

function extractYamlList(yaml: string, key: string): string[] {
	const sectionStart = yaml.indexOf(`${key}:`);
	if (sectionStart === -1) return [];

	const afterKey = yaml.slice(sectionStart + key.length + 1);
	const lines = afterKey.split("\n");
	const items: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed === "") {
			if (items.length > 0) break;
			continue;
		}
		if (!trimmed.startsWith("- ")) {
			if (items.length > 0) break;
			continue;
		}
		items.push(trimmed.slice(2).trim());
	}

	return items;
}

// ---------------------------------------------------------------------------
// Index generation
// ---------------------------------------------------------------------------

/** Generate an index.md listing all entries grouped by category. */
export async function generateIndex(kbDir: string, entries: KbEntry[]): Promise<void> {
	const byCategory = new Map<string, KbEntry[]>();
	for (const entry of entries) {
		const cat = entry.frontmatter.category;
		if (!byCategory.has(cat)) byCategory.set(cat, []);
		byCategory.get(cat)!.push(entry);
	}

	const lines: string[] = [];
	lines.push("# Knowledge Base Index\n");
	lines.push(`> Auto-generated by **pi-md-knowledge** — ${new Date().toISOString()}\n`);

	// Project overview section — synthesized from entries
	lines.push("## Project Overview\n");
	const overview = generateProjectOverview(entries);
	lines.push(overview);
	lines.push("");

	lines.push("## Quick Navigation\n");

	for (const [cat, catEntries] of byCategory) {
		const meta = CATEGORY_META[cat as keyof typeof CATEGORY_META];
		const label = meta?.label ?? cat;
		const desc = meta?.description ?? "";
		lines.push(`### ${label}\n`);
		lines.push(`> ${desc}\n`);

		for (const entry of catEntries) {
			const link = entry.filename;
			const entryDesc = entry.frontmatter.description;
			const fileCount = entry.frontmatter.sourceFiles.length;
			lines.push(`- [${entry.frontmatter.title}](./${link}) — ${entryDesc} (${fileCount} files)`);
		}
		lines.push("");
	}

	// Global tag index
	const allTags = new Map<string, string[]>();
	for (const entry of entries) {
		for (const tag of entry.frontmatter.tags) {
			if (!allTags.has(tag)) allTags.set(tag, []);
			allTags.get(tag)!.push(entry.filename);
		}
	}

	if (allTags.size > 0) {
		lines.push("## Tags\n");
		const sortedTags = [...allTags.entries()].sort((a, b) => a[0].localeCompare(b[0]));
		for (const [tag, files] of sortedTags) {
			lines.push(`- \`${tag}\`: ${files.map((f) => `[${f}](./${f})`).join(", ")}`);
		}
		lines.push("");
	}

	await writeFile(join(kbDir, INDEX_FILE), lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------
// Full knowledge base operations
// ---------------------------------------------------------------------------

/** Ensure the .kb directory exists. */
export async function ensureKbDir(cwd: string): Promise<string> {
	const kbDir = join(cwd, KB_DIR);
	await mkdir(kbDir, { recursive: true });
	return kbDir;
}

/** Check if a knowledge base already exists. */
export async function kbExists(cwd: string): Promise<boolean> {
	try {
		const s = await stat(join(cwd, KB_DIR, STATE_FILE));
		return s.isFile();
	} catch {
		return false;
	}
}

/** List all .md entry filenames in the kb directory. */
export async function listEntries(kbDir: string): Promise<string[]> {
	const files = await readdir(kbDir);
	return files.filter((f) => f.endsWith(".md") && f !== INDEX_FILE);
}

/** Remove entries whose source files no longer exist or are listed. */
export async function removeEntries(kbDir: string, filenames: string[]): Promise<void> {
	for (const f of filenames) {
		try {
			await rm(join(kbDir, f));
		} catch {
			// File may already be gone
		}
	}
}

/** Write the full knowledge base (init flow). */
export async function writeKnowledgeBase(
	cwd: string,
	entries: KbEntry[],
	fileHashes: Record<string, string>,
	lastCommitHash?: string,
): Promise<InitResult> {
	const start = Date.now();
	const kbDir = await ensureKbDir(cwd);

	// Write all entries
	for (const entry of entries) {
		await writeEntry(kbDir, entry);
	}

	// Generate index
	await generateIndex(kbDir, entries);

	// Build category summary
	const categories: Record<string, number> = {};
	for (const entry of entries) {
		const cat = entry.frontmatter.category;
		categories[cat] = (categories[cat] ?? 0) + 1;
	}

	// Write state
	const state = createInitialState(fileHashes, entries.length);
	state.lastCommitHash = lastCommitHash;
	state.summary.categories = categories;
	await writeState(kbDir, state);

	return {
		entriesCreated: entries.length,
		filesScanned: Object.keys(fileHashes).length,
		durationMs: Date.now() - start,
		categories,
	};
}

/** Update existing entries (update flow). */
export async function updateKnowledgeBase(
	cwd: string,
	entries: KbEntry[],
	fileHashes: Record<string, string>,
	removeFilenames: string[],
	lastCommitHash?: string,
): Promise<UpdateResult> {
	const start = Date.now();
	const kbDir = join(cwd, KB_DIR);

	// Remove stale entries
	await removeEntries(kbDir, removeFilenames);

	// Write updated/new entries
	for (const entry of entries) {
		await writeEntry(kbDir, entry);
	}

	// Read existing entries to keep
	const existingFiles = await listEntries(kbDir);
	const updatedFilenames = new Set(entries.map((e) => e.filename));
	const keptCount = existingFiles.filter((f) => !updatedFilenames.has(f)).length;

	// Re-generate index with all entries
	const allEntries: KbEntry[] = [];
	for (const f of existingFiles) {
		const entry = await readEntry(kbDir, f);
		if (entry) allEntries.push(entry);
	}
	await generateIndex(kbDir, allEntries);

	// Build category summary
	const categories: Record<string, number> = {};
	for (const entry of allEntries) {
		const cat = entry.frontmatter.category;
		categories[cat] = (categories[cat] ?? 0) + 1;
	}

	// Update state
	const state = createInitialState(fileHashes, allEntries.length);
	state.lastCommitHash = lastCommitHash;
	state.summary.categories = categories;
	await writeState(kbDir, state);

	return {
		entriesCreated: entries.length - (entries.length - removeFilenames.length),
		entriesUpdated: entries.length,
		entriesRemoved: removeFilenames.length,
		filesScanned: Object.keys(fileHashes).length,
		durationMs: Date.now() - start,
	};
}
