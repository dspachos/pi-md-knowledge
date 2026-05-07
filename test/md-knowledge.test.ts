/**
 * Tests for the pi-md-knowledge package.
 *
 * Run with: node --test test/*.test.ts  (via tsx or similar)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	sanitizeContent,
	isSensitiveFile,
	likelyContainsSecrets,
	sanitizeFileContent,
	sanitizeStructuredData,
} from "../extensions/src/sanitize.js";
import { hashContent } from "../extensions/src/scanner.js";
import { parseEntry } from "../extensions/src/writer.js";
import type { KbEntryFrontmatter } from "../extensions/src/types.js";

// ---------------------------------------------------------------------------
// Sanitize tests
// ---------------------------------------------------------------------------

describe("sanitize", () => {
	describe("sanitizeContent", () => {
		it("should redact password assignments", () => {
			const input = 'const password = "super-secret-123"';
			const result = sanitizeContent(input);
			assert.ok(!result.content.includes("super-secret-123"));
			assert.ok(result.redactionCount >= 1);
		});

		it("should redact API key assignments", () => {
			const input = 'api_key = "sk-abc123def456"';
			const result = sanitizeContent(input);
			assert.ok(!result.content.includes("sk-abc123def456"));
		});

		it("should redact AWS access keys", () => {
			const input = "AWS_KEY=AKIAIOSFODNN7EXAMPLE";
			const result = sanitizeContent(input);
			assert.ok(result.content.includes("[REDACTED"));
			assert.ok(!result.content.includes("AKIAIOSFODNN7EXAMPLE"));
		});

		it("should redact GitHub tokens", () => {
			const input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij";
			const result = sanitizeContent(input);
			assert.ok(!result.content.includes("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ"));
		});

		it("should redact connection strings with credentials", () => {
			const input = "mongodb://admin:password123@localhost:27017/mydb";
			const result = sanitizeContent(input);
			assert.ok(!result.content.includes("password123"));
		});

		it("should redact private key blocks", () => {
			const input =
				"-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE KEY-----";
			const result = sanitizeContent(input);
			assert.ok(result.content.includes("[REDACTED]"));
			assert.ok(!result.content.includes("MIIBOgIBAAJBAKj34"));
		});

		it("should redact .env-style secrets", () => {
			const input = "DATABASE_URL=postgres://user:pass@host/db\nJWT_SECRET=myjwtsecret123";
			const result = sanitizeContent(input);
			assert.ok(result.content.includes("[REDACTED]"));
		});

		it("should redact bearer tokens", () => {
			const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig';
			const result = sanitizeContent(input);
			assert.ok(result.content.includes("[REDACTED]"));
		});

		it("should leave safe content untouched", () => {
			const input = "const greeting = 'Hello, World!';\nconsole.log(greeting);";
			const result = sanitizeContent(input);
			assert.equal(result.content, input);
			assert.equal(result.redactionCount, 0);
		});

		it("should return triggered pattern names", () => {
			const input = 'password = "secret123"';
			const result = sanitizeContent(input);
			assert.ok(result.triggered.length > 0);
			assert.ok(result.triggered.includes("password-assignment"));
		});
	});

	describe("isSensitiveFile", () => {
		it("should flag .env files", () => {
			assert.equal(isSensitiveFile(".env"), true);
			assert.equal(isSensitiveFile(".env.local"), true);
			assert.equal(isSensitiveFile(".env.production"), true);
		});

		it("should flag credential files", () => {
			assert.equal(isSensitiveFile("credentials.json"), true);
			assert.equal(isSensitiveFile("serviceAccountKey.json"), true);
			assert.equal(isSensitiveFile("secrets.yaml"), true);
		});

		it("should flag private key files", () => {
			assert.equal(isSensitiveFile("id_rsa"), true);
			assert.equal(isSensitiveFile("id_ed25519"), true);
			assert.equal(isSensitiveFile("server.key"), true);
			assert.equal(isSensitiveFile("cert.pem"), true);
		});

		it("should not flag safe files", () => {
			assert.equal(isSensitiveFile("index.ts"), false);
			assert.equal(isSensitiveFile("config.json"), false);
			assert.equal(isSensitiveFile("README.md"), false);
			assert.equal(isSensitiveFile(".env.example"), false);
		});
	});

	describe("likelyContainsSecrets", () => {
		it("should detect code with passwords", () => {
			const input = 'const password = "mysecretpassword"';
			assert.equal(likelyContainsSecrets(input), true);
		});

		it("should not flag simple code", () => {
			const input = "function add(a, b) { return a + b; }";
			assert.equal(likelyContainsSecrets(input), false);
		});
	});

	describe("sanitizeFileContent", () => {
		it("should return null for sensitive files", () => {
			const result = sanitizeFileContent(".env", "DB_PASSWORD=secret");
			assert.equal(result, null);
		});

		it("should sanitize content from normal files", () => {
			const result = sanitizeFileContent("config.ts", 'const apiKey = "sk-123456"');
			assert.ok(result !== null);
			assert.ok(!result.includes("sk-123456"));
		});
	});

	describe("sanitizeStructuredData", () => {
		it("should redact secret keys in objects", () => {
			const data = {
				name: "myapp",
				password: "super-secret",
				api_key: "sk-test",
				nested: {
					token: "abc123",
					safe: "value",
				},
			};
			const result = sanitizeStructuredData(data);
			assert.equal(result.name, "myapp");
			assert.equal(result.password, "[REDACTED]");
			assert.equal((result.nested as any).token, "[REDACTED]");
			assert.equal((result.nested as any).safe, "value");
		});
	});
});

// ---------------------------------------------------------------------------
// Scanner tests
// ---------------------------------------------------------------------------

describe("scanner", () => {
	describe("hashContent", () => {
		it("should produce consistent hashes", () => {
			const a = hashContent("hello");
			const b = hashContent("hello");
			assert.equal(a, b);
		});

		it("should produce different hashes for different content", () => {
			const a = hashContent("hello");
			const b = hashContent("world");
			assert.notEqual(a, b);
		});

		it("should return a 16-char hex string", () => {
			const h = hashContent("test");
			assert.equal(h.length, 16);
			assert.ok(/^[0-9a-f]+$/.test(h));
		});
	});
});

// ---------------------------------------------------------------------------
// Writer tests
// ---------------------------------------------------------------------------

describe("writer", () => {
	describe("parseEntry", () => {
		it("should parse valid frontmatter", () => {
			const raw = [
				"---",
				'title: "My Module"',
				'description: "A test module"',
				"category: module",
				"tags:",
				"  - typescript",
				"  - module",
				"related:",
				"  - ./src/utils.md",
				'updatedAt: "2025-01-01T00:00:00.000Z"',
				"sourceFiles:",
				"  - src/index.ts",
				"---",
				"",
				"## Overview",
				"",
				"This is the content.",
			].join("\n");

			const entry = parseEntry(raw, "test.md");
			assert.ok(entry);
			assert.equal(entry!.frontmatter.title, "My Module");
			assert.equal(entry!.frontmatter.category, "module");
			assert.deepEqual(entry!.frontmatter.tags, ["typescript", "module"]);
			assert.deepEqual(entry!.frontmatter.sourceFiles, ["src/index.ts"]);
			assert.ok(entry!.content.includes("This is the content."));
		});

		it("should return null for content without frontmatter", () => {
			const raw = "Just some plain text without frontmatter.";
			const entry = parseEntry(raw, "plain.md");
			assert.equal(entry, null);
		});

		it("should return null for unclosed frontmatter", () => {
			const raw = "---\ntitle: test\nNo closing";
			const entry = parseEntry(raw, "broken.md");
			assert.equal(entry, null);
		});
	});
});
