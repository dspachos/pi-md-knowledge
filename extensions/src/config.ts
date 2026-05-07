/**
 * Configuration loader for pi-md-knowledge.
 *
 * Reads optional .kbrc.json from the project root for custom settings.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { KbConfig } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

const CONFIG_FILENAME = ".kbrc.json";

export async function loadConfig(cwd: string): Promise<KbConfig> {
	const configPath = join(cwd, CONFIG_FILENAME);
	try {
		const raw = await readFile(configPath, "utf-8");
		const parsed = JSON.parse(raw);
		return {
			ignorePatterns: parsed.ignorePatterns ?? DEFAULT_CONFIG.ignorePatterns,
			maxEntryLines: parsed.maxEntryLines ?? DEFAULT_CONFIG.maxEntryLines,
			maxSourceLines: parsed.maxSourceLines ?? DEFAULT_CONFIG.maxSourceLines,
			includeExtensions: parsed.includeExtensions ?? DEFAULT_CONFIG.includeExtensions,
			includeContent: parsed.includeContent ?? DEFAULT_CONFIG.includeContent,
		};
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}
