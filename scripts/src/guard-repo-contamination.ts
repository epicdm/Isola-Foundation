/**
 * guard-repo-contamination
 *
 * On 2026-07-31 the Replit Agent committed two files directly into the deploy
 * workspace, on the Foundation lane's active branch, and a Republish shipped
 * them before anyone reviewed them:
 *
 *   foundation-lane-2b4fba8.bundle                          (70,413,463 B, Git-LFS)
 *   artifacts/isola/prisma/schema.prisma.backup.1785530798  (already 54 lines stale)
 *
 * Neither was imported, executed or served, so the application was unaffected.
 * The damage was 67 MB of dead weight in a production image, an LFS rule nobody
 * asked for, and a schema fork sitting next to the canonical one where a future
 * edit could pick the wrong file.
 *
 * This guard makes that class of contamination fail BEFORE a commit or build
 * rather than after a deploy. It is intentionally narrow:
 *
 *   - a `*.bundle` file that is not on the allowlist is a finding;
 *   - a `schema.prisma.backup.*` file is always a finding;
 *   - nothing else is inspected, and no file's CONTENTS are ever read.
 *
 * WHAT IT MUST NOT DO, and is tested for:
 *   - it must not flag `context-bundle.ts` / `context-bundle.test.ts`; those are
 *     source files whose NAME contains "bundle" but whose extension is not it;
 *   - it must not flag the canonical `schema.prisma`;
 *   - it must not flag anything under `prisma/migrations/`;
 *   - it must not flag `evidence/stage1/isola-stage1.bundle`, which the
 *     repository has tracked deliberately since before this incident.
 *
 * Scope: the candidate list is supplied by the caller, and `main()` builds it
 * from `git ls-files` plus `git ls-files --others --exclude-standard`. That is
 * tracked files plus untracked-but-not-ignored files — so `node_modules`,
 * `.next` and every other ignored build cache are never walked.
 *
 * Output is filenames and byte sizes only. This guard never prints file
 * contents, and never reads them.
 *
 * Usage:
 *   tsx scripts/src/guard-repo-contamination.ts          # human readable
 *   tsx scripts/src/guard-repo-contamination.ts --json   # machine readable
 *
 * Exit 0 = clean. Exit 1 = contamination found. Exit 2 = the guard itself failed.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * Bundles the repository tracks on purpose. Anything else ending in `.bundle`
 * is a finding. Keep this list short and justified; adding to it should require
 * the same review as adding any other binary to the tree.
 */
export const ALLOWED_BUNDLES: readonly string[] = ['evidence/stage1/isola-stage1.bundle']

/** Advisory only. A bundle is a finding at any size; this just labels the big ones. */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024

export type FindingKind = 'unapproved_bundle' | 'prisma_schema_backup'

export interface Finding {
  readonly kind: FindingKind
  readonly file: string
  readonly bytes: number | null
  readonly reason: string
}

/** Normalise to forward slashes so the rules behave identically on any platform. */
export function normalise(file: string): string {
  return file.split(path.sep).join('/')
}

export function isAllowedBundle(file: string): boolean {
  return ALLOWED_BUNDLES.includes(normalise(file))
}

/**
 * True only for a real `*.bundle` file. `context-bundle.ts` contains the word
 * but does not end in the extension, and must not match.
 */
export function isBundleFile(file: string): boolean {
  return normalise(file).toLowerCase().endsWith('.bundle')
}

/**
 * True for `schema.prisma.backup.<anything>` in any directory.
 *
 * The canonical `schema.prisma` does not match, and neither does a migration
 * under `prisma/migrations/`, because both lack the `.backup.` segment.
 */
export function isPrismaSchemaBackup(file: string): boolean {
  return /(^|\/)schema\.prisma\.backup\..+$/.test(normalise(file))
}

/**
 * Pure evaluation over a candidate list. Sizes are supplied by the caller so
 * this stays testable without touching a filesystem.
 */
export function evaluate(
  files: readonly string[],
  sizeOf: (file: string) => number | null = () => null,
): Finding[] {
  const findings: Finding[] = []

  for (const raw of files) {
    const file = normalise(raw)
    if (file === '') continue

    if (isBundleFile(file) && !isAllowedBundle(file)) {
      const bytes = sizeOf(raw)
      findings.push({
        kind: 'unapproved_bundle',
        file,
        bytes,
        reason:
          bytes !== null && bytes >= LARGE_FILE_BYTES
            ? 'git bundle is not on the allowlist (large)'
            : 'git bundle is not on the allowlist',
      })
      continue
    }

    if (isPrismaSchemaBackup(file)) {
      findings.push({
        kind: 'prisma_schema_backup',
        file,
        bytes: sizeOf(raw),
        reason: 'timestamped Prisma schema backup beside the canonical schema',
      })
    }
  }

  return findings.sort((a, b) => a.file.localeCompare(b.file))
}

export function hasBlockingFindings(findings: readonly Finding[]): boolean {
  return findings.length > 0
}

/** Tracked files plus untracked-but-not-ignored files. Never walks ignored paths. */
export function repositoryFiles(cwd: string = process.cwd()): string[] {
  const run = (args: string[]): string[] =>
    execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')

  const tracked = run(['ls-files'])
  const untracked = run(['ls-files', '--others', '--exclude-standard'])
  return [...new Set([...tracked, ...untracked])]
}

function sizeOnDisk(cwd: string): (file: string) => number | null {
  return (file) => {
    try {
      return statSync(path.join(cwd, file)).size
    } catch {
      return null
    }
  }
}

export function formatHuman(findings: readonly Finding[]): string {
  if (findings.length === 0) {
    return 'guard-repo-contamination: clean — no unapproved bundles, no Prisma schema backups.'
  }
  const lines = [
    `guard-repo-contamination: ${findings.length} finding(s) — refusing to proceed.`,
    '',
  ]
  for (const f of findings) {
    const size = f.bytes === null ? 'size unknown' : `${f.bytes} B`
    lines.push(`  [${f.kind}] ${f.file} (${size})`)
    lines.push(`      ${f.reason}`)
  }
  lines.push('')
  lines.push('  A git bundle or a schema backup does not belong in the tree.')
  lines.push('  Delete the file, or justify it by adding it to ALLOWED_BUNDLES.')
  return lines.join('\n')
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const cwd = process.cwd()
  const json = argv.includes('--json')

  let findings: Finding[]
  try {
    findings = evaluate(repositoryFiles(cwd), sizeOnDisk(cwd))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`guard-repo-contamination: could not list repository files: ${message}\n`)
    return 2
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ findings, clean: findings.length === 0 }, null, 2)}\n`)
  } else {
    process.stdout.write(`${formatHuman(findings)}\n`)
  }

  return hasBlockingFindings(findings) ? 1 : 0
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === `file://${path.resolve(process.argv[1])}`

if (invokedDirectly) {
  process.exit(main())
}
