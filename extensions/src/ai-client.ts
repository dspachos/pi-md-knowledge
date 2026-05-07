/**
 * AI client — spawns a pi subprocess to get LLM completions.
 *
 * Uses `pi --mode json -p --no-session` to get structured LLM output
 * without affecting the current session. Each call creates a temp file
 * for large prompts and streams events back.
 *
 * Architecture:
 *   - Phase 1: Scan files (static) → collect file batches
 *   - Phase 2: AI plans the KB structure (what entries to create)
 *   - Phase 3: AI generates each entry's content (in parallel chunks)
 *   - Phase 4: Write results to .kb/
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFile, writeFile, mkdir, rm, mkdtemp } from "node:fs/promises";
import type { Message } from "@mariozechner/pi-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AiClientOptions {
	/** Working directory for the subprocess */
	cwd: string;
	/** Optional model override (passed as --model) */
	model?: string;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Callback for progress updates */
	onProgress?: (message: string) => void;
}

export interface AiResult {
	/** The final text output from the LLM */
	text: string;
	/** Token usage if available */
	usage?: {
		input: number;
		output: number;
		cost: number;
	};
	/** Any stderr output */
	stderr: string;
	/** Exit code */
	exitCode: number;
}

export interface PlannedEntry {
	/** Suggested filename (e.g. "module_auth.md") */
	filename: string;
	/** Title for frontmatter */
	title: string;
	/** Category */
	category: string;
	/** Source files to include */
	sourceFiles: string[];
	/** Brief description of what this entry should cover */
	brief: string;
}

// ---------------------------------------------------------------------------
// Temp file management
// ---------------------------------------------------------------------------

/** Create a temp directory for prompt files. */
export async function createTempDir(prefix = "pi-kb-"): Promise<string> {
	const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
	return dir;
}

/** Clean up temp directory. */
export async function cleanupTempDir(dir: string): Promise<void> {
	try {
		await rm(dir, { recursive: true, force: true });
	} catch {
		// Ignore cleanup errors
	}
}

/** Write a prompt to a temp file, return the path. */
async function writePromptFile(tmpDir: string, name: string, content: string): Promise<string> {
	const filePath = path.join(tmpDir, name);
	await writeFile(filePath, content, "utf-8");
	return filePath;
}

// ---------------------------------------------------------------------------
// LLM invocation
// ---------------------------------------------------------------------------

/** Figure out how to invoke pi (handles both installed pi and dev mode) */
function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

/**
 * Send a prompt to the LLM and get the text response.
 * Uses `pi --mode json` for structured output.
 */
export async function askLlm(
	systemPrompt: string,
	userPrompt: string,
	options: AiClientOptions,
): Promise<AiResult> {
	const tmpDir = await createTempDir();

	try {
		// Write prompts to temp files (they can be large)
		const systemFile = await writePromptFile(tmpDir, "system.md", systemPrompt);
		const userFile = await writePromptFile(tmpDir, "user.md", userPrompt);

		const args: string[] = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--append-system-prompt", systemFile,
		];

		if (options.model) {
			args.push("--model", options.model);
		}

		// The user prompt is passed as the final argument
		args.push(userFile);

		return await runPiProcess(args, options);
	} finally {
		await cleanupTempDir(tmpDir);
	}
}

/**
 * Send a prompt with inline content (for smaller prompts where temp files aren't needed).
 */
export async function askLlmInline(
	systemPrompt: string,
	userPrompt: string,
	options: AiClientOptions,
): Promise<AiResult> {
	const tmpDir = await createTempDir();

	try {
		const systemFile = await writePromptFile(tmpDir, "system.md", systemPrompt);

		const args: string[] = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--append-system-prompt", systemFile,
		];

		if (options.model) {
			args.push("--model", options.model);
		}

		// Pass user prompt directly as the task
		args.push(userPrompt);

		return await runPiProcess(args, options);
	} finally {
		await cleanupTempDir(tmpDir);
	}
}

/** Run a pi subprocess and collect JSON events. */
function runPiProcess(args: string[], options: AiClientOptions): Promise<AiResult> {
	return new Promise<AiResult>((resolve, reject) => {
		const invocation = getPiInvocation(args);
		let wasAborted = false;

		const result: AiResult = {
			text: "",
			usage: undefined,
			stderr: "",
			exitCode: 0,
		};

		const proc = spawn(invocation.command, invocation.args, {
			cwd: options.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdoutBuffer = "";
		let stderrBuffer = "";

		const processStdoutLine = (line: string) => {
			if (!line.trim()) return;
			let event: any;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}

			if (event.type === "message_end" && event.message) {
				const msg = event.message as Message;
				if (msg.role === "assistant") {
					// Accumulate text from assistant messages
					for (const part of msg.content) {
						if (part.type === "text" && part.text) {
							result.text += part.text;
						}
					}

					// Extract usage
					if (msg.usage) {
						result.usage = {
							input: (result.usage?.input ?? 0) + (msg.usage.input || 0),
							output: (result.usage?.output ?? 0) + (msg.usage.output || 0),
							cost: (result.usage?.cost ?? 0) + (msg.usage.cost?.total || 0),
						};
					}
				}
			}
		};

		proc.stdout.on("data", (data: Buffer) => {
			stdoutBuffer += data.toString();
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() || "";
			for (const line of lines) processStdoutLine(line);
		});

		proc.stderr.on("data", (data: Buffer) => {
			stderrBuffer += data.toString();
		});

		proc.on("close", (code) => {
			// Process any remaining buffer
			if (stdoutBuffer.trim()) processStdoutLine(stdoutBuffer);
			result.exitCode = code ?? 0;
			result.stderr = stderrBuffer;

			if (wasAborted) {
				reject(new Error("AI request was aborted"));
			} else if (result.exitCode !== 0 && !result.text) {
				reject(new Error(`pi exited with code ${result.exitCode}: ${stderrBuffer.slice(0, 500)}`));
			} else {
				resolve(result);
			}
		});

		proc.on("error", (err) => {
			reject(new Error(`Failed to spawn pi: ${err.message}`));
		});

		// Handle abort
		if (options.signal) {
			const kill = () => {
				wasAborted = true;
				proc.kill("SIGTERM");
				setTimeout(() => {
					if (!proc.killed) proc.kill("SIGKILL");
				}, 5000);
			};

			if (options.signal.aborted) {
				kill();
			} else {
				options.signal.addEventListener("abort", kill, { once: true });
			}
		}
	});
}

// ---------------------------------------------------------------------------
// Batched file reading
// ---------------------------------------------------------------------------

export interface FileBatch {
	/** Relative paths in this batch */
	files: string[];
	/** Combined content of all files in this batch */
	content: string;
	/** Approximate token count (rough: chars / 4) */
	estimatedTokens: number;
}

/**
 * Split files into batches that fit within a token budget.
 * Reads each file and groups them until the budget is exceeded.
 */
export async function batchFiles(
	cwd: string,
	filePaths: string[],
	maxTokensPerBatch: number = 60000,
	onProgress?: (file: string, index: number, total: number) => void,
): Promise<FileBatch[]> {
	const batches: FileBatch[] = [];
	let currentFiles: string[] = [];
	let currentContent = "";
	let currentTokens = 0;

	for (let i = 0; i < filePaths.length; i++) {
		const relPath = filePaths[i];
		onProgress?.(relPath, i, filePaths.length);

		let content: string;
		try {
			content = await readFile(path.join(cwd, relPath), "utf-8");
		} catch {
			continue; // Skip unreadable files
		}

		// Rough token estimate: ~4 chars per token
		const tokens = Math.ceil(content.length / 4);

		// If this single file exceeds the budget, it gets its own batch
		if (tokens > maxTokensPerBatch) {
			// Flush current batch first
			if (currentFiles.length > 0) {
				batches.push({
					files: currentFiles,
					content: currentContent,
					estimatedTokens: currentTokens,
				});
				currentFiles = [];
				currentContent = "";
				currentTokens = 0;
			}

			// Truncate the large file
			const maxChars = maxTokensPerBatch * 4;
			const truncated = content.length > maxChars
				? content.slice(0, maxChars) + "\n... (truncated)"
				: content;

			batches.push({
				files: [relPath],
				content: `=== ${relPath} ===\n${truncated}`,
				estimatedTokens: maxTokensPerBatch,
			});
			continue;
		}

		// Would adding this file exceed the budget?
		if (currentTokens + tokens > maxTokensPerBatch && currentFiles.length > 0) {
			// Flush current batch
			batches.push({
				files: currentFiles,
				content: currentContent,
				estimatedTokens: currentTokens,
			});
			currentFiles = [];
			currentContent = "";
			currentTokens = 0;
		}

		currentFiles.push(relPath);
		currentContent += `=== ${relPath} ===\n${content}\n\n`;
		currentTokens += tokens;
	}

	// Flush remaining
	if (currentFiles.length > 0) {
		batches.push({
			files: currentFiles,
			content: currentContent,
			estimatedTokens: currentTokens,
		});
	}

	return batches;
}

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

/** Format a duration in ms to human-readable. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const mins = Math.floor(ms / 60000);
	const secs = Math.floor((ms % 60000) / 1000);
	return `${mins}m ${secs}s`;
}

/** Format token count. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 1000000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}
