/**
 * AI-powered knowledge base scanner.
 *
 * Pipeline:
 *   Phase 1 — Walk & Read:    Scan the file tree, read all files
 *   Phase 2 — Analyze & Plan: Send file batches to AI, get a plan of KB entries
 *   Phase 3 — Generate:       Send each planned entry's files to AI, get rich markdown content
 *   Phase 4 — Collect:        Assemble final entries with frontmatter
 *
 * Falls back to static extraction (extractor.ts) if AI is unavailable.
 */

import { readFile, stat, readdir, mkdir, writeFile } from "node:fs/promises";
import { join, extname, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type {
	ScannedFile,
	KbEntry,
	KbCategory,
	KbConfig,
	KbEntryFrontmatter,
} from "./types.js";
import { DEFAULT_IGNORE_PATTERNS } from "./types.js";
import { isSensitiveFile, sanitizeFileContent } from "./sanitize.js";
import {
	askLlm,
	batchFiles,
	createTempDir,
	cleanupTempDir,
	formatDuration,
	formatTokens,
	type AiClientOptions,
	type FileBatch,
	type PlannedEntry,
} from "./ai-client.js";
import { writeFile as writeFileAsync } from "node:fs/promises";
import {
	extractFileKnowledge,
	mergeKnowledge,
	generateDescription,
} from "./extractor.js";

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ScanProgress {
	phase: "walking" | "reading" | "analyzing" | "planning" | "generating" | "writing";
	message: string;
	processed: number;
	total: number;
}

export type ProgressCallback = (progress: ScanProgress) => void;

// ---------------------------------------------------------------------------
// File walking (same as before — static, fast)
// ---------------------------------------------------------------------------

async function* walkDir(
	root: string,
	dir: string,
	ignorePatterns: string[],
	includeExtensions: string[],
): AsyncGenerator<string> {
	const entries = await readdir(join(root, dir), { withFileTypes: true });

	for (const entry of entries) {
		const relPath = dir ? join(dir, entry.name) : entry.name;
		if (shouldIgnore(entry.name, relPath, ignorePatterns)) continue;

		if (entry.isDirectory()) {
			yield* walkDir(root, relPath, ignorePatterns, includeExtensions);
		} else if (entry.isFile()) {
			if (includeExtensions.length > 0) {
				const ext = extname(entry.name).toLowerCase();
				if (!includeExtensions.includes(ext)) continue;
			}
			yield relPath;
		}
	}
}

function shouldIgnore(name: string, relPath: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (name.endsWith(pattern.slice(1))) return true;
		} else if (pattern.startsWith(".")) {
			if (name === pattern || relPath.split("/").some((s) => s === pattern)) return true;
		} else {
			if (name === pattern || relPath.split("/").some((s) => s === pattern)) return true;
		}
	}
	return false;
}

async function readScannedFile(root: string, relPath: string): Promise<ScannedFile | null> {
	if (isSensitiveFile(relPath)) return null;
	const absPath = join(root, relPath);
	try {
		const fileStat = await stat(absPath);
		if (fileStat.size > 500_000) return null;
		let raw = await readFile(absPath, "utf-8");
		const sanitized = sanitizeFileContent(relPath, raw);
		if (sanitized === null) return null;
		raw = sanitized;
		return {
			path: absPath,
			relativePath: relPath,
			extension: extname(relPath).toLowerCase(),
			size: fileStat.size,
			lines: raw.split("\n").length,
			lastModified: fileStat.mtime,
			content: raw,
		};
	} catch {
		return null;
	}
}

export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// AI Prompts
// ---------------------------------------------------------------------------

const PLAN_SYSTEM_PROMPT = `You are a codebase knowledge base architect. Your job is to analyze source code and plan how to organize it into a knowledge base.

You will receive a batch of source files. Analyze them and produce a JSON plan of knowledge base entries.

RULES:
1. Group related files together into logical entries
2. Each entry should cover a cohesive topic (a module, a feature, a config area, etc.)
3. Categories: architecture, module, api, config, data-model, testing, build, documentation, scripts, styles, infrastructure, general
4. Use descriptive titles that tell you WHAT the code does, not just where it lives
5. The brief should explain the entry's PURPOSE — what would someone need to know when referencing this entry?

OUTPUT FORMAT — respond with ONLY a JSON array, no markdown fences, no explanation:
[
  {
    "filename": "module_auth.md",
    "title": "Authentication Module",
    "category": "module",
    "sourceFiles": ["src/auth/index.ts", "src/auth/tokens.ts"],
    "brief": "Handles user authentication via JWT tokens, session management, and password hashing"
  }
]

If a file doesn't fit well with others, give it its own entry. Aim for entries that are useful to someone asking "how does X work?"`;

const GENERATE_SYSTEM_PROMPT = `You are a knowledge base writer for a codebase documentation system. Your job is to read source code and write a comprehensive, useful knowledge base entry.

You will receive source files for a specific part of the codebase. Write a markdown document that captures REAL KNOWLEDGE about this code.

STRUCTURE your entry with these sections (include only sections that have meaningful content):

## Purpose
What does this code DO and WHY? One clear paragraph.

## How It Works
Step-by-step explanation of the logic, data flow, and key mechanisms. This is the most important section.

## Key Concepts
Important abstractions, types, or ideas the code introduces. Use bullet points.

## API Surface
What functions/types/classes does this module expose? Include brief signatures.

## Configuration
Any settings, options, or constants that control behavior.

## Dependencies
What external packages does this rely on and what are they used for?

## Error Handling
How does this code handle failures? What error types exist?

## Constraints & Invariants
Important assumptions, limitations, or validation rules.

## When to Reference
Bullet list of scenarios where someone would need to look at this code.

RULES:
- Write PROSE, not just lists. Explain the "why" behind design decisions.
- Be specific — mention actual function names, type names, variable names
- Focus on knowledge that helps someone understand, modify, or debug the code
- Do NOT just paraphrase the code — explain the INTENT and BEHAVIOR
- Keep it concise but comprehensive — aim for quality over length
- Do NOT include the source code itself — extract knowledge FROM it`;

// ---------------------------------------------------------------------------
// AI Pipeline Phases
// ---------------------------------------------------------------------------

/**
 * Phase 2: Send file batches to AI to plan the KB structure.
 * Returns a merged list of planned entries across all batches.
 */
async function planEntriesFromBatches(
	batches: FileBatch[],
	options: AiClientOptions,
	onProgress?: ProgressCallback,
): Promise<PlannedEntry[]> {
	const allPlans: PlannedEntry[] = [];
	const tmpDir = await createTempDir("pi-kb-plan-");

	try {
		for (let i = 0; i < batches.length; i++) {
			const batch = batches[i];
			onProgress?.({
				phase: "planning",
				message: `Analyzing batch ${i + 1}/${batches.length} (${batch.files.length} files, ~${formatTokens(batch.estimatedTokens)} tokens)`,
				processed: i,
				total: batches.length,
			});

			// Save batch content to temp file (prompts can be large)
			const batchFile = join(tmpDir, `batch-${i}.md`);
			await writeFileAsync(batchFile, batch.content, "utf-8");

			const userPrompt = `Analyze these ${batch.files.length} source files from the project and plan knowledge base entries for them.\n\nThe files are in a project at the working directory. Here are the file contents:\n\nFile path: ${batchFile}`;

			const result = await askLlm(PLAN_SYSTEM_PROMPT, userPrompt, options);

			// Parse the JSON response
			const plans = parsePlansFromResponse(result.text);
			allPlans.push(...plans);
		}
	} finally {
		await cleanupTempDir(tmpDir);
	}

	return allPlans;
}

/**
 * Phase 3: Generate rich content for each planned entry via AI.
 * Processes entries in parallel (up to a concurrency limit).
 */
async function generateEntriesContent(
	plannedEntries: PlannedEntry[],
	fileContentMap: Map<string, string>,
	options: AiClientOptions,
	onProgress?: ProgressCallback,
	concurrency: number = 3,
): Promise<Map<string, string>> {
	const results = new Map<string, string>();
	let completed = 0;

	// Process in chunks of `concurrency`
	for (let i = 0; i < plannedEntries.length; i += concurrency) {
		const chunk = plannedEntries.slice(i, i + concurrency);

		await Promise.all(
			chunk.map(async (entry) => {
				onProgress?.({
					phase: "generating",
					message: `Generating: ${entry.title}`,
					processed: completed,
					total: plannedEntries.length,
				});

				// Collect the source file contents for this entry
				const fileContents: string[] = [];
				for (const sf of entry.sourceFiles) {
					const content = fileContentMap.get(sf);
					if (content) {
						fileContents.push(`=== ${sf} ===\n${content}`);
					}
				}

				if (fileContents.length === 0) return;

				const userPrompt =
					`Write a knowledge base entry for: **${entry.title}**\n\n` +
					`Category: ${entry.category}\n` +
					`Purpose: ${entry.brief}\n\n` +
					`Source files:\n${fileContents.join("\n\n")}`;

				try {
					const result = await askLlm(GENERATE_SYSTEM_PROMPT, userPrompt, options);
					results.set(entry.filename, result.text);
				} catch (err) {
					// Fallback: use static extraction
					const fallback = generateStaticFallback(entry, fileContentMap);
					results.set(entry.filename, fallback);
				}

				completed++;
			}),
		);
	}

	return results;
}

// ---------------------------------------------------------------------------
// JSON parsing helpers
// ---------------------------------------------------------------------------

/** Parse planned entries from the LLM's JSON response. */
function parsePlansFromResponse(text: string): PlannedEntry[] {
	// Strip markdown fences if present
	let cleaned = text.trim();
	if (cleaned.startsWith("```")) {
		cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
	}

	try {
		const parsed = JSON.parse(cleaned);
		if (!Array.isArray(parsed)) return [];

		return parsed
			.filter((p: any) => p.filename && p.sourceFiles && Array.isArray(p.sourceFiles))
			.map((p: any) => ({
				filename: String(p.filename),
				title: String(p.title || p.filename),
				category: String(p.category || "general"),
				sourceFiles: (p.sourceFiles as string[]).map(String),
				brief: String(p.brief || p.description || ""),
			}));
	} catch {
		// Try to extract JSON array from the text
		const match = cleaned.match(/\[[\s\S]*\]/);
		if (match) {
			try {
				const parsed = JSON.parse(match[0]);
				return parsed
					.filter((p: any) => p.filename && p.sourceFiles)
					.map((p: any) => ({
						filename: String(p.filename),
						title: String(p.title || p.filename),
						category: String(p.category || "general"),
						sourceFiles: (p.sourceFiles as string[]).map(String),
						brief: String(p.brief || p.description || ""),
					}));
			} catch {
				return [];
			}
		}
		return [];
	}
}

// ---------------------------------------------------------------------------
// Static fallback (uses extractor.ts)
// ---------------------------------------------------------------------------

function generateStaticFallback(
	entry: PlannedEntry,
	fileContentMap: Map<string, string>,
): string {
	const parts: string[] = [];

	parts.push(`## Purpose\n`);
	parts.push(entry.brief || `${entry.category} module.`);
	parts.push("");

	parts.push(`## Files (${entry.sourceFiles.length})\n`);
	for (const sf of entry.sourceFiles) {
		const content = fileContentMap.get(sf);
		const lines = content ? content.split("\n").length : "?";
		parts.push(`- \`${sf}\` (${lines} lines)`);
	}
	parts.push("");

	parts.push("## When to Reference\n");
	parts.push(`> Consult this entry when you need to understand ${entry.title.toLowerCase()}.`);
	parts.push("");

	return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScanResult {
	entries: KbEntry[];
	fileHashes: Record<string, string>;
	totalFilesScanned: number;
}

/** Scan the codebase using AI to generate rich knowledge base entries. */
export async function scanCodebase(
	cwd: string,
	config: KbConfig,
	onProgress?: ProgressCallback,
): Promise<ScanResult> {
	const allIgnore = [...DEFAULT_IGNORE_PATTERNS, ...config.ignorePatterns];
	const fileHashes: Record<string, string> = {};
	const fileContentMap = new Map<string, string>();
	const filePaths: string[] = [];

	// --- Phase 1: Walk & Read (static, fast) ---
	onProgress?.({ phase: "walking", message: "Scanning directory structure...", processed: 0, total: 0 });

	for await (const relPath of walkDir(cwd, "", allIgnore, config.includeExtensions)) {
		filePaths.push(relPath);
	}

	onProgress?.({ phase: "reading", message: `Reading ${filePaths.length} files...`, processed: 0, total: filePaths.length });

	for (let i = 0; i < filePaths.length; i++) {
		const relPath = filePaths[i];
		if ((i + 1) % 25 === 0 || i === filePaths.length - 1) {
			onProgress?.({ phase: "reading", message: `Reading files... (${i + 1}/${filePaths.length})`, processed: i + 1, total: filePaths.length });
		}

		const scanned = await readScannedFile(cwd, relPath);
		if (scanned) {
			fileContentMap.set(relPath, scanned.content);
			fileHashes[relPath] = hashContent(scanned.content);
		}
	}

	if (fileContentMap.size === 0) {
		return { entries: [], fileHashes, totalFilesScanned: 0 };
	}

	// --- Phase 2: Batch files and send to AI for planning ---
	onProgress?.({ phase: "analyzing", message: "Batching files for AI analysis...", processed: 0, total: 0 });

	const batches = await batchFiles(cwd, [...fileContentMap.keys()], 60000,
		(file, idx, total) => {
			if ((idx + 1) % 50 === 0 || idx === total - 1) {
				onProgress?.({ phase: "analyzing", message: `Preparing batches... (${idx + 1}/${total} files)`, processed: idx + 1, total });
			}
		},
	);

	const aiOptions: AiClientOptions = { cwd, signal: undefined };

	// Plan: ask AI what entries to create
	let plannedEntries: PlannedEntry[];
	try {
		onProgress?.({ phase: "planning", message: `Planning KB structure from ${batches.length} batch(es)...`, processed: 0, total: batches.length });
		plannedEntries = await planEntriesFromBatches(batches, aiOptions, onProgress);
	} catch {
		// AI unavailable — fall back to static extraction
		onProgress?.({ phase: "planning", message: "AI unavailable, using static analysis...", processed: 0, total: 0 });
		plannedEntries = planStaticEntries(fileContentMap);
	}

	if (plannedEntries.length === 0) {
		plannedEntries = planStaticEntries(fileContentMap);
	}

	// --- Phase 3: Generate content for each entry via AI ---
	onProgress?.({
		phase: "generating",
		message: `Generating ${plannedEntries.length} entries...`,
		processed: 0,
		total: plannedEntries.length,
	});

	let contentMap: Map<string, string>;
	try {
		contentMap = await generateEntriesContent(plannedEntries, fileContentMap, aiOptions, onProgress);
	} catch {
		// Full fallback to static
		contentMap = new Map();
		for (const entry of plannedEntries) {
			contentMap.set(entry.filename, generateStaticFallback(entry, fileContentMap));
		}
	}

	// --- Phase 4: Assemble entries ---
	onProgress?.({ phase: "writing", message: "Assembling entries...", processed: 0, total: plannedEntries.length });

	const entries: KbEntry[] = [];
	for (const plan of plannedEntries) {
		const content = contentMap.get(plan.filename) || generateStaticFallback(plan, fileContentMap);
		const now = new Date().toISOString();

		// Extract tags from source file extensions
		const tags = new Set<string>();
		tags.add(plan.category);
		for (const sf of plan.sourceFiles) {
			const ext = extname(sf).replace(".", "");
			if (ext) tags.add(ext);
		}

		const frontmatter: KbEntryFrontmatter = {
			title: plan.title,
			description: plan.brief || `${plan.category} — ${plan.sourceFiles.length} files`,
			category: (plan.category as KbCategory) || "general",
			tags: [...tags],
			related: [],
			updatedAt: now,
			sourceFiles: plan.sourceFiles,
		};

		entries.push({
			filename: plan.filename,
			frontmatter,
			content,
		});
	}

	return { entries, fileHashes, totalFilesScanned: fileContentMap.size };
}

/** Static fallback planning: group files by directory. */
function planStaticEntries(fileContentMap: Map<string, string>): PlannedEntry[] {
	const groups = new Map<string, string[]>();

	for (const filePath of fileContentMap.keys()) {
		const dir = dirname(filePath);
		const key = dir || ".";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(filePath);
	}

	const entries: PlannedEntry[] = [];
	for (const [dir, files] of groups) {
		const filename = dir.replace(/[:/\\]/g, "_").replace(/_+/g, "_") + ".md";
		entries.push({
			filename: filename === "_.md" ? "general.md" : filename,
			title: dir === "." ? "root" : dir,
			category: "module",
			sourceFiles: files,
			brief: `Files in ${dir}`,
		});
	}

	return entries;
}

/** Quick-scan only files that changed since the last hash map. */
export async function scanChangedFiles(
	cwd: string,
	config: KbConfig,
	previousHashes: Record<string, string>,
): Promise<{ changed: string[]; removed: string[]; added: string[] }> {
	const allIgnore = [...DEFAULT_IGNORE_PATTERNS, ...config.ignorePatterns];
	const currentFiles = new Set<string>();

	for await (const relPath of walkDir(cwd, "", allIgnore, config.includeExtensions)) {
		currentFiles.add(relPath);
	}

	const previousFiles = new Set(Object.keys(previousHashes));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];

	for (const f of currentFiles) {
		if (!previousFiles.has(f)) {
			added.push(f);
		} else {
			const scanned = await readScannedFile(cwd, f);
			if (scanned) {
				const newHash = hashContent(scanned.content);
				if (newHash !== previousHashes[f]) changed.push(f);
			}
		}
	}

	for (const f of previousFiles) {
		if (!currentFiles.has(f)) removed.push(f);
	}

	return { changed, removed, added };
}
