/**
 * Core type definitions for the pi-md-knowledge package.
 */

/** Metadata stored in .kb/state.json */
export interface KbState {
	version: 1;
	createdAt: string;
	updatedAt: string;
	lastCommitHash?: string;
	fileHashes: Record<string, string>;
	summary: {
		totalFiles: number;
		totalEntries: number;
		categories: Record<string, number>;
	};
}

/** Frontmatter structure for each .kb/*.md file */
export interface KbEntryFrontmatter {
	title: string;
	description: string;
	category: KbCategory;
	tags: string[];
	related: string[];
	updatedAt: string;
	sourceFiles: string[];
}

/** Categories for organizing knowledge base entries */
export type KbCategory =
	| "architecture"
	| "module"
	| "api"
	| "config"
	| "data-model"
	| "testing"
	| "build"
	| "documentation"
	| "scripts"
	| "styles"
	| "infrastructure"
	| "general";

/** A scanned file with metadata */
export interface ScannedFile {
	path: string;
	relativePath: string;
	extension: string;
	size: number;
	lines: number;
	lastModified: Date;
	content: string;
}

/** A generated knowledge base entry ready for writing */
export interface KbEntry {
	filename: string;
	frontmatter: KbEntryFrontmatter;
	content: string;
}

/** Result of an init operation */
export interface InitResult {
	entriesCreated: number;
	filesScanned: number;
	durationMs: number;
	categories: Record<string, number>;
}

/** Result of an update operation */
export interface UpdateResult {
	entriesCreated: number;
	entriesUpdated: number;
	entriesRemoved: number;
	filesScanned: number;
	durationMs: number;
}

/** Result of an add operation */
export interface AddResult {
	filename: string;
	created: boolean;
}

/** File classification heuristic */
export interface FileClassification {
	category: KbCategory;
	priority: number;
	groupKey: string;
}

/** Configuration for the knowledge base */
export interface KbConfig {
	/** Directories to always ignore (in addition to defaults) */
	ignorePatterns: string[];
	/** Maximum number of lines per knowledge entry */
	maxEntryLines: number;
	/** Maximum content lines to include from a source file */
	maxSourceLines: number;
	/** File extensions to include in scanning */
	includeExtensions: string[];
	/** Whether to include file content in entries or just structure */
	includeContent: boolean;
}

export const DEFAULT_CONFIG: KbConfig = {
	ignorePatterns: [],
	maxEntryLines: 80,
	maxSourceLines: 40,
	includeExtensions: [],
	includeContent: true,
};

/** Directories and patterns always excluded from scanning */
export const DEFAULT_IGNORE_PATTERNS = [
	"node_modules",
	".git",
	".kb",
	".pi",
	"dist",
	"build",
	"out",
	".next",
	".nuxt",
	"coverage",
	".turbo",
	".cache",
	".temp",
	"__pycache__",
	".venv",
	"vendor",
	".tox",
	".mypy_cache",
	".pytest_cache",
	"target",
	".gradle",
	".idea",
	".vscode",
	".DS_Store",
	"*.min.js",
	"*.min.css",
	"*.map",
	"*.lock",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"composer.lock",
	"Gemfile.lock",
	"poetry.lock",
];

/** File extension to category mapping */
export const EXTENSION_CATEGORY_MAP: Record<string, KbCategory> = {
	// API / routes
	".route": "api",
	".controller": "api",
	".resolver": "api",
	".handler": "api",
	".middleware": "api",
	// Config
	".env": "config",
	".toml": "config",
	".yaml": "config",
	".yml": "config",
	".ini": "config",
	".conf": "config",
	// Data models
	".model": "data-model",
	".schema": "data-model",
	".entity": "data-model",
	".migration": "data-model",
	".prisma": "data-model",
	// Testing
	".test": "testing",
	".spec": "testing",
	// Build
	".dockerfile": "build",
	".dockerignore": "build",
	// Styles
	".css": "styles",
	".scss": "styles",
	".sass": "styles",
	".less": "styles",
	".styled": "styles",
};

/** Filename-based category overrides */
export const FILENAME_CATEGORY_MAP: Record<string, KbCategory> = {
	"dockerfile": "build",
	"docker-compose": "infrastructure",
	"docker-compose.yml": "infrastructure",
	"docker-compose.yaml": "infrastructure",
	"makefile": "build",
	"package.json": "build",
	"tsconfig.json": "config",
	"jsconfig.json": "config",
	"vite.config": "config",
	"webpack.config": "config",
	"rollup.config": "config",
	"next.config": "config",
	"nuxt.config": "config",
	"tailwind.config": "config",
	"postcss.config": "config",
	".eslintrc": "config",
	".prettierrc": "config",
	"jest.config": "testing",
	"vitest.config": "testing",
	"cypress.config": "testing",
	"playwright.config": "testing",
	"README": "documentation",
	"CHANGELOG": "documentation",
	"CONTRIBUTING": "documentation",
	"LICENSE": "documentation",
	".github": "infrastructure",
	".gitlab-ci": "infrastructure",
	".circleci": "infrastructure",
	"terraform": "infrastructure",
	"serverless": "infrastructure",
	"sam": "infrastructure",
	"cdk": "infrastructure",
};

/** All valid categories */
export const ALL_CATEGORIES: KbCategory[] = [
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
];

/** Category display names and descriptions */
export const CATEGORY_META: Record<KbCategory, { label: string; description: string }> = {
	architecture: { label: "Architecture", description: "High-level project structure and design decisions" },
	module: { label: "Modules", description: "Source code modules and their responsibilities" },
	api: { label: "API", description: "API endpoints, routes, controllers, and handlers" },
	config: { label: "Configuration", description: "Project configuration files and settings" },
	"data-model": { label: "Data Models", description: "Database schemas, models, and data structures" },
	testing: { label: "Testing", description: "Test files, test configurations, and test utilities" },
	build: { label: "Build System", description: "Build scripts, Dockerfiles, and CI/CD" },
	documentation: { label: "Documentation", description: "README files, guides, and documentation" },
	scripts: { label: "Scripts", description: "Utility scripts and automation" },
	styles: { label: "Styles", description: "CSS, SCSS, and styling files" },
	infrastructure: { label: "Infrastructure", description: "Infrastructure as code, deployment configs" },
	general: { label: "General", description: "Miscellaneous project files" },
};
