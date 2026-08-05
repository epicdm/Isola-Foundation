/**
 * guard-chatwoot-safe-read
 *
 * Twice in one day a Chatwoot API read printed live credentials into a session
 * transcript:
 *
 *   - `GET /api/v1/accounts/5/inboxes/{id}/agent_bot` returns the bound bot's
 *     `access_token` and HMAC `secret`
 *     (defect-chatwoot-r1-agentbot-token-secret-exposed-in-transcript-2026-08-05);
 *   - `GET /api/v1/accounts/5/inboxes/46` returns `provider_config`, which for a
 *     `Channel::Whatsapp` inbox carries a live Meta Graph `api_key` and a
 *     `webhook_verify_token`
 *     (defect-chatwoot-r1-whatsapp-meta-token-exposed-in-transcript-2026-08-05).
 *
 * The second one leaked a permanent, never-expiring, 41-scope EPIC_BFF system
 * user token that reaches every EPIC WhatsApp number, including 3742.
 *
 * Both mistakes have the same shape: the operator knew SOME fields were
 * sensitive and removed them AFTER the fact. That is a denylist, and a denylist
 * fails the first time Chatwoot adds a field — which is exactly what happened
 * between the webhook read (where `secret` WAS filtered) and the agent_bot read
 * (where the same operator did not know `access_token` would be there).
 *
 * So this module is allowlist-only, in both directions:
 *
 *   1. `projectInbox` / `projectAgentBot` — turn a raw Chatwoot response into the
 *      safe subset. Unknown fields are DROPPED, not inspected. A field that
 *      Chatwoot adds tomorrow is invisible by construction rather than newly
 *      dangerous.
 *
 *   2. `findUnsafeChatwootReads` — a static check over runbooks, scripts and
 *      docs, so a future operational procedure cannot ship a command that pipes
 *      a raw inbox or agent_bot response to stdout.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO, and is tested for:
 *   - it never deletes a key from an object and returns the rest — that is the
 *     denylist shape this exists to prevent;
 *   - it never reads or transmits a credential in order to redact it;
 *   - it does not try to validate that a value "looks like" a token. Field
 *     provenance decides, not the value's shape.
 *
 * Usage:
 *   tsx scripts/src/guard-chatwoot-safe-read.ts          # scan repo, human readable
 *   tsx scripts/src/guard-chatwoot-safe-read.ts --json   # machine readable
 *
 * Exit 0 = clean. Exit 1 = an unsafe read was found. Exit 2 = the guard failed.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Inbox fields an operator may see. Chosen to cover real operational questions —
 * who owns the inbox, is auto-assignment on, is it inside working hours — and
 * nothing else.
 *
 * `phone_number` is included: it is the customer-facing identity of the line
 * (+17672956737), printed throughout Port and CLAUDE.md, and an operator cannot
 * confirm they are looking at the right inbox without it. `provider` is the
 * provider NAME (`whatsapp_cloud`); `provider_config` is its credential bag and
 * is absent from this list on purpose.
 */
export const SAFE_INBOX_FIELDS: readonly string[] = [
  'id',
  'name',
  'channel_type',
  'phone_number',
  'provider',
  'enable_auto_assignment',
  'enable_email_collect',
  'csat_survey_enabled',
  'allow_messages_after_resolved',
  'greeting_enabled',
  'working_hours_enabled',
  'out_of_office_message',
  'timezone',
]

/**
 * AgentBot fields an operator may see. The whole point of an agent_bot read is
 * "which bot is bound here, and is the binding live" — id, name and status
 * answer that completely. `access_token` and `secret` answer nothing an
 * operator needs and are the two fields that leaked.
 */
export const SAFE_AGENT_BOT_FIELDS: readonly string[] = [
  'id',
  'name',
  'description',
  'bot_type',
  'outgoing_url',
  'status',
  'inbox_id',
  'account_id',
]

/**
 * Field names that must never reach stdout, at any nesting depth, from any
 * endpoint.
 *
 * This list is NOT the mechanism — the allowlists above are. This exists only so
 * the static check can recognise a runbook that prints one of these, and so
 * `projectInbox`/`projectAgentBot` can fail loudly if an allowlist is ever edited
 * to include one. Belt and braces, with the allowlist as the braces.
 */
export const FORBIDDEN_FIELDS: readonly string[] = [
  'provider_config',
  'api_key',
  'access_token',
  'webhook_verify_token',
  'verify_token',
  'secret',
  'app_secret',
  'hmac_secret',
  'hmac_token',
  'authorization',
]

/** A URL may carry a credential in its query string. Keep the shape, drop the query. */
export function stripQuery(value: unknown): unknown {
  if (typeof value !== 'string') return value
  const cut = value.search(/[?#]/)
  return cut === -1 ? value : `${value.slice(0, cut)}?<stripped>`
}

function isForbidden(field: string): boolean {
  return FORBIDDEN_FIELDS.includes(field.toLowerCase())
}

/**
 * Project an arbitrary object down to an allowlist.
 *
 * Throws if the allowlist itself names a forbidden field. An allowlist is only
 * as good as the review of the allowlist; this makes a bad edit fail a test
 * rather than leak in production.
 */
export function projectAllowlist(
  raw: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const offending = allowed.filter(isForbidden)
  if (offending.length > 0) {
    throw new Error(
      `guard-chatwoot-safe-read: allowlist names forbidden field(s): ${offending.join(', ')}`,
    )
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {}

  const source = raw as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const field of allowed) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue
    const value = source[field]
    // A permitted field must still be a scalar. If Chatwoot ever nests an object
    // under an allowlisted name, dropping it is the safe move — an object can
    // hide a credential at depth, which is precisely how `provider_config` hid
    // `api_key`.
    if (value !== null && typeof value === 'object') continue
    out[field] = field === 'outgoing_url' ? stripQuery(value) : value
  }
  return out
}

export function projectInbox(raw: unknown): Record<string, unknown> {
  return projectAllowlist(raw, SAFE_INBOX_FIELDS)
}

export function projectAgentBot(raw: unknown): Record<string, unknown> {
  return projectAllowlist(raw, SAFE_AGENT_BOT_FIELDS)
}

// ---------------------------------------------------------------------------
// Static check over runbooks, scripts and docs
// ---------------------------------------------------------------------------

/** Chatwoot endpoints whose raw response is known to carry credentials. */
const SENSITIVE_ENDPOINT_RE =
  /\/api\/v1\/accounts\/[^\s"'`/]+\/(inboxes|webhooks|agent_bots)(\/[^\s"'`]*)?/i

/**
 * Markers that show the author projected the response instead of printing it.
 * `jq` with an explicit object construction, an explicit field selection, or a
 * call into this helper all count.
 *
 * A marker is NEVER sufficient on its own — see `isProjectionMarker`. Using
 * `jq` says nothing about what `jq` was asked to select.
 */
const PROJECTION_MARKER_RE =
  /(guard-chatwoot-safe-read|projectInbox|projectAgentBot|projectAllowlist|jq\s+[-a-zA-Z]*\s*['"][^'"]*\{|jq\s+[-a-zA-Z]*\s*['"]\s*\.[A-Za-z_])/

/** A line that is plainly commentary rather than an executable command. */
const PROSE_RE = /^\s*(?:[*>#]|\/\/|--\s)/

/**
 * Anything that puts a value in front of a human, a log or a file.
 *
 * The first version of this list held five verbs and missed `console.error`,
 * `process.stdout.write` and every PowerShell form — on the platform this
 * repository is developed on. A sink list that only covers the shells the
 * author happened to think of is a denylist wearing a different hat.
 */
const OUTPUT_SINK_RE =
  /(\bjq\b|\becho\b|\bprintf\b|\bprint\b|\bputs\b|\btee\b|console\.(?:log|error|warn|info|debug)|process\.(?:stdout|stderr)\.write|Write-Host|Write-Output|Write-Error|ConvertTo-Json|Out-File)/i

/**
 * An explicit selection of a named field: `.api_key`, `["api_key"]`,
 * `['api_key']`, or PowerShell's `-Property` / `-ExpandProperty api_key`.
 *
 * Deliberately NOT a bare word match — the word "secret" in a sentence is not a
 * finding, and the guard has to stay usable inside defect write-ups.
 */
function forbiddenSelectorRe(field: string): RegExp {
  return new RegExp(
    `(?:[.\\[]\\s*["']?${field}["']?\\s*\\]?|-(?:Expand)?Property\\s+["']?${field}\\b)`,
    'i',
  )
}

/**
 * An Authorization-style request header. Matched separately from the field
 * selectors because a header is written `Authorization: Bearer …`, not
 * `.authorization` — the selector form would never see it.
 */
const AUTH_HEADER_RE = /\b(authorization|api[_-]?access[_-]?token|x-api-key|api[_-]?key)\s*:/i

/**
 * The line passes a header to a request rather than printing one: `curl -H`,
 * `--header`, PowerShell `-Headers`.
 *
 * Every authenticated Chatwoot read carries an `api_access_token:` header, and
 * a correctly projected read pipes that same line into `jq`. Without this the
 * auth-header rule fires on the safe form and the guard cries wolf on exactly
 * the command operators are supposed to run. Field selectors are unaffected —
 * a request header does not excuse selecting `.access_token` downstream.
 */
const REQUEST_HEADER_ARG_RE = /(?:^|\s)(?:-H\b|--header\b|-Headers\b)/i

/**
 * If a line both selects a credential field and reaches an output sink, name
 * the field. Returns null otherwise.
 *
 * The sink is required. `curl -H "api_access_token: $TOK" …` USES a credential
 * header; it does not print one, and flagging it would make the guard cry wolf
 * on every authenticated read.
 */
export function findPrintedCredential(line: string): string | null {
  if (!OUTPUT_SINK_RE.test(line)) return null
  for (const field of FORBIDDEN_FIELDS) {
    if (forbiddenSelectorRe(field).test(line)) return field
  }
  if (AUTH_HEADER_RE.test(line) && !REQUEST_HEADER_ARG_RE.test(line)) return 'authorization header'
  return null
}

/**
 * Whether a line shows real evidence of projection.
 *
 * A projection marker is not enough by itself. `… | jq '.provider_config'` uses
 * `jq`, matches the marker pattern, and is a credential leak — that exact shape
 * is why this function exists rather than a bare `PROJECTION_MARKER_RE.test()`.
 * Selecting a forbidden field disqualifies the line no matter how it is spelt.
 */
export function isProjectionMarker(line: string): boolean {
  if (!PROJECTION_MARKER_RE.test(line)) return false
  return !FORBIDDEN_FIELDS.some((field) => forbiddenSelectorRe(field).test(line))
}

export type UnsafeReadKind = 'unprojected_chatwoot_read' | 'forbidden_field_printed'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly kind: UnsafeReadKind
  readonly reason: string
}

/**
 * Find command lines that read a credential-bearing Chatwoot endpoint without
 * projecting the response, or that print a credential field outright.
 *
 * RULE ORDER MATTERS, AND IT IS THE REASON THIS FUNCTION WAS WRONG ONCE.
 * The credential-printed rule is evaluated FIRST, before any projection-marker
 * logic. The original ordering asked "does this line look projected?" first,
 * accepted `jq '.provider_config'` as proof that it was, and then returned
 * early — so the single most likely way to re-leak (the incident command with
 * one pipe appended) produced no finding at all, while the guard reported the
 * repository clean. Projection is a property of WHAT was selected, never of
 * which tool did the selecting.
 *
 * STATED LIMITS — this is a lint, not a proof. These are NOT covered, and are
 * not claimed to be:
 *   - a read split across lines (a variable holds the URL, a later line reads
 *     it) — neither line carries both halves of the pattern;
 *   - an arbitrary wrapper function with no recognisable endpoint and no
 *     recognisable sink on the line;
 *   - a URL assembled entirely at runtime from values this file cannot see;
 *   - a credential hidden in URL userinfo or a path segment, outside the
 *     Chatwoot read patterns above.
 * The allowlist projection is the real control; this stops the obvious
 * regression from being written down and re-run by the next operator.
 */
export function findUnsafeChatwootReads(file: string, contents: string): Finding[] {
  const findings: Finding[] = []
  const lines = contents.split(/\r?\n/)

  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line === '') return

    // RULE 1 — a credential field is selected and sent to an output sink.
    // Evaluated first and unconditionally: no endpoint match, no projection
    // marker and no prose marker can suppress it. Commented-out code counts,
    // because commented-out code gets uncommented.
    const printed = findPrintedCredential(line)
    if (printed !== null) {
      findings.push({
        file,
        line: index + 1,
        kind: 'forbidden_field_printed',
        reason: `selects and prints the credential field \`${printed}\``,
      })
      return // one finding per line is enough
    }

    // RULE 2 — a credential-bearing endpoint is read with nothing projecting
    // the response. Prose describing the endpoint is exempt so Port records and
    // defect write-ups stay writable.
    if (SENSITIVE_ENDPOINT_RE.test(line) && !PROSE_RE.test(raw) && !isProjectionMarker(line)) {
      findings.push({
        file,
        line: index + 1,
        kind: 'unprojected_chatwoot_read',
        reason:
          'reads a Chatwoot inbox/webhook/agent_bot endpoint without projecting the response through an explicit field allowlist',
      })
    }
  })

  return findings
}

/**
 * Files worth scanning: operational runbooks and the scripts that implement them.
 *
 * `.ps1`/`.psm1` are in the list because PowerShell is the primary shell on the
 * platform this repository is developed on. Omitting them meant a runbook
 * written the most natural way here would never have been read at all.
 */
export function isScannableFile(file: string): boolean {
  return /\.(md|sh|bash|ts|js|mjs|cjs|yml|yaml|ps1|psm1)$/i.test(file)
}

/**
 * This guard and its tests necessarily quote the unsafe commands verbatim — the
 * tests assert that the real leaking commands are caught, which means the real
 * leaking commands appear in the tree. Scanning them would make the guard
 * permanently red for the one reason that is not a defect.
 *
 * Kept to these two exact paths, and tested, so it cannot become a place to
 * park a runbook. Everything else in the repository is scanned.
 */
export const GUARD_OWN_FILES: readonly string[] = [
  'scripts/src/guard-chatwoot-safe-read.ts',
  'scripts/src/guard-chatwoot-safe-read.test.ts',
  'scripts/src/guard-chatwoot-safe-read.integration.test.ts',
]

/**
 * The exact path strings that count as this guard's own files.
 *
 * `git ls-files` is relative to the cwd it runs in, and this guard is invoked
 * both from the repository root and from `scripts/` (pnpm --filter), so each
 * file is registered in both spellings — and ONLY those two. An earlier version
 * matched any path ENDING in the same filename, which quietly excluded
 * `anything/src/guard-chatwoot-safe-read.ts` from the scan. The exclusion now
 * names complete paths, so it cannot be widened by where a file happens to sit.
 */
const GUARD_OWN_FILE_FORMS: ReadonlySet<string> = new Set(
  GUARD_OWN_FILES.flatMap((own) => [own, own.replace(/^scripts\//, '')]),
)

export function isGuardOwnFixtureFile(file: string): boolean {
  const normalised = file.split(path.sep).join('/').replace(/^\.\//, '')
  return GUARD_OWN_FILE_FORMS.has(normalised)
}

function repositoryFiles(cwd: string): string[] {
  const run = (args: readonly string[]): string[] =>
    execFileSync('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f !== '')

  return [...new Set([...run(['ls-files']), ...run(['ls-files', '--others', '--exclude-standard'])])]
}

export function formatHuman(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'guard-chatwoot-safe-read: clean — no unprojected Chatwoot credential reads found.'
  }
  const lines = [
    `guard-chatwoot-safe-read: ${findings.length} unsafe Chatwoot read(s) found.`,
    '',
  ]
  for (const f of findings) {
    lines.push(`  [${f.kind}] ${f.file}:${f.line}`)
    lines.push(`      ${f.reason}`)
  }
  lines.push('')
  lines.push('  Project the response through an explicit allowlist before printing it:')
  lines.push('    projectInbox(raw) / projectAgentBot(raw) from scripts/src/guard-chatwoot-safe-read.ts')
  lines.push("    or, in shell:  ... | jq '{id, name, channel_type, phone_number}'")
  lines.push('  Never delete a credential field after printing the object — that is a denylist.')
  return lines.join('\n')
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const cwd = process.cwd()
  const json = argv.includes('--json')

  let files: string[]
  try {
    files = repositoryFiles(cwd).filter((f) => isScannableFile(f) && !isGuardOwnFixtureFile(f))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`guard-chatwoot-safe-read: could not list repository files: ${message}\n`)
    return 2
  }

  const findings: Finding[] = []
  for (const file of files) {
    let contents: string
    try {
      contents = readFileSync(path.join(cwd, file), 'utf8')
    } catch {
      continue // unreadable or vanished between listing and reading; not this guard's business
    }
    findings.push(...findUnsafeChatwootReads(file, contents))
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ findings, clean: findings.length === 0 }, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatHuman(findings)}\n`)
  }

  return findings.length > 0 ? 1 : 0
}

/**
 * Entry-point gate. Compared as URLs, not as a hand-built `file://` + path
 * string: on Windows `path.resolve` yields `C:\...` while `import.meta.url` is
 * `file:///C:/...`, so the string form never matches and the guard silently does
 * nothing on the platform this repository is developed on.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href

if (invokedDirectly) {
  process.exit(main())
}
