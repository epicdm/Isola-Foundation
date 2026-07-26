/**
 * guard-cw00-checksum-exception
 *
 * ONE migration in this repository was edited after it had already been applied
 * to production, under a single narrowly-scoped owner exception:
 *
 *   20260725210000_chatwoot_binding_account_inbox_mode_unique
 *
 * The original migration named production's exact rows in hard preconditions.
 * That made it safe to run unattended via `start:prod` — and unreplayable
 * everywhere else, which broke development convergence and migration-only
 * disaster recovery. Repairing it required changing a file whose checksum is
 * already recorded in production's `_prisma_migrations`. Prisma offers no
 * supported way to refresh that checksum: `migrate resolve --applied` on an
 * already-applied migration returns P3008.
 *
 * So production's ledger will read the ORIGINAL checksum forever, while the
 * repository holds the REPAIRED one. That divergence is permanent and
 * deliberate. This guard exists so it stays *exactly* that one divergence:
 *
 *   - it permits ONLY this migration name, and ONLY this exact checksum pair;
 *   - it fails closed if the production checksum is not the recorded original
 *     (someone re-applied or tampered with the ledger row);
 *   - it fails closed if the repository checksum is not the recorded repaired
 *     value (the migration was edited again, without a new owner exception);
 *   - it fails closed on ANY other applied migration whose repository checksum
 *     no longer matches its ledger checksum.
 *
 * WHAT IT DOES NOT DO: it does not silence Prisma. `prisma migrate dev` will
 * continue to report this migration as modified after it was applied, and will
 * offer to reset the development database. That warning is correct and expected
 * for this one migration, and must NOT be suppressed globally — a blanket
 * suppression would hide the next real drift. Decline the reset.
 *
 * Read-only: SELECT against `_prisma_migrations` and sha256 over files on disk.
 * Prints redacted evidence — host and database name only, never a credential.
 *
 * Usage:
 *   tsx scripts/src/guard-cw00-checksum-exception.ts            # uses DATABASE_URL
 *   tsx scripts/src/guard-cw00-checksum-exception.ts --json     # machine-readable
 */

import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Repository root, derived from this file's location (scripts/src/…). */
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../..')
const ISOLA = path.join(REPO_ROOT, 'artifacts', 'isola')
export const MIGRATIONS_DIR = path.join(ISOLA, 'prisma', 'migrations')

/** The single owner-approved exception. Both values are load-bearing. */
export const CW00_EXCEPTION = {
  migrationName: '20260725210000_chatwoot_binding_account_inbox_mode_unique',
  /** sha256 of the migration as APPLIED to production on 2026-07-25T22:21:50Z. */
  productionChecksum: 'a67295d73829ac254daa326e71d2cfb3eaf4660e387115df50cd8d59b64f8882',
  /** sha256 of the REPAIRED migration now in this repository (LF bytes). */
  repairedChecksum: '1b06b3b3f51c0137a66b049bfa27a020fde1e5fc82533ec8360ce46b98558f68',
  approvedOn: '2026-07-26',
  reason:
    'Owner-approved single exception: the migration was made environment-agnostic so development ' +
    'and fresh databases can converge and migration-only disaster recovery works. Production was ' +
    'not re-run and its ledger checksum is unchanged.',
} as const

export interface LedgerRow {
  migration_name: string
  checksum: string
  finished_at: Date | string | null
  rolled_back_at: Date | string | null
}

export interface Finding {
  migrationName: string
  repositoryChecksum: string | null
  ledgerChecksum: string
  status: 'match' | 'match-line-endings' | 'approved-exception' | 'MISMATCH' | 'MISSING-FILE'
  detail?: string
}

const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex')

/**
 * Both renderings of a migration's bytes.
 *
 * Prisma hashes the migration file exactly as it finds it, so a migration
 * applied from a Windows (CRLF) checkout records a different checksum from the
 * same migration applied from a Linux (LF) checkout. That is a line-ending
 * artefact, NOT content drift — and this repository has two real instances of
 * it in production's ledger (`20260720070638_add_notification_outbox`, whose
 * `resolve --applied` row was written from Windows, and
 * `20260722203000_repair_escalation_ref_schema_drift`).
 *
 * Treating those as drift would make this guard cry wolf on every run and get
 * switched off. Matching either rendering still proves the CONTENT is
 * unchanged, which is what the guard is actually asserting.
 */
export function checksumVariants(file: string): { lf: string; crlf: string } {
  const text = readFileSync(file).toString('utf8')
  const lf = text.replace(/\r\n/g, '\n')
  return { lf: sha256(Buffer.from(lf, 'utf8')), crlf: sha256(Buffer.from(lf.replace(/\n/g, '\r\n'), 'utf8')) }
}

/** sha256 of a migration.sql, normalised to LF so Windows checkouts agree with Linux. */
export function checksumMigrationFile(file: string): string {
  return checksumVariants(file).lf
}

export function readRepositoryChecksums(migrationsDir: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const [name, v] of readRepositoryChecksumVariants(migrationsDir)) out.set(name, v.lf)
  return out
}

export function readRepositoryChecksumVariants(
  migrationsDir: string,
): Map<string, { lf: string; crlf: string }> {
  const out = new Map<string, { lf: string; crlf: string }>()
  if (!existsSync(migrationsDir)) return out
  for (const name of readdirSync(migrationsDir)) {
    const dir = path.join(migrationsDir, name)
    if (!statSync(dir).isDirectory()) continue
    const sql = path.join(dir, 'migration.sql')
    if (existsSync(sql)) out.set(name, checksumVariants(sql))
  }
  return out
}

/**
 * Pure decision function. Compares every APPLIED ledger row against the
 * repository, allowing exactly one recorded exception.
 */
export function evaluate(
  ledger: LedgerRow[],
  repo: Map<string, string> | Map<string, { lf: string; crlf: string }>,
): Finding[] {
  const findings: Finding[] = []
  const applied = ledger.filter((r) => r.finished_at !== null && r.rolled_back_at === null)

  for (const row of applied) {
    const entry = repo.get(row.migration_name)
    const variants =
      entry === undefined ? null : typeof entry === 'string' ? { lf: entry, crlf: entry } : entry
    const repoSum = variants?.lf ?? null

    if (variants === null) {
      findings.push({
        migrationName: row.migration_name,
        repositoryChecksum: null,
        ledgerChecksum: row.checksum,
        status: 'MISSING-FILE',
        detail: 'Applied in the database but absent from the repository.',
      })
      continue
    }

    if (variants.lf === row.checksum) {
      findings.push({
        migrationName: row.migration_name,
        repositoryChecksum: repoSum,
        ledgerChecksum: row.checksum,
        status: 'match',
      })
      continue
    }

    if (variants.crlf === row.checksum) {
      findings.push({
        migrationName: row.migration_name,
        repositoryChecksum: repoSum,
        ledgerChecksum: row.checksum,
        status: 'match-line-endings',
        detail:
          'Content is identical; the ledger checksum was computed from a CRLF (Windows) checkout ' +
          'while the repository stores LF. Not drift.',
      })
      continue
    }

    const isException =
      row.migration_name === CW00_EXCEPTION.migrationName &&
      row.checksum === CW00_EXCEPTION.productionChecksum &&
      (variants.lf === CW00_EXCEPTION.repairedChecksum ||
        variants.crlf === CW00_EXCEPTION.repairedChecksum)

    if (isException) {
      findings.push({
        migrationName: row.migration_name,
        repositoryChecksum: repoSum,
        ledgerChecksum: row.checksum,
        status: 'approved-exception',
        detail: `Owner-approved ${CW00_EXCEPTION.approvedOn}. ${CW00_EXCEPTION.reason}`,
      })
      continue
    }

    // Same migration, but one side is not the recorded value.
    let detail = 'Applied migration was modified after application, with no approved exception.'
    if (row.migration_name === CW00_EXCEPTION.migrationName) {
      if (row.checksum !== CW00_EXCEPTION.productionChecksum) {
        detail =
          `The CW00 exception is registered for ledger checksum ${CW00_EXCEPTION.productionChecksum}, ` +
          `but this database reports ${row.checksum}. The ledger row is not the one the exception ` +
          'covers — it may have been re-applied or edited. Refusing.'
      } else {
        detail =
          `The CW00 exception is registered for repository checksum ${CW00_EXCEPTION.repairedChecksum}, ` +
          `but the working tree hashes to ${repoSum}. The migration was edited again after the ` +
          'approved repair. A new owner exception is required. Refusing.'
      }
    }
    findings.push({
      migrationName: row.migration_name,
      repositoryChecksum: repoSum,
      ledgerChecksum: row.checksum,
      status: 'MISMATCH',
      detail,
    })
  }

  return findings
}

export function hasBlockingFindings(findings: Finding[]): boolean {
  return findings.some((f) => f.status === 'MISMATCH' || f.status === 'MISSING-FILE')
}

interface MinimalPrismaClient {
  $queryRawUnsafe: <T>(sql: string) => Promise<T>
  $disconnect: () => Promise<void>
}
type PrismaClientCtor = new (opts: { datasources: { db: { url: string } } }) => MinimalPrismaClient

/**
 * `@prisma/client` is a dependency of `@workspace/isola`, not of
 * `@workspace/scripts`, and a fresh `git worktree` has no node_modules at all.
 * Try the isola package first, then ordinary resolution, and fail with a
 * actionable message rather than a bare MODULE_NOT_FOUND.
 */
export function loadPrismaClient(): { PrismaClient: PrismaClientCtor } {
  const candidates = [path.join(ISOLA, 'package.json'), path.join(REPO_ROOT, 'package.json')]
  for (const base of candidates) {
    if (!existsSync(base)) continue
    try {
      return createRequire(base)('@prisma/client') as { PrismaClient: PrismaClientCtor }
    } catch {
      /* try the next base */
    }
  }
  try {
    return createRequire(import.meta.url)('@prisma/client') as { PrismaClient: PrismaClientCtor }
  } catch {
    throw new Error(
      'guard-cw00-checksum-exception: could not resolve @prisma/client. It is a dependency of ' +
        '@workspace/isola. Run `pnpm install` at the repository root (a fresh `git worktree` has no ' +
        'node_modules of its own).',
    )
  }
}

export function redactedTarget(databaseUrl: string | undefined): string {
  if (!databaseUrl) return '(DATABASE_URL unset)'
  try {
    const u = new URL(databaseUrl)
    return `${u.hostname}/${u.pathname.replace(/^\//, '')}`
  } catch {
    return '(unparseable DATABASE_URL)'
  }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json')
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) {
    console.error('guard-cw00-checksum-exception: DATABASE_URL is not set.')
    process.exit(2)
  }

  const repo = readRepositoryChecksumVariants(MIGRATIONS_DIR)

  const { PrismaClient } = loadPrismaClient()
  const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  let ledger: LedgerRow[]
  try {
    ledger = await prisma.$queryRawUnsafe<LedgerRow[]>(
      'SELECT migration_name, checksum, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at',
    )
  } finally {
    await prisma.$disconnect()
  }

  const findings = evaluate(ledger, repo)
  const blocking = hasBlockingFindings(findings)
  const exception = findings.find((f) => f.status === 'approved-exception')

  if (json) {
    console.log(JSON.stringify({ target: redactedTarget(databaseUrl), findings, blocking }, null, 2))
  } else {
    console.log(`guard-cw00-checksum-exception — target ${redactedTarget(databaseUrl)}`)
    console.log(`  applied migrations checked : ${findings.length}`)
    console.log(`  exact checksum matches     : ${findings.filter((f) => f.status === 'match').length}`)
    const crlf = findings.filter((f) => f.status === 'match-line-endings')
    console.log(`  line-ending-only matches   : ${crlf.length}${crlf.length ? ' (' + crlf.map((f) => f.migrationName).join(', ') + ')' : ''}`)
    console.log(`  approved exception         : ${exception ? 1 : 0}`)
    if (exception) {
      console.log(`    ${exception.migrationName}`)
      console.log(`      ledger (production, unchanged) : ${exception.ledgerChecksum}`)
      console.log(`      repository (repaired)          : ${exception.repositoryChecksum}`)
      console.log(`      NOTE: \`prisma migrate dev\` will report this migration as modified.`)
      console.log(`            That warning is expected for this checksum pair only.`)
    }
    for (const f of findings.filter((x) => x.status === 'MISMATCH' || x.status === 'MISSING-FILE')) {
      console.error(`  ${f.status}: ${f.migrationName}`)
      console.error(`      ledger     : ${f.ledgerChecksum}`)
      console.error(`      repository : ${f.repositoryChecksum ?? '(file absent)'}`)
      console.error(`      ${f.detail}`)
    }
  }

  process.exit(blocking ? 1 : 0)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main()
}
