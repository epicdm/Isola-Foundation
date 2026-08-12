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

const META_MCP_TOOL_RE = /^mcp__meta[_-]developer[_-]tools__(.+)$/i;

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
      `Input key \`${credentialHit}\` carries credential-shaped material. Credentials must never be passed through an agent session, and a denied call still records its metadata.`,
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
      `\`${short}\` is not in the Meta DevTools MCP allowlist. Unknown tools fail closed: an unclassified capability cannot be assumed read-only.`,
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
    const casing = [...spec.actions].find((a) => a.toLowerCase() === rawAction.toLowerCase());
    return deny(short, rawAction, 'meta-mcp-unknown-action',
      `\`${rawAction}\` is not an allowlisted action for \`${short}\`.` +
        (casing ? ` Actions are matched exactly; \`${casing}\` is the allowlisted spelling.` : ''),
      `allowed actions: ${[...spec.actions].join(', ')}`);
  }

  // --- unexpected top-level keys ------------------------------------------
  for (const k of Object.keys(ti)) {
    if (spec.keys.has(k) || UNIVERSAL_OPTIONAL_KEYS.has(k)) continue;
    return deny(short, rawAction, 'meta-mcp-unexpected-key',
      `Input key \`${k}\` is not part of the verified schema for \`${short}:${rawAction}\`. Unrecognised keys fail closed because their effect on the request cannot be predicted.`,
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
      `A second \`action\` appears at \`${nestedAction}\`. Only a single top-level action is verifiable; a nested one may be the operation actually executed.`,
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

function deny(tool, action, code, reason, remedy) {
  return { decision: 'deny', tool, action: action || null, code, reason, remedy };
}

/** Metadata-only audit line. Never includes raw input values. */
function auditLine(toolName, verdict) {
  const short = shortToolName(toolName) || String(toolName || '?');
  const action = verdict && verdict.action ? verdict.action : '-';
  const outcome = verdict && verdict.decision === 'deny' ? `DENY:${verdict.code}` : 'ALLOW';
  return `meta-mcp ${short} action=${action} ${outcome}`;
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
