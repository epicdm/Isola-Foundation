/**
 * publish-gate.test.ts - the gate must fail for every unsafe shape and pass for
 * exactly one safe one.
 *
 * Everything here runs against the PURE evaluator, so no repository is
 * constructed, no command is run, no production system is touched and no real
 * secret exists to leak. The one child-process test invokes the CLI only to prove
 * it refuses without a full reviewed SHA - it exits before running any check.
 */

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEPLOYMENT_RELEVANT_PATTERNS,
  evaluatePublishGate,
  isFullSha,
  migrationFactsFromPorcelain,
  parsePorcelain,
  parseReleaseManifest,
  renderAttestation,
  type PublishGateInput,
} from './publish-gate'

const HEAD = '171442e6d7eb0ee471a5c3c661694e573fa7352b'
const ANCESTOR = 'b8764d7cd5b9968f2aa1b4ce1e0ccdc146dff0c2'
const NOW = '2026-07-30T12:00:00.000Z'

function gate(over: Partial<PublishGateInput> = {}): PublishGateInput {
  return {
    branch: 'design/golden-screens-latest',
    expectedBranch: 'design/golden-screens-latest',
    head: HEAD,
    headAfterChecks: HEAD,
    expectedSha: HEAD,
    porcelain: '',
    requiredAncestors: [{ sha: ANCESTOR, isAncestor: true }],
    tests: { ok: true, sha: HEAD, command: 'vitest run', timestamp: NOW, summary: 'Tests 1405 passed (1405)' },
    typecheck: { ok: true, sha: HEAD, command: 'tsc --noEmit', timestamp: NOW, summary: 'clean' },
    migrations: { unreviewedMigrationPaths: [], schemaChangedWithoutMigration: false },
    now: NOW,
    ...over,
  }
}

function failed(input: PublishGateInput): string[] {
  return evaluatePublishGate(input).failures.map((f) => f.condition)
}

describe('it passes only for a clean, exact, reviewed HEAD', () => {
  it('passes and prints a PASS attestation', () => {
    const r = evaluatePublishGate(gate())
    expect(r.pass).toBe(true)
    expect(r.failures).toEqual([])
    const out = r.lines.join('\n')
    expect(out).toContain('PUBLISH_GATE=PASS')
    expect(out).toContain(HEAD)
    expect(out).toContain('design/golden-screens-latest')
    expect(out).toContain('Tests 1405 passed')
    expect(out).toContain(NOW)
    expect(out).toContain('clean worktree    yes (untracked included)')
  })

  it('never prints PASS when anything failed', () => {
    const r = evaluatePublishGate(gate({ porcelain: '?? stray.ts' }))
    const out = r.lines.join('\n')
    expect(out).toContain('PUBLISH_GATE=FAIL')
    expect(out).not.toContain('PUBLISH_GATE=PASS')
    expect(out).toContain('failed conditions')
  })
})

describe('it fails for a dirty filesystem', () => {
  it('an UNTRACKED file fails — Replit publishes the filesystem, so it would ship unreviewed', () => {
    const c = failed(gate({ porcelain: '?? artifacts/isola/scripts/rebind-staff-manager.ts' }))
    expect(c).toContain('untracked_files_present')
  })

  it('the untracked failure names the files that would ship', () => {
    const r = evaluatePublishGate(gate({ porcelain: '?? a.ts\n?? b.ts' }))
    const f = r.failures.find((x) => x.condition === 'untracked_files_present')
    expect(f?.detail).toContain('a.ts')
    expect(f?.detail).toContain('b.ts')
    expect(f?.detail).toContain('2 untracked')
  })

  it('a MODIFIED tracked file fails', () => {
    expect(failed(gate({ porcelain: ' M artifacts/isola/lib/notify.ts' }))).toContain('tracked_files_modified')
  })

  it('a staged-and-modified file fails', () => {
    expect(failed(gate({ porcelain: 'MM artifacts/isola/lib/notify.ts' }))).toContain('tracked_files_modified')
  })

  it('a deleted tracked file fails', () => {
    expect(failed(gate({ porcelain: ' D artifacts/isola/lib/notify.ts' }))).toContain('tracked_files_modified')
  })
})

describe('it fails for the wrong commit', () => {
  it('a mismatched expected SHA fails', () => {
    const other = 'a'.repeat(40)
    expect(failed(gate({ expectedSha: other }))).toContain('head_is_not_the_reviewed_sha')
  })

  it('a SHORT expected SHA fails — a prefix is not an identity', () => {
    expect(failed(gate({ expectedSha: '171442e' }))).toContain('expected_sha_not_full')
  })

  it('a short SHA that PREFIXES head still fails', () => {
    const c = failed(gate({ expectedSha: HEAD.slice(0, 12) }))
    expect(c).toContain('expected_sha_not_full')
    expect(evaluatePublishGate(gate({ expectedSha: HEAD.slice(0, 12) })).pass).toBe(false)
  })

  it('an uppercase SHA fails rather than being silently normalised', () => {
    expect(failed(gate({ expectedSha: HEAD.toUpperCase() }))).toContain('expected_sha_not_full')
  })

  it('HEAD moving DURING the checks fails', () => {
    const moved = 'c'.repeat(40)
    const c = failed(gate({ headAfterChecks: moved }))
    expect(c).toContain('head_moved_during_checks')
  })

  it('an unexpected branch fails', () => {
    expect(failed(gate({ branch: 'main' }))).toContain('unexpected_branch')
  })
})

describe('it fails for missing intended ancestry', () => {
  it('a required commit that is not an ancestor fails, and is named', () => {
    const missing = 'd'.repeat(40)
    const r = evaluatePublishGate(gate({ requiredAncestors: [{ sha: missing, isAncestor: false }] }))
    expect(r.failures.map((f) => f.condition)).toContain('required_commit_missing')
    expect(r.failures.find((f) => f.condition === 'required_commit_missing')?.detail).toContain(missing)
  })

  it('asserting NO ancestry at all fails — a release must state what it contains', () => {
    expect(failed(gate({ requiredAncestors: [] }))).toContain('no_required_ancestry_asserted')
  })

  it('a short required ancestor fails', () => {
    expect(failed(gate({ requiredAncestors: [{ sha: 'b8764d7', isAncestor: true }] }))).toContain(
      'required_ancestor_not_full_sha',
    )
  })

  it('one missing ancestor among several still fails', () => {
    const c = failed(
      gate({
        requiredAncestors: [
          { sha: ANCESTOR, isAncestor: true },
          { sha: 'e'.repeat(40), isAncestor: false },
        ],
      }),
    )
    expect(c).toContain('required_commit_missing')
  })
})

describe('it fails for checks that did not pass, or belong elsewhere', () => {
  it('failed tests fail the gate', () => {
    const c = failed(gate({ tests: { ok: false, sha: HEAD, command: 'vitest run', timestamp: NOW, summary: '2 failed' } }))
    expect(c).toContain('tests_failed')
  })

  it('failed typecheck fails the gate', () => {
    const c = failed(gate({ typecheck: { ok: false, sha: HEAD, command: 'tsc', timestamp: NOW, summary: 'error TS2352' } }))
    expect(c).toContain('typecheck_failed')
  })

  it('missing evidence fails — absence is not success', () => {
    expect(failed(gate({ tests: null }))).toContain('tests_missing')
    expect(failed(gate({ typecheck: null }))).toContain('typecheck_missing')
  })

  it('a PASSING test result from another HEAD is rejected', () => {
    const stale = 'f'.repeat(40)
    const c = failed(gate({ tests: { ok: true, sha: stale, command: 'vitest run', timestamp: NOW, summary: 'all green' } }))
    expect(c).toContain('test_result_belongs_to_another_head')
  })

  it('a PASSING typecheck from another HEAD is rejected', () => {
    const stale = 'f'.repeat(40)
    const c = failed(gate({ typecheck: { ok: true, sha: stale, command: 'tsc', timestamp: NOW, summary: 'clean' } }))
    expect(c).toContain('typecheck_result_belongs_to_another_head')
  })
})

describe('it fails for migration and deployment-config risk', () => {
  it('a dirty deployment-config file fails and is named separately', () => {
    const r = evaluatePublishGate(gate({ porcelain: ' M artifacts/isola/package.json' }))
    const c = r.failures.map((f) => f.condition)
    expect(c).toContain('deployment_config_not_clean')
  })

  it('a dirty .env fails, and no VALUE is printed — only the path', () => {
    const r = evaluatePublishGate(gate({ porcelain: ' M .env' }))
    const out = r.lines.join('\n')
    expect(r.failures.map((f) => f.condition)).toContain('deployment_config_not_clean')
    expect(out).toContain('.env')
    // The attestation reports paths and statuses; it never reads or echoes
    // contents, so pasting it into Port cannot leak a secret.
    expect(out).not.toMatch(/=[A-Za-z0-9_\-]{16,}/)
  })

  it('recognises every deployment-relevant path shape', () => {
    for (const p of [
      '.env',
      '.env.production',
      'artifacts/isola/.env.local',
      '.replit',
      'replit.nix',
      'artifacts/isola/next.config.js',
      'artifacts/isola/package.json',
      'pnpm-lock.yaml',
      'Dockerfile',
    ]) {
      expect(DEPLOYMENT_RELEVANT_PATTERNS.some((re) => re.test(p))).toBe(true)
    }
    for (const p of ['artifacts/isola/lib/notify.ts', 'README.md', 'docs/env.md']) {
      expect(DEPLOYMENT_RELEVANT_PATTERNS.some((re) => re.test(p))).toBe(false)
    }
  })

  it('an uncommitted migration fails', () => {
    const facts = migrationFactsFromPorcelain('?? artifacts/isola/prisma/migrations/20260730_x/migration.sql')
    expect(facts.unreviewedMigrationPaths).toHaveLength(1)
    expect(failed(gate({ migrations: facts }))).toContain('unreviewed_migration_change')
  })

  it('a changed schema with NO migration fails — a Publish would diff dev against prod and emit DROPs', () => {
    const facts = migrationFactsFromPorcelain(' M artifacts/isola/prisma/schema.prisma')
    expect(facts.schemaChangedWithoutMigration).toBe(true)
    expect(failed(gate({ migrations: facts }))).toContain('schema_changed_without_migration')
  })

  it('a changed schema WITH a migration is not the schema-mismatch failure', () => {
    const facts = migrationFactsFromPorcelain(
      ' M artifacts/isola/prisma/schema.prisma\n?? artifacts/isola/prisma/migrations/20260730_x/migration.sql',
    )
    expect(facts.schemaChangedWithoutMigration).toBe(false)
    expect(facts.unreviewedMigrationPaths).toHaveLength(1)
  })
})

describe('porcelain parsing', () => {
  it('treats a rename as its destination path — that is what ships', () => {
    const e = parsePorcelain('R  old/a.ts -> new/b.ts')
    expect(e).toHaveLength(1)
    expect(e[0].path).toBe('new/b.ts')
    expect(e[0].untracked).toBe(false)
  })

  it('an empty listing is a clean tree', () => {
    expect(parsePorcelain('')).toEqual([])
    expect(parsePorcelain('\n  \n')).toEqual([])
  })

  it('distinguishes untracked from modified', () => {
    const e = parsePorcelain('?? a.ts\n M b.ts')
    expect(e.filter((x) => x.untracked).map((x) => x.path)).toEqual(['a.ts'])
    expect(e.filter((x) => !x.untracked).map((x) => x.path)).toEqual(['b.ts'])
  })
})

describe('isFullSha', () => {
  it('accepts exactly forty lowercase hex characters', () => {
    expect(isFullSha(HEAD)).toBe(true)
    expect(isFullSha('0'.repeat(40))).toBe(true)
  })
  it('rejects everything else', () => {
    for (const v of [HEAD.slice(0, 39), `${HEAD}0`, HEAD.toUpperCase(), 'z'.repeat(40), '', null, undefined, 12345]) {
      expect(isFullSha(v)).toBe(false)
    }
  })
})

describe('the reviewed release manifest', () => {
  it('accepts a complete manifest', () => {
    const r = parseReleaseManifest({
      branch: 'design/golden-screens-latest',
      expectedSha: HEAD,
      requiredAncestors: [ANCESTOR],
    })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.manifest.requiredAncestors).toEqual([ANCESTOR])
  })

  it('refuses a manifest with a short SHA anywhere', () => {
    expect(parseReleaseManifest({ branch: 'b', expectedSha: '171442e', requiredAncestors: [ANCESTOR] }).ok).toBe(false)
    expect(parseReleaseManifest({ branch: 'b', expectedSha: HEAD, requiredAncestors: ['b8764d7'] }).ok).toBe(false)
  })

  it('refuses an empty ancestry — a manifest that proves nothing is worse than none', () => {
    expect(parseReleaseManifest({ branch: 'b', expectedSha: HEAD, requiredAncestors: [] }).ok).toBe(false)
  })

  it('refuses a non-object or a missing branch', () => {
    for (const bad of [null, [], 'x', 42, { expectedSha: HEAD, requiredAncestors: [ANCESTOR] }]) {
      expect(parseReleaseManifest(bad).ok).toBe(false)
    }
  })
})

describe('the attestation reports every failure, not the first', () => {
  it('collects independent failures in one run', () => {
    const c = failed(
      gate({
        branch: 'main',
        expectedSha: 'a'.repeat(40),
        porcelain: '?? stray.ts\n M .env',
        requiredAncestors: [{ sha: 'd'.repeat(40), isAncestor: false }],
        tests: null,
      }),
    )
    expect(c).toContain('unexpected_branch')
    expect(c).toContain('head_is_not_the_reviewed_sha')
    expect(c).toContain('untracked_files_present')
    expect(c).toContain('deployment_config_not_clean')
    expect(c).toContain('required_commit_missing')
    expect(c).toContain('tests_missing')
  })

  it('renderAttestation is a pure function of its inputs', () => {
    const input = gate()
    expect(renderAttestation(input, [])).toEqual(renderAttestation(input, []))
  })
})

describe('the CLI refuses before running anything without a full reviewed SHA', () => {
  it('exits non-zero and says why', () => {
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'publish-gate.ts')
    let code = 0
    let out = ''
    try {
      out = execFileSync('npx', ['tsx', cli, '--expected-sha', '171442e'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: join(dirname(fileURLToPath(import.meta.url)), '..', '..'),
      })
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      code = e.status ?? 1
      out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    expect(code).not.toBe(0)
    expect(out).toContain('PUBLISH_GATE=FAIL')
    expect(out).toContain('expected_sha_not_full')
  }, 60_000)
})
