import { readFileSync, existsSync, readdirSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import dotenv from 'dotenv'
import pg from 'pg'

// pg is CJS-only; under Node ESM it exposes no named exports, so `Pool`
// must come off the default import rather than `import { Pool } from 'pg'`
// (which throws SyntaxError: does not provide an export named 'Pool').
const { Pool } = pg
type Pool = InstanceType<typeof pg.Pool>

// bt-paperclip-board-key-expiry-daily-report-2026-09-13, DB-only half.
// Paperclip is normally reached over its HTTP API — CREDENTIAL-SWEEP-REGISTER
// C-12 is explicit that keys are "minted through the API, not SQL" because
// they are stored hashed. This script does not mint or mutate anything: it
// is a read-only SELECT against Paperclip's own Postgres for a report the
// API has no endpoint for (an estate-wide expiry-window listing). No Docker
// socket, no container exec, per instruction — direct DB connection only.
//
// PAPERCLIP_DATABASE_URL is a new env var name, proposed by this script.
// This repo's own DATABASE_URL (lib/db) points at Foundation's own Neon
// database, not Paperclip's — reusing that name would risk exactly the
// wrong-database class of mistake this register exists to prevent, so a
// distinct, explicit name was chosen deliberately rather than overloading
// the existing one. Confirm the name before wiring a live schedule.

export interface ExpiringBoardKey {
  name: string
  expiresAt: Date
  daysLeft: number
}

const EXPIRY_WINDOW_DAYS = 7

// Caught by independent Codex review at this branch's head: the original
// query had no lower bound, so a key that expired months ago and was never
// revoked would appear at the TOP of an "expiring within 7 days" report
// (most negative days-left sorts first) -- the opposite of the warning
// this report exists to give. `expires_at >= now()` scopes it to genuinely
// upcoming expirations; anything already expired is a separate, already
// urgent problem this report is not the instrument for.
export const EXPIRING_BOARD_KEYS_SQL = `
  SELECT name, expires_at
  FROM board_api_keys
  WHERE revoked_at IS NULL
    AND expires_at >= now()
    AND expires_at < now() + interval '7 days'
  ORDER BY expires_at ASC
`

// Pure: turns a raw expiry timestamp into whole days remaining, rounded up
// so "6.2 days left" reports as 7, not 6 -- the report is meant to warn
// early, not to shave a day off the reader's reaction time.
export function daysLeft(expiresAt: Date, now: Date = new Date()): number {
  const msPerDay = 24 * 60 * 60 * 1000
  return Math.ceil((expiresAt.getTime() - now.getTime()) / msPerDay)
}

// Pure: shapes raw rows into the report's own type, sorted soonest-first.
// Kept separate from the SQL so it is unit-testable without a database.
export function buildExpiryReport(
  rows: { name: string; expiresAt: Date }[],
  now: Date = new Date(),
): ExpiringBoardKey[] {
  return rows
    .map((r) => ({ name: r.name, expiresAt: r.expiresAt, daysLeft: daysLeft(r.expiresAt, now) }))
    .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
}

export function formatExpiryReportLines(rows: ExpiringBoardKey[]): string[] {
  if (rows.length === 0) return ['No board_api_keys rows expire within the next 7 days.']
  return rows.map(
    (r) => `${r.name}\texpires ${r.expiresAt.toISOString()}\t${r.daysLeft} day(s) left`,
  )
}

const REQUIRED_COLUMNS = ['name', 'expires_at', 'revoked_at'] as const

// This repo has no prior direct connection to Paperclip's schema -- every
// other touch point is its HTTP API. Rather than guess column names and
// silently return wrong or empty data (Law 11: a check that fires zero
// proves nothing), introspect the real table first and fail loudly, naming
// exactly what was found, if the assumed shape does not match.
//
// Caught by independent Codex review at this branch's head: an earlier
// version queried information_schema.columns by bare table_name, which
// returns the union of every schema's board_api_keys on the search_path --
// not necessarily the one the unqualified report query below would
// actually resolve to if more than one exists. to_regclass('board_api_keys')
// resolves the name through the SAME search_path Postgres itself uses,
// so the guard inspects the exact relation the report query will read.
export async function assertExpectedSchema(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT a.attname AS column_name
     FROM pg_attribute a
     WHERE a.attrelid = to_regclass('board_api_keys')
       AND a.attnum > 0
       AND NOT a.attisdropped`,
  )
  const found = new Set(rows.map((r) => r.column_name))
  const missing = REQUIRED_COLUMNS.filter((c) => !found.has(c))
  if (missing.length > 0) {
    throw new Error(
      `report-paperclip-key-expiry: board_api_keys is missing expected column(s): ${missing.join(', ')}. ` +
        `Found columns: ${[...found].sort().join(', ') || '(table not found on this connection\'s search_path)'}. ` +
        'Refusing to run a query against an unverified shape.',
    )
  }
}

export async function queryExpiringBoardKeys(pool: Pool): Promise<{ name: string; expiresAt: Date }[]> {
  await assertExpectedSchema(pool)
  const { rows } = await pool.query<{ name: string; expires_at: Date }>(EXPIRING_BOARD_KEYS_SQL)
  return rows.map((r) => ({ name: r.name, expiresAt: r.expires_at }))
}

// ---------------------------------------------------------------------------
// Second check: every model name sent as a literal string anywhere in the
// estate must still appear on its vendor's current pricing page. Seeded
// with DeepSeek, the precedent from this session's own stale-cost-table
// defect (isolav2 PR #136) -- extend VENDOR_MODEL_PATTERNS as other vendors
// are onboarded.

export interface VendorPricingSource {
  vendor: string
  pricingPageUrl: string
  // Matches a literal string this vendor's model names look like, so a
  // scan can attribute a found literal to the page that should list it.
  namePattern: RegExp
}

export const VENDOR_PRICING_SOURCES: VendorPricingSource[] = [
  {
    vendor: 'deepseek',
    pricingPageUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
    namePattern: /^deepseek-[a-z0-9.-]+$/i,
  },
]

// Pure: extracts quoted string literals from source text that match a
// known vendor's model-name shape. Intentionally string-literal-only (not
// "any identifier") -- a model name that only ever appears as a variable
// reference has nothing new to check; the risk this guards against is a
// stale literal baked directly into a request body or a cost table.
export function extractModelLiterals(source: string, patterns: RegExp[]): Set<string> {
  const found = new Set<string>()
  const stringLiteralRe = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"|`([^`\\]*(?:\\.[^`\\]*)*)`/g
  let m: RegExpExecArray | null
  while ((m = stringLiteralRe.exec(source)) !== null) {
    const literal = m[1] ?? m[2] ?? m[3] ?? ''
    if (patterns.some((p) => p.test(literal))) found.add(literal)
  }
  return found
}

const SCAN_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'])
const SCAN_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage'])

// Not pure: walks a repo root on disk collecting model-name literals per
// file, so the report can say WHERE a stale name lives, not just that one
// exists. Depth-first, skips the usual generated/vendor directories.
//
// Caught by independent Codex review at this branch's head: the original
// version used statSync, which follows symlinks -- a symlink inside a
// scanned repo could walk the scan outside the intended root entirely.
// lstatSync reports the link itself, and a symlink (file or directory) is
// skipped rather than followed, so the scan never leaves the given roots.
export function scanEstateForModelLiterals(
  repoRoots: string[],
  patterns: RegExp[] = VENDOR_PRICING_SOURCES.map((v) => v.namePattern),
): Map<string, Set<string>> {
  const byModel = new Map<string, Set<string>>()

  function walk(dir: string) {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SCAN_SKIP_DIRS.has(entry)) continue
      const full = path.join(dir, entry)
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      if (st.isSymbolicLink()) continue
      if (st.isDirectory()) {
        walk(full)
        continue
      }
      if (!st.isFile()) continue
      if (!SCAN_FILE_EXTENSIONS.has(path.extname(entry))) continue
      let text: string
      try {
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      for (const literal of extractModelLiterals(text, patterns)) {
        if (!byModel.has(literal)) byModel.set(literal, new Set())
        byModel.get(literal)!.add(full)
      }
    }
  }

  for (const root of repoRoots) {
    if (existsSync(root)) walk(root)
  }
  return byModel
}

export interface ModelCurrencyFinding {
  model: string
  vendor: string
  files: string[]
  stillListedOnPricingPage: boolean | 'unknown'
}

// Pure given the fetched page text -- kept separate from the network call
// so the matching logic is unit-testable without hitting a real vendor URL.
export function modelListedOnPage(model: string, pageText: string): boolean {
  return pageText.includes(model)
}

export async function checkModelCurrency(
  byModel: Map<string, Set<string>>,
  sources: VendorPricingSource[] = VENDOR_PRICING_SOURCES,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCurrencyFinding[]> {
  const pageTextByVendor = new Map<string, string | 'unavailable'>()
  const findings: ModelCurrencyFinding[] = []

  for (const [model, files] of byModel) {
    const source = sources.find((s) => s.namePattern.test(model))
    if (!source) continue

    if (!pageTextByVendor.has(source.vendor)) {
      try {
        const res = await fetchImpl(source.pricingPageUrl)
        pageTextByVendor.set(source.vendor, res.ok ? await res.text() : 'unavailable')
      } catch {
        pageTextByVendor.set(source.vendor, 'unavailable')
      }
    }

    const pageText = pageTextByVendor.get(source.vendor)!
    findings.push({
      model,
      vendor: source.vendor,
      files: [...files].sort(),
      stillListedOnPricingPage: pageText === 'unavailable' ? 'unknown' : modelListedOnPage(model, pageText),
    })
  }

  return findings.sort((a, b) => a.model.localeCompare(b.model))
}

export function formatModelCurrencyLines(findings: ModelCurrencyFinding[]): string[] {
  if (findings.length === 0) return ['No vendor-pattern model-name literals found in the scanned roots.']
  return findings.map((f) => {
    const status =
      f.stillListedOnPricingPage === 'unknown'
        ? 'UNKNOWN (pricing page unreachable)'
        : f.stillListedOnPricingPage
          ? 'still listed'
          : 'NOT FOUND ON CURRENT PRICING PAGE'
    return `${f.model} (${f.vendor}): ${status} -- ${f.files.length} file(s)`
  })
}

function loadEffectivePaperclipDatabaseUrl(cwd: string): string | undefined {
  const envPath = path.join(cwd, '.env')
  if (existsSync(envPath)) dotenv.config({ path: envPath })
  return process.env.PAPERCLIP_DATABASE_URL
}

async function main() {
  const databaseUrl = loadEffectivePaperclipDatabaseUrl(process.cwd())
  if (!databaseUrl) {
    console.error(
      'report-paperclip-key-expiry: PAPERCLIP_DATABASE_URL is not set. ' +
        'This is a new, proposed env var name -- see the header comment in this file.',
    )
    process.exit(1)
  }

  const pool = new Pool({ connectionString: databaseUrl })
  try {
    const rows = await queryExpiringBoardKeys(pool)
    const report = buildExpiryReport(rows)
    console.log('=== board_api_keys expiring within 7 days ===')
    for (const line of formatExpiryReportLines(report)) console.log(line)
  } finally {
    await pool.end()
  }

  const estateRoots = (process.env.MODEL_CURRENCY_SCAN_ROOTS ?? '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
  if (estateRoots.length === 0) {
    console.log('\n=== model-name currency check ===')
    console.log(
      'MODEL_CURRENCY_SCAN_ROOTS not set -- skipped. Set it to a ' +
        `${path.delimiter}-separated list of repo roots to scan (e.g. the bff-v2 and Isola-Foundation checkouts).`,
    )
    return
  }

  const byModel = scanEstateForModelLiterals(estateRoots)
  const findings = await checkModelCurrency(byModel)
  console.log('\n=== model-name currency check ===')
  for (const line of formatModelCurrencyLines(findings)) console.log(line)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
