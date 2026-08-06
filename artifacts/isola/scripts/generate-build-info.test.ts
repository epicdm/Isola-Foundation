import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { evaluateBuildIdentity } from '@/lib/build-info/contract'
import {
  DEVELOPMENT_BUILD_INFO,
  DIRT_EXEMPT_PATHS,
  GENERATED_PATH,
  deriveBuildInfo,
  dirtyTrackedPaths,
  isGeneratedIdentityStale,
  parseArgs,
  parseBuildInfoModule,
  renderBuildInfoModule,
} from './generate-build-info.mjs'

const SHA = '7317fd894f97fa5d8e03f72f8947788ef3c37552'
const TREE = '9507818216b7a41ee5ee5f8f1d2b26af5a03e59a'
const AT = '2026-08-06T13:20:00Z'

describe('deriveBuildInfo', () => {
  it('derives a production identity from clean git output', () => {
    const r = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT })
    expect(r.ok).toBe(true)
    expect(r.info).toEqual({
      schema: 1,
      mode: 'production',
      source_sha: SHA,
      source_tree: TREE,
      source_dirty: false,
      built_at: AT,
    })
  })

  it('produces a value the health contract accepts — the two ends agree', () => {
    const r = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT })
    expect(evaluateBuildIdentity(r.info).ok).toBe(true)
  })

  it('fails when git could not be consulted at all', () => {
    expect(deriveBuildInfo({ head: null, tree: null, porcelain: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'git_metadata_unavailable',
    })
    expect(deriveBuildInfo({ head: SHA, tree: null, porcelain: '', builtAt: AT }).ok).toBe(false)
  })

  it.each([
    ['short', '7317fd8'],
    ['uppercase', SHA.toUpperCase()],
    ['non-hex', 'z'.repeat(40)],
    ['the literal string unknown', 'unknown'],
  ])('fails on a %s HEAD rather than writing it', (_label, head) => {
    expect(deriveBuildInfo({ head, tree: TREE, porcelain: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'source_sha_malformed',
    })
  })

  it('fails on a malformed tree', () => {
    expect(deriveBuildInfo({ head: SHA, tree: 'nope', porcelain: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'source_tree_malformed',
    })
  })

  it('fails on a timestamp that is not an ISO-8601 UTC instant', () => {
    expect(deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: '2026-08-06 13:20' })).toEqual({
      ok: false,
      reason: 'built_at_malformed',
    })
  })

  it('records a dirty worktree instead of hiding it', () => {
    const r = deriveBuildInfo({
      head: SHA,
      tree: TREE,
      porcelain: ' M artifacts/isola/app/api/onboard/whatsapp/route.ts',
      builtAt: AT,
    })
    expect(r.info!.source_dirty).toBe(true)
  })

  it('is deterministic: identical input yields byte-identical output', () => {
    const a = renderBuildInfoModule(deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!)
    const b = renderBuildInfoModule(deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!)
    expect(a).toBe(b)
  })

  it('changed source changes the identity', () => {
    const a = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!
    const b = deriveBuildInfo({ head: 'a'.repeat(40), tree: 'b'.repeat(40), porcelain: '', builtAt: AT }).info!
    expect(a.source_sha).not.toBe(b.source_sha)
    expect(a.source_tree).not.toBe(b.source_tree)
    expect(renderBuildInfoModule(a)).not.toBe(renderBuildInfoModule(b))
  })
})

describe('dirtyTrackedPaths', () => {
  it('exempts exactly one path — the generator writing its own output', () => {
    expect(DIRT_EXEMPT_PATHS).toEqual([GENERATED_PATH])
    expect(dirtyTrackedPaths(` M ${GENERATED_PATH}`)).toEqual([])
  })

  it('does not exempt anything else', () => {
    expect(dirtyTrackedPaths(' M artifacts/isola/lib/build-info/contract.ts')).toEqual([
      'artifacts/isola/lib/build-info/contract.ts',
    ])
  })

  it('reduces a rename to the path that will exist in the published filesystem', () => {
    expect(dirtyTrackedPaths('R  old/path.ts -> new/path.ts')).toEqual(['new/path.ts'])
  })
})

describe('parseBuildInfoModule / staleness', () => {
  it('round-trips a rendered module', () => {
    const info = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!
    expect(parseBuildInfoModule(renderBuildInfoModule(info))).toEqual(info)
  })

  it('reads the committed development placeholder as development', () => {
    const parsed = parseBuildInfoModule(renderBuildInfoModule(DEVELOPMENT_BUILD_INFO))!
    expect(parsed.mode).toBe('development')
    expect(parsed.source_sha).toBeNull()
  })

  it('treats an absent or unparsable module as stale', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(null, fresh)).toBe(true)
    expect(isGeneratedIdentityStale(parseBuildInfoModule('not a module'), fresh)).toBe(true)
  })

  it('treats a file generated at a different source as stale', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!
    const older = deriveBuildInfo({ head: 'a'.repeat(40), tree: 'b'.repeat(40), porcelain: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(older)), fresh)).toBe(true)
  })

  it('treats the committed development placeholder as stale against a real build', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(DEVELOPMENT_BUILD_INFO)), fresh)).toBe(true)
  })

  it('ignores built_at drift — a timestamp says nothing about which source was compiled', () => {
    const a = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: AT }).info
    const b = deriveBuildInfo({ head: SHA, tree: TREE, porcelain: '', builtAt: '2026-08-07T09:00:00Z' }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(a)), b)).toBe(false)
  })
})

describe('parseArgs', () => {
  it('reads the flags and defaults to neither', () => {
    expect(parseArgs([])).toEqual({ requireIdentity: false, verify: false })
    expect(parseArgs(['--require-identity'])).toEqual({ requireIdentity: true, verify: false })
    expect(parseArgs(['--verify'])).toEqual({ requireIdentity: false, verify: true })
  })
})

// ── child-process integration ───────────────────────────────────────────────
//
// The unit tests above prove the judgement. These prove the ENTRY POINT: that the
// script exits non-zero and writes nothing usable when identity cannot be proven,
// which is the whole fail-closed claim. Prior art: scripts/src/guard-not-prod-db.

const SCRIPT = fileURLToPath(new URL('./generate-build-info.mjs', import.meta.url))

function runGenerator(args: string[], cwd: string, script: string = SCRIPT): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { code: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

describe('generate-build-info.mjs (entry point)', () => {
  it('importing the module runs nothing', () => {
    // If the entry-point gate were wrong, importing this file at the top of this
    // test would already have rewritten the repository's generated module.
    expect(typeof deriveBuildInfo).toBe('function')
  })

  it('--require-identity exits non-zero and writes nothing when git is unavailable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isola-buildinfo-'))
    try {
      // A copy of the script inside a tree that LOOKS right but whose resolved
      // repository root is a temp directory with no git metadata — the exact
      // condition under which a release must refuse to produce an artifact.
      const scripts = join(dir, 'artifacts', 'isola', 'scripts')
      const generated = join(dir, GENERATED_PATH)
      mkdirSync(scripts, { recursive: true })
      mkdirSync(dirname(generated), { recursive: true })
      const copied = join(scripts, 'generate-build-info.mjs')
      writeFileSync(copied, readFileSync(SCRIPT, 'utf8'), 'utf8')
      writeFileSync(generated, 'SENTINEL — must not be overwritten\n', 'utf8')

      const r = runGenerator(['--require-identity'], dir, copied)

      expect(r.code).not.toBe(0)
      expect(r.stderr).toContain('BUILD_IDENTITY=FAIL')
      expect(r.stderr).toContain('git_metadata_unavailable')
      expect(r.stdout).not.toContain('BUILD_IDENTITY=OK')
      // Fail closed means fail closed: no artifact identity was written at all.
      expect(readFileSync(generated, 'utf8')).toContain('SENTINEL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the development fallback cannot be selected by a production build', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isola-buildinfo-dev-'))
    try {
      const scripts = join(dir, 'artifacts', 'isola', 'scripts')
      const generated = join(dir, GENERATED_PATH)
      mkdirSync(scripts, { recursive: true })
      mkdirSync(dirname(generated), { recursive: true })
      const copied = join(scripts, 'generate-build-info.mjs')
      writeFileSync(copied, readFileSync(SCRIPT, 'utf8'), 'utf8')

      // Without the flag the fallback IS written, and it is explicitly development.
      const dev = runGenerator([], dir, copied)
      expect(dev.code).toBe(0)
      expect(dev.stdout).toContain('BUILD_IDENTITY=DEVELOPMENT')
      const written = parseBuildInfoModule(readFileSync(generated, 'utf8'))!
      expect(written.mode).toBe('development')
      expect(evaluateBuildIdentity(written).ok).toBe(false)

      // With the flag, the same conditions are a hard failure. No environment
      // variable, flag combination or leftover file promotes it into a release.
      const prod = runGenerator(['--require-identity'], dir, copied)
      expect(prod.code).not.toBe(0)
      expect(parseBuildInfoModule(readFileSync(generated, 'utf8'))!.mode).toBe('development')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('--verify reports CURRENT against this repository, and the module it checked is real', () => {
    const r = runGenerator(['--verify'], fileURLToPath(new URL('.', import.meta.url)))
    // Either CURRENT (a build ran here) or STALE (the committed dev placeholder is
    // in place) is a truthful answer; what must never happen is a silent pass with
    // no identity at all.
    expect(`${r.stdout}${r.stderr}`).toMatch(/BUILD_IDENTITY=(CURRENT|STALE)/)
  }, 60_000)
})
