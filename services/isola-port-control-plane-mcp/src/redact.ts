/**
 * redact.ts
 *
 * Defense-in-depth redaction layer. Runs AFTER the read-only client layer
 * and BEFORE anything is handed back to an MCP tool caller.
 *
 * Rules (exact, documented per spec):
 *
 * 1. Phone numbers (STRUCTURED string values): any string value that looks
 *    like a phone number has all but the last 4 digits masked, e.g.
 *    "+17678183742" -> "*******3742". Detection: 7+ digit characters where
 *    digits are the dominant content. ISO dates/timestamps are exempt (a
 *    date is not a phone number).
 *
 * 2. Emails: masked consistently as `<first-char-of-local>***@<tld>`.
 *
 * 3. Any object key matching /(secret|token|key|password|credential)/i:
 *    the value is fully redacted to "[REDACTED]" regardless of type.
 *
 * 4. Keys named body/message/transcript/content/text are stripped to
 *    "[STRIPPED]" (conversation-like content). These stay stripped even in
 *    read_record; they can never be added to the free-text whitelist.
 *
 * 5. Entity-type allowlist: only ALLOWLISTED_BLUEPRINTS may be returned.
 *
 * 6. (internal-agent addition) VALUE-LEVEL SCRUB on every returned string:
 *    bearer tokens, Authorization headers, JWTs, common key shapes, PEM
 *    private keys, password/secret/token/api_key assignments, long
 *    base64/hex runs (unlabelled), connection strings with credentials.
 *    Replaced with [REDACTED:kind].
 *
 * 7. (internal-agent addition) FREE TEXT (read_record whitelisted fields)
 *    additionally gets embedded-email masking and a STRICTER phone mask.
 */

export const ALLOWLISTED_BLUEPRINTS = [
  "decision",
  "requirement",
  "build_task",
  "defect",
  "evidence",
  "capability",
  "marketing_claim",
  "epic_project",
  "uat_test_case",
  "incident",
  "risk",
  // Internal-agent additions (see docs/SECURITY-REVIEW.md, addendum A)
  "execution_plan",
  "execution_packet",
  "isola_launch_gate",
  "isola_component",
  "agent_contract"
] as const;

export type AllowlistedBlueprint = (typeof ALLOWLISTED_BLUEPRINTS)[number];

export function isAllowlistedBlueprint(blueprint: unknown): blueprint is AllowlistedBlueprint {
  return typeof blueprint === "string" && (ALLOWLISTED_BLUEPRINTS as readonly string[]).includes(blueprint);
}

const SECRET_KEY_RE = /(secret|token|key|password|credential)/i;
const STRIPPED_BODY_KEYS = new Set(["body", "message", "transcript", "content", "text"]);

const PHONE_RE = /(\+?\d[\d\s\-().]{6,}\d)/g;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:?\d{2})?)?$/;

// ---------------------------------------------------------------------
// Free-text field whitelist (read_record only).
// ---------------------------------------------------------------------
const COMMON_FREE_TEXT = [
  "description", "summary", "plan", "current_state", "next_action", "next_gate",
  "decision_text", "rationale", "context", "consequences", "objective",
  "acceptance", "acceptance_criteria", "evidence_needed", "rollback",
  "stop_conditions", "scope", "root_cause", "resolution", "impact",
  "verification", "contract"
];

export const FREE_TEXT_FIELDS_BY_BLUEPRINT: Record<string, ReadonlySet<string>> = Object.fromEntries(
  ALLOWLISTED_BLUEPRINTS.map((bp) => [bp, new Set(COMMON_FREE_TEXT)])
);

/** Secret-looking and conversation-like keys are NEVER free text, whatever the whitelist says. */
export function isFreeTextKey(blueprint: string, key: string): boolean {
  if (SECRET_KEY_RE.test(key)) return false;
  if (STRIPPED_BODY_KEYS.has(key.toLowerCase())) return false;
  return FREE_TEXT_FIELDS_BY_BLUEPRINT[blueprint]?.has(key) ?? false;
}

// ---------------------------------------------------------------------
// Value-level scrub
// ---------------------------------------------------------------------
const DIGEST_LABEL_RE = /(?:sha-?\d*|hash|digest|commit|checksum|md5)\s*[:=]?\s*["'`]?$/i;
const HEX_ONLY_RE = /^[0-9a-fA-F]+$/;
const KEY_DIGEST_LABEL_RE = /(sha-?\d*|hash|digest|commit|checksum)/i;

export function scrubSecrets(input: string, keyHint?: string): string {
  let v = input;
  v = v.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED:pem_private_key]");
  v = v.replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, "[REDACTED:pem_private_key]");
  v = v.replace(/\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s:@\/]+:[^\s@\/]+@[^\s]+/g, "[REDACTED:connection_string]");
  v = v.replace(/\bAuthorization\s*:[^\r\n]*/gi, "Authorization: [REDACTED:authorization_header]");
  v = v.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "[REDACTED:bearer_token]");
  v = v.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[REDACTED:jwt]");
  v = v.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, "[REDACTED:api_key]");
  v = v.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED:github_token]");
  v = v.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED:github_token]");
  v = v.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "[REDACTED:slack_token]");
  v = v.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws_access_key]");
  v = v.replace(/\bAIza[0-9A-Za-z_-]{35}/g, "[REDACTED:google_api_key]");
  v = v.replace(
    /([A-Za-z0-9_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*["']?\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;"'\]})]+)/gi,
    "$1[REDACTED:credential_assignment]"
  );
  const keyLabelled = keyHint !== undefined && KEY_DIGEST_LABEL_RE.test(keyHint);
  v = v.replace(/[A-Za-z0-9]{32,}/g, (m: string, offset: number, whole: string) => {
    const hex = HEX_ONLY_RE.test(m);
    if (!hex && !(/[0-9]/.test(m) && /[A-Za-z]/.test(m))) return m; // plain long word
    if (hex) {
      if (keyLabelled && m.length === whole.length) return m;
      if (DIGEST_LABEL_RE.test(whole.slice(Math.max(0, offset - 24), offset))) return m;
    }
    return "[REDACTED:long_secret_like_string]";
  });
  v = v.replace(/[A-Za-z0-9+\/]{40,}={1,2}/g, "[REDACTED:base64_blob]");
  return v;
}

const EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// E.164-ish with leading '+': +1 767 818 0001, +17678180001
const PHONE_PLUS_RE = /(?<![\w])\+\d[\d\s().-]{7,20}\d(?![\w])/g;
// NANP-style with separators: 767-818-0001, (767) 818-0001, 1.767.818.0001
const PHONE_NANP_RE = /(?<![\w+.:\/-])(?:1[\s.-])?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?![\w-])/g;

function maskDigitsKeepLast4(match: string): string {
  const digits = match.replace(/\D/g, "");
  return "*".repeat(Math.max(digits.length - 4, 0)) + digits.slice(-4);
}

/**
 * Stricter phone masking for FREE TEXT. Leaves ISO timestamps, dates,
 * versions, UUIDs, hashes, entity ids, percentages and amounts alone.
 * Bare unseparated digit runs WITHOUT a leading '+' are intentionally not
 * masked (epoch seconds / ids / amounts are indistinguishable from them).
 */
export function maskPhonesInText(text: string): string {
  let out = text.replace(PHONE_PLUS_RE, (m) => {
    const n = m.replace(/\D/g, "").length;
    if (n < 8 || n > 15) return m;
    if (/\d{4}-\d{2}-\d{2}/.test(m)) return m;
    return maskDigitsKeepLast4(m);
  });
  out = out.replace(PHONE_NANP_RE, (m) => maskDigitsKeepLast4(m));
  return out;
}

export function maskEmail(value: string): string {
  if (!EMAIL_RE.test(value)) return value;
  const [local, domain] = value.split("@");
  const tldParts = domain.split(".");
  const tld = tldParts[tldParts.length - 1];
  const firstChar = local.charAt(0) || "*";
  return `${firstChar}***@${tld}`;
}

export function maskEmailsInText(text: string): string {
  return text.replace(EMAIL_IN_TEXT_RE, (m) => maskEmail(m));
}

/** Full free-text pipeline: secret scrub, then email + strict phone masking. */
export function redactFreeText(text: string, keyHint?: string): string {
  return maskPhonesInText(maskEmailsInText(scrubSecrets(text, keyHint)));
}

export function maskPhoneNumber(value: string): string {
  return value.replace(PHONE_RE, (match) => {
    const digits = match.replace(/\D/g, "");
    if (digits.length < 4) return match;
    const last4 = digits.slice(-4);
    const maskedLen = Math.max(digits.length - 4, 0);
    return "*".repeat(maskedLen) + last4;
  });
}

function looksLikePhone(value: string): boolean {
  if (ISO_DATE_RE.test(value.trim())) return false;
  const digitCount = (value.match(/\d/g) || []).length;
  return digitCount >= 7 && digitCount / value.length > 0.5;
}

function redactStringValue(raw: string, keyHint?: string): string {
  const value = scrubSecrets(raw, keyHint);
  if (EMAIL_RE.test(value)) return maskEmail(value);
  if (looksLikePhone(value)) return maskPhoneNumber(value);
  return value;
}

/**
 * Recursively redact a value. `keyHint` is the object key this value was
 * stored under (if any), used for secret-key and body/transcript rules.
 */
export function redactValue(value: unknown, keyHint?: string): unknown {
  if (keyHint && SECRET_KEY_RE.test(keyHint)) {
    return "[REDACTED]";
  }
  if (keyHint && STRIPPED_BODY_KEYS.has(keyHint.toLowerCase())) {
    return "[STRIPPED]";
  }

  if (typeof value === "string") {
    return redactStringValue(value, keyHint);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, k);
    }
    return out;
  }
  return value;
}

/**
 * Apply the full allowlist + redaction pipeline to a single Port entity.
 * Returns null if the entity's blueprint is not allowlisted.
 */
export function sanitizeEntity(entity: unknown): Record<string, unknown> | null {
  if (!entity || typeof entity !== "object") return null;
  const rec = entity as Record<string, unknown>;
  const blueprint = rec.blueprint ?? rec.$blueprint;
  if (!isAllowlistedBlueprint(blueprint)) {
    return null;
  }
  return redactValue(rec) as Record<string, unknown>;
}

/** Filter + redact a list of entities in one pass, dropping non-allowlisted ones. */
export function sanitizeEntities(entities: unknown[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of entities) {
    const s = sanitizeEntity(e);
    if (s) out.push(s);
  }
  return out;
}
