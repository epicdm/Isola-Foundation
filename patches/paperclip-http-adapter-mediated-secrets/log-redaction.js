import os from "node:os";
export const CURRENT_USER_REDACTION_TOKEN = "*";
function isPlainObject(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function uniqueNonEmpty(values) {
    return Array.from(new Set(values.map((value) => value?.trim() ?? "").filter(Boolean)));
}
function splitPathSegments(value) {
    return value.replace(/[\\/]+$/, "").split(/[\\/]+/).filter(Boolean);
}
function replaceLastPathSegment(pathValue, replacement) {
    const normalized = pathValue.replace(/[\\/]+$/, "");
    const lastSeparator = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
    if (lastSeparator < 0)
        return replacement;
    return `${normalized.slice(0, lastSeparator + 1)}${replacement}`;
}
export function maskUserNameForLogs(value, fallback = CURRENT_USER_REDACTION_TOKEN) {
    const trimmed = value.trim();
    if (!trimmed)
        return fallback;
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
    }
    catch {
        // Some environments do not expose userInfo; env vars are enough fallback.
    }
    return uniqueNonEmpty(candidates);
}
function defaultHomeDirs(userNames) {
    const candidates = [
        process.env.HOME,
        process.env.USERPROFILE,
    ];
    try {
        candidates.push(os.homedir());
    }
    catch {
        // Ignore and fall back to env hints below.
    }
    for (const userName of userNames) {
        candidates.push(`/Users/${userName}`);
        candidates.push(`/home/${userName}`);
        candidates.push(`C:\\Users\\${userName}`);
    }
    return uniqueNonEmpty(candidates);
}
let cachedCurrentUserCandidates = null;
function getDefaultCurrentUserCandidates() {
    if (cachedCurrentUserCandidates)
        return cachedCurrentUserCandidates;
    const userNames = defaultUserNames();
    cachedCurrentUserCandidates = {
        userNames,
        homeDirs: defaultHomeDirs(userNames),
        replacement: CURRENT_USER_REDACTION_TOKEN,
    };
    return cachedCurrentUserCandidates;
}
function resolveCurrentUserCandidates(opts) {
    const defaults = getDefaultCurrentUserCandidates();
    const userNames = uniqueNonEmpty(opts?.userNames ?? defaults.userNames);
    const homeDirs = uniqueNonEmpty(opts?.homeDirs ?? defaults.homeDirs);
    const replacement = opts?.replacement?.trim() || defaults.replacement;
    return { userNames, homeDirs, replacement };
}
export function redactCurrentUserText(input, opts) {
    if (!input)
        return input;
    if (opts?.enabled === false)
        return input;
    const { userNames, homeDirs, replacement } = resolveCurrentUserCandidates(opts);
    let result = input;
    for (const homeDir of [...homeDirs].sort((a, b) => b.length - a.length)) {
        if (!result.includes(homeDir))
            continue;
        const lastSegment = splitPathSegments(homeDir).pop() ?? "";
        const replacementDir = lastSegment
            ? replaceLastPathSegment(homeDir, maskUserNameForLogs(lastSegment, replacement))
            : replacement;
        result = result.split(homeDir).join(replacementDir);
    }
    for (const userName of [...userNames].sort((a, b) => b.length - a.length)) {
        if (!result.includes(userName))
            continue;
        const pattern = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(userName)}(?![A-Za-z0-9._-])`, "g");
        result = result.replace(pattern, maskUserNameForLogs(userName, replacement));
    }
    return result;
}
export function redactCurrentUserValue(value, opts) {
    if (typeof value === "string") {
        return redactCurrentUserText(value, opts);
    }
    if (Array.isArray(value)) {
        return value.map((entry) => redactCurrentUserValue(entry, opts));
    }
    if (!isPlainObject(value)) {
        return value;
    }
    const redacted = {};
    for (const [key, entry] of Object.entries(value)) {
        redacted[key] = redactCurrentUserValue(entry, opts);
    }
    return redacted;
}

// ---------------------------------------------------------------------------
// SECRET VALUES MUST NEVER REACH THE LOGS
// ---------------------------------------------------------------------------
//
// Added 2026-08-24 after a planted canary proved a failed
// `POST /api/companies/{id}/secrets` wrote the whole request body to the
// service log at WARN, secret value in clear. A 201 did not; only the failure
// path did — which is worse than it sounds, because a 409 means "this key
// already exists", exactly when an operator retries with the same value.
//
// The first version of this redactor was reviewed adversarially and FAILED on
// five counts. Every one is a case where the log LOOKED redacted and was not,
// so each is named here and pinned by a test:
//
//   (a) only `reqBody` was redacted — `reqQuery` and `reqParams` were not, so
//       `?token=…` sailed straight through
//   (b) snake/kebab variants missed: secret_value, access_token, client_secret,
//       private_key all survived a key regex written for camelCase
//   (c) an own enumerable `toJSON` was COPIED onto the clone, and pino called
//       it during serialisation, re-introducing the value after redaction
//   (d) `Object.entries` INVOKES getters, so a hostile accessor could throw
//       from inside the logger, or hand back the value it was meant to hide
//   (e) Error objects and class instances are not plain, so they were returned
//       untouched with their enumerable properties intact

/** Tokens that make a field a credential wherever they appear in its name. */
const SECRET_KEY_SUBSTRINGS = [
  "secret", "password", "passphrase", "token", "apikey", "credential",
  "privatekey", "clientsecret", "bearer", "sessionkey",
];

/** Names that are credentials exactly, but whose token is too common to match
 *  by substring without destroying useful logs (`value`, `auth`). */
const SECRET_KEY_EXACT = new Set([
  "value", "auth", "authorization", "cookie", "setcookie", "sessionid",
]);

export const SECRET_LOG_REPLACEMENT = "[REDACTED]";

/** Compare on letters and digits only, so secret_value / secret-value /
 *  SecretValue / SECRET_VALUE all reduce to the same thing. */
function normaliseKeyForSecretMatch(key) {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function isSecretLogKey(key) {
  const n = normaliseKeyForSecretMatch(key);
  if (SECRET_KEY_EXACT.has(n)) return true;
  return SECRET_KEY_SUBSTRINGS.some((t) => n.includes(t));
}

/**
 * Read one own property WITHOUT ever invoking an accessor.
 *
 * `Object.entries` calls getters. A getter can throw — taking the logger down
 * with it — or hand back the value the caller was trying to hide. So the
 * descriptor is inspected and only a data property is read; an accessor is
 * described, never called. See (d) above.
 */
function readOwn(obj, key) {
  let d;
  try {
    d = Object.getOwnPropertyDescriptor(obj, key);
  } catch {
    return "[REDACTED:unreadable]";
  }
  if (d === undefined) return undefined;
  if (!("value" in d)) return "[REDACTED:accessor]";
  return d.value;
}

/**
 * Produce a log-safe copy of an arbitrary value.
 *
 * Structure and non-secret data are preserved, because an unreadable log is
 * its own outage: route, company id, status, error classification and a
 * secret's `key` and `name` all survive. Only credential values are replaced.
 *
 * Robustness is a security property here, not a nicety: this runs inside the
 * logger, so anything it throws on becomes a failure to log at all.
 */
export function redactSecretValuesForLogs(value, depth = 0, seen) {
  const visited = seen ?? new WeakSet();

  if (value === null || typeof value !== "object") {
    // Functions are never useful in a log line, and a copied `toJSON` is
    // actively dangerous — see (c) above.
    return typeof value === "function" ? "[Function]" : value;
  }
  if (depth > 8) return "[REDACTED:depth]";
  if (visited.has(value)) return "[REDACTED:cycle]";
  visited.add(value);

  if (Array.isArray(value)) {
    return value.map((entry) => redactSecretValuesForLogs(entry, depth + 1, visited));
  }

  // Types whose useful log form is a description, not a traversal.
  if (value instanceof Date) return value.toISOString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return `[Buffer length=${value.length}]`;
  }
  if (value instanceof Map) return `[Map size=${value.size}]`;
  if (value instanceof Set) return `[Set size=${value.size}]`;

  // Errors: keep the diagnostic parts and follow `cause`, a common place for a
  // nested secret to hide. See (e) above.
  if (value instanceof Error) {
    const err = value;
    const out = {
      name: err.name,
      message: err.message,
      ...(err.stack ? { stack: err.stack } : {}),
      ...(err.code !== undefined ? { code: err.code } : {}),
    };
    if (err.cause !== undefined) {
      out.cause = redactSecretValuesForLogs(err.cause, depth + 1, visited);
    }
    // An Error can carry arbitrary own enumerable props (Object.assign).
    for (const key of Object.keys(err)) {
      if (key === "cause" || key === "stack" || key === "message" || key === "name") continue;
      out[key] = isSecretLogKey(key)
        ? SECRET_LOG_REPLACEMENT
        : redactSecretValuesForLogs(readOwn(err, key), depth + 1, visited);
    }
    return out;
  }

  // Everything else — plain object or class instance alike — is REBUILT as a
  // plain object. Rebuilding rather than cloning is what drops `toJSON`, any
  // prototype, and any accessor.
  const out = {};
  for (const key of Object.keys(value)) {
    out[key] = isSecretLogKey(key)
      ? SECRET_LOG_REPLACEMENT
      : redactSecretValuesForLogs(readOwn(value, key), depth + 1, visited);
  }
  return out;
}
//# sourceMappingURL=log-redaction.js.map
