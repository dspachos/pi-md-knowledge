/**
 * Knowledge extractor — extracts MEANINGFUL knowledge from source code.
 *
 * This is the core intelligence of the knowledge base. Instead of just
 * listing file metadata (line counts, exports), it analyzes code to extract:
 *
 * - Purpose: What does this module/file ACTUALLY DO?
 * - Responsibilities: What problems does it solve?
 * - Key Concepts: What are the important abstractions?
 * - Data Flow: How does data move through the code?
 * - Patterns: What design patterns or conventions are used?
 * - Relationships: How do the components interact?
 * - Configuration: What settings control behavior?
 * - Error Handling: How are failures handled?
 * - Dependencies: What external services/libraries are needed and WHY?
 * - API Surface: What does this expose and how should it be used?
 */

import type { ScannedFile, KbCategory } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExtractedKnowledge {
	/** One-sentence purpose of the file/module */
	purpose: string;
	/** What this code is responsible for (2-5 bullet points) */
	responsibilities: string[];
	/** Key abstractions, types, or concepts the code introduces */
	keyConcepts: string[];
	/** How data flows through the code */
	dataFlow: string[];
	/** Design patterns or architectural decisions evident in the code */
	patterns: string[];
	/** How errors and edge cases are handled */
	errorHandling: string[];
	/** External dependencies and what they're used for */
	dependencyPurposes: string[];
	/** Public API surface — what this module exposes to consumers */
	apiSurface: string[];
	/** Configuration options and their effects */
	configuration: string[];
	/** Important constraints, invariants, or assumptions */
	constraints: string[];
}

export interface FileKnowledge extends ExtractedKnowledge {
	file: ScannedFile;
	language: string;
}

// ---------------------------------------------------------------------------
// Language detection helper
// ---------------------------------------------------------------------------

function detectLanguage(ext: string): string {
	const map: Record<string, string> = {
		".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
		".py": "python", ".rb": "ruby", ".go": "go", ".rs": "rust", ".java": "java",
		".kt": "kotlin", ".swift": "swift", ".c": "c", ".cpp": "cpp", ".cs": "csharp",
		".php": "php", ".ex": "elixir", ".exs": "elixir", ".erl": "erlang",
		".hs": "haskell", ".lua": "lua", ".sql": "sql", ".sh": "shell",
		".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
		".md": "markdown", ".css": "css", ".scss": "scss", ".graphql": "graphql",
		".tf": "terraform", ".dart": "dart", ".vue": "vue", ".svelte": "svelte",
		".proto": "protobuf", ".html": "html",
	};
	return map[ext] || "unknown";
}

// ---------------------------------------------------------------------------
// JSDoc / TSDoc / Doc Comment Extraction
// ---------------------------------------------------------------------------

/** Extract all JSDoc/TSDoc comment blocks from source code. */
function extractDocComments(content: string): string[] {
	const comments: string[] = [];

	// Multi-line /** ... */ comments
	const multiLinePattern = /\/\*\*([\s\S]*?)\*\//g;
	let match: RegExpExecArray | null;
	while ((match = multiLinePattern.exec(content)) !== null) {
		const body = match[1]
			.replace(/^\s*\*\s?/gm, "")  // Remove leading * from each line
			.trim();
		if (body.length > 10) comments.push(body);
	}

	// Single-line /** ... */ comments
	const singleLinePattern = /\/\*\*?\s*([^*\n]+?)\s*\*\//g;
	while ((match = singleLinePattern.exec(content)) !== null) {
		if (match[1].trim().length > 10) comments.push(match[1].trim());
	}

	return comments;
}

/** Extract Python docstrings. */
function extractDocstrings(content: string): string[] {
	const docstrings: string[] = [];

	// Triple-quoted strings after class/function definitions
	const pattern = /(?:^|\n)(?:class|def|async\s+def)\s+\w+[^:]*:\s*\n\s+"""([\s\S]*?)"""/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(content)) !== null) {
		const body = match[1].trim();
		if (body.length > 10) docstrings.push(body);
	}

	// Module-level docstrings
	const moduleDoc = content.match(/^"""([\s\S]*?)"""/);
	if (moduleDoc && moduleDoc[1].trim().length > 10) {
		docstrings.unshift(moduleDoc[1].trim());
	}

	return docstrings;
}

/** Extract the module-level description from a file's first doc comment or leading comment. */
function extractModuleDescription(content: string, language: string): string {
	// Try doc comments first
	let comments: string[];
	if (language === "python") {
		comments = extractDocstrings(content);
	} else {
		comments = extractDocComments(content);
	}

	if (comments.length > 0) {
		// Take the first meaningful comment — often the module description
		const first = comments[0];
		// Return just the first paragraph (before @param, @returns, etc.)
		const firstParagraph = first.split(/\n\s*\n/)[0]
			.replace(/@\w+.*$/s, "")  // Remove JSDoc tags
			.trim();
		if (firstParagraph.length > 10) return firstParagraph;
	}

	// Try leading // comments at the top of the file
	const leadingComments: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.startsWith("//")) {
			leadingComments.push(trimmed.replace(/^\/\/\s?/, ""));
		} else if (trimmed === "" && leadingComments.length > 0) {
			continue; // Allow blank lines in the header comment block
		} else {
			break;
		}
	}
	if (leadingComments.length > 0) {
		const joined = leadingComments.join(" ").trim();
		if (joined.length > 10) return joined;
	}

	return "";
}

// ---------------------------------------------------------------------------
// TypeScript / JavaScript Knowledge Extraction
// ---------------------------------------------------------------------------

function extractTsJsKnowledge(file: ScannedFile): ExtractedKnowledge {
	const content = file.content;
	const knowledge: ExtractedKnowledge = {
		purpose: "",
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	// --- Purpose from module description ---
	const moduleDesc = extractModuleDescription(content, "typescript");
	if (moduleDesc) {
		// Take the first meaningful sentence only, cleaned up
		let firstSentence = moduleDesc.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
		const periodIdx = firstSentence.indexOf(".");
		if (periodIdx > 0 && periodIdx < 120) {
			firstSentence = firstSentence.slice(0, periodIdx + 1);
		}
		knowledge.purpose = firstSentence;
	}

	// --- Key Concepts from types/interfaces ---
	const typePattern = /(?:export\s+)?(?:type|interface)\s+(\w+)(?:\s+extends\s+(\w+))?\s*(?:=|\{)/g;
	let match: RegExpExecArray | null;
	const typeHierarchy: string[] = [];
	while ((match = typePattern.exec(content)) !== null) {
		const name = match[1];
		const parent = match[2];
		if (parent) {
			typeHierarchy.push(`\`${name}\` extends \`${parent}\``);
		} else {
			typeHierarchy.push(`\`${name}\``);
		}

		// Extract what the type/interface contains (property names)
		const braceStart = content.indexOf("{", match.index);
		if (braceStart > 0) {
			const props = extractInterfaceProperties(content, braceStart);
			if (props.length > 0) {
				knowledge.keyConcepts.push(`\`${name}\` defines: ${props.slice(0, 6).join(", ")}${props.length > 6 ? `, +${props.length - 6} more` : ""}`);
			}
		}
	}
	if (typeHierarchy.length > 0) {
		knowledge.keyConcepts.unshift(`Types: ${typeHierarchy.slice(0, 8).join(", ")}`);
	}

	// --- Enums with their values ---
	const enumPattern = /enum\s+(\w+)\s*\{([^}]+)\}/g;
	while ((match = enumPattern.exec(content)) !== null) {
		const name = match[1];
		const values = match[2].split(",").map(v => v.trim().split("=")[0].trim()).filter(Boolean);
		knowledge.keyConcepts.push(`\`${name}\` enum: ${values.slice(0, 10).join(", ")}`);
	}

	// --- Responsibilities from exported functions ---
	// Note: only match doc comments directly attached to functions (no code lines in between)
	const funcPattern = /\/\*\*((?:(?!\*\/)[^])*?)\*\/\n(?:\s*\n)?\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(([^)]*)\)/g;
	while ((match = funcPattern.exec(content)) !== null) {
		const docText = match[1].replace(/^\s*\*\s?/gm, "").trim();
		const funcName = match[2];
		const params = match[3].trim();

		// Extract description from JSDoc (before any @ tags)
		const desc = docText.split(/@\w/)[0].trim();
		if (desc) {
			knowledge.responsibilities.push(desc.split(".")[0] + ` (via \`${funcName}\`)`);
		}

		// Extract @param descriptions for data flow
		const paramDocs = docText.match(/@param\s+\w+\s+-?\s*([^@]+)/g);
		if (paramDocs) {
			for (const pd of paramDocs) {
				const cleaned = pd.replace(/@param\s+\w+\s+-?\s*/, "").trim();
				if (cleaned) knowledge.dataFlow.push(cleaned);
			}
		}

		// Extract @returns for API surface
		const returnsDoc = docText.match(/@returns?\s+([^@]+)/);
		if (returnsDoc) {
			knowledge.apiSurface.push(`\`${funcName}(${summarizeParams(params)})\` → ${returnsDoc[1].trim()}`);
		} else {
			knowledge.apiSurface.push(`\`${funcName}(${summarizeParams(params)})\``);
		}
	}

	// --- Arrow functions and const exports ---
	const arrowPattern = /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s+)?\(([^)]*)\)\s*(?::\s*[^=]+?)?\s*=>/g;
	while ((match = arrowPattern.exec(content)) !== null) {
		const name = match[1];
		const params = match[2].trim();
		if (!name.startsWith("_")) {
			knowledge.apiSurface.push(`\`${name}(${summarizeParams(params)})\``);
		}
	}

	// --- Class-based exports ---
	const classPattern = /\/\*\*([\s\S]*?)\*\/\s*(?:export\s+)?(?:default\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?(?:\s+implements\s+([^{]+))?\s*\{/g;
	while ((match = classPattern.exec(content)) !== null) {
		const docText = match[1].replace(/^\s*\*\s?/gm, "").trim();
		const className = match[2];
		const extendsClass = match[3];
		const implementsInterface = match[4];

		const desc = docText.split(/@\w/)[0].trim();
		if (desc) {
			knowledge.responsibilities.push(desc.split(".")[0]);
		}

		let classDesc = `\`${className}\``;
		if (extendsClass) classDesc += ` extends \`${extendsClass}\``;
		if (implementsInterface) classDesc += ` implements \`${implementsInterface.trim()}\``;
		knowledge.keyConcepts.push(classDesc);

		// Extract class methods
		const classBody = extractClassBody(content, match.index);
		if (classBody) {
			const methodPattern = /(?:(?:public|private|protected|static|async|abstract)\s+)*(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{]+)?\s*\{/g;
			let mMatch: RegExpExecArray | null;
			while ((mMatch = methodPattern.exec(classBody)) !== null) {
				const methodName = mMatch[1];
				if (methodName !== "constructor" && !methodName.startsWith("_")) {
					knowledge.apiSurface.push(`\`${className}.${methodName}(${summarizeParams(mMatch[2])})\``);
				}
			}
		}
	}

	// --- Error handling patterns ---
	const tryCatchPattern = /catch\s*\((\w+)\)\s*\{/g;
	while ((match = tryCatchPattern.exec(content)) !== null) {
		const errorVar = match[1];
		// Look at what happens in the catch block
		const catchStart = match.index + match[0].length;
		const catchBody = extractBlockBody(content, catchStart - 1);
		if (catchBody) {
			const patterns: string[] = [];
			if (catchBody.includes("log") || catchBody.includes("console")) patterns.push("logs errors");
			if (catchBody.includes("throw") || catchBody.includes("raise")) patterns.push("re-throws");
			if (catchBody.includes("return")) patterns.push("returns error value");
			if (catchBody.includes("retry")) patterns.push("implements retry logic");
			if (catchBody.includes("notify") || catchBody.includes("report")) patterns.push("reports errors");

			if (patterns.length > 0) {
				knowledge.errorHandling.push(patterns.join(", "));
			} else {
				knowledge.errorHandling.push(`catches \`${errorVar}\` errors`);
			}
		}
	}

	// Null/undefined checks
	const nullChecks = content.match(/\?\./g);
	if (nullChecks && nullChecks.length > 3) {
		knowledge.errorHandling.push("Uses optional chaining for null safety");
	}

	// Error type definitions
	const errorClassPattern = /class\s+(\w+)\s+extends\s+(?:Error|[\w.]*Error)/g;
	while ((match = errorClassPattern.exec(content)) !== null) {
		knowledge.errorHandling.push(`Defines custom error: \`${match[1]}\``);
	}

	// --- Dependency purposes ---
	const importPattern = /import\s+.*?\s+from\s+['"]([^./][^'"]*)['"]/g;
	const importMap = new Map<string, string[]>();
	while ((match = importPattern.exec(content)) !== null) {
		const mod = match[1];
		// Extract what's imported from this module
		const importLine = content.slice(
			content.lastIndexOf("import", match.index),
			match.index + match[0].length,
		);
		const namedImports = importLine.match(/\{([^}]+)\}/);
		if (namedImports) {
			importMap.set(mod, namedImports[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0].trim()));
		} else {
			const defaultImport = importLine.match(/import\s+(\w+)/);
			if (defaultImport) importMap.set(mod, [defaultImport[1]]);
		}
	}

	for (const [mod, imports] of importMap) {
		knowledge.dependencyPurposes.push(`\`${mod}\` → ${imports.slice(0, 5).join(", ")}`);
	}

	// --- Configuration from constant objects ---
	const configPattern = /(?:const|export\s+const)\s+(\w*(?:CONFIG|OPTIONS|SETTINGS|DEFAULTS|CONSTANTS)\w*)\s*(?::\s*\w+)?\s*=\s*(?:\{|Readonly\()/gi;
	while ((match = configPattern.exec(content)) !== null) {
		const configName = match[1];
		const braceStart = content.indexOf("{", match.index);
		if (braceStart > 0) {
			const props = extractObjectProperties(content, braceStart);
			if (props.length > 0) {
				knowledge.configuration.push(`\`${configName}\`: ${props.slice(0, 8).join(", ")}`);
			}
		}
	}

	// --- Patterns detection ---
	// Observer/Event pattern
	if (/\.on\(|\.emit\(|\.subscribe\(|addEventListener/.test(content)) {
		knowledge.patterns.push("Event-driven / Observer pattern");
	}
	// Factory pattern
	if (/create\w+|factory|build\w+|make\w+/i.test(content) && /return\s+(?:new|{)/.test(content)) {
		knowledge.patterns.push("Factory pattern");
	}
	// Middleware pattern
	if (/middleware|next\(\)|\.use\(/.test(content)) {
		knowledge.patterns.push("Middleware pattern");
	}
	// Singleton
	if (/getInstance|private\s+static\s+instance|private\s+constructor/.test(content)) {
		knowledge.patterns.push("Singleton pattern");
	}
	// Builder pattern
	if (/builder|\.with\w+\(|\.set\w+\(.*return\s+this/.test(content)) {
		knowledge.patterns.push("Builder pattern");
	}
	// Async patterns
	if (/Promise|async|await/.test(content)) {
		knowledge.patterns.push("Asynchronous execution with Promises/async-await");
	}
	// Generator pattern
	if (/function\s*\*|yield/.test(content)) {
		knowledge.patterns.push("Generator/Iterator pattern");
	}
	// Plugin/Extension pattern
	if (/register|plugin|extension|hook/.test(content)) {
		knowledge.patterns.push("Plugin/Extension architecture");
	}
	// Map/Record-based lookup
	if (/new\s+Map\(\[|Record<|as\s+const/.test(content)) {
		knowledge.patterns.push("Map/Record-based data structures");
	}

	// --- Constraints / Invariants ---
	// Assert statements
	const assertPattern = /assert(?:\.strict)?\.(?:equal|deepEqual|ok|throws)\([^)]+\)/g;
	const asserts = content.match(assertPattern);
	if (asserts && asserts.length > 0) {
		knowledge.constraints.push(`Contains ${asserts.length} assertion(s) for validation`);
	}

	// Type guards
	const guardPattern = /function\s+is\w+\(.*\)\s*:\s*\w+\s+is\s+\w+/g;
	while ((match = guardPattern.exec(content)) !== null) {
		knowledge.constraints.push(`Type guard: ${match[0].replace(/\s+/g, " ")}`);
	}

	// Validation patterns
	if (/\.test\(|\.match\(|typeof\s+\w+\s*===|instanceof\s+/.test(content)) {
		const validations: string[] = [];
		const typeofChecks = content.match(/typeof\s+(\w+)\s*===?\s*['"](\w+)['"]/g);
		if (typeofChecks) {
			for (const tc of typeofChecks) {
				validations.push(tc);
			}
		}
		if (validations.length > 0) {
			knowledge.constraints.push(`Runtime type validation: ${validations.slice(0, 5).join(", ")}`);
		}
	}

	// Fill purpose from function/class names if no doc comment
	if (!knowledge.purpose) {
		const exports = extractExportedNames(content);
		const mainExport = exports[0];
		if (mainExport) {
			// Heuristic: generate a purpose from the main export name
			const words = mainExport.replace(/([A-Z])/g, " $1").toLowerCase().trim();
			knowledge.purpose = `Provides ${words} functionality.`;
		}
	}

	return knowledge;
}

// ---------------------------------------------------------------------------
// Python Knowledge Extraction
// ---------------------------------------------------------------------------

function extractPythonKnowledge(file: ScannedFile): ExtractedKnowledge {
	const content = file.content;
	const knowledge: ExtractedKnowledge = {
		purpose: "",
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	// Module docstring
	const moduleDesc = extractModuleDescription(content, "python");
	if (moduleDesc) {
		knowledge.purpose = moduleDesc.split(".")[0] + ".";
	}

	// Classes
	const classPattern = /class\s+(\w+)(?:\(([^)]+)\))?:/g;
	let match: RegExpExecArray | null;
	while ((match = classPattern.exec(content)) !== null) {
		const name = match[1];
		const parents = match[2];
		let desc = `\`${name}\``;
		if (parents) desc += ` inherits from \`${parents}\``;
		knowledge.keyConcepts.push(desc);
	}

	// Functions with docstrings
	const funcPattern = /(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*[^:]+)?:\s*\n\s+"""([\s\S]*?)"""/g;
	while ((match = funcPattern.exec(content)) !== null) {
		const name = match[1];
		const params = match[2];
		const docstring = match[3].trim();

		const firstLine = docstring.split("\n")[0].trim();
		if (firstLine) {
			knowledge.responsibilities.push(firstLine + ` (via \`${name}\`)`);
		}

		knowledge.apiSurface.push(`\`${name}(${summarizeParams(params)})\``);
	}

	// Decorators (patterns)
	const decoratorPattern = /@(\w+)/g;
	const decorators = new Set<string>();
	while ((match = decoratorPattern.exec(content)) !== null) {
		decorators.add(match[1]);
	}
	if (decorators.has("abstractmethod")) knowledge.patterns.push("Abstract base classes");
	if (decorators.has("dataclass") || decorators.has("attrs")) knowledge.patterns.push("Data classes");
	if (decorators.has("pytest") || decorators.has("fixture")) knowledge.patterns.push("pytest fixtures");
	if (decorators.has("staticmethod") || decorators.has("classmethod")) knowledge.patterns.push("Class/static methods");

	// Imports
	const importPattern = /^(?:from|import)\s+(\w[\w.]*)/gm;
	while ((match = importPattern.exec(content)) !== null) {
		knowledge.dependencyPurposes.push(`\`${match[1]}\``);
	}

	// Error handling
	const exceptionPattern = /(?:raise|except)\s+(\w+)/g;
	const exceptions = new Set<string>();
	while ((match = exceptionPattern.exec(content)) !== null) {
		exceptions.add(match[1]);
	}
	if (exceptions.size > 0) {
		knowledge.errorHandling.push(`Handles/raises: ${[...exceptions].slice(0, 6).map(e => `\`${e}\``).join(", ")}`);
	}

	// Purpose from function/class names if no docstring
	if (!knowledge.purpose) {
		const classes = [...content.matchAll(/^class\s+(\w+)/gm)].map(m => m[1]);
		const functions = [...content.matchAll(/^(?:async\s+)?def\s+(\w+)/gm)].map(m => m[1]);
		const main = classes[0] || functions[0];
		if (main) {
			const words = main.replace(/([A-Z])/g, " $1").toLowerCase().trim();
			knowledge.purpose = `Provides ${words} functionality.`;
		}
	}

	return knowledge;
}

// ---------------------------------------------------------------------------
// Generic Knowledge Extraction (for any language)
// ---------------------------------------------------------------------------

function extractGenericKnowledge(file: ScannedFile): ExtractedKnowledge {
	const content = file.content;
	const knowledge: ExtractedKnowledge = {
		purpose: "",
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	// Extract any comments as purpose hints
	const moduleDesc = extractModuleDescription(content, "unknown");
	if (moduleDesc) {
		knowledge.purpose = moduleDesc.split(".")[0] + ".";
	}

	return knowledge;
}

// ---------------------------------------------------------------------------
// JSON / YAML / TOML Config Extraction
// ---------------------------------------------------------------------------

function extractConfigKnowledge(file: ScannedFile): ExtractedKnowledge {
	const content = file.content;
	const knowledge: ExtractedKnowledge = {
		purpose: "",
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	const ext = file.extension;
	const fileName = file.relativePath.split("/").pop() || file.relativePath;

	if (ext === ".json") {
		try {
			const parsed = JSON.parse(content);
			const keys = Object.keys(parsed);

			// package.json special handling
			if (fileName === "package.json") {
				knowledge.purpose = `Node.js package manifest for \`${parsed.name || "unknown"}\` (v${parsed.version || "0.0.0"}).`;
				if (parsed.description) knowledge.purpose = `${parsed.description} — v${parsed.version || "0.0.0"}.`;

				if (parsed.scripts && Object.keys(parsed.scripts).length > 0) {
					const scripts = Object.entries(parsed.scripts)
						.map(([k, v]) => `\`${k}\`: ${String(v)}`)
						.slice(0, 10);
					knowledge.configuration.push(`Scripts: ${scripts.join(", ")}`);
				}

				if (parsed.dependencies && Object.keys(parsed.dependencies).length > 0) {
					const deps = Object.keys(parsed.dependencies).slice(0, 15);
					knowledge.dependencyPurposes.push(`Dependencies: ${deps.join(", ")}`);
				}

				if (parsed.devDependencies && Object.keys(parsed.devDependencies).length > 0) {
					const deps = Object.keys(parsed.devDependencies).slice(0, 15);
					knowledge.dependencyPurposes.push(`Dev dependencies: ${deps.join(", ")}`);
				}

				if (parsed.peerDependencies && Object.keys(parsed.peerDependencies).length > 0) {
					const deps = Object.keys(parsed.peerDependencies).slice(0, 10);
					knowledge.dependencyPurposes.push(`Peer dependencies: ${deps.join(", ")}`);
				}

				if (parsed.main) knowledge.keyConcepts.push(`Entry point: \`${parsed.main}\``);
				if (parsed.type) knowledge.keyConcepts.push(`Module type: ${parsed.type}`);

				// pi-specific config
				if (parsed.pi) {
					const piConfig = Object.entries(parsed.pi)
						.map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
						.slice(0, 10);
					knowledge.configuration.push(`Pi config: ${piConfig.join(", ")}`);
				}
			} else if (fileName === "tsconfig.json") {
				knowledge.purpose = "TypeScript compiler configuration.";
				if (parsed.compilerOptions) {
					const opts = Object.entries(parsed.compilerOptions)
						.map(([k, v]) => `${k}: ${v}`)
						.slice(0, 12);
					knowledge.configuration.push(`Compiler options: ${opts.join(", ")}`);
				}
				if (parsed.include) knowledge.configuration.push(`Includes: ${parsed.include.join(", ")}`);
				if (parsed.exclude) knowledge.configuration.push(`Excludes: ${parsed.exclude.join(", ")}`);
			} else {
				// Generic JSON
				knowledge.purpose = `Configuration file with keys: ${keys.slice(0, 10).join(", ")}.`;
				for (const key of keys.slice(0, 10)) {
					const val = parsed[key];
					const type = Array.isArray(val) ? `array (${val.length} items)` : typeof val;
					knowledge.configuration.push(`\`${key}\`: ${type}`);
				}
			}
		} catch {
			knowledge.purpose = "JSON configuration file (possibly malformed).";
		}
	} else if (ext === ".yaml" || ext === ".yml") {
		// Extract top-level keys from YAML
		const topKeys = content.match(/^(\w[\w-]*):/gm);
		if (topKeys) {
			const keys = topKeys.map(k => k.replace(":", ""));
			knowledge.purpose = `YAML configuration covering: ${keys.slice(0, 10).join(", ")}.`;
			knowledge.configuration = keys.slice(0, 15).map(k => `\`${k}\``);
		}
	} else if (ext === ".toml") {
		const sections = content.match(/^\[([^\]]+)\]/gm);
		if (sections) {
			knowledge.purpose = `TOML configuration with sections: ${sections.join(", ")}.`;
			knowledge.configuration = sections.map(s => `\`${s}\``);
		}
	}

	return knowledge;
}

// ---------------------------------------------------------------------------
// Markdown Documentation Extraction
// ---------------------------------------------------------------------------

function extractMarkdownKnowledge(file: ScannedFile): ExtractedKnowledge {
	const content = file.content;
	const knowledge: ExtractedKnowledge = {
		purpose: "",
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	// Extract headings to understand document structure
	const headings = content.match(/^#{1,3}\s+(.+)$/gm);
	if (headings) {
		knowledge.keyConcepts = headings
			.map(h => h.replace(/^#+\s+/, "").trim())
			.filter(h => h.length > 2)
			.slice(0, 15);
	}

	// First paragraph after the first heading as purpose
	const firstHeading = content.match(/^#\s+(.+)$/m);
	if (firstHeading) {
		const afterHeading = content.slice(content.indexOf(firstHeading[0]) + firstHeading[0].length).trim();
		const firstPara = afterHeading.split(/\n\s*\n/)[0]?.trim();
		if (firstPara && firstPara.length > 10) {
			knowledge.purpose = firstPara.split(".")[0] + ".";
		} else {
			knowledge.purpose = `Documentation: ${firstHeading[1].trim()}.`;
		}
	}

	// Code blocks indicate what technologies/tools are discussed
	const codeBlocks = content.match(/```\w+/g);
	if (codeBlocks) {
		const languages = [...new Set(codeBlocks.map(b => b.replace("```", "")))];
		if (languages.length > 0) {
			knowledge.patterns.push(`Code examples in: ${languages.join(", ")}`);
		}
	}

	return knowledge;
}

// ---------------------------------------------------------------------------
// Helper Functions
// ---------------------------------------------------------------------------

/** Extract property names from an interface body starting at the opening brace. */
function extractInterfaceProperties(content: string, bracePos: number): string[] {
	const props: string[] = [];
	let depth = 0;
	let i = bracePos;
	let lastPropStart = -1;

	for (; i < content.length; i++) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") { depth--; if (depth === 0) break; }
		else if (depth === 1 && /[a-zA-Z]/.test(content[i]) && (i === 0 || /[\s;,\n{]/.test(content[i - 1]))) {
			// Potential property name start
			const rest = content.slice(i);
			const propMatch = rest.match(/^(\w+)(\?)?:\s*/);
			if (propMatch && !["type", "interface", "export", "import", "const", "let", "var", "function", "class", "return", "if", "else"].includes(propMatch[1])) {
				props.push(propMatch[1] + (propMatch[2] ? "?" : ""));
				i += propMatch[0].length;
			}
		}
	}
	return props;
}

/** Extract property names from a plain object literal. */
function extractObjectProperties(content: string, bracePos: number): string[] {
	const props: string[] = [];
	let depth = 0;
	for (let i = bracePos; i < content.length && i < bracePos + 2000; i++) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") { depth--; if (depth === 0) break; }
		else if (depth === 1) {
			const rest = content.slice(i);
			const propMatch = rest.match(/^["']?(\w+)["']?\s*:/);
			if (propMatch) {
				props.push(propMatch[1]);
				i += propMatch[0].length;
			}
		}
	}
	return props;
}

/** Extract class body (everything between the opening and closing brace). */
function extractClassBody(content: string, classStart: number): string | null {
	const bracePos = content.indexOf("{", classStart);
	if (bracePos === -1) return null;

	let depth = 0;
	for (let i = bracePos; i < content.length; i++) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") { depth--; if (depth === 0) return content.slice(bracePos, i + 1); }
	}
	return null;
}

/** Extract block body starting from the opening brace character. */
function extractBlockBody(content: string, bracePos: number): string | null {
	if (content[bracePos] !== "{") return null;
	let depth = 0;
	for (let i = bracePos; i < content.length; i++) {
		if (content[i] === "{") depth++;
		else if (content[i] === "}") { depth--; if (depth === 0) return content.slice(bracePos + 1, i); }
	}
	return null;
}

/** Summarize function parameters into a readable form. */
function summarizeParams(params: string): string {
	if (!params.trim()) return "";
	const paramList = params.split(",").map(p => {
		const trimmed = p.trim();
		if (!trimmed) return "";
		// Extract just the parameter name
		const name = trimmed.split(":")[0].split("=")[0].split("?")[0].trim();
		return name;
	}).filter(Boolean);

	if (paramList.length === 0) return "";
	if (paramList.length <= 3) return paramList.join(", ");
	return `${paramList.slice(0, 3).join(", ")}, ...`;
}

/** Extract exported names from source code. */
function extractExportedNames(content: string): string[] {
	const names: string[] = [];
	const patterns = [
		/export\s+(?:default\s+)?function\s+(\w+)/g,
		/export\s+(?:default\s+)?class\s+(\w+)/g,
		/export\s+const\s+(\w+)/g,
		/export\s+(?:type|interface)\s+(\w+)/g,
		/export\s+\{([^}]+)\}/g,
	];

	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(content)) !== null) {
			if (match[1]) {
				if (pattern.source.startsWith("export\\s\\+\\{")) {
					// Named exports block
					const named = match[1].split(",").map(n => n.trim().split(/\s+as\s+/).pop()!.trim());
					names.push(...named);
				} else {
					names.push(match[1]);
				}
			}
		}
	}

	return [...new Set(names)];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Extract knowledge from a single file. */
export function extractFileKnowledge(file: ScannedFile): FileKnowledge {
	const language = detectLanguage(file.extension);

	let knowledge: ExtractedKnowledge;

	if (file.extension === ".json" || file.extension === ".yaml" || file.extension === ".yml" || file.extension === ".toml") {
		knowledge = extractConfigKnowledge(file);
	} else if (file.extension === ".md") {
		knowledge = extractMarkdownKnowledge(file);
	} else if (language === "typescript" || language === "javascript") {
		knowledge = extractTsJsKnowledge(file);
	} else if (language === "python") {
		knowledge = extractPythonKnowledge(file);
	} else {
		knowledge = extractGenericKnowledge(file);
	}

	return { file, language, ...knowledge };
}

/** Merge knowledge from multiple files into a single module-level knowledge object. */
export function mergeKnowledge(fileKnowledges: FileKnowledge[]): ExtractedKnowledge & { purposes: string[] } {
	const merged: ExtractedKnowledge & { purposes: string[] } = {
		purpose: "",
		purposes: [],
		responsibilities: [],
		keyConcepts: [],
		dataFlow: [],
		patterns: [],
		errorHandling: [],
		dependencyPurposes: [],
		apiSurface: [],
		configuration: [],
		constraints: [],
	};

	// Collect individual purposes
	for (const fk of fileKnowledges) {
		if (fk.purpose) merged.purposes.push(fk.purpose);
		merged.responsibilities.push(...fk.responsibilities);
		merged.keyConcepts.push(...fk.keyConcepts);
		merged.dataFlow.push(...fk.dataFlow);
		merged.patterns.push(...fk.patterns);
		merged.errorHandling.push(...fk.errorHandling);
		merged.dependencyPurposes.push(...fk.dependencyPurposes);
		merged.apiSurface.push(...fk.apiSurface);
		merged.configuration.push(...fk.configuration);
		merged.constraints.push(...fk.constraints);
	}

	// Deduplicate
	merged.responsibilities = [...new Set(merged.responsibilities)].slice(0, 12);
	merged.keyConcepts = [...new Set(merged.keyConcepts)].slice(0, 15);
	merged.dataFlow = [...new Set(merged.dataFlow)].slice(0, 8);
	merged.patterns = [...new Set(merged.patterns)].slice(0, 8);
	merged.errorHandling = [...new Set(merged.errorHandling)].slice(0, 6);
	merged.dependencyPurposes = [...new Set(merged.dependencyPurposes)].slice(0, 12);
	merged.apiSurface = [...new Set(merged.apiSurface)].slice(0, 15);
	merged.configuration = [...new Set(merged.configuration)].slice(0, 10);
	merged.constraints = [...new Set(merged.constraints)].slice(0, 6);

	// Synthesize a merged purpose
	if (merged.purposes.length === 1) {
		merged.purpose = merged.purposes[0];
	} else if (merged.purposes.length > 1) {
		merged.purpose = merged.purposes[0]; // Use the first one (usually the most important)
	}

	return merged;
}

/** Generate a meaningful description from extracted knowledge. */
export function generateDescription(knowledge: ExtractedKnowledge, category: KbCategory): string {
	if (knowledge.purpose) {
		// Truncate to a reasonable description length
		const purpose = knowledge.purpose.length > 150
			? knowledge.purpose.slice(0, 147) + "..."
			: knowledge.purpose;
		return purpose;
	}

	// Fallback: build from responsibilities
	if (knowledge.responsibilities.length > 0) {
		const mainResp = knowledge.responsibilities[0].replace(/\s*\(via.*\)$/, "");
		return mainResp.length > 150 ? mainResp.slice(0, 147) + "..." : mainResp;
	}

	// Fallback: build from API surface
	if (knowledge.apiSurface.length > 0) {
		const apis = knowledge.apiSurface.slice(0, 3).join(", ");
		return `Exposes: ${apis}`;
	}

	return `${category} module`;
}
