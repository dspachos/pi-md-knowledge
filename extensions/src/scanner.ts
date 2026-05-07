/**
 * Codebase scanner — walks the file tree, reads files, classifies them,
 * groups them into logical knowledge-base entries, and extracts
 * MEANINGFUL knowledge from the source code.
 *
 * Uses the extractor module to generate knowledge-rich content instead
 * of just listing file metadata.
 */

import { readFile, stat, readdir } from "node:fs/promises";
import { join, relative, extname, basename, dirname } from "node:path";
import type {
	ScannedFile,
	KbEntry,
	KbCategory,
	FileClassification,
	KbConfig,
	KbEntryFrontmatter,
} from "./types.js";
import {
	DEFAULT_IGNORE_PATTERNS,
	EXTENSION_CATEGORY_MAP,
	FILENAME_CATEGORY_MAP,
} from "./types.js";
import { createHash } from "node:crypto";
import { isSensitiveFile, sanitizeFileContent } from "./sanitize.js";
import {
	extractFileKnowledge,
	mergeKnowledge,
	generateDescription,
	type ExtractedKnowledge,
	type FileKnowledge,
} from "./extractor.js";

// ---------------------------------------------------------------------------
// Progress reporting
// ---------------------------------------------------------------------------

export interface ScanProgress {
	/** Current phase of the scan */
	phase: "walking" | "reading" | "classifying" | "extracting" | "generating" | "writing";
	/** Human-readable status message */
	message: string;
	/** Files processed so far in the current phase */
	processed: number;
	/** Total files to process in the current phase (0 if unknown) */
	total: number;
}

export type ProgressCallback = (progress: ScanProgress) => void;

// ---------------------------------------------------------------------------
// File walking
// ---------------------------------------------------------------------------

/** Recursively walk a directory, yielding relative file paths. */
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

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

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

		const lines = raw.split("\n").length;

		return {
			path: absPath,
			relativePath: relPath,
			extension: extname(relPath).toLowerCase(),
			size: fileStat.size,
			lines,
			lastModified: fileStat.mtime,
			content: raw,
		};
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function detectLanguage(ext: string): string {
	const map: Record<string, string> = {
		".ts": "TypeScript", ".tsx": "TypeScript (React)", ".js": "JavaScript", ".jsx": "JavaScript (React)",
		".py": "Python", ".rb": "Ruby", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
		".swift": "Swift", ".c": "C", ".cpp": "C++", ".cs": "C#", ".php": "PHP", ".scala": "Scala",
		".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".lua": "Lua",
		".r": "R", ".sql": "SQL", ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell",
		".html": "HTML", ".xml": "XML", ".json": "JSON", ".yaml": "YAML", ".yml": "YAML",
		".toml": "TOML", ".md": "Markdown", ".css": "CSS", ".scss": "SCSS", ".less": "LESS",
		".graphql": "GraphQL", ".proto": "Protocol Buffers", ".tf": "Terraform", ".dart": "Dart",
		".vue": "Vue", ".svelte": "Svelte",
	};
	return map[ext] || "Unknown";
}

/** Classify a file into a category with a grouping key. */
function classifyFile(file: ScannedFile): FileClassification {
	const basenameNoExt = basename(file.relativePath, file.extension).toLowerCase();
	const filename = basename(file.relativePath).toLowerCase();
	const dirParts = dirname(file.relativePath).split("/");

	for (const [pattern, category] of Object.entries(FILENAME_CATEGORY_MAP)) {
		if (filename === pattern.toLowerCase() || basenameNoExt === pattern.toLowerCase()) {
			return { category, priority: 10, groupKey: dirParts.join("/") };
		}
		if (basenameNoExt.startsWith(pattern.toLowerCase() + ".")) {
			return { category, priority: 9, groupKey: dirParts.join("/") };
		}
	}

	const extCategory = EXTENSION_CATEGORY_MAP[file.extension];
	if (extCategory) {
		return { category: extCategory, priority: 5, groupKey: dirParts.join("/") };
	}

	if (basenameNoExt.includes(".test") || basenameNoExt.includes(".spec") || basenameNoExt.includes("_test")) {
		return { category: "testing", priority: 8, groupKey: dirParts.join("/") };
	}

	if (file.extension === ".sh" || file.extension === ".bash" || file.extension === ".py") {
		const isScript = dirParts.some((d) => d === "scripts" || d === "bin" || d === "tools");
		if (isScript) return { category: "scripts", priority: 7, groupKey: dirParts.join("/") };
	}

	const lang = detectLanguage(file.extension);
	if (
		lang.includes("TypeScript") || lang.includes("JavaScript") || lang === "Python" ||
		lang === "Go" || lang === "Rust" || lang === "Ruby" || lang === "Java" ||
		lang === "Kotlin" || lang === "Swift" || lang === "PHP" || lang === "C#" ||
		lang.includes("C++") || lang === "C" || lang === "Dart" || lang === "Scala"
	) {
		return { category: "module", priority: 3, groupKey: dirParts.join("/") };
	}

	if (file.extension === ".md") {
		return { category: "documentation", priority: 4, groupKey: dirParts.join("/") };
	}

	if (dirParts.some((d) => d === "routes" || d === "api" || d === "controllers" || d === "handlers" || d === "resolvers")) {
		return { category: "api", priority: 6, groupKey: "api" };
	}

	if (dirParts.some((d) => d === "models" || d === "entities" || d === "schemas" || d === "migrations" || d === "prisma")) {
		return { category: "data-model", priority: 6, groupKey: "data-model" };
	}

	return { category: "general", priority: 1, groupKey: dirParts.join("/") };
}

// ---------------------------------------------------------------------------
// Knowledge-based content generation
// ---------------------------------------------------------------------------

/** Generate a clean, readable filename from a group key. */
function pathToFilename(groupKey: string): string {
	const cleaned = groupKey
		.replace(/[:/\\]/g, "_")
		.replace(/_\./g, "_")
		.replace(/\.+/g, ".")
		.replace(/_+/g, "_")
		.replace(/(^_|_$|\.$)/g, "")
		.replace(/_\./g, "_");
	return (cleaned || "general") + ".md";
}

/** Compute a SHA-256 hash of file content for change detection. */
export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

/** Generate an entry description from the first file's doc comment or purpose. */
function buildEntryDescription(
	category: KbCategory,
	firstFile: ScannedFile,
	fileKnowledges: FileKnowledge[],
): string {
	// Use the extractor's description generator
	const merged = mergeKnowledge(fileKnowledges);
	return generateDescription(merged, category);
}

/** Generate the markdown body for a knowledge base entry. */
function generateEntryContent(
	category: KbCategory,
	groupKey: string,
	fileKnowledges: FileKnowledge[],
	dirPart: string,
): string {
	const merged = mergeKnowledge(fileKnowledges);
	const sections: string[] = [];

	// --- Purpose ---
	if (merged.purpose) {
		sections.push(`## Purpose\n`);
		sections.push(merged.purpose);
		sections.push("");
	}

	// --- File Summary (compact) ---
	if (fileKnowledges.length === 1) {
		sections.push(`## Source\n`);
		sections.push(`\`${fileKnowledges[0].file.relativePath}\` (${fileKnowledges[0].file.lines} lines, ${detectLanguage(fileKnowledges[0].file.extension)})`);
		sections.push("");
	} else {
		sections.push(`## Files (${fileKnowledges.length})\n`);
		for (const fk of fileKnowledges) {
			const purpose = fk.purpose || detectLanguage(fk.file.extension) + " file";
			sections.push(`- \`${fk.file.relativePath}\` (${fk.file.lines} lines) — ${purpose.length > 100 ? purpose.slice(0, 97) + "..." : purpose}`);
		}
		sections.push("");
	}

	// --- Responsibilities ---
	if (merged.responsibilities.length > 0) {
		sections.push("## Responsibilities\n");
		for (const r of merged.responsibilities.slice(0, 8)) {
			sections.push(`- ${r}`);
		}
		sections.push("");
	}

	// --- Key Concepts ---
	if (merged.keyConcepts.length > 0) {
		sections.push("## Key Concepts\n");
		for (const kc of merged.keyConcepts.slice(0, 10)) {
			sections.push(`- ${kc}`);
		}
		sections.push("");
	}

	// --- API Surface ---
	if (merged.apiSurface.length > 0) {
		sections.push("## API Surface\n");
		for (const api of merged.apiSurface.slice(0, 10)) {
			sections.push(`- ${api}`);
		}
		sections.push("");
	}

	// --- Data Flow ---
	if (merged.dataFlow.length > 0) {
		sections.push("## Data Flow\n");
		for (const df of merged.dataFlow.slice(0, 6)) {
			sections.push(`- ${df}`);
		}
		sections.push("");
	}

	// --- Patterns ---
	if (merged.patterns.length > 0) {
		sections.push("## Patterns\n");
		for (const p of merged.patterns) {
			sections.push(`- ${p}`);
		}
		sections.push("");
	}

	// --- Configuration ---
	if (merged.configuration.length > 0) {
		sections.push("## Configuration\n");
		for (const c of merged.configuration.slice(0, 8)) {
			sections.push(`- ${c}`);
		}
		sections.push("");
	}

	// --- Dependencies ---
	if (merged.dependencyPurposes.length > 0) {
		sections.push("## Dependencies\n");
		for (const dep of merged.dependencyPurposes.slice(0, 10)) {
			sections.push(`- ${dep}`);
		}
		sections.push("");
	}

	// --- Error Handling ---
	if (merged.errorHandling.length > 0) {
		sections.push("## Error Handling\n");
		for (const eh of merged.errorHandling) {
			sections.push(`- ${eh}`);
		}
		sections.push("");
	}

	// --- Constraints ---
	if (merged.constraints.length > 0) {
		sections.push("## Constraints\n");
		for (const c of merged.constraints) {
			sections.push(`- ${c}`);
		}
		sections.push("");
	}

	// --- Agent guidance ---
	sections.push("## When to Reference\n");
	sections.push(generateAgentUsage(category, dirPart, merged));
	sections.push("");

	return sections.join("\n");
}

/** Generate agent usage instructions for a KB entry based on extracted knowledge. */
function generateAgentUsage(
	category: KbCategory,
	dirPart: string,
	knowledge: ExtractedKnowledge,
): string {
	const instructions: string[] = [];
	instructions.push("> 🤖 **Agent guidance**: Consult this entry when you need to:");

	switch (category) {
		case "module":
			instructions.push(`- Understand what the \`${dirPart || "root"}\` module does and why`);
			instructions.push("- Find where a function or type is defined and how it works");
			instructions.push("- Understand the module's responsibilities and API surface");
			if (knowledge.dataFlow.length > 0) instructions.push("- Trace data flow through this module");
			if (knowledge.patterns.length > 0) instructions.push("- Understand design patterns used here");
			break;
		case "api":
			instructions.push("- Find API endpoints, routes, or handlers");
			instructions.push("- Understand request/response patterns and data flow");
			instructions.push("- Locate middleware or authentication logic");
			break;
		case "config":
			instructions.push("- Check project configuration options and their effects");
			instructions.push("- Understand build or tool settings and dependencies");
			break;
		case "testing":
			instructions.push("- Understand test coverage and what behaviors are tested");
			instructions.push("- Find test utilities or fixtures");
			instructions.push("- Write new tests following existing patterns");
			break;
		case "build":
			instructions.push("- Understand build scripts, dependencies, and how to build");
			instructions.push("- Modify package configuration or scripts");
			break;
		case "documentation":
			instructions.push("- Find user-facing docs or README content");
			instructions.push("- Understand project features or usage");
			break;
		case "data-model":
			instructions.push("- Understand database schemas or data structures");
			instructions.push("- Find model definitions, types, or migrations");
			break;
		case "architecture":
			instructions.push("- Understand high-level design decisions and system structure");
			break;
		default:
			instructions.push(`- Look up details about the ${dirPart || "project"} area`);
			instructions.push("- Find file locations or configuration");
			break;
	}

	return instructions.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ScanResult {
	entries: KbEntry[];
	fileHashes: Record<string, string>;
	totalFilesScanned: number;
}

/** Scan the codebase and generate knowledge base entries. */
export async function scanCodebase(
	cwd: string,
	config: KbConfig,
	onProgress?: ProgressCallback,
): Promise<ScanResult> {
	const allIgnore = [...DEFAULT_IGNORE_PATTERNS, ...config.ignorePatterns];
	const fileHashes: Record<string, string> = {};
	const fileMap = new Map<string, ScannedFile>();

	// --- Phase 1: Walk files ---
	onProgress?.({ phase: "walking", message: "Scanning directory structure...", processed: 0, total: 0 });

	const filePaths: string[] = [];
	for await (const relPath of walkDir(cwd, "", allIgnore, config.includeExtensions)) {
		filePaths.push(relPath);
	}

	// --- Phase 2: Read files ---
	onProgress?.({
		phase: "reading",
		message: `Reading ${filePaths.length} files...`,
		processed: 0,
		total: filePaths.length,
	});

	let readCount = 0;
	for (const relPath of filePaths) {
		readCount++;
		if (readCount % 25 === 0 || readCount === filePaths.length) {
			onProgress?.({
				phase: "reading",
				message: `Reading files... (${readCount}/${filePaths.length})`,
				processed: readCount,
				total: filePaths.length,
			});
		}

		const scanned = await readScannedFile(cwd, relPath);
		if (scanned) {
			fileMap.set(relPath, scanned);
			fileHashes[relPath] = hashContent(scanned.content);
		}
	}

	// --- Phase 3: Classify ---
	onProgress?.({
		phase: "classifying",
		message: `Classifying ${fileMap.size} files...`,
		processed: 0,
		total: fileMap.size,
	});

	const groups = new Map<string, { files: ScannedFile[]; category: KbCategory }>();

	for (const file of fileMap.values()) {
		const classification = classifyFile(file);

		let groupKey: string;
		if (classification.category === "module" || classification.category === "general") {
			const dir = dirname(file.relativePath);
			groupKey = `${classification.category}:${dir || "."}`;
		} else if (classification.category === "documentation" && file.extension === ".md") {
			groupKey = `doc:${file.relativePath}`;
		} else {
			groupKey = `${classification.category}:${classification.groupKey}`;
		}

		if (!groups.has(groupKey)) {
			groups.set(groupKey, { files: [], category: classification.category });
		}
		groups.get(groupKey)!.files.push(file);
	}

	// --- Phase 4: Extract knowledge ---
	onProgress?.({
		phase: "extracting",
		message: `Extracting knowledge from ${groups.size} groups...`,
		processed: 0,
		total: groups.size,
	});

	// Extract knowledge per file, then group
	const fileKnowledgeMap = new Map<string, FileKnowledge>();
	let extractCount = 0;
	for (const file of fileMap.values()) {
		extractCount++;
		if (extractCount % 15 === 0 || extractCount === fileMap.size) {
			onProgress?.({
				phase: "extracting",
				message: `Extracting knowledge... (${extractCount}/${fileMap.size} files)`,
				processed: extractCount,
				total: fileMap.size,
			});
		}
		fileKnowledgeMap.set(file.relativePath, extractFileKnowledge(file));
	}

	// --- Phase 5: Generate entries ---
	onProgress?.({
		phase: "generating",
		message: `Generating ${groups.size} knowledge entries...`,
		processed: 0,
		total: groups.size,
	});

	const entries: KbEntry[] = [];
	const groupEntries = [...groups.entries()];

	for (let gi = 0; gi < groupEntries.length; gi++) {
		const [groupKey, group] = groupEntries[gi];

		if (gi % 5 === 0 || gi === groupEntries.length - 1) {
			onProgress?.({
				phase: "generating",
				message: `Generating entries... (${gi + 1}/${groupEntries.length})`,
				processed: gi + 1,
				total: groupEntries.length,
			});
		}

		const sortedFiles = [...group.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

		// For large groups, split into sub-entries
		if (sortedFiles.length > 10) {
			const chunks: ScannedFile[][] = [];
			for (let i = 0; i < sortedFiles.length; i += 8) {
				chunks.push(sortedFiles.slice(i, i + 8));
			}

			for (let ci = 0; ci < chunks.length; ci++) {
				const chunk = chunks[ci];
				const entry = generateEntry(
					group.category, groupKey, chunk, config,
					fileKnowledgeMap, ci > 0 ? `-part${ci + 1}` : "",
				);
				entries.push(entry);
			}
		} else {
			const entry = generateEntry(group.category, groupKey, sortedFiles, config, fileKnowledgeMap);
			entries.push(entry);
		}
	}

	return { entries, fileHashes, totalFilesScanned: fileMap.size };
}

function generateEntry(
	category: KbCategory,
	groupKey: string,
	files: ScannedFile[],
	config: KbConfig,
	fileKnowledgeMap: Map<string, FileKnowledge>,
	suffix = "",
): KbEntry {
	const firstFile = files[0];
	const dirPart = dirname(firstFile.relativePath);

	// Determine title
	let title: string;
	if (category === "documentation") {
		title = basename(firstFile.relativePath, firstFile.extension);
	} else if (dirPart && dirPart !== ".") {
		title = dirPart + suffix;
	} else {
		title = category + suffix;
	}

	// Collect file knowledges
	const fileKnowledges = files.map(f => fileKnowledgeMap.get(f.relativePath)!).filter(Boolean);

	// Build tags from file types
	const tags = new Set<string>();
	tags.add(category);
	for (const f of files) {
		const lang = detectLanguage(f.extension);
		if (lang !== "Unknown") tags.add(lang.toLowerCase().replace(/[^a-z0-9]/g, "-"));
		tags.add(f.extension.replace(".", "") || "plain");
	}

	// Build related from imports
	const related: string[] = [];
	for (const fk of fileKnowledges) {
		// Reuse import extraction for related entries
		const lang = detectLanguage(fk.file.extension);
		if (lang.includes("TypeScript") || lang.includes("JavaScript")) {
			const importPattern = /(?:import|require)\s*\(?['"](\.\/[^'"]+)['"]/g;
			let match: RegExpExecArray | null;
			while ((match = importPattern.exec(fk.file.content)) !== null) {
				related.push(match[1]);
			}
		}
	}

	// Generate description using knowledge extractor
	const description = fileKnowledges.length > 0
		? buildEntryDescription(category, firstFile, fileKnowledges)
		: `${category} — ${files.length} files in ${dirPart || "root"}`;

	// Generate content using knowledge extractor
	const content = fileKnowledges.length > 0
		? generateEntryContent(category, groupKey, fileKnowledges, dirPart)
		: generateFallbackContent(category, files, dirPart);

	const filename = pathToFilename(groupKey);

	const frontmatter: KbEntryFrontmatter = {
		title,
		description,
		category,
		tags: [...tags],
		related: [...new Set(related)].slice(0, 20),
		updatedAt: new Date().toISOString(),
		sourceFiles: files.map((f) => f.relativePath),
	};

	return { filename, frontmatter, content };
}

/** Minimal fallback when knowledge extraction fails or returns nothing useful. */
function generateFallbackContent(
	category: KbCategory,
	files: ScannedFile[],
	dirPart: string,
): string {
	const parts: string[] = [];
	parts.push(`## Files (${files.length})\n`);
	for (const f of files) {
		const lang = detectLanguage(f.extension);
		parts.push(`- \`${f.relativePath}\` (${f.lines} lines, ${lang})`);
	}
	parts.push("");
	parts.push("## When to Reference\n");
	parts.push(`> 🤖 **Agent guidance**: Consult this entry when you need to find files in \`${dirPart || "root"}\`.`);
	parts.push("");
	return parts.join("\n");
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
				if (newHash !== previousHashes[f]) {
					changed.push(f);
				}
			}
		}
	}

	for (const f of previousFiles) {
		if (!currentFiles.has(f)) {
			removed.push(f);
		}
	}

	return { changed, removed, added };
}
