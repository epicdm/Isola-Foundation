/**
 * scripts/publish-gate.ts - the only thing that runs commands. All judgement
 * lives in lib/release/publish-gate.ts, which is pure and tested.
 *
 * Usage:
 *   scripts/check.sh --publish-gate --expected-sha <FULL_SHA> \
 *       [--require-ancestor <FULL_SHA> ...] [--expected-branch <name>]
 *   scripts/check.sh --publish-gate --manifest release-manifest.json
 *
 * It RERUNS the checks rather than trusting a stored result, which the dispatch
 * prefers and which is the only way the result provably belongs to the HEAD being
 * published. HEAD is read before AND after; if it moved, the gate fails rather
 * than attesting a filesystem that no longer exists. In a workspace shared by two
 * agent lanes that is a live condition, not a hypothetical.
 *
 * Exit 0 only on PASS.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import {
  evaluatePublishGate,
  isFullSha,
  migrationFactsFromPorcelain,
  parseReleaseManifest,
  type CheckEvidence,
} from '@/lib/release/publish-gate'

const REPO = '/home/runner/workspace'
const APP = `${REPO}/artifacts/isola`

function git(args: string[]): string {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8' }).trim()
}

function isAncestor(sha: string): boolean {
  try {
    execFileSync('git', ['-C', REPO, 'merge-base', '--is-ancestor', sha, 'HEAD'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function run(command: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(command, args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { ok: true, out }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string }
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

interface Args {
  expectedSha: string
  requireAncestors: string[]
  expectedBranch: string
  manifest: string | null
}

export function parseArgs(argv: string[]): Args {
  const a: Args = { expectedSha: '', requireAncestors: [], expectedBranch: '', manifest: null }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1] ?? ''
    if (flag === '--expected-sha') { a.expectedSha = value.trim(); i += 1 }
    else if (flag === '--require-ancestor') { if (value.trim()) a.requireAncestors.push(value.trim()); i += 1 }
    else if (flag === '--expected-branch') { a.expectedBranch = value.trim(); i += 1 }
    else if (flag === '--manifest') { a.manifest = value.trim(); i += 1 }
  }
  return a
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))

  let expectedSha = args.expectedSha
  let expectedBranch = args.expectedBranch
  let requiredShas = args.requireAncestors

  if (args.manifest) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(args.manifest, 'utf8'))
    } catch (err) {
      console.error(`PUBLISH_GATE=FAIL\n  manifest_unreadable: ${args.manifest}: ${(err as Error).message}`)
      process.exit(1)
    }
    const m = parseReleaseManifest(parsed)
    if (!m.ok) {
      console.error(`PUBLISH_GATE=FAIL\n  manifest_invalid: ${m.why}`)
      process.exit(1)
    }
    // Explicit flags win, so a manifest can be overridden deliberately but never
    // silently weakened - the union of both ancestry sets is required.
    expectedSha = expectedSha || m.manifest.expectedSha
    expectedBranch = expectedBranch || m.manifest.branch
    requiredShas = [...new Set([...requiredShas, ...m.manifest.requiredAncestors])]
  }

  if (!isFullSha(expectedSha)) {
    console.error(
      'PUBLISH_GATE=FAIL\n  expected_sha_not_full: --expected-sha <FULL 40-char SHA> is required ' +
        '(or --manifest). A short SHA is a prefix, and a prefix can match a commit you did not review.',
    )
    process.exit(1)
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  const head = git(['rev-parse', 'HEAD'])
  const porcelain = git(['status', '--porcelain', '--untracked-files=all'])

  // Rerun both checks against this filesystem.
  const tsc = run('./node_modules/.bin/tsc', ['--noEmit', '-p', 'tsconfig.json'])
  const vitest = run('npx', ['vitest', 'run'])

  const headAfterChecks = git(['rev-parse', 'HEAD'])
  const now = new Date().toISOString()

  const summary =
    vitest.out
      .split('\n')
      .filter((l) => /^\s*(Test Files|Tests)\s/.test(l))
      .map((l) => l.trim())
      .join(' ') || (vitest.ok ? 'passed' : 'failed')

  const typecheck: CheckEvidence = {
    ok: tsc.ok,
    sha: head,
    command: 'tsc --noEmit -p tsconfig.json',
    timestamp: now,
    summary: tsc.ok ? 'clean' : tsc.out.split('\n').filter((l) => l.includes('error TS')).slice(0, 3).join(' | '),
  }
  const tests: CheckEvidence = {
    ok: vitest.ok,
    sha: head,
    command: 'vitest run',
    timestamp: now,
    summary,
  }

  const result = evaluatePublishGate({
    branch,
    expectedBranch,
    head,
    headAfterChecks,
    expectedSha,
    porcelain,
    requiredAncestors: requiredShas.map((sha) => ({ sha, isAncestor: isFullSha(sha) ? isAncestor(sha) : false })),
    tests,
    typecheck,
    migrations: migrationFactsFromPorcelain(porcelain),
    now,
  })

  console.log(result.lines.join('\n'))
  process.exit(result.pass ? 0 : 1)
}

// Entry-point gated, following scripts/src/guard-not-prod-db.ts: importing this
// module for a test must never run the gate.
if (process.argv[1] && /publish-gate(\.ts|\.js)?$/.test(process.argv[1])) {
  main()
}
