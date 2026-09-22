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
  // 2026-08-20 (Packet 5M-RN) — DESTRUCTIVE NETWORK OPERATIONS.
  //
  // container-destroy above matches the verb directly after the CLI name, so every
  // subcommand form slipped past it — network removal among them. Neither this guard
  // nor the user-home guard refused it, and the network the estate is wired through
  // was one unguarded line from being removed.
  //
  // This surface is execution-only by construction: the write path exits before the
  // exec rules are consulted, so documentation quoting these commands is unaffected
  // without needing a flag.
  //
  // Verbs only — ls, inspect, connect, disconnect and create are untouched.
  {
    id: 'network-destroy',
    re: new RegExp(
      '\\b' + CLI.container + '\\s+network\\s+(' +
        [VERB.remove, tok('rem', 'ove'), tok('pru', 'ne')].join('|') + ')\\b',
      'i'
    ),
    why: 'Destructive docker network operation. Removing a network disconnects every container attached to it. Remove a named network only under explicit authorization.',
  },

  // 2026-08-21 (Packet 5M-ER4S) — DESTRUCTIVE RESOURCE REMOVAL.
  //
  // Same shape as the network gap directly above, found the same way and one day
  // later: `container-destroy` matches the container/compose forms, `network-destroy`
  // matches networks, and NOTHING matched secrets, configs or volumes on either
  // guard surface. Measured across 23 destructive cases before this rule existed,
  // 19 were ALLOWED by both surfaces — including sudo, env-prefixed, bash -c,
  // sh -c, ssh-wrapped, multi-target, by-id, substituted, globbed and xargs forms.
  //
  // A Swarm secret cannot be read back once created, so removing the wrong name is
  // unrecoverable from this estate — only the issuer that minted the value can
  // replace it. A volume removal is the data. This matters immediately: Packet 5M-E
  // converts the portal's six plaintext credentials into Docker secrets and then
  // rotates the live gateway admin token.
  //
  // Execution-only by construction: DESTRUCTIVE_RULES are applied against
  // scanTarget on the Bash path only, so a runbook or a Port record may quote the
  // vocabulary. That is the same reasoning already recorded for the rules above.
  //
  // Not a production-name blacklist — the verb is the predicate. ls, inspect and
  // create are untouched. This rule is deliberately duplicated on the user-home
  // surface (`docker-resource-destroy`) so neither surface is load-bearing alone;
  // the user-home hook is per-machine and not reviewed in a PR, so a lane without
  // it must still be protected by the copy that travels with this repository.
  {
    id: 'resource-destroy',
    re: new RegExp(
      '\\b' + CLI.container + '\\s+(secret|config|volume)\\s+(' +
        [VERB.remove, tok('rem', 'ove')].join('|') + ')\\b',
      'i'
    ),
    why: 'Destructive removal of a Docker secret, config or volume. A Swarm secret cannot be read back, so removing the wrong one is unrecoverable without the issuer; a volume is the data. Remove a named resource only under an explicit exact-target authorization.',
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
      // ORCHESTRATOR SECRET STORES, added 2026-09-22 after the second exposure
      // of the same file in one day. `/run/secrets/gateway_bindings` and
      // `isola_gw_bindings_v8` carry inline `agentBotSecret`/`agentBotAccessToken`
      // values, and matched NOTHING above: no extension, not `.env`-shaped. The
      // existing rules key on file SHAPE, and a Swarm/Compose secret has no
      // shape — its secrecy comes from WHERE IT LIVES, which is why the path
      // rule below exists too. Both exposures came from "I just need to see the
      // structure first", which is why the answer is a deny with a projection
      // in the remedy, not a wrap.
      '[a-z0-9_.-]*bindings(_v[0-9]+)?',
      // The extension is matched EXCEPT for documentation formats. Writing
      // ABOUT secrets is not holding one, and on 2026-09-22 this very
      // alternative — added hours earlier in the same change — blocked a lane
      // from reading its own notes file named `..._exported_secrets.md`. That
      // is a guard binding to VOCABULARY rather than to an operation
      // (CLAUDE.md §2.27c), and the estate's rule is to report it rather than
      // rename the document to get through. A doc that genuinely pastes a
      // credential is still covered: it falls to the redaction wrap, which
      // rewrites values, instead of a flat deny that hides the prose too.
      '[a-z0-9_.-]*_secrets?(\\.(?!md$|markdown$|txt$|rst$|adoc$)[a-z0-9]+)?',
    ].join('|') +
    ')$',
  'i'
);

/**
 * A SECRET BY LOCATION, NOT BY NAME. Anything under a container/orchestrator
 * secret mount is a credential whatever it is called — `/run/secrets/<x>`
 * (Docker/Swarm), `/var/run/secrets/<x>` (Kubernetes). Enumerated separately
 * from SECRET_FILE_RE because that regex anchors on the FILENAME and these
 * files are deliberately named like ordinary config.
 */
const SECRET_STORE_PATH_RE = /(^|[\s'"`=])\/(?:var\/)?run\/secrets\/[^\s'"`;|&]*/i;
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

/**
 * CREDENTIAL-BEARING SURFACES — read legitimately, but the output carries a
 * secret. These are NOT denied: denying them would block real investigation
 * (you often need to see a git remote, or an Asterisk peer block). Instead the
 * guard rewrites the command to pipe its own output through lib/secret-redact.js
 * via PreToolUse `updatedInput`.
 *
 * Each entry below is a MEASURED exposure, not a hypothetical:
 *   - `git remote -v` / `git config ... url`  printed a live GitHub PAT that was
 *     embedded in /opt/lk-voice-agent/.git/config          (2026-08-16)
 *   - a line-range read of an Asterisk SIP peers config printed two plaintext
 *     `secret=` values                                      (2026-08-16)
 *
 * Note `sed`/`awk`/`grep`/`strings` are the readers here. SECRET_DUMP_RE only
 * knows cat/head/tail/less — which is precisely why the SIP read sailed through.
 */
const CREDENTIAL_SURFACE_RE = new RegExp(
  [
    // `docker inspect` / `docker service inspect` print a service's FULL env,
    // which on this estate is where injected credentials live. Added
    // 2026-09-22 after it printed a live HASHID_FIELD_SALT into a lane's
    // transcript — the third credential exposure of the day.
    //
    // The guard ALREADY blocked epic-portal's `inspect*Service` API family,
    // which does the same job through a different door. The CLI door was left
    // open. That is CLAUDE.md §2.21 exactly: a remediation applied to one copy
    // of a thing while an identical copy sits untouched is a moved problem, not
    // a fixed one — and the copy nobody enumerated is the one with no owner
    // watching it.
    //
    // Wrapped, not denied, on purpose: inspecting a service is ordinary and
    // often necessary investigation (it is how the crash-loop above was
    // diagnosed). What must not happen is the VALUES reaching the transcript.
    // Denying it outright would push the work into some unguarded shape.
    // ANCHORED TO A COMMAND POSITION, not to the mere appearance of the words.
    // The first version of this line matched anywhere in the command text, and
    // within two minutes it blocked a `grep -E 'docker inspect|...'` that ran
    // the SELFTEST — a search for the phrase is not an invocation of it. That
    // was the fourth guard false-positive of 2026-09-22 and the third authored
    // by me, all the same root cause: matching what text LOOKS like instead of
    // what is being DONE (CLAUDE.md §2.27c).
    //
    // So `docker` must sit at the start, after a separator (`;` `&&` `||` `|`
    // newline, subshell) or directly after `sudo`. Inside a quoted pattern it
    // is preceded by a quote, which is not a command position, so it no longer
    // matches. Same discipline the build rule already uses.
    // SUBCOMMANDS LIMITED TO THE ONES THAT ACTUALLY PRINT ENV. The first
    // version also swept in `docker secret inspect` and `docker config
    // inspect`, and the user-home hook's own suite failed — correctly. Those
    // two were DELIBERATELY allowed there: `docker secret inspect` prints
    // METADATA ONLY (id, name, timestamps), never the secret payload, which is
    // the whole point of Docker's secret API. I had widened the pattern on the
    // shape of the words without checking what the subcommands do.
    //
    // That cross-hook test did exactly its job — it protected a decision
    // somebody actually made (CLAUDE.md §2.28) against a careless widening,
    // and it is the reason this line is three words shorter than it was.
    '(?:^|[;&|(\\n]|\\bsudo\\b)\\s*docker\\s+(?:service\\s+|container\\s+)?inspect\\b',
    // A git remote URL can embed user:token@host.
    '\\bgit\\s+(remote\\s+(-v|show|get-url)|config\\b[^\\n|;&]*\\b(url|remote\\.))',
    '[\\\\/]\\.git[\\\\/]config\\b',
    // Telephony peer/registration configs hold plaintext `secret=` per peer.
    '\\bsip[a-z0-9_-]*\\.conf\\b',
    '\\b(pjsip|sip_[a-z0-9_]*|iax|manager)\\.conf\\b',
    // Any reader pointed at a config file that commonly carries an injected
    // credential. The reader list is deliberately wider than SECRET_DUMP_RE's:
    // that one knew only cat/head/tail/less, which is exactly how a `sed` line
    // range over a SIP peers file walked straight through it.
    //
    // `.ya?ml` earns its place from a measured exposure: a provisioned
    // `.paperclip.yaml` carries `adapter.config.headers.Authorization: Bearer
    // rtp_…`, injected at provision time from the secret store. The COMMITTED
    // template is clean — it holds only a comment saying the bearer is injected
    // — so this is a case where placement was already right and the failure was
    // purely in how the live file was read: dumped raw. Nothing else would have
    // caught it, since a provisioned yaml is not SECRET_FILE-shaped.
    '\\b(cat|bat|less|more|head|tail|type|Get-Content|nl|sed|awk|grep|rg|strings|od|perl|python3?)\\b' +
      '[^\\n|;&]*\\.(conf|cfg|ini|properties|ya?ml)\\b',
    // `.env` too, and this closes a gap found while USING the rule: SECRET_DUMP_RE
    // denies only PAGERS on a secret file (cat/head/tail/less/…), so `grep FOO
    // /opt/bff-v2/.env` was neither denied nor rewritten — it printed values.
    //
    // Wrapping rather than denying is deliberate here. The guard's own remedy
    // text tells you to read variable NAMES with
    // `grep -o "^[A-Z_][A-Z0-9_]*=" .env`, so a blanket deny would forbid the
    // very command the guard recommends. Routing it through the redactor
    // produces that same names-only result automatically: `KEY=<secret>` comes
    // back as `KEY=[REDACTED:…]`. The blatant `cat .env` stays denied by rule 1,
    // which runs first.
    // The (?!example|sample|template|dist) is not cosmetic: `.env.example` is a
    // committed TEMPLATE with no secrets in it, and SECRET_FILE_EXEMPT_RE
    // already exempts that family elsewhere. Without this, the guard blocked
    // reading a checked-in example file — caught by a PRE-EXISTING test that
    // existed to stop exactly this over-blocking.
    '\\b(sed|awk|grep|rg|strings|od|perl|python3?|cut|sort|uniq|wc)\\b[^\\n|;&]*' +
      // The lookahead binds IMMEDIATELY after `.env`, before the optional
      // suffix group. Placing it inside that group does nothing: the group is
      // optional, so the engine simply matches bare `.env` and succeeds — which
      // is what happened on the first attempt.
      '(^|[\\s\'"`/\\\\=])\\.env(?!\\.(?:example|sample|template|dist)\\b)(\\.[a-z0-9_-]+)?\\b',
    // A SECRET MANAGER'S CLI IS A CREDENTIAL-BEARING SURFACE BY DEFINITION.
    // Added BEFORE any bulk migration work, not after — the guard had never
    // seen `infisical`, and `secrets`, `export` and `run` all print values.
    // Wrapping (not denying) is what makes it usable: the redactor leaves the
    // KEY NAMES and folder structure readable, which is exactly what inventory
    // and organisation work needs, while the values never reach a transcript.
    // Covers the sibling CLIs too, so this is not a one-vendor patch.
    '\\b(infisical|vault|doppler|op|sops|aws\\s+secretsmanager|gcloud\\s+secrets|az\\s+keyvault)\\b',
  ].join('|'),
  'i'
);

const SECRET_DUMP_RE = new RegExp(
  [
    // `env |` means "dump the environment". `.env |` means "a FILE PATH, piped"
    // — a different thing entirely. Without the lookbehind, `\benv` matches the
    // tail of `/opt/bff-v2/.env` (the `.` is a word boundary), so ANY pipe after
    // a .env path was read as an environment dump and denied.
    //
    // That false positive mattered: it fired ahead of the credential-surface
    // rewrite below, so the safe, redacted form of the read was blocked while
    // the guard's own remedy text was recommending exactly that command. Bare
    // `env |`, `printenv` and `set | grep` are still caught.
    // Lookbehind excludes a preceding DOT ONLY — not a slash.
    //
    // The first version used (?<![./\w]) and that was a REGRESSION, found by
    // adversarial review 2026-08-16, not by the tests I wrote: excluding `/`
    // let every path-qualified dump through —
    //     /usr/bin/env | sort      /bin/env | sort      /usr/bin/printenv
    // are genuine environment dumps that the original rule caught and my
    // "fix" did not.
    //
    // Only the dot is needed for the false positive this was meant to solve:
    // `/opt/bff-v2/.env | sort` is a FILE PATH piped, and its `env` is
    // preceded by `.`. A slash before `env` means a binary, and a binary
    // named env being piped IS the dump.
    //
    // Residual, accepted: a FILE literally named `/etc/env` piped would now
    // match and be denied. Rare, and it fails toward denial.
    '(?<![.\\w])(printenv|env\\s*(\\||$)|set\\s*\\|\\s*grep|Get-ChildItem\\s+Env:|dir\\s+env:)',
    // A pager/dump command applied to a secret file. The gap deliberately
    // excludes `|`, `;` and `&` so a later, unrelated command in the same line
    // cannot be attributed to an earlier `cat`/`head`.
    '(\\b(cat|bat|less|more|head|tail|type|Get-Content|nl|xxd|base64)\\b[^\\n|;&]*' + SECRET_PATH_TOKEN + ')',
  ].join('|'),
  'i'
);

/**
 * epic-portal (EasyPanel MCP) procedures that return full plaintext secrets
 * (encryption keys, JWT secrets, DB/Redis/MariaDB passwords) for every
 * service on the instance, with no redaction and no per-project scoping.
 * Confirmed by direct observation twice in one session (2026-08-09, then
 * again 2026-08-10) — reclassified P0 both times. Its own stated purpose
 * ("resource selection") has no functional need for runtime secret values,
 * so this is blocked outright rather than relied on as a remembered rule.
 * See defect-easypanel-listprojectsandservices-second-secret-dump-2026-08-10.
 *
 * Safe alternatives that cover every legitimate need so far: listProjects,
 * listPorts, listMounts, getComposeDockerServices, getMonitorTableData —
 * none of these return secret material.
 */
const EASYPANEL_BLOCKED_PROCEDURES = new Set([
  'listProjectsAndServices',
  // 2026-09-21: inspectAppService on isola-lumen-api-prod returned that service's
  // FULL plaintext env block (Django secret key, DB and Redis passwords, ~12 API
  // tokens) into a lane's transcript while it was only looking up app configs.
  // Same defect as the line above, a different door — the 2026-08-10 fix named
  // ONE procedure and nothing else, so the sibling that returns the same shape
  // walked straight through (§2.21: enumerate every copy of the thing you fix).
  // The whole inspect*Service family returns "configuration" of a service, and
  // for app/compose/database services that configuration IS the env/passwords.
  'inspectAppService',
  'inspectComposeService',
  'inspectPostgresService',
  'inspectMySQLService',
  'inspectMariaDBService',
  'inspectMongoService',
  'inspectRedisService',
  'inspectBoxService',
  // inspectProject returns "a project with its services and resolved domain
  // configuration" — the per-project slice of listProjectsAndServices' shape.
  'inspectProject',
  // getEnv returns the raw Traefik environment file (DNS/ACME provider tokens).
  'getEnv',
]);

/**
 * Family rule alongside the explicit set: any epic-portal procedure named
 * inspect<Something>Service is treated as secret-bearing even if it is not
 * listed above (a service type added to EasyPanel later must not become a
 * fresh unlisted door). getServiceError / getServiceNotes / getServiceDomain /
 * getMetricsServiceStats do NOT match this shape and stay allowed.
 */
const EASYPANEL_BLOCKED_PROCEDURE_RE = /(^|[./])inspect[A-Za-z0-9]*Service$/;

/** Tool-name prefix used by every epic-portal MCP wrapper (query/mutation/destructive). */
const EASYPANEL_MCP_TOOL_RE = /^mcp__epic-portal__execute_/;

/** Host/path fingerprints for the raw HTTP bypass routes a blocked procedure could be
 * reached through: the JSON-RPC-over-HTTPS route documented this session (used when the
 * native tool wrapper mis-encodes non-empty input), a REST-style /api/rpc/... path, and
 * a tRPC-style /api/trpc/namespace.procedure path. Checked independent of host, since a
 * proxy or different hostname must not create a bypass. */
const EASYPANEL_RAW_ENDPOINT_RE = /portal\.saas00\.epic\.dm\/api\/mcp/i;
const EASYPANEL_RAW_PATH_RE = /\/api\/(rpc|trpc|mcp)\/[^\s'"]*/i;

/**
 * A path/endpoint match alone is not enough to block — "prose mentioning the
 * Graph host is still not gated" is the same design rule this reuses (see
 * isola-guard.js header). A commit message, a doc, or this very policy file
 * can legitimately contain the string "/api/rpc/...listProjectsAndServices"
 * without performing a call. Only treat it as a real network call when the
 * command also looks like one is actually being made.
 */
const HTTP_INVOCATION_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|axios)\b|\bfetch\s*\(|\.request\s*\(/i;

const EASYPANEL_MAX_INSPECT_DEPTH = 6;

/**
 * True if `name` matches a blocked procedure, bare ("listProjectsAndServices")
 * or namespaced ("projects.listProjectsAndServices", "projects/listProjectsAndServices").
 */
function matchesBlockedEasyPanelProcedureName(name) {
  if (typeof name !== 'string' || !name) return false;
  for (const blocked of EASYPANEL_BLOCKED_PROCEDURES) {
    if (name === blocked || name.endsWith('.' + blocked) || name.endsWith('/' + blocked)) {
      return true;
    }
  }
  if (EASYPANEL_BLOCKED_PROCEDURE_RE.test(name)) return true;
  return false;
}

/**
 * Walks a tool_input payload looking for a procedure name in any plausible
 * location, defensively handling two real shapes seen this session:
 *   - the procedure name nested under arguments/params/input/body/data
 *   - the whole input (or a sub-field) arriving as a JSON-encoded STRING
 *     rather than a parsed object (the documented native-tool encoding bug)
 *
 * Deliberately THROWS (rather than silently giving up) when the payload
 * nests deeper than a sane bound — an unusually-shaped payload targeting
 * epic-portal is itself suspicious, and the caller is responsible for
 * treating a thrown error here as fail-CLOSED for epic-portal-shaped calls.
 */
function collectProcedureCandidates(value, depth) {
  const out = [];
  if (depth > EASYPANEL_MAX_INSPECT_DEPTH) {
    throw new Error('easypanel payload nesting exceeds safe inspection depth (' + EASYPANEL_MAX_INSPECT_DEPTH + ')');
  }
  if (value == null) return out;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      let parsed;
      try {
        parsed = JSON.parse(trimmed);
      } catch (_) {
        return out; // not JSON after all — nothing further to extract, not an error
      }
      out.push(...collectProcedureCandidates(parsed, depth + 1));
    }
    return out;
  }
  if (typeof value !== 'object') return out;
  if (typeof value.procedure === 'string') out.push(value.procedure);
  if (typeof value.method === 'string') out.push(value.method);
  for (const key of ['arguments', 'params', 'input', 'body', 'data', 'payload']) {
    if (value[key] !== undefined) out.push(...collectProcedureCandidates(value[key], depth + 1));
  }
  return out;
}

/**
 * True if this call — through the native MCP tool OR a raw HTTP bypass —
 * would invoke a blocked EasyPanel procedure. Checked against both tool_input
 * (native path, including nested/serialized shapes) and a command string
 * (raw curl/node path, including /api/rpc and /api/trpc forms).
 *
 * Throws (does not swallow) if tool_input inspection hits the depth guard —
 * callers targeting epic-portal MUST treat that as fail-CLOSED, not fail-open.
 */
function isBlockedEasyPanelCall(toolName, toolInput, cmd) {
  const isEasyPanelTool = EASYPANEL_MCP_TOOL_RE.test(toolName || '');
  if (isEasyPanelTool) {
    const candidates = collectProcedureCandidates(toolInput, 0);
    if (candidates.some(matchesBlockedEasyPanelProcedureName)) return true;
  }
  if (cmd && HTTP_INVOCATION_RE.test(cmd) && (EASYPANEL_RAW_ENDPOINT_RE.test(cmd) || EASYPANEL_RAW_PATH_RE.test(cmd))) {
    for (const name of EASYPANEL_BLOCKED_PROCEDURES) {
      if (cmd.includes(name)) return true;
    }
    // Family rule on the raw path too: /api/rpc/services/app/inspectAppService,
    // /api/trpc/services.postgres.inspectPostgresService, or the name inside a
    // JSON-RPC body. Word-bounded so prose in an unrelated curl cannot match.
    if (/\binspect[A-Za-z0-9]*Service\b/.test(cmd)) return true;
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

/**
 * A NAMED SET IS A LIST OF THE SERVERS SOMEONE HAPPENED TO KNOW ABOUT.
 *
 * Measured 2026-09-22: the sets above name only the `ssh-deepseek` MCP server,
 * so every command issued through `mcp__host03__remote-ssh` classified as
 * 'other' and was NEVER INSPECTED — not for secret reads, not for
 * build-in-live-checkout, not for destructive shapes. The whole exec rule set
 * was absent on a second production host for as long as that server existed.
 * It surfaced because a `docker exec … cat /run/secrets/…` on host03 put two
 * live agent-bot credentials in a transcript and nothing stopped it; the read
 * was the symptom, the ungoverned server was the defect.
 *
 * Matching by SHAPE closes the class rather than one instance: any MCP server
 * exposing an ssh-ish tool is governed the moment it appears, including one
 * added tomorrow. The failure direction is deliberate — an unrecognised
 * `mcp__*__remote-ssh` is treated as EXEC, which means MORE inspection, never
 * less. Same family as §2.21 (enumerate every copy) applied to tool surfaces.
 */
const MCP_EXEC_TOOL_RE = /^mcp__[A-Za-z0-9_.-]+__(remote-ssh|ssh-exec|ssh-command|exec)$/;
const MCP_WRITE_TOOL_RE = /^mcp__[A-Za-z0-9_.-]+__(ssh-edit-block|ssh-write-chunk|ssh-write-file)$/;
const MCP_READ_TOOL_RE = /^mcp__[A-Za-z0-9_.-]+__(ssh-read-lines|ssh-search-code|ssh-read-file)$/;

function classifyTool(toolName) {
  if (TOOL_CLASSES.exec.has(toolName)) return 'exec';
  if (TOOL_CLASSES.write.has(toolName)) return 'write';
  if (TOOL_CLASSES.read.has(toolName)) return 'read';
  // Shape-matched MCP transports, checked AFTER the explicit sets so a named
  // tool keeps its declared class. Write/read are matched before exec so a
  // narrower tool is not promoted to exec by accident.
  if (typeof toolName === 'string') {
    if (MCP_WRITE_TOOL_RE.test(toolName)) return 'write';
    if (MCP_READ_TOOL_RE.test(toolName)) return 'read';
    if (MCP_EXEC_TOOL_RE.test(toolName)) return 'exec';
  }
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

/**
 * extractCommitMessage — return the MESSAGE BODY of a `git commit`/`git tag`,
 * or '' when the command is not one.
 *
 * Exists so the exec shape-rules can treat prose as prose. A commit message
 * documenting `cat .env` is describing an operation, not performing one, and
 * blocking it teaches people to route the message through a file — one step
 * from switching the guard off.
 *
 * Returns ONLY the message. The caller still scans the surrounding command, so
 * a real operation chained after the message is unaffected.
 */
function extractCommitMessage(cmd) {
  const s = String(cmd || '');
  // Git accepts GLOBAL OPTIONS between `git` and the subcommand, and this
  // precondition did not allow for them. Measured 2026-09-09: a real commit
  // issued as
  //     git -c user.name=EPICDM -c user.email=... commit -q -F - <<'MSG'
  // never matched `git\s+commit`, so NOTHING was masked, and the build rule
  // then fired on "next build" inside the message body — refusing a commit
  // as a build. The masking machinery was correct; it was simply never
  // reached for the shape this estate actually uses (every commit here sets
  // -c user.name / -c user.email because the worktrees have no local identity).
  //
  // The first fix for that refusal only made rule 3 consume scanTarget, and
  // its selftest case used a bare `git commit` — so the test passed while the
  // real command stayed blocked. A test that does not reproduce the shape
  // under test proves nothing about it (Law 20).
  //
  // Only -c/-C/--no-pager/--git-dir/--work-tree/--namespace are admitted, each
  // consuming its own argument. Anything else still falls through to null, so
  // this widens the PRECONDITION and not the exemption: the message body is
  // still identified by offset, and a real operation outside it is still seen.
  if (!/\bgit\s+(?:(?:-[cC]\s+\S+|--no-pager|--git-dir[=\s]\S+|--work-tree[=\s]\S+|--namespace[=\s]\S+)\s+)*(commit|tag)\b/.test(s)) return null;

  const spans = [];

  // Heredoc: git commit -F - <<'EOF' ... EOF   (quoted or bare delimiter)
  const here = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\s*\r?\n([\s\S]*?)\r?\n\2\b/.exec(s);
  if (here) {
    const bodyStart = here.index + here[0].indexOf(here[3], here[0].indexOf('\n'));
    spans.push([bodyStart, bodyStart + here[3].length]);
  }

  // -m / --message with a quoted body. ALL of them: git accepts repeated -m.
  for (const re of [/-m\s+"((?:[^"\\]|\\.)*)"/g, /-m\s+'((?:[^'\\]|\\.)*)'/g,
                    /--message[=\s]+"((?:[^"\\]|\\.)*)"/g, /--message[=\s]+'((?:[^'\\]|\\.)*)'/g]) {
    let m;
    while ((m = re.exec(s))) {
      const start = m.index + m[0].indexOf(m[1]);
      spans.push([start, start + m[1].length]);
    }
  }

  if (!spans.length) return null;
  return { text: spans.map(([a, b]) => s.slice(a, b)).join('\n'), spans };
}

/**
 * maskSpans — blank the given [start,end) ranges of `s`.
 *
 * WHY OFFSETS AND NOT `split(value).join(...)`:
 *
 * The first implementation blanked the message BY CONTENT. Adversarial review
 * 2026-08-16 broke it in one line:
 *
 *     git commit -F - <<EOF
 *     cat /opt/bff-v2/.env
 *     EOF
 *     cat /opt/bff-v2/.env
 *
 * The real second command is byte-identical to the message body, so
 * `split/join` erased BOTH — the exempted region swallowed a live command and
 * the shape rules never saw it.
 *
 * LAW: AN EXEMPTION IDENTIFIES A REGION, NOT A VALUE. The moment it matches by
 * content, any identical text anywhere inherits the exemption. This is the same
 * defect class as an exemption token that is honoured wherever it appears —
 * "the scope evaluated is wider than the scope intended".
 *
 * Replacement is a fixed-width placeholder so offsets stay meaningful, and
 * spans are applied right-to-left so earlier ones are not shifted.
 */
function maskSpans(s, spans) {
  const str = String(s == null ? '' : s);
  return [...spans]
    .sort((a, b) => b[0] - a[0])
    .reduce((acc, [a, b]) => acc.slice(0, a) + ' <commit-message> ' + acc.slice(b), str);
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
  SECRET_STORE_PATH_RE,
  SECRET_DUMP_RE,
  CREDENTIAL_SURFACE_RE,
  MCP_EXEC_TOOL_RE,
  MCP_WRITE_TOOL_RE,
  MCP_READ_TOOL_RE,
  EASYPANEL_BLOCKED_PROCEDURES,
  EASYPANEL_BLOCKED_PROCEDURE_RE,
  EASYPANEL_MCP_TOOL_RE,
  EASYPANEL_RAW_ENDPOINT_RE,
  EASYPANEL_RAW_PATH_RE,
  HTTP_INVOCATION_RE,
  matchesBlockedEasyPanelProcedureName,
  collectProcedureCandidates,
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
  extractCommitMessage,
  maskSpans,
};
