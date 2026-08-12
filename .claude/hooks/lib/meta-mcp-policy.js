'use strict';
/**
 * Meta DevTools MCP policy.
 *
 * WHY THIS EXISTS
 * ---------------
 * `meta-graph-policy.js` governs Graph-over-curl. It has no awareness of the
 * `mcp__meta_developer_tools__*` tool family, so those calls fell through
 * `classifyTool() === 'other'` and were allowed unconditionally: no action
 * check, no mutation denial, no audit. That family includes
 * `devtools_webhook_manage` (subscribe / unsubscribe / update_fields) and
 * `devtools_webhook_test` (sends a real delivery), and this environment holds
 * `manage` permission on both EPIC apps — so a Meta configuration change was
 * one tool name away from the read calls an agent already makes.
 *
 * See defect-meta-guard-does-not-cover-meta-devtools-mcp-2026-08-11.
 *
 * DESIGN
 * ------
 * Allowlist by EXACT tool name and EXACT action string. Everything else is
 * denied: unknown tools, unknown/omitted/differently-cased/malformed actions,
 * unexpected input keys, actions hidden in nested objects, and any input value
 * that looks like a credential.
 *
 * SCOPE LIMIT — read this before widening the allowlist.
 * A PreToolUse hook decides allow/deny BEFORE execution. It cannot project or
 * redact a tool RESPONSE. So "allowed" here must mean "the provider's contract
 * is metadata-only", never "we will scrub whatever comes back". Any action that
 * could return a credential, an app secret, or unrestricted configuration stays
 * denied until a server-side metadata-only projection exists.
 */

const crypto = require('crypto');

const META_MCP_TOOL_RE = /^mcp__meta[_-]developer[_-]tools__(.+)$/i;

/**
 * UNTRUSTED-INPUT DISCIPLINE
 * --------------------------
 * Independent review of b2ecf20 found raw denied `action` reaching two sinks:
 * the persistent `meta-mcp.log` line, and the denial reason echoed to
 * transcript-visible stderr. Both are wrong for the same reason — a DENIED
 * value is attacker-shaped by definition, so it can carry a newline (forging a
 * second audit line), or credential material that no pattern list anticipates.
 * Pattern-based redaction is the wrong control here: it can only remove shapes
 * it already knows.
 *
 * The rule applied instead: a value that failed validation is NEVER reproduced.
 * Only allowlisted CONSTANTS are echoed verbatim. Everything derived from input
 * is either charset-filtered and length-capped (for key paths, which must stay
 * legible to be useful) or reduced to a bounded non-reversible hash (for the
 * denied action, where only correlation matters).
 */

/** Identifier-ish charset. Anything else is dropped, not escaped. */
const LABEL_UNSAFE_RE = /[^A-Za-z0-9_.[\]-]/g;
/** Control characters are removed by codepoint, not by a literal regex class. */
function stripControl(input) {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0);
    // C0, DEL, C1 NEL, and the Unicode line/paragraph separators. U+2028 and
    // U+2029 are >= 0x20, so a codepoint floor alone would let them through and
    // a log reader that honours them would see a forged second record.
    if (c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029) continue;
    out += ch;
  }
  return out;
}

/** Charset-filtered, length-capped, newline-free. Never round-trips a secret. */
function safeLabel(v, max = 48) {
  const original = String(v === null || v === undefined ? '' : v);
  const cleaned = stripControl(original).replace(LABEL_UNSAFE_RE, '');
  const capped = cleaned.slice(0, max);
  return { value: capped === '' ? '<empty>' : capped, altered: capped !== original };
}

/**
 * NO INPUT-DERIVED LABEL IS EVER ECHOED.
 *
 * ROUND-2 CORRECTION. The previous version echoed any label that LOOKED clean
 * (`^[A-Za-z0-9_.[\]-]+$`). Review showed that is not a safety property at all:
 * a key can be named `ZZQQ_NOTATOKEN_7731_XYZ_CANARY`, or a secret can sit
 * under a path whose components are all syntactically valid, and the denial
 * reason reproduced it verbatim. Syntactic cleanliness says nothing about
 * whether a value is attacker-controlled.
 *
 * So no input-derived label is echoed at all. A denial names WHAT was wrong and
 * gives a bounded correlator; it never quotes the offending text. Only schema
 * constants — tool names and action names already matched against an allowlist
 * — appear verbatim.
 */
function keyRef(v) {
  return `(ref ${shortHash(v)})`;
}

/** A tool name is only echoed when it is a known constant of this policy. */
function toolLabel(short) {
  const known =
    Object.prototype.hasOwnProperty.call(ALLOWED, short) || MUTATING_TOOLS.has(short);
  return known
    ? { known: true, text: '`' + short + '`', audit: short }
    : { known: false, text: `an unrecognised tool ${keyRef(short)}`, audit: 'unknown-tool' };
}

/** Bounded, non-reversible. Enough to correlate a denial with a report. */
function shortHash(v) {
  return crypto
    .createHash('sha256')
    .update(String(v === null || v === undefined ? '' : v))
    .digest('hex')
    .slice(0, 8);
}

function isAllowlistedAction(shortTool, action) {
  const spec = ALLOWED[shortTool];
  return !!(spec && typeof action === 'string' && spec.actions.has(action));
}

/** Optional telemetry keys the provider documents on every tool. */
const UNIVERSAL_OPTIONAL_KEYS = new Set(['model_name', 'skill_name']);

/**
 * ALLOW_METADATA_READ — exact action sets, from the installed tool schemas.
 * Each maps tool -> allowed actions -> permitted input keys (beyond universal).
 */
const ALLOWED = {
  devtools_app_list: { actions: new Set(['list']), keys: new Set(['action', 'cursor', 'limit']) },
  devtools_app: {
    // 'security' and 'data_protection_officer' are DELIBERATELY absent — see
    // CREDENTIAL_RISK below.
    actions: new Set(['basic_settings', 'advanced_settings', 'restrictions']),
    keys: new Set(['action', 'app_id']),
  },
  devtools_webhook_list: {
    actions: new Set(['list_topics', 'list_subscriptions']),
    keys: new Set(['action', 'app_id']),
  },
  devtools_api_usage: {
    actions: new Set(['rate_limits', 'call_volume', 'deprecations']),
    keys: new Set(['action', 'app_id', 'endpoint', 'lookback_minutes']),
  },
  devtools_compliance: { actions: new Set(['status']), keys: new Set(['action', 'app_id']) },
  devtools_app_review: {
    actions: new Set(['status', 'history', 'privileges', 'requirements']),
    keys: new Set(['action', 'app_id']),
  },
  devtools_discovery: {
    actions: new Set(['search_docs']),
    keys: new Set(['action', 'query', 'max_results', 'offset']),
  },
  devtools_api_changelog: {
    actions: new Set(['list_products', 'get_changelog_url', 'get_rss_url']),
    keys: new Set(['action', 'product']),
  },
  devtools_skill_invocation: {
    actions: new Set(['start', 'end']),
    keys: new Set(['action', 'skill_name']),
  },
};

/** DENY_MUTATION — changes Meta state or causes a real delivery. */
const MUTATING_TOOLS = new Map([
  [
    'devtools_webhook_manage',
    'subscribes, unsubscribes or edits webhook fields on a Meta app — a live channel-ownership change, and the exact class of change that "one authoritative processor per number" exists to control.',
  ],
  [
    'devtools_webhook_test',
    'sends a real test payload to the subscribed callback URL. That is an outbound delivery with a side effect at the receiving processor, not an inspection.',
  ],
]);

/** DENY_CREDENTIAL_RISK — reads whose response may carry secrets or personal data. */
const CREDENTIAL_RISK_ACTIONS = new Map([
  [
    'devtools_app|security',
    'app security settings may expose secret-bearing or security-sensitive configuration, and a PreToolUse hook cannot redact a response before the model sees it.',
  ],
  [
    'devtools_app|data_protection_officer',
    'returns the named DPO\'s personal contact details. Not required for the approved G1-G7 asset inventory, and personal data must not enter a transcript by default.',
  ],
]);

/** Value shapes that must never be sent as MCP input from an agent session. */
const CREDENTIAL_VALUE_RES = [
  /\bEAA[A-Za-z0-9_-]{20,}/, // Meta user/app/page token
  /\bBearer\s+[A-Za-z0-9._-]{20,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Key names that must never carry a literal value in MCP input. */
const CREDENTIAL_KEY_RE =
  /(^|_)(token|secret|password|passwd|credential|authorization|api[_-]?key|verify[_-]?token|access[_-]?token|client[_-]?secret)($|_)/i;

function isMetaMcpTool(toolName) {
  return META_MCP_TOOL_RE.test(String(toolName || ''));
}

function shortToolName(toolName) {
  const m = META_MCP_TOOL_RE.exec(String(toolName || ''));
  return m ? m[1] : null;
}

/** Walk every nested key/value so hidden actions and credentials cannot slip past. */
function walk(node, fn, depth = 0, path = '') {
  if (depth > 12 || node === null || node === undefined) return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => walk(v, fn, depth + 1, `${path}[${i}]`));
    return;
  }
  if (typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      fn(k, v, path ? `${path}.${k}` : k);
      walk(v, fn, depth + 1, path ? `${path}.${k}` : k);
    }
    return;
  }
}

/**
 * @returns {{decision:'allow'|'deny', code?:string, reason?:string, remedy?:string,
 *            tool?:string, action?:string}}
 */
function evaluateMetaMcp(toolName, toolInput) {
  const short = shortToolName(toolName);
  if (!short) return { decision: 'allow', reason: 'not a Meta DevTools MCP tool' };

  const ti = toolInput && typeof toolInput === 'object' ? toolInput : {};

  // A serialized tool_input must not smuggle the real payload past inspection.
  if (typeof toolInput === 'string') {
    return deny(short, null, 'meta-mcp-unparseable-input',
      'The tool input arrived as a serialized string rather than an object, so its action cannot be verified before execution.',
      'call the tool with a structured object input.');
  }

  // --- credential material in input, checked before anything else ----------
  let credentialHit = null;
  walk(ti, (k, v, p) => {
    if (credentialHit) return;
    if (typeof v === 'string') {
      if (CREDENTIAL_KEY_RE.test(k) && v.trim() !== '') credentialHit = p;
      else if (CREDENTIAL_VALUE_RES.some((re) => re.test(v))) credentialHit = p;
    }
  });
  if (credentialHit) {
    return deny(short, null, 'meta-mcp-credential-input',
      `An input field ${keyRef(credentialHit)} carries credential-shaped material. Credentials must never be passed through an agent session. Neither the field path nor its value is echoed or recorded — a path can itself carry the secret.`,
      'the Meta DevTools MCP authenticates through its own owner-authorized session. No token belongs in the tool input.');
  }

  // --- mutation, denied by tool identity ----------------------------------
  if (MUTATING_TOOLS.has(short)) {
    return deny(short, ti.action, 'meta-mcp-mutation',
      `\`${short}\` ${MUTATING_TOOLS.get(short)}`,
      'Meta asset and webhook changes are owner-operated actions performed outside an agent session. Use devtools_webhook_list:list_subscriptions to READ current state.');
  }

  const spec = ALLOWED[short];
  if (!spec) {
    return deny(short, ti.action, 'meta-mcp-unknown-tool',
      `${toolLabel(short).text} is not in the Meta DevTools MCP allowlist. Unknown tools fail closed: an unclassified capability cannot be assumed read-only. The tool suffix is withheld because it is attacker-controlled text.`,
      'if this tool is genuinely metadata-only, add it to ALLOWED in meta-mcp-policy.js with its exact actions and input keys, with schema evidence.');
  }

  // --- action must be a present, top-level, exactly-matching string --------
  const rawAction = ti.action;
  if (typeof rawAction !== 'string' || rawAction === '') {
    return deny(short, null, 'meta-mcp-missing-action',
      'No top-level `action` string was supplied, so the operation cannot be classified before it runs.',
      `supply one of: ${[...spec.actions].join(', ')}`);
  }
  const riskKey = `${short}|${rawAction}`;
  if (CREDENTIAL_RISK_ACTIONS.has(riskKey)) {
    return deny(short, rawAction, 'meta-mcp-credential-risk',
      `\`${short}:${rawAction}\` ${CREDENTIAL_RISK_ACTIONS.get(riskKey)}`,
      'use basic_settings / advanced_settings / restrictions, which are metadata-only. Re-evaluate this action only once a server-side metadata-only projection exists.');
  }
  if (!spec.actions.has(rawAction)) {
    // The supplied action FAILED validation, so it is never reproduced — not in
    // this reason, not in the audit line. Only the allowlisted constants below
    // are echoed. `ref` is a bounded, non-reversible correlator.
    const casing = [...spec.actions].find((a) => a.toLowerCase() === rawAction.toLowerCase());
    return deny(short, rawAction, 'meta-mcp-unknown-action',
      `The supplied \`action\` is not allowlisted for \`${short}\` (ref ${shortHash(rawAction)}).` +
        (casing ? ` Actions match exactly; \`${casing}\` is the allowlisted spelling.` : '') +
        ' The value itself is withheld because it failed validation.',
      `allowed actions: ${[...spec.actions].join(', ')}`);
  }

  // --- unexpected top-level keys ------------------------------------------
  // rawAction is allowlisted from here on, so echoing it is safe.
  for (const k of Object.keys(ti)) {
    if (spec.keys.has(k) || UNIVERSAL_OPTIONAL_KEYS.has(k)) continue;
    return deny(short, rawAction, 'meta-mcp-unexpected-key',
      `An input key ${keyRef(k)} is not part of the verified schema for \`${short}:${rawAction}\`. Unrecognised keys fail closed because their effect on the request cannot be predicted. The key name is withheld: a name is as attacker-controlled as a value.`,
      `permitted keys: ${[...spec.keys, ...UNIVERSAL_OPTIONAL_KEYS].join(', ')}`);
  }

  // --- an action hidden in a nested object or free-text field --------------
  let nestedAction = null;
  walk(ti, (k, v, p) => {
    if (nestedAction) return;
    if (p === 'action') return; // the verified top-level one
    if (/^action$/i.test(k)) nestedAction = p;
  });
  if (nestedAction) {
    return deny(short, rawAction, 'meta-mcp-nested-action',
      `A second \`action\` appears in a nested field ${keyRef(nestedAction)}. Only a single top-level action is verifiable; a nested one may be the operation actually executed. Neither the field path nor its value is echoed.`,
      'send exactly one top-level action.');
  }
  const freeText = [ti.query, ti.product, ti.endpoint, ti.skill_name]
    .filter((v) => typeof v === 'string')
    .join(' ');
  if (/\b(subscribe|unsubscribe|update_fields|test_send)\b/i.test(freeText)) {
    return deny(short, rawAction, 'meta-mcp-freetext-injection',
      'A free-text field names a mutating action. Free text is not an instruction channel, and a request shaped to look like one is refused rather than interpreted.',
      'remove the mutating verb from the free-text field.');
  }

  return { decision: 'allow', tool: short, action: rawAction, reason: 'allowlisted metadata read' };
}

/**
 * A denied verdict carries NO raw action — only a bounded correlator. Storing
 * the raw value on the verdict object at all is what let it reach the audit
 * ledger at b2ecf20; removing it here makes that class of mistake structurally
 * hard to repeat, rather than relying on every call site to remember.
 */
function deny(tool, action, code, reason, remedy) {
  return {
    decision: 'deny',
    tool,
    action: null,
    actionRef: action === undefined || action === null ? null : shortHash(action),
    code,
    reason,
    remedy,
  };
}

/**
 * Metadata-only audit line. Exactly one line, always.
 *
 * An ALLOWED action is echoed verbatim only because it has already matched an
 * allowlist constant by exact string equality — the value written is the
 * constant, not the input. A DENIED action is never written; `ref` is a bounded
 * non-reversible hash, enough to correlate a denial with a report and useless
 * for reconstructing the input.
 */
function auditLine(toolName, verdict) {
  const rawShort = shortToolName(toolName) || String(toolName || '');
  const tool = toolLabel(rawShort);
  // An unknown tool suffix is attacker-controlled text and is never persisted.
  const short = tool.audit;
  const v = verdict || {};
  const isDeny = v.decision === 'deny';

  let actionField = 'unknown';
  if (!isDeny && typeof v.action === 'string' && isAllowlistedAction(rawShort, v.action)) {
    actionField = v.action;
  }

  const parts = [
    'meta-mcp',
    short,
    `action=${actionField}`,
    isDeny ? `DENY:${safeLabel(v.code, 48).value}` : 'ALLOW',
  ];
  if (isDeny && v.actionRef) parts.push(`ref=${safeLabel(v.actionRef, 16).value}`);
  if (!tool.known) parts.push(`toolref=${shortHash(rawShort)}`);

  // Belt and braces: even the assembled line is stripped, so no component can
  // introduce a second audit record.
  return stripControl(parts.join(' '));
}

module.exports = {
  META_MCP_TOOL_RE,
  ALLOWED,
  MUTATING_TOOLS,
  CREDENTIAL_RISK_ACTIONS,
  isMetaMcpTool,
  shortToolName,
  evaluateMetaMcp,
  auditLine,
};
