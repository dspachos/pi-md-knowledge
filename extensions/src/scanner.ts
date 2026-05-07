/**
 * Codebase scanner — walks the file tree, reads files, classifies them,
 * and groups them into logical knowledge-base entries.
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

		// Check ignore patterns
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
			// Extension glob: *.lock, *.min.js
			if (name.endsWith(pattern.slice(1))) return true;
		} else if (pattern.startsWith(".")) {
			// Hidden directory or file
			if (name === pattern || relPath.split("/").some((s) => s === pattern)) return true;
		} else {
			// Plain name match (directory or file)
			if (name === pattern || relPath.split("/").some((s) => s === pattern)) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

async function readScannedFile(root: string, relPath: string): Promise<ScannedFile | null> {
	// Skip files with sensitive names entirely
	if (isSensitiveFile(relPath)) return null;

	const absPath = join(root, relPath);
	try {
		const fileStat = await stat(absPath);
		if (fileStat.size > 500_000) return null; // Skip files > 500KB

		let raw = await readFile(absPath, "utf-8");

		// Sanitize any embedded secrets from the content
		const sanitized = sanitizeFileContent(relPath, raw);
		if (sanitized === null) return null; // File determined to be sensitive
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

/** Determine the programming language from a file extension. */
function detectLanguage(ext: string): string {
	const langMap: Record<string, string> = {
		".ts": "TypeScript",
		".tsx": "TypeScript (React)",
		".js": "JavaScript",
		".jsx": "JavaScript (React)",
		".py": "Python",
		".rb": "Ruby",
		".go": "Go",
		".rs": "Rust",
		".java": "Java",
		".kt": "Kotlin",
		".swift": "Swift",
		".c": "C",
		".cpp": "C++",
		".h": "C/C++ Header",
		".hpp": "C++ Header",
		".cs": "C#",
		".php": "PHP",
		".scala": "Scala",
		".ex": "Elixir",
		".exs": "Elixir",
		".erl": "Erlang",
		".hs": "Haskell",
		".lua": "Lua",
		".r": "R",
		".R": "R",
		".sql": "SQL",
		".sh": "Shell",
		".bash": "Shell",
		".zsh": "Shell",
		".fish": "Shell",
		".ps1": "PowerShell",
		".html": "HTML",
		".htm": "HTML",
		".xml": "XML",
		".json": "JSON",
		".yaml": "YAML",
		".yml": "YAML",
		".toml": "TOML",
		".md": "Markdown",
		".css": "CSS",
		".scss": "SCSS",
		".less": "LESS",
		".graphql": "GraphQL",
		".gql": "GraphQL",
		".proto": "Protocol Buffers",
		".tf": "Terraform",
		".dart": "Dart",
		".vue": "Vue",
		".svelte": "Svelte",
	};
	return langMap[ext] || "Unknown";
}

/** Extract exports/symbols from source code (best-effort). */
function extractExports(content: string, language: string): string[] {
	const exports: string[] = [];
	const patterns: RegExp[] = [];

	if (language.includes("TypeScript") || language.includes("JavaScript")) {
		patterns.push(
			/(?:export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+)(\w+)/g,
			/(?:export\s+\{[^}]*\})/g,
			/module\.exports\s*=\s*\{([^}]*)\}/g,
		);
	} else if (language === "Python") {
		patterns.push(/^class\s+(\w+)/gm, /^def\s+(\w+)/gm);
	} else if (language === "Go") {
		patterns.push(/^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm, /^type\s+(\w+)/gm);
	} else if (language === "Rust") {
		patterns.push(/pub\s+(?:async\s+)?fn\s+(\w+)/g, /pub\s+(?:struct|enum|trait|type)\s+(\w+)/g);
	}

	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) exports.push(match[1]);
		}
	}

	return [...new Set(exports)].slice(0, 30); // Cap at 30
}

/** Extract imports/dependencies from source (best-effort). */
function extractImports(content: string, language: string): string[] {
	const imports: string[] = [];

	if (language.includes("TypeScript") || language.includes("JavaScript")) {
		const pattern = /(?:import|require)\s*\(?['"]([^'"]+)['"]/g;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			imports.push(match[1]);
		}
	} else if (language === "Python") {
		const pattern = /^(?:from|import)\s+([^\s.]+)/gm;
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			imports.push(match[1]);
		}
	}

	return [...new Set(imports)].slice(0, 20);
}

/** Classify a file into a category with a grouping key. */
function classifyFile(file: ScannedFile): FileClassification {
	const basenameNoExt = basename(file.relativePath, file.extension).toLowerCase();
	const filename = basename(file.relativePath).toLowerCase();
	const dirParts = dirname(file.relativePath).split("/");

	// Check filename-based categories first
	for (const [pattern, category] of Object.entries(FILENAME_CATEGORY_MAP)) {
		if (filename === pattern.toLowerCase() || basenameNoExt === pattern.toLowerCase()) {
			return { category, priority: 10, groupKey: dirParts.join("/") };
		}
		if (basenameNoExt.startsWith(pattern.toLowerCase() + ".")) {
			return { category, priority: 9, groupKey: dirParts.join("/") };
		}
	}

	// Check extension-based categories
	const extCategory = EXTENSION_CATEGORY_MAP[file.extension];
	if (extCategory) {
		return { category: extCategory, priority: 5, groupKey: dirParts.join("/") };
	}

	// Test file heuristic
	if (basenameNoExt.includes(".test") || basenameNoExt.includes(".spec") || basenameNoExt.includes("_test")) {
		return { category: "testing", priority: 8, groupKey: dirParts.join("/") };
	}

	// Script heuristic
	if (file.extension === ".sh" || file.extension === ".bash" || file.extension === ".py") {
		const isScript = dirParts.some((d) => d === "scripts" || d === "bin" || d === "tools");
		if (isScript) return { category: "scripts", priority: 7, groupKey: dirParts.join("/") };
	}

	// Language-based source classification
	const lang = detectLanguage(file.extension);
	if (
		lang.includes("TypeScript") ||
		lang.includes("JavaScript") ||
		lang === "Python" ||
		lang === "Go" ||
		lang === "Rust" ||
		lang === "Ruby" ||
		lang === "Java" ||
		lang === "Kotlin" ||
		lang === "Swift" ||
		lang === "PHP" ||
		lang === "C#" ||
		lang.includes("C++") ||
		lang === "C" ||
		lang === "Dart" ||
		lang === "Scala"
	) {
		return { category: "module", priority: 3, groupKey: dirParts.join("/") };
	}

	// Documentation
	if (file.extension === ".md") {
		return { category: "documentation", priority: 4, groupKey: dirParts.join("/") };
	}

	// API routes heuristic
	if (
		dirParts.some(
			(d) =>
				d === "routes" ||
				d === "api" ||
				d === "controllers" ||
				d === "handlers" ||
				d === "resolvers",
		)
	) {
		return { category: "api", priority: 6, groupKey: "api" };
	}

	// Data model heuristic
	if (
		dirParts.some(
			(d) =>
				d === "models" ||
				d === "entities" ||
				d === "schemas" ||
				d === "migrations" ||
				d === "prisma",
		)
	) {
		return { category: "data-model", priority: 6, groupKey: "data-model" };
	}

	return { category: "general", priority: 1, groupKey: dirParts.join("/") };
}

// ---------------------------------------------------------------------------
// Entry generation
// ---------------------------------------------------------------------------

function truncateContent(content: string, maxLines: number): string {
	const lines = content.split("\n");
	if (lines.length <= maxLines) return content;
	return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
}

/** Build a short one-line description summarising the file. */
function buildDescription(file: ScannedFile, language: string, exports: string[]): string {
	const name = basename(file.relativePath);

	if (exports.length > 0) {
		const topExports = exports.slice(0, 5).join(", ");
		return `${language} file — exports: ${topExports}${exports.length > 5 ? `, +${exports.length - 5} more` : ""}`;
	}

	if (file.lines <= 20) {
		return `${language} file (${file.lines} lines) — small utility/config file`;
	}

	return `${language} file (${file.lines} lines) — see content for details`;
}

/** Generate a clean, readable filename from a group key.
 *  e.g. "general:." → "general.md", "module:extensions/src" → "module_extensions_src.md" */
function pathToFilename(groupKey: string): string {
	const cleaned = groupKey
		.replace(/[:/\\]/g, "_")           // separators → underscore
		.replace(/_\./g, "_")              // "_." → "_"  (e.g. "general_." → "general_")
		.replace(/\.+/g, ".")              // collapse multiple dots
		.replace(/_+/g, "_")              // collapse multiple underscores
		.replace(/(^_|_$|\.$)/g, "")      // strip leading/trailing _ or .
		.replace(/_\./g, "_");             // clean any remaining "_." artifacts
	return (cleaned || "general") + ".md";
}

/** Compute a SHA-256 hash of file content for change detection. */
export function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// AI-friendly content generators
// ---------------------------------------------------------------------------

/** Generate a concise one-line purpose for a file. */
function generateFilePurpose(file: ScannedFile, language: string, exports: string[]): string {
	// Extract the first JSDoc / doc-comment summary from the file
	const docMatch = file.content.match(/\/\*\*[\s*]*([^(\*\/)]*?\S)[\s*]*\*\//);
	if (docMatch) {
		const summary = docMatch[1].replace(/\n/g, " ").trim();
		if (summary.length > 5 && summary.length < 120) return summary;
	}

	// Multi-line doc comment
	const multiDocMatch = file.content.match(/\/\*\*[\s\S]*?\*\//);
	if (multiDocMatch) {
		const body = multiDocMatch[0]
			.replace(/\/\*\*?|\*\/?/g, "")
			.replace(/^\s*\*\s?/gm, "")
			.split("\n")
			.map((l: string) => l.trim())
			.find((l: string) => l.length > 5 && !l.startsWith("@") && !l.startsWith("{"));
		if (body && body.length < 120) return body;
	}

	// Fallback: use exports
	if (exports.length > 0) {
		return `Exports: ${exports.slice(0, 3).join(", ")}`;
	}

	return `${language} ${file.extension} file`;
}

/** Generate an overview paragraph for a group of files. */
function generateOverview(
	category: KbCategory,
	files: ScannedFile[],
	summaries: { file: ScannedFile; lang: string; exports: string[] }[],
	dirPart: string,
): string {
	const parts: string[] = [];

	if (files.length === 1) {
		const s = summaries[0];
		parts.push(`\`${s.file.relativePath}\` — ${generateFilePurpose(s.file, s.lang, s.exports)}.`);
	} else {
		parts.push(`${files.length} files in \`${dirPart || "root"}\`.`);

		// Summarize the main responsibilities
		const responsibilities = new Set<string>();
		for (const s of summaries) {
			const purpose = generateFilePurpose(s.file, s.lang, s.exports);
			if (purpose.length > 10) responsibilities.add(purpose);
		}
		if (responsibilities.size > 0 && responsibilities.size <= 5) {
			parts.push("Main responsibilities:");
			for (const r of responsibilities) {
				parts.push(`- ${r}`);
			}
		}
	}

	return parts.join("\n");
}

/** Extract key function signatures and patterns for architecture notes. */
function extractArchitectureNotes(
	summaries: { file: ScannedFile; lang: string; exports: string[] }[],
): string {
	const notes: string[] = [];

	for (const { file: f, lang, exports } of summaries) {
		// Only extract from source code files
		if (!lang.includes("TypeScript") && !lang.includes("JavaScript") && lang !== "Python") continue;

		// Extract top-level function signatures (name + params, no body)
		const funcSigs: string[] = [];
		const funcPattern = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
		let match: RegExpExecArray | null;
		while ((match = funcPattern.exec(f.content)) !== null) {
			const name = match[1];
			const params = match[2].trim();
			if (params.length > 60) continue; // Skip overly verbose signatures
			funcSigs.push(`\`${name}(${params || ""})\``);
		}

		// Extract exported type/interface names
		const typeExports: string[] = [];
		const typePattern = /export\s+(?:type|interface)\s+(\w+)/g;
		while ((match = typePattern.exec(f.content)) !== null) {
			typeExports.push(match[1]);
		}

		if (funcSigs.length > 0 || typeExports.length > 0) {
			const sigs = funcSigs.slice(0, 5).join(", ");
			const types = typeExports.length > 0 ? `Types: ${typeExports.slice(0, 5).join(", ")}` : "";
			notes.push(`**${f.relativePath}**: ${sigs}${types ? " | " + types : ""}`);
		}
	}

	return notes.join("\n");
}

/** Generate agent usage instructions for a KB entry. */
function generateAgentUsage(
	category: KbCategory,
	title: string,
	summaries: { file: ScannedFile; lang: string; exports: string[] }[],
	dirPart: string,
): string {
	const instructions: string[] = [];
	instructions.push("> 🤖 **Agent guidance**: Consult this entry when you need to:");

	switch (category) {
		case "module":
			instructions.push(`- Understand the implementation in \`${dirPart || "root"}\``);
			instructions.push("- Find where a function or type is defined");
			instructions.push("- Understand module dependencies and exports");
			break;
		case "api":
			instructions.push("- Find API endpoints, routes, or handlers");
			instructions.push("- Understand request/response patterns");
			instructions.push("- Locate middleware or authentication logic");
			break;
		case "config":
			instructions.push("- Check project configuration options");
			instructions.push("- Understand build or tool settings");
			break;
		case "testing":
			instructions.push("- Understand test coverage and patterns");
			instructions.push("- Find test utilities or fixtures");
			instructions.push("- Write new tests following existing patterns");
			break;
		case "build":
			instructions.push("- Understand build scripts and dependencies");
			instructions.push("- Modify package configuration");
			break;
		case "documentation":
			instructions.push("- Find user-facing docs or README content");
			instructions.push("- Understand project features or usage");
			break;
		case "data-model":
			instructions.push("- Understand database schemas or data structures");
			instructions.push("- Find model definitions or migrations");
			break;
		case "architecture":
			instructions.push("- Understand high-level design decisions");
			instructions.push("- Get an overview of system structure");
			break;
		default:
			instructions.push(`- Look up details about the ${title} area`);
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
export async function scanCodebase(cwd: string, config: KbConfig): Promise<ScanResult> {
	const allIgnore = [...DEFAULT_IGNORE_PATTERNS, ...config.ignorePatterns];
	const fileHashes: Record<string, string> = {};
	const fileMap = new Map<string, ScannedFile>();

	// Walk and read all files
	for await (const relPath of walkDir(cwd, "", allIgnore, config.includeExtensions)) {
		const scanned = await readScannedFile(cwd, relPath);
		if (scanned) {
			fileMap.set(relPath, scanned);
			fileHashes[relPath] = hashContent(scanned.content);
		}
	}

	// Group files by classification
	const groups = new Map<string, { files: ScannedFile[]; category: KbCategory }>();

	for (const file of fileMap.values()) {
		const classification = classifyFile(file);

		// For modules, group by directory to create directory-level entries
		let groupKey: string;
		if (classification.category === "module" || classification.category === "general") {
			const dir = dirname(file.relativePath);
			groupKey = `${classification.category}:${dir || "."}`;
		} else if (classification.category === "documentation" && file.extension === ".md") {
			// Each doc file gets its own entry
			groupKey = `doc:${file.relativePath}`;
		} else {
			groupKey = `${classification.category}:${classification.groupKey}`;
		}

		if (!groups.has(groupKey)) {
			groups.set(groupKey, { files: [], category: classification.category });
		}
		groups.get(groupKey)!.files.push(file);
	}

	// Generate entries
	const entries: KbEntry[] = [];
	let entryCount = 0;

	for (const [groupKey, group] of groups) {
		const sortedFiles = [...group.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));

		// For large groups, split into sub-entries
		if (sortedFiles.length > 10) {
			// Split into chunks of up to 8 files
			const chunks: ScannedFile[][] = [];
			for (let i = 0; i < sortedFiles.length; i += 8) {
				chunks.push(sortedFiles.slice(i, i + 8));
			}

			for (let ci = 0; ci < chunks.length; ci++) {
				const chunk = chunks[ci];
				const entry = generateEntry(group.category, groupKey, chunk, config, ci > 0 ? `-part${ci + 1}` : "");
				entries.push(entry);
				entryCount++;
			}
		} else {
			const entry = generateEntry(group.category, groupKey, sortedFiles, config);
			entries.push(entry);
			entryCount++;
		}
	}

	return { entries, fileHashes, totalFilesScanned: fileMap.size };
}

function generateEntry(
	category: KbCategory,
	groupKey: string,
	files: ScannedFile[],
	config: KbConfig,
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

	// Build tags
	const tags = new Set<string>();
	tags.add(category);
	for (const f of files) {
		const lang = detectLanguage(f.extension);
		if (lang !== "Unknown") tags.add(lang.toLowerCase().replace(/[^a-z0-9]/g, "-"));
		tags.add(f.extension.replace(".", "") || "plain");
	}

	// Collect all exports and imports across files
	const allExports: string[] = [];
	const allImports = new Set<string>();
	const fileSummaries: { file: ScannedFile; lang: string; exports: string[] }[] = [];

	for (const f of files) {
		const lang = detectLanguage(f.extension);
		const exports = extractExports(f.content, lang);
		allExports.push(...exports);
		fileSummaries.push({ file: f, lang, exports });
		for (const imp of extractImports(f.content, lang)) {
			if (!imp.startsWith(".")) allImports.add(imp);
		}
	}

	// Build content sections — concise, AI-friendly format
	const sections: string[] = [];

	// Overview — AI-generated summary based on file analysis
	sections.push("## Overview\n");
	const overviewText = generateOverview(category, files, fileSummaries, dirPart);
	sections.push(overviewText);
	sections.push("");

	// File table — compact reference
	sections.push("## Files\n");
	sections.push("| File | Lines | Purpose |");
	sections.push("|------|-------|--------|");
	for (const { file: f, lang, exports } of fileSummaries) {
		const purpose = generateFilePurpose(f, lang, exports);
		sections.push(`| \`${f.relativePath}\` | ${f.lines} | ${purpose} |`);
	}
	sections.push("");

	// Key exports (only if present)
	const uniqueExports = [...new Set(allExports)];
	if (uniqueExports.length > 0) {
		sections.push("## Key Exports\n");
		for (const exp of uniqueExports.slice(0, 10)) {
			sections.push(`- \`${exp}\``);
		}
		sections.push("");
	}

	// Dependencies (only external ones, compact)
	if (allImports.size > 0) {
		sections.push("## Dependencies\n");
		sections.push([...allImports].slice(0, 10).map((imp) => `\`${imp}\``).join(", "));
		sections.push("");
	}

	// Architecture notes — extract function signatures and key patterns
	const archNotes = extractArchitectureNotes(fileSummaries);
	if (archNotes) {
		sections.push("## Architecture\n");
		sections.push(archNotes);
		sections.push("");
	}

	// Agent usage instructions
	sections.push("## When to Reference\n");
	sections.push(generateAgentUsage(category, title, fileSummaries, dirPart));
	sections.push("");

	const content = sections.join("\n");

	// Build related files
	const related: string[] = [];
	for (const f of files) {
		const lang = detectLanguage(f.extension);
		const imports = extractImports(f.content, lang);
		for (const imp of imports) {
			if (imp.startsWith(".")) related.push(imp);
		}
	}

	// Description — concise, meaningful
	const languages = new Set(files.map((f) => detectLanguage(f.extension)));
	const langStr = [...languages].join(", ");
	let description: string;
	if (files.length === 1) {
		const lang = detectLanguage(firstFile.extension);
		const exports = extractExports(firstFile.content, lang);
		description = buildDescription(firstFile, lang, exports);
	} else {
		description = `${category} — ${files.length} files (${langStr}) in ${dirPart || "root"}`;
	}

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
