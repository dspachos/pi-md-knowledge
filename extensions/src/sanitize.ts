/**
 * Secret detection and redaction engine.
 *
 * Scans content for passwords, API keys, tokens, certificates,
 * connection strings, and other sensitive information, then
 * replaces them with safe placeholders.
 */

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

interface SecretPattern {
	/** Human-readable name for logging / reporting */
	name: string;
	/** RegExp — each capture group (or the full match) is redacted */
	pattern: RegExp;
	/** Replacement string ($1 etc. are preserved) */
	replacement: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
	// ---- Generic key=value secrets ----
	{
		name: "password-assignment",
		pattern: /\b(password|passwd|pwd|pass)\s*[:=]\s*['"]?([^\s'"`,;}\]){&]+)['"]?/gi,
		replacement: "$1=[REDACTED]",
	},
	{
		name: "secret-assignment",
		pattern:
			/\b(secret|secret_key|secretkey|secret_token|secrettoken)\s*[:=]\s*['"]?([^\s'"`,;}\]){&]+)['"]?/gi,
		replacement: "$1=[REDACTED]",
	},
	{
		name: "token-assignment",
		pattern:
			/\b(api_key|apikey|api_secret|apisecret|access_token|accesstoken|auth_token|authtoken|private_key|privatekey)\s*[:=]\s*['"]?([^\s'"`,;}\]){&]+)['"]?/gi,
		replacement: "$1=[REDACTED]",
	},
	{
		name: "credentials-url",
		pattern: /:\/\/([^:/\s]+):([^/@\s]+)@/g,
		replacement: "://$1:[REDACTED]@",
	},

	// ---- Bearer / basic auth headers ----
	{
		name: "bearer-token",
		pattern: /\b(Authoration|Authorization)\s*[:=]\s*['"]?(Bearer|Basic|Token)\s+([^\s'"`,;}\]])+/gi,
		replacement: "$1: $2 [REDACTED]",
	},

	// ---- Well-known key formats ----
	{
		name: "aws-access-key",
		pattern: /\b(AKIA[0-9A-Z]{16})\b/g,
		replacement: "[REDACTED_AWS_KEY]",
	},
	{
		name: "aws-secret-key",
		pattern: /\b([A-Za-z0-9/+=]{40})\b/g,
		replacement: "[REDACTED]",
	},
	{
		name: "github-token",
		pattern: /\b(gh[ps]_[A-Za-z0-9_]{36,})\b/g,
		replacement: "[REDACTED_GITHUB_TOKEN]",
	},
	{
		name: "github-oauth",
		pattern: /\b(github_pat_[A-Za-z0-9_]{22,})\b/g,
		replacement: "[REDACTED_GITHUB_PAT]",
	},
	{
		name: "slack-token",
		pattern: /\b(xox[bpsa]-[0-9A-Za-z-]{10,})\b/g,
		replacement: "[REDACTED_SLACK_TOKEN]",
	},
	{
		name: "stripe-key",
		pattern: /\b(sk_live_[0-9A-Za-z]{24,})\b/g,
		replacement: "[REDACTED_STRIPE_KEY]",
	},
	{
		name: "stripe-publishable",
		pattern: /\b(pk_live_[0-9A-Za-z]{24,})\b/g,
		replacement: "[REDACTED_STRIPE_PK]",
	},
	{
		name: "google-api-key",
		pattern: /\b(AIza[0-9A-Za-z_-]{35})\b/g,
		replacement: "[REDACTED_GOOGLE_KEY]",
	},
	{
		name: "firebase-key",
		pattern: /\b(AIzaSy[A-Za-z0-9_-]{33})\b/g,
		replacement: "[REDACTED_FIREBASE_KEY]",
	},
	{
		name: "heroku-key",
		pattern: /\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi,
		replacement: "[REDACTED_UUID]",
	},

	// ---- Connection strings ----
	{
		name: "mongodb-connection",
		pattern: /mongodb(\+srv)?:\/\/[^\s'"]+/gi,
		replacement: "mongodb://[REDACTED]",
	},
	{
		name: "postgres-connection",
		pattern: /postgres(ql)?:\/\/[^\s'"]+/gi,
		replacement: "postgresql://[REDACTED]",
	},
	{
		name: "mysql-connection",
		pattern: /mysql:\/\/*[^\s'"]+/gi,
		replacement: "mysql://[REDACTED]",
	},
	{
		name: "redis-connection",
		pattern: /rediss?:\/\/[^\s'"]+/gi,
		replacement: "redis://[REDACTED]",
	},
	{
		name: "jdbc-connection",
		pattern: /jdbc:[^\s'"]+/gi,
		replacement: "jdbc:[REDACTED]",
	},

	// ---- PEM / private key blocks ----
	{
		name: "private-key-block",
		pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/gim,
		replacement: "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",
	},
	{
		name: "ssh-private-key",
		pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/gim,
		replacement: "-----BEGIN OPENSSH PRIVATE KEY-----[REDACTED]-----END OPENSSH PRIVATE KEY-----",
	},

	// ---- .env-style secrets ----
	{
		name: "env-var-secret",
		pattern:
			/^\s*(DB_PASSWORD|DATABASE_URL|REDIS_URL|SECRET_KEY|JWT_SECRET|ENCRYPTION_KEY|MAIL_PASSWORD|SMTP_PASSWORD|SENDGRID_KEY|TWILIO_AUTH|AWS_SECRET|AZURE_KEY|VAULT_TOKEN)\s*=\s*.+$/gim,
		replacement: "$1=[REDACTED]",
	},
];

// ---------------------------------------------------------------------------
// Filename-based sensitivity checks
// ---------------------------------------------------------------------------

/** Files that should be entirely excluded from the knowledge base. */
const SENSITIVE_FILENAMES = new Set([
	".env",
	".env.local",
	".env.development",
	".env.production",
	".env.staging",
	".env.test",
	".env.ci",
	// .env.example is safe — contains no real secrets
	".npmrc",
	".pypirc",
	".netrc",
	".aws/credentials",
	".aws/config",
	"credentials.json",
	"serviceAccountKey.json",
	"secrets.yaml",
	"secrets.yml",
	"secrets.json",
	"id_rsa",
	"id_ed25519",
	"id_ecdsa",
	"ssh_config",
	"known_hosts",
	".htpasswd",
	".pgpass",
]);

/** Patterns for filenames that likely contain secrets. */
const SENSITIVE_PATTERNS = [
	/\.env\.(?!example)/i,
	/^credentials/i,
	/^secrets?[\._-]/i,
	/^.*\.pem$/i,
	/^.*\.p12$/i,
	/^.*\.pfx$/i,
	/^.*\.jks$/i,
	/^.*\.keystore$/i,
	/^id_(rsa|ed25519|ecdsa|dsa)$/i,
	/\.key$/i,  // matches files ending in .key, NOT config.json
];

// ---------------------------------------------------------------------------
// Content-based sensitivity check
// ---------------------------------------------------------------------------

/** Heuristic score: how likely is this content to contain real secrets? */
function sensitivityScore(content: string): number {
	let score = 0;
	const lower = content.toLowerCase();

	// Strong indicators
	if (/\bpassword\s*[:=]\s*['"][^'"]{4,}/i.test(content)) score += 3;
	if (/\bapi[_-]?key\s*[:=]\s*['"][^'"]{10,}/i.test(content)) score += 3;
	if (/\bsecret\s*[:=]\s*['"][^'"]{8,}/i.test(content)) score += 3;
	if (/-----BEGIN.*PRIVATE KEY-----/i.test(content)) score += 5;

	// Moderate indicators
	if (lower.includes("bearer ")) score += 1;
	if (lower.includes("authorization:")) score += 1;
	if (/mongodb:\/\//i.test(content)) score += 1;
	if (/postgres(ql)?:\/\//i.test(content)) score += 1;

	// Weak indicators (common in config templates)
	if (lower.includes("password")) score += 0.5;
	if (lower.includes("api_key")) score += 0.5;
	if (lower.includes("secret_key")) score += 0.5;

	return score;
}

// ---------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------()

export interface SanitizeResult {
	/** The sanitized content */
	content: string;
	/** Number of redactions made */
	redactionCount: number;
	/** Names of patterns that triggered */
	triggered: string[];
}

/**
 * Sanitize content by replacing detected secrets with redaction markers.
 *
 * Runs every pattern in order; later patterns see the output of earlier ones,
 * so a connection-string pattern can fire even after its embedded password was
 * already redacted.
 */
export function sanitizeContent(content: string): SanitizeResult {
	let sanitized = content;
	let totalRedactions = 0;
	const triggered = new Set<string>();

	for (const { name, pattern, replacement } of SECRET_PATTERNS) {
		const before = sanitized;
		sanitized = sanitized.replace(pattern, replacement);
		if (sanitized !== before) {
			triggered.add(name);
			// Count how many replacements occurred
			const matches = before.match(pattern);
			if (matches) totalRedactions += matches.length;
		}
	}

	return {
		content: sanitized,
		redactionCount: totalRedactions,
		triggered: [...triggered],
	};
}

/**
 * Check if a file should be entirely excluded from the knowledge base
 * due to its name/path being sensitive.
 */
export function isSensitiveFile(relativePath: string): boolean {
	const filename = relativePath.split("/").pop() ?? "";

	// Exact filename match
	if (SENSITIVE_FILENAMES.has(filename)) return true;
	if (SENSITIVE_FILENAMES.has(relativePath)) return true;

	// Pattern match
	for (const pattern of SENSITIVE_PATTERNS) {
		if (pattern.test(filename)) return true;
	}

	return false;
}

/**
 * Quick check whether content likely contains secrets worth scanning.
 * Returns true if the content has a sensitivity score above the threshold.
 */
export function likelyContainsSecrets(content: string): boolean {
	return sensitivityScore(content) >= 1.5;
}

/**
 * Full sanitization pipeline for a single file.
 *
 * Returns null if the file should be completely excluded,
 * or the sanitized content otherwise.
 */
export function sanitizeFileContent(relativePath: string, content: string): string | null {
	if (isSensitiveFile(relativePath)) return null;

	// Even non-sensitive-named files may contain embedded secrets
	const result = sanitizeContent(content);
	return result.content;
}

/**
 * Redact values inside frontmatter-like YAML/JSON structures.
 * Handles cases where structured data embeds secret values.
 */
export function sanitizeStructuredData(data: Record<string, unknown>): Record<string, unknown> {
	const SECRET_KEYS = new Set([
		"password",
		"passwd",
		"pwd",
		"secret",
		"secretkey",
		"secret_key",
		"api_key",
		"apikey",
		"access_token",
		"accesstoken",
		"auth_token",
		"authtoken",
		"private_key",
		"privatekey",
		"token",
		"key",
		"credential",
		"credentials",
	]);

	const result: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(data)) {
		if (SECRET_KEYS.has(k.toLowerCase()) && typeof v === "string" && v.length > 0) {
			result[k] = "[REDACTED]";
		} else if (typeof v === "object" && v !== null && !Array.isArray(v)) {
			result[k] = sanitizeStructuredData(v as Record<string, unknown>);
		} else {
			result[k] = v;
		}
	}
	return result;
}
