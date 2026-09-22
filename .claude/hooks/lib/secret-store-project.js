#!/usr/bin/env node
/**
 * secret-store-project — positive-allowlist projection for orchestrator secret
 * stores (/run/secrets, /var/run/secrets).
 *
 * WHY THIS EXISTS
 * ---------------
 * isola-guard rule 1a denies reads of container secret mounts outright.
 * Everything under those paths is a credential BY LOCATION, whatever the file is
 * called: `gateway_bindings` looks like ordinary config and carries inline
 * `agentBotSecret` / `agentBotAccessToken` values. Two live credential pairs
 * reached a transcript that way on 2026-09-22, the second after the first was
 * already reported.
 *
 * But an outright deny with no way through is not a control, it is a wall —
 * and the operational questions those stores answer are legitimate ("which
 * Paperclip agent is bound to inbox 8?"). The first version of rule 1a printed a
 * remedy command that CONTAINED the secret path, so the rule denied its own
 * remedy. A peer lane hit that dead end within the hour and correctly refused to
 * reword around it. A refusal that names a remedy it also refuses is a dead end,
 * not a fail-closed control — see CLAUDE.md §2.26 ("a fail-closed rule needs a
 * mechanism to fail with") and §2.24 (prose is not a control).
 *
 * So the remedy is a MECHANISM, not a sentence: pipe the store through this
 * file. The guard allows the read only when this exact path appears in the same
 * command, which is checkable by literal substring rather than by parsing the
 * caller's intent. Same shape as secret-redact.js in rule 1b, deliberately.
 *
 * THE INVARIANT: this never emits a key it was not told to emit.
 * A secret field added to the store tomorrow is still never printed, because
 * unknown keys are dropped by default rather than matched by shape. Key NAMES
 * and presence are always readable; values are not. That is the estate rule, and
 * it is the difference between this and a redactor — a redactor must recognise a
 * secret to hide it, and it failed on 2026-09-22 because a camelCase short value
 * did not look like one. A projection does not have to recognise anything.
 *
 * COVERAGE BOUNDARY, STATED PLAINLY:
 *   - covers: JSON documents on stdin
 *   - does NOT cover: non-JSON stores (raw tokens, PEM, .env-shaped files).
 *     Those parse-fail and emit nothing, which is the correct outcome — there is
 *     no projection of a file whose whole content is one secret.
 *
 * Pure functions + entry-point-gated main(), per scripts/src/guard-not-prod-db.ts.
 */

'use strict';

/**
 * Keys safe to print from a bindings/config store. Positive list: anything not
 * named here is dropped, including keys that do not exist yet.
 */
const DEFAULT_ALLOW = [
  'accountId',
  'agentId',
  'chatwootAccountId',
  'chatwootAgentBotId',
  'chatwootBaseUrl',
  'chatwootInboxId',
  'createdAt',
  'enabled',
  'exposure',
  'id',
  'inboxId',
  'label',
  'name',
  'phoneNumberId',
  'status',
  'templateId',
  'tenantId',
  'updatedAt',
  'version',
  'wabaId',
];

/**
 * Key-name fragments that may NEVER be projected, even via --allow.
 *
 * This is what makes --allow safe to offer at all: without it, the documented
 * escape hatch ("add a field deliberately") would also be the way to defeat the
 * control in one flag. Matched case-insensitively as a substring of the KEY
 * NAME, so `agentBotSecret`, `access_token` and `BEARER` are all caught without
 * ever inspecting the value.
 */
const NEVER_ALLOW = [
  'auth',
  'bearer',
  'credential',
  'jwt',
  'key',
  'passphrase',
  'password',
  'private',
  'salt',
  'secret',
  'session',
  'signature',
  'token',
];

/** True when a key name may never be printed, whatever the allowlist says. */
function isForbiddenKey(key) {
  if (typeof key !== 'string') return true;
  const k = key.toLowerCase();
  return NEVER_ALLOW.some((frag) => k.includes(frag));
}

/**
 * Build the effective allowlist. Extra keys widen it, but never past NEVER_ALLOW.
 * Returns { allow: Set<string>, refused: string[] } so a refused --allow is
 * reported rather than silently ignored — a flag accepted and discarded is the
 * failure mode in CLAUDE.md §2.24's third corollary.
 */
function buildAllowlist(extra) {
  const allow = new Set(DEFAULT_ALLOW.filter((k) => !isForbiddenKey(k)));
  const refused = [];
  for (const raw of extra || []) {
    const key = String(raw).trim();
    if (!key) continue;
    if (isForbiddenKey(key)) refused.push(key);
    else allow.add(key);
  }
  return { allow, refused };
}

/**
 * Normalise a parsed store into a list of records.
 * Accepts an array, a `{bindings: [...]}` / `{items: [...]}` wrapper, or a
 * single object. Anything else yields an empty list rather than a guess.
 */
function toRecords(parsed) {
  if (Array.isArray(parsed)) return parsed.filter((r) => r && typeof r === 'object');
  if (!parsed || typeof parsed !== 'object') return [];
  for (const wrapper of ['bindings', 'items', 'records', 'entries']) {
    if (Array.isArray(parsed[wrapper])) {
      return parsed[wrapper].filter((r) => r && typeof r === 'object');
    }
  }
  return [parsed];
}

/**
 * Render an allowlisted value. Primitives pass through; anything structured is
 * replaced by a type marker rather than recursed into, because a nested object
 * is exactly where an unreviewed secret field would sit.
 */
function renderValue(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (Array.isArray(value)) return `<array:${value.length}>`;
  if (t === 'object') return `<object:${Object.keys(value).length} keys>`;
  return `<${t}>`;
}

/**
 * Project one record: keep allowlisted keys, report the NAMES of everything
 * dropped. The omitted-key names are the point, not a leftover — they are how a
 * reader learns the store carries an `agentBotSecret` without seeing it.
 */
function projectRecord(record, allow) {
  const kept = {};
  const omitted = [];
  for (const key of Object.keys(record).sort()) {
    if (allow.has(key) && !isForbiddenKey(key)) kept[key] = renderValue(record[key]);
    else omitted.push(key);
  }
  if (omitted.length) kept.__omitted_keys = omitted;
  return kept;
}

/**
 * Whole-document projection. Pure: takes text, returns { ok, output, error }.
 * Never returns any part of the raw input on failure — a parse error must not
 * echo the thing it failed to parse.
 */
function project(text, options) {
  const opts = options || {};
  const { allow, refused } = buildAllowlist(opts.allow);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      output: '',
      error:
        'secret-store-project: input is not JSON, so nothing can be projected. ' +
        'Refusing to emit any of it. If the store is a raw token, PEM or ' +
        '.env-shaped file, its whole content is the secret and there is no safe ' +
        'projection — read the key NAME and presence instead.',
    };
  }
  const records = toRecords(parsed);
  const projected = records.map((r) => projectRecord(r, allow));
  const report = {
    __projection: 'positive allowlist; unknown keys are dropped, not matched',
    __record_count: projected.length,
    records: projected,
  };
  if (refused.length) {
    report.__refused_allow_flags = refused;
    report.__refused_reason =
      'these key names are permanently non-projectable and were NOT added';
  }
  return { ok: true, output: JSON.stringify(report, null, 1), error: '' };
}

module.exports = {
  DEFAULT_ALLOW,
  NEVER_ALLOW,
  buildAllowlist,
  isForbiddenKey,
  project,
  projectRecord,
  renderValue,
  toRecords,
};

/* istanbul ignore next -- entry point */
if (require.main === module) {
  const extra = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--allow' && argv[i + 1]) {
      extra.push(...String(argv[i + 1]).split(',').map((s) => s.trim()));
      i += 1;
    }
  }
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
  });
  process.stdin.on('end', () => {
    const result = project(buf, { allow: extra });
    if (!result.ok) {
      process.stderr.write(result.error + '\n');
      process.exit(2);
    }
    process.stdout.write(result.output + '\n');
  });
  process.stdout.on('error', () => process.exit(0));
}
