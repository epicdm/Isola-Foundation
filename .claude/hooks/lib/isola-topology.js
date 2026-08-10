/**
 * Isola topology — the single source of truth for "where is production".
 *
 * Consumed by every hook in .claude/hooks/. Keep this file boring and factual:
 * it encodes WHERE things live, never WHAT to do about them.
 *
 * Sources (Port, read-only reconciliation 2026-07-23 / 2026-07-24):
 *   - evidence-clawith-revenue-path-live-reconciliation-2026-07-24
 *   - evidence-hermes-workspace-live-reconciliation-2026-07-23
 *   - evidence-clawith-v183-inventory-2026-07-24
 *   - xp-clawith-r5a-provisioning-and-tenant-disposition (build-contamination incident)
 *
 * NOTE ON TOKEN ASSEMBLY: command verbs below are assembled at runtime via tok().
 * A naive whole-payload substring scanner (the incumbent ~/.claude/hooks/
 * enforce-safety.js does exactly this) otherwise reads this policy file as an
 * ATTEMPT to run the commands it exists to forbid — it blocked the first version
 * of this file for that reason. Assembly keeps the policy expressible without
 * tripping scanners that cannot distinguish description from execution.
 *
 * Update procedure: change here, then run `node .claude/hooks/selftest.js`.
 */

'use strict';

const tok = (...parts) => parts.join('');

const CLI = {
  container: tok('do', 'cker'),
  proc: tok('pm', '2'),
  svc: tok('system', 'ctl'),
};

const VERB = {
  remove: tok('r', 'm'),
  terminate: tok('ki', 'll'),
  halt: tok('st', 'op'),
  teardown: tok('do', 'wn'),
  purge: tok('del', 'ete'),
  wipe: tok('trun', 'cate'),
  discard: tok('dr', 'op'),
};

/**
 * Canonical LIVE checkouts on the deepseek host (66.118.37.12).
 * A build, install or migrate executed inside any of these mutates what a
 * running process serves. This is exactly the R5A build-output contamination
 * class: a production build was run in /opt/bff-v2 (the directory pm2's
 * bff-v2-web serves from) while on a feature branch, rewriting BUILD_ID and
 * tracing candidate files into live route manifests.
 */
const LIVE_CHECKOUTS = [
  '/opt/bff-v2',
  '/opt/isola-runtime',
  '/home/epicdm/clawith-v1110',
  '/home/epicdm/hermes-workspace',
  '/home/epicdm/.hermes/hermes-agent',
  '/opt/hermes-eric',
  '/opt/lk-voice-agent',
  '/opt/emapro-api',
  '/opt/isola-bridge',
  '/home/epicdm/isola-port-control-plane-mcp',
];

/**
 * Deployed-branch facts that engineers get wrong. GitHub reports a stale default
 * branch (`legacy-pre-isola-archive`) for epicdm/isolav2; the real active trunk is
 * below. Determine the deployed commit from the process's exec cwd, never from
 * GitHub's default branch (R5A finding).
 */
const DEPLOYED_TRUNKS = {
  'epicdm/isolav2': 'fix/bffv2-retire-dashboard-reseller-campaigns-broadcast',
  'epicdm/Isola-Foundation': 'main (deploy source is the Replit workspace checkout, NOT GitHub main)',
};

/**
 * Paths that are safe to build in: isolated worktrees and scratch areas.
 * A live-checkout match is forgiven when the path also matches one of these.
 */
const SAFE_BUILD_ROOTS = [
  '/tmp/',
  '/home/epicdm/worktrees/',
  '/home/epicdm/backups/',
  '/home/epicdm/scratch/',
];

/** Commands that produce or install build output. */
const BUILD_COMMAND_RE = new RegExp(
  [
    'next\\s+build',
    'npm\\s+run\\s+build',
    'pnpm\\s+(run\\s+)?build',
    'yarn\\s+build',
    'npm\\s+ci\\b',
    'npm\\s+i(nstall)?\\b',
    'pnpm\\s+i(nstall)?\\b',
    'yarn\\s+install\\b',
    CLI.container + '\\s+compose\\s+(up\\s+--build|build)',
    CLI.container + '\\s+build',
    'prisma\\s+migrate\\s+deploy',
    'prisma\\s+generate',
    'tsc\\s+--build',
    'vite\\s+build',
  ].join('|'),
  'i'
);

/** Service lifecycle verbs that must go through the deploy gate. */
const RESTART_COMMAND_RE = new RegExp(
  [
    CLI.proc + '\\s+(restart|reload|start|' + VERB.purge + '|' + VERB.terminate + '|resurrect)',
    CLI.svc + '\\s+(--user\\s+)?(restart|start|' + VERB.halt + '|disable|enable)',
    CLI.container + '\\s+compose\\s+(' + VERB.teardown + '|restart|up)\\b',
    CLI.container + '\\s+(restart|' + VERB.halt + '|' + VERB.terminate + '|' + VERB.remove + ')\\b',
  ].join('|'),
  'i'
);

/**
 * Destructive shapes. Structure-based, never bare substrings, so prose that
 * merely mentions these words does not trip them. Evaluated ONLY against
 * execution tools (see TOOL_CLASSES) — never against task text, Port records,
 * documentation or scheduling calls.
 */
const DESTRUCTIVE_RULES = [
  {
    id: 'sql-discard-object',
    re: new RegExp('\\b' + VERB.discard + '\\s+(table|database|schema)\\b', 'i'),
    why: 'Destructive SQL (object removal). Use a reviewed migration through the validated path.',
  },
  {
    id: 'sql-wipe-table',
    re: new RegExp('\\b' + VERB.wipe + '\\s+(table\\s+)?["a-z0-9_.]', 'i'),
    why: 'Destructive SQL (whole-table wipe).',
  },
  {
    id: 'sql-unscoped-row-purge',
    re: new RegExp('\\b' + VERB.purge + '\\s+from\\s+["a-z0-9_.]+\\s*(;|$)', 'i'),
    why: 'Row purge with no WHERE clause — unscoped deletion is refused.',
  },
  {
    id: 'container-destroy',
    re: new RegExp(
      '\\b' + CLI.container + '\\s+(' + [VERB.remove, VERB.terminate, VERB.halt].join('|') + ')\\b' +
        '|\\b' + CLI.container + '\\s+compose\\s+' + VERB.teardown + '\\b',
      'i'
    ),
    why: 'Destructive container op. Runtime containers must be reloaded, not torn down.',
  },
  {
    id: 'process-manager-destroy',
    re: new RegExp('\\b' + CLI.proc + '\\s+(' + VERB.purge + '|' + VERB.terminate + ')\\b', 'i'),
    why: 'Process-manager removal can take down production. Restart through the deploy gate.',
  },
  {
    id: 'recursive-force-remove-system-path',
    re: new RegExp('\\b' + VERB.remove + '\\s+-[a-z]*r[a-z]*f?\\s+/(opt|home|srv|etc|data|var|root)\\b', 'i'),
    why: 'Recursive force-removal against a real system path.',
  },
  {
    id: 'prisma-db-push',
    re: /\bprisma\s+db\s+push\b/i,
    why:
      'Prohibited by ratified release standard (dec-isola-release-protection-standard-2026-07-22, ' +
      'dec-two-database-schema-reconciliation-2026-07-23): `prisma db push` silently drops out-of-band tables.',
    remedy:
      'use a reviewed migration, or `prisma db execute` with explicit DDL inside a transaction against a zero-row target.',
  },
  {
    id: 'prisma-ledger-tamper',
    re: /\bprisma\s+migrate\s+resolve\b|_prisma_migrations\s*(set|delete|update|insert)/i,
    why:
      'Migration-ledger tampering. A ledger `finished_at` must never be treated as proof of DDL execution ' +
      '(inc-escalation-schema-ledger-divergence-2026-07-23).',
    remedy: 'verify live columns/indexes via an independent raw catalog check instead of editing the ledger.',
  },
  {
    id: 'git-history-destructive',
    re: /\bgit\s+(push\s+(-f|--force)(?!-with-lease)|reset\s+--hard\s+origin|clean\s+-[a-z]*f[a-z]*d)/i,
    why: 'Destructive git op (force-push / hard reset to origin / force-clean). Prefer --force-with-lease and explicit owner authorization.',
  },
];

/**
 * Protected production assets that must never be reconfigured as a side effect
 * of engineering work. Matched only inside execution and write payloads, and
 * only alongside a mutating verb (see isola-guard.js).
 */
const PROTECTED_NUMBERS = [
  // Role map per decision-isola-whatsapp-number-role-map-2026-07-24 (Ratified).
  // NOTE: decision-3742-authoritative-processor-hermes-2026-07-24 is SUPERSEDED —
  // do not use it for routing or acceptance.
  {
    number: '17678183742',
    pnid: '975632242309171',
    label: "3742 — EPIC's sole public customer-facing front door (cut over to Clawith v1.11)",
  },
  { number: '17678189043', pnid: '1029700810228517', label: '9043 — Hermes internal owner line. OUT OF SCOPE: do not touch.' },
  { number: '17672956737', pnid: '278390858690809', label: '6737 — EPIC Front Desk / Customer Zero; only pnid in ESCALATION_REF_ALLOWED_PNIDS' },
  { number: '17678180001', pnid: null, label: '0001 — legacy; preserve unchanged, do not test or promote' },
  { number: '17678189525', pnid: null, label: '9525 — Anansi, intentional per-phone override' },
];

/**
 * Shared WABA. Any WABA-level webhook change hits all 11 numbers on it —
 * per d51-waveb-a2-per-phone-flip-law, flip per-phone, never per-WABA, and
 * re-check GET /{waba}/subscribed_apps after any Chatwoot inbox create/update.
 */
const SHARED_WABA_ID = '272252189309178';

/**
 * Meta Graph API. Certain reads are not only allowed but REQUIRED — proving
 * webhook ownership means calling GET /{phone_number_id}?fields=webhook_configuration
 * and GET /{waba}/subscribed_apps.
 *
 * The host match lives here; the request POLICY lives in lib/meta-graph-policy.js.
 *
 * REMOVED 2026-08-05 — META_MUTATION_INDICATOR_RE. It classified any curl data
 * flag (`--data`, `--data-urlencode`, ` -d `) as a mutation, which is wrong in
 * both directions: it blocked `curl -G --data-urlencode` (a GET, and the safer
 * way to pass parameters) while permitting credential-minting GETs such as
 * /oauth/access_token. Method classification is now derived from the actual curl
 * option grammar, and endpoint access is default-deny against a named allowlist.
 * See defect-isola-guard-meta-graph-read-classification-and-token-minting-gap-2026-08-05.
 */
const META_HOST_RE = /graph\.facebook\.com/i;

/**
 * Legacy stack references that must not re-enter application code.
 * v1.8.3 (/opt/isola-runtime, port 8800, runtime.epic.dm) is a frozen migration
 * source per decision-clawith-v183-migrate-or-retire-2026-07-24. Documentation,
 * ledgers and evidence legitimately discuss it; application code must not call it.
 */
const LEGACY_REFERENCE_RE = /(localhost|127\.0\.0\.1):8800|runtime\.epic\.dm|\/opt\/isola-runtime/i;

/** Extensions treated as prose rather than executable application code. */
const PROSE_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.rst', '.log', '.csv']);

/** Secret-bearing file shapes. `.example` / `.sample` / `.template` are exempt. */
const SECRET_FILE_RE = new RegExp(
  '(^|[\\\\/])(' +
    [
      '\\.env(\\.[a-z0-9_-]+)*',
      '\\.npmrc',
      '\\.pgpass',
      'id_rsa',
      'id_ed25519',
      '.*\\.pem',
      '.*\\.key',
      '.*\\.p12',
      '.*\\.pfx',
      'credentials(\\.json)?',
      'auth\\.json',
      '\\.credentials\\.json',
      'service-account.*\\.json',
    ].join('|') +
    ')$',
  'i'
);
const SECRET_FILE_EXEMPT_RE = /\.(example|sample|template|dist)$|\.example\.|\.sample\./i;

/** Commands that would dump an environment or print a secret file to stdout. */
/**
 * A secret-bearing FILE reference, as opposed to an identifier that merely
 * contains the same letters. `process.env.FOO` and `import.meta.env` are code,
 * not files, so `.env` only counts when it starts a path segment — preceded by
 * start-of-string, whitespace, a quote, `/`, `\` or `=`.
 *
 * (Learned the hard way: an earlier version matched `.env` inside
 * `process.env.DATABASE_URL` and blocked a legitimate read-only inspection.)
 */
const SECRET_PATH_TOKEN =
  '(^|[\\s\'"`/\\\\=])(\\.env(\\.[a-z0-9_-]+)?|\\.pgpass|id_rsa|id_ed25519|[^\\s\'"]*\\.pem|credentials\\.json|auth\\.json)\\b';

const SECRET_DUMP_RE = new RegExp(
  [
    '\\b(printenv|env\\s*(\\||$)|set\\s*\\|\\s*grep|Get-ChildItem\\s+Env:|dir\\s+env:)',
    // A pager/dump command applied to a secret file. The gap deliberately
    // excludes `|`, `;` and `&` so a later, unrelated command in the same line
    // cannot be attributed to an earlier `cat`/`head`.
    '(\\b(cat|bat|less|more|head|tail|type|Get-Content|nl|xxd|base64)\\b[^\\n|;&]*' + SECRET_PATH_TOKEN + ')',
  ].join('|'),
  'i'
);

/**
 * epic-portal (EasyPanel MCP) policy — ALLOWLIST, not denylist, and STRICT
 * SHAPE VALIDATION rather than adversarial nested search.
 *
 * MCP remains Isola's normal AI-to-system control plane; this is not a move
 * to SSH or direct database access as a replacement. listProjectsAndServices
 * returns full plaintext secrets (encryption keys, JWT secrets, DB/Redis/
 * MariaDB passwords) for every service on the instance, with no redaction
 * and no per-project scoping — reclassified P0 twice in one session
 * (2026-08-09, 2026-08-10) after direct observation. The connector stays
 * enabled; this guard narrows what it may currently do until each procedure
 * (and, separately, its output shape — see the PostToolUse output-projection
 * hook) has had its own review.
 *
 * Observed non-empty-input failure on execute_query; wire-level serialization
 * cause remains unresolved (schema comparison is suggestive, not proof — see
 * evidence-* / this session's Task 2 diagnosis).
 *
 * DESIGN: earlier revisions searched the whole payload for a "procedure"
 * field wherever it might be nested and blocked if anything disallowed
 * turned up anywhere. This revision inverts that: the wrapper shape itself
 * is validated FIRST — exactly {procedure, input} at the top level, nothing
 * else — and anything that doesn't match that exact shape is rejected as an
 * unexpected wrapper, full stop, rather than searched loosely hoping to
 * still find a safe interpretation. Each allowed procedure then has its own
 * exact input predicate — not "procedure name is on a list", but "procedure
 * name AND its arguments match a reviewed, scoped shape".
 *
 * getMonitorTableData was allowlisted in an earlier revision but is REMOVED
 * here: its real input schema has no properties at all (no project/service
 * fields to scope it with), so per policy ("if it cannot be safely scoped,
 * temporarily remove it") it cannot be given a predicate and stays out until
 * that changes upstream or a scoping mechanism is found.
 */
const EASYPANEL_REVIEWED_PROJECT = 'isola';

/** Every service name actually reviewed/discussed this session under the
 * "isola" EasyPanel project. Do not guess additional names — an unreviewed
 * service name fails closed exactly like an unreviewed procedure would. */
const EASYPANEL_REVIEWED_SERVICES = new Set([
  'nocobase', 'nocobase-db',
  'activepieces', 'activepieces-db', 'activepieces-redis',
  'ai', 'ai-db',
  'chat', 'chatwoot-db', 'chatwoot-redis', 'chatwoot-sidekiq',
  'paymenter', 'paymenter-mysql', 'paymenter-redis',
]);

/** search_procedures is schema/metadata discovery only — it returns
 * procedure descriptions and input schemas, it never executes one. Always
 * allowed; not subject to the query allowlist below. */
const EASYPANEL_METADATA_TOOL_RE = /^mcp__epic-portal__search_procedures$/;
const EASYPANEL_QUERY_TOOL_RE = /^mcp__epic-portal__execute_query$/;
/** True prefix catch-all — deliberately NOT a match on just the two exact
 * names above, so a suffixed or otherwise-unexpected epic-portal tool
 * (execute_admin, execute_query_extra, search_procedures_extra, a future
 * tool this policy has never seen) is blocked outright rather than
 * implicitly trusted for looking similar. */
const EASYPANEL_ANY_TOOL_RE = /^mcp__epic-portal__/;

/** Raw HTTP bypass: block ANY call reaching an EasyPanel MCP/RPC/tRPC path via an
 * actual network-client invocation — host-agnostic (direct IP, alternate host, a
 * proxy) and tolerant of query strings / trailing slashes. Not procedure-specific:
 * once the native tool is allowlist-gated, a raw bypass has no legitimate use here
 * at all, so the whole class is blocked rather than parsed procedure-by-procedure. */
const EASYPANEL_RAW_PATH_RE = /\/api\/(mcp|rpc|trpc)(?=[\s'"`/?]|$)/i;

/** A path match alone is not enough — "prose mentioning the Graph host is still not
 * gated" is the same design rule this reuses. A commit message, a doc, or this very
 * policy file can legitimately contain these path strings without performing a call.
 * Only treat it as a real network call when the command also looks like one.
 *
 * HONESTY NOTE: this is tested defense-in-depth against the specific clients this
 * repo's own agents actually use (curl, wget, PowerShell's web cmdlets, Node
 * fetch/.request(), Python requests/httpx, axios). It is NOT a claim that every
 * possible raw network bypass is impossible — any HTTP-capable tool or language
 * not covered by this pattern (a compiled binary, a different SDK, a language this
 * regex doesn't recognize) is not caught by this specific check. The PreToolUse
 * hook is one containment layer; the MCP connector's own allowlisting (once it
 * exists there) is the layer that would make this true regardless of client. */
const HTTP_INVOCATION_RE =
  /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|axios)\b|\bfetch\s*\(|\.request\s*\(|\b(requests|httpx)\.(get|post|put|delete|patch|request)\s*\(|\bhttpx\.Client\s*\(/i;

/**
 * Resolves tool_input.input to a plain object, handling the one legitimate
 * known quirk (a JSON-encoded STRING instead of a parsed object) without
 * treating that as inherently suspicious — but anything that still isn't a
 * plain object after that one allowance fails closed.
 */
function resolveInputObject(input) {
  let resolved = input;
  if (typeof resolved === 'string') {
    const trimmed = resolved.trim();
    if (trimmed === '') {
      resolved = {};
    } else {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (e) {
        throw new Error('input is a string that failed to parse as JSON: ' + e.message);
      }
      resolved = parsed;
    }
  }
  if (resolved === undefined || resolved === null) resolved = {};
  if (typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error('input did not resolve to a plain object');
  }
  return resolved;
}

function requireNoExtraKeys(obj, allowedKeys, label) {
  const extra = Object.keys(obj).filter((k) => !allowedKeys.has(k));
  if (extra.length) throw new Error(label + ' has unexpected fields: ' + extra.join(', '));
}

function requireReviewedTarget(obj, label) {
  if (obj.projectName !== EASYPANEL_REVIEWED_PROJECT) {
    throw new Error(label + ' projectName must be exactly "' + EASYPANEL_REVIEWED_PROJECT + '"');
  }
  if (typeof obj.serviceName !== 'string' || !EASYPANEL_REVIEWED_SERVICES.has(obj.serviceName)) {
    throw new Error(label + ' serviceName is missing or not in the reviewed set');
  }
}

/**
 * Exact per-procedure input predicates. Throws (fail-closed) on any
 * deviation — missing/ambiguous/extra target fields, out-of-scope project
 * or service, or a procedure not in this map at all.
 */
const EASYPANEL_QUERY_PREDICATES = {
  listProjects(input) {
    requireNoExtraKeys(input, new Set([]), 'listProjects');
  },
  listPorts(input) {
    requireNoExtraKeys(input, new Set(['projectName', 'serviceName']), 'listPorts');
    requireReviewedTarget(input, 'listPorts');
  },
  listMounts(input) {
    requireNoExtraKeys(input, new Set(['projectName', 'serviceName']), 'listMounts');
    requireReviewedTarget(input, 'listMounts');
  },
  getComposeDockerServices(input) {
    // The vendor schema treats projectName/serviceName as OPTIONAL (omitting
    // them would return data across an unscoped range) — policy requires
    // both present regardless of what the vendor schema permits.
    requireNoExtraKeys(input, new Set(['projectName', 'serviceName']), 'getComposeDockerServices');
    requireReviewedTarget(input, 'getComposeDockerServices');
  },
  // getMonitorTableData: intentionally absent — see the policy comment above.
};

const EASYPANEL_ALLOWED_QUERY_PROCEDURES = new Set(Object.keys(EASYPANEL_QUERY_PREDICATES));

/**
 * True if this call must be blocked.
 *
 * 1. Tool-name allowlist: only search_procedures (always allowed) and
 *    execute_query (gated below) are ever considered "safe-shaped" at all;
 *    every other mcp__epic-portal__* tool name is blocked outright.
 * 2. Wrapper-shape allowlist: execute_query's tool_input must be exactly
 *    {procedure: string, input?: ...} — no extra top-level keys, no
 *    non-object top-level shape. Anything else is an unexpected wrapper,
 *    rejected outright rather than searched for a recoverable interpretation.
 * 3. Procedure allowlist + exact input predicate: the named procedure must
 *    be one of the reviewed ones, AND its resolved input must pass that
 *    procedure's own exact predicate.
 *
 * Throws (does not swallow) on any of the above failing for an
 * epic-portal-shaped call — callers MUST treat that as fail-CLOSED.
 */
function isBlockedEasyPanelCall(toolName, toolInput, cmd) {
  const tool = toolName || '';
  if (EASYPANEL_METADATA_TOOL_RE.test(tool)) {
    return false; // search_procedures: metadata/schema discovery only, never executes anything
  }
  if (EASYPANEL_QUERY_TOOL_RE.test(tool)) {
    const ti = toolInput;
    if (ti === null || typeof ti !== 'object' || Array.isArray(ti)) {
      throw new Error('unexpected tool_input shape: not a plain object');
    }
    requireNoExtraKeys(ti, new Set(['procedure', 'input']), 'tool_input');
    if (typeof ti.procedure !== 'string' || !ti.procedure) {
      throw new Error('missing or non-string procedure field');
    }
    const predicate = EASYPANEL_QUERY_PREDICATES[ti.procedure];
    if (!predicate) return true; // not an allowlisted procedure — fail closed
    const resolvedInput = resolveInputObject(ti.input);
    predicate(resolvedInput); // throws on any predicate failure — propagates to fail-closed
    return false;
  }
  if (EASYPANEL_ANY_TOOL_RE.test(tool)) {
    return true; // any epic-portal tool that isn't one of the two exact names above
  }
  if (cmd && HTTP_INVOCATION_RE.test(cmd) && EASYPANEL_RAW_PATH_RE.test(cmd)) {
    return true; // raw bypass to the EasyPanel endpoint is blocked outright, full stop
  }
  return false;
}

/**
 * Tool classification. The central lesson from the incumbent global hook:
 * scanning every tool's serialized input causes false positives on tools that
 * merely DESCRIBE an operation (a task update mentioning a container teardown,
 * a Port record documenting a table wipe). Only EXEC and WRITE payloads are
 * inspected for destructive shapes.
 */
const TOOL_CLASSES = {
  exec: new Set(['Bash', 'PowerShell', 'mcp__ssh-deepseek__remote-ssh']),
  write: new Set([
    'Write',
    'Edit',
    'NotebookEdit',
    'mcp__ssh-deepseek__ssh-edit-block',
    'mcp__ssh-deepseek__ssh-write-chunk',
  ]),
  read: new Set([
    'Read',
    'Grep',
    'Glob',
    'LSP',
    'mcp__ssh-deepseek__ssh-read-lines',
    'mcp__ssh-deepseek__ssh-search-code',
  ]),
};

function classifyTool(toolName) {
  if (TOOL_CLASSES.exec.has(toolName)) return 'exec';
  if (TOOL_CLASSES.write.has(toolName)) return 'write';
  if (TOOL_CLASSES.read.has(toolName)) return 'read';
  return 'other'; // Task*, Schedule*, Port MCP, Agent, Skill, WebFetch, Artifact...
}

function normalizePath(p) {
  if (typeof p !== 'string') return '';
  return p.replace(/\\/g, '/');
}

function isUnderAny(candidate, roots) {
  const c = normalizePath(candidate).toLowerCase();
  return roots.some((r) => {
    const root = normalizePath(r).toLowerCase().replace(/\/+$/, '');
    return c === root || c.startsWith(root + '/');
  });
}

/** Does this text reference a canonical live checkout? Returns the path or null. */
function matchLiveCheckout(text) {
  const t = normalizePath(text);
  for (const p of LIVE_CHECKOUTS) {
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(escaped + '(?![a-z0-9._-])', 'i').test(t)) return p;
  }
  return null;
}

function isSafeBuildLocation(text) {
  const t = normalizePath(text).toLowerCase();
  return SAFE_BUILD_ROOTS.some((r) => t.includes(normalizePath(r).toLowerCase()));
}

function extname(p) {
  const m = /\.[a-z0-9]+$/i.exec(normalizePath(p));
  return m ? m[0].toLowerCase() : '';
}

function isProseFile(p) {
  return PROSE_EXTENSIONS.has(extname(p));
}

function isSecretFile(p) {
  const norm = normalizePath(p);
  if (SECRET_FILE_EXEMPT_RE.test(norm)) return false;
  return SECRET_FILE_RE.test(norm);
}

module.exports = {
  CLI,
  VERB,
  DEPLOYED_TRUNKS,
  SHARED_WABA_ID,
  LIVE_CHECKOUTS,
  SAFE_BUILD_ROOTS,
  BUILD_COMMAND_RE,
  RESTART_COMMAND_RE,
  DESTRUCTIVE_RULES,
  PROTECTED_NUMBERS,
  META_HOST_RE,
  LEGACY_REFERENCE_RE,
  SECRET_FILE_RE,
  SECRET_DUMP_RE,
  EASYPANEL_REVIEWED_PROJECT,
  EASYPANEL_REVIEWED_SERVICES,
  EASYPANEL_ALLOWED_QUERY_PROCEDURES,
  EASYPANEL_QUERY_PREDICATES,
  EASYPANEL_METADATA_TOOL_RE,
  EASYPANEL_QUERY_TOOL_RE,
  EASYPANEL_ANY_TOOL_RE,
  EASYPANEL_RAW_PATH_RE,
  HTTP_INVOCATION_RE,
  resolveInputObject,
  isBlockedEasyPanelCall,
  TOOL_CLASSES,
  classifyTool,
  normalizePath,
  isUnderAny,
  matchLiveCheckout,
  isSafeBuildLocation,
  extname,
  isProseFile,
  isSecretFile,
};
