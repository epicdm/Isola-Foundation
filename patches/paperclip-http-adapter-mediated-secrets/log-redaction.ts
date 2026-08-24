import os from "node:os";

export const CURRENT_USER_REDACTION_TOKEN = "*";

export interface CurrentUserRedactionOptions {
  enabled?: boolean;
  replacement?: string;
  userNames?: string[];
  homeDirs?: string[];
}

type CurrentUserCandidates = {
  userNames: string[];
  homeDirs: string[];
  replacement: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueNonEmpty(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}

function splitPathSegments(value: string) {
  return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}

function replaceLastPathSegment(pathValue: string, replacement: string) {
  const normalized = pathValue.replace(/[\\/]+$/, "");
  const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (lastSeparator < 0) return replacement;
  return `${normalized.slice(0, lastSeparator + 1)}${replacement}`;
}

export function maskUserNameForLogs(value: string, fallback = CURRENT_USER_REDACTION_TOKEN) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  return `${trimmed[0]}${"*".repeat(Math.max(1, Array.from(trimmed).length - 1))}`;
}

function defaultUserNames() {
  const candidates = [
    process.env.USER,
    process.env.LOGNAME,
    process.env.USERNAME,
  ];

  try {
    candidates.push(os.userInfo().username);
  } catch {
    // Some environments do not expose userInfo; env vars are enough fallback.
  }

  return uniqueNonEmpty(candidates);
}

function defaultHomeDirs(userNames: string[]) {
  const candidates: Array<string | null | undefined> = [
    process.env.HOME,
    process.env.USERPROFILE,
  ];

  try {
    candidates.push(os.homedir());
  } catch {
    // Ignore and fall back to env hints below.
  }

  for (const userName of userNames) {
    candidates.push(`/Users/${userName}`);
    candidates.push(`/home/${userName}`);
    candidates.push(`C:\\Users\\${userName}`);
  }

  return uniqueNonEmpty(candidates);
}

let cachedCurrentUserCandidates: CurrentUserCandidates | null = null;

function getDefaultCurrentUserCandidates(): CurrentUserCandidates {
  if (cachedCurrentUserCandidates) return cachedCurrentUserCandidates;
  const userNames = defaultUserNames();
  cachedCurrentUserCandidates = {
    userNames,
    homeDirs: defaultHomeDirs(userNames),
    replacement: CURRENT_USER_REDACTION_TOKEN,
  };
  return cachedCurrentUserCandidates;
}

function resolveCurrentUserCandidates(opts?: CurrentUserRedactionOptions) {
  const defaults = getDefaultCurrentUserCandidates();
  const userNames = uniqueNonEmpty(opts?.userNames ?? defaults.userNames);
  const homeDirs = uniqueNonEmpty(opts?.homeDirs ?? defaults.homeDirs);
  const replacement = opts?.replacement?.trim() || defaults.replacement;
  return { userNames, homeDirs, replacement };
}

export function redactCurrentUserText(input: string, opts?: CurrentUserRedactionOptions) {
  if (!input) return input;
  if (opts?.enabled === false) return input;

  const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);
  let result = input;

  for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
    if (!result.includes(homeDir)) continue;
    const lastSegment = splitPathSegments(homeDir).pop() ?? "";
    const replacementDir = lastSegment
      ? replaceLastPathSegment(homeDir, maskUserNameForLogs(lastSegment, replacement))
      : replacement;
    result = result.split(homeDir).join(replacementDir);
  }

  for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
    if (!result.includes(userName)) continue;
    const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
    result = result.replace(pattern, maskUserNameForLogs(userName, replacement));
  }

  return result;
}

export function redactCurrentUserValue<T>(value: T, opts?: CurrentUserRedactionOptions): T {
  if (typeof value === "string") {
    return redactCurrentUserText(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCurrentUserValue(entry, opts)) as T;
  }
  if (!isPlainObject(value)) {
    return value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = redactCurrentUserValue(entry, opts);
  }
  return redacted as T;
}

// ---------------------------------------------------------------------------
// SECRET VALUES MUST NEVER REACH THE LOGS
// ---------------------------------------------------------------------------

/**
 * Field names whose VALUE is a credential and must never be logged.
 *
 * Added 2026-08-24 after a planted-canary probe proved that a failed
 * `POST /api/companies/{id}/secrets` writes the entire request body to the
 * service log at WARN level — secret value in clear. A 201 does not; only the
 * failure path does, which is worse than it sounds: a 409 means "this key
 * already exists", which is precisely the moment an operator retries with the
 * same value, logging it again on every attempt.
 *
 * Matching is on the KEY NAME, so it protects any route that happens to carry
 * one of these fields, not just the secrets endpoint.
 */
const SECRET_LOG_KEYS = /^(value|secret|secretValue|password|passphrase|token|accessToken|refreshToken|api_?key|apiToken|authorization|auth|credential|privateKey|clientSecret)$/i;

export const SECRET_LOG_REPLACEMENT = "[REDACTED]";

/**
 * Recursively replace credential-bearing values, preserving structure.
 *
 * What is DELIBERATELY kept: every other field. The route, the company id, the
 * secret's `key` and `name`, the error classification and the status all stay
 * readable, because an unreadable log is its own outage. Only the value goes.
 *
 * Depth-limited: a hostile or cyclic body must not turn a log line into a hang.
 */
export function redactSecretValuesForLogs<T>(value: T, depth = 0): T {
  if (depth > 8) return SECRET_LOG_REPLACEMENT as unknown as T;
  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValuesForLogs(entry, depth + 1)) as unknown as T;
  }
  if (!isPlainObject(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = SECRET_LOG_KEYS.test(key)
      ? SECRET_LOG_REPLACEMENT
      : redactSecretValuesForLogs(entry, depth + 1);
  }
  return out as unknown as T;
}
