import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { evaluateBuildIdentity } from '@/lib/build-info/contract'
import {
  BUILD_CONSUMED_ENV_FILES,
  DEPENDENCY_TREE_PATHS,
  DEVELOPMENT_BUILD_INFO,
  DIRT_EXEMPT_PATHS,
  ENV_PROBE_DIRECTORIES,
  PACKAGE_MANAGER_INPUTS,
  GENERATED_PATH,
  PATH_CLASS,
  SNAPSHOT_EXCLUDED_PREFIXES,
  classifySnapshotPath,
  deriveBuildInfo,
  evaluatePackageManagerPin,
  evaluatePreflight,
  dirtyPaths,
  isDirtExempt,
  isGeneratedIdentityStale,
  normalizeSnapshotPath,
  parseArgs,
  parseBuildInfoModule,
  parsePorcelainZ,
  probeEnvFiles,
  renderBuildInfoModule,
  unquotePath,
} from './generate-build-info.mjs'

/** Build `git status --porcelain -z` output: every record is NUL-terminated. */
const z = (...records: string[]) => `${records.map((r) => `${r}\0`).join('')}`

const SHA = '7317fd894f97fa5d8e03f72f8947788ef3c37552'
const TREE = '9507818216b7a41ee5ee5f8f1d2b26af5a03e59a'
const AT = '2026-08-06T13:20:00Z'

describe('deriveBuildInfo', () => {
  it('derives a production identity from clean git output', () => {
    const r = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT })
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
    const r = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT })
    expect(evaluateBuildIdentity(r.info).ok).toBe(true)
  })

  it('fails when git could not be consulted at all', () => {
    expect(deriveBuildInfo({ head: null, tree: null, porcelainZ: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'git_metadata_unavailable',
    })
    expect(deriveBuildInfo({ head: SHA, tree: null, porcelainZ: '', builtAt: AT }).ok).toBe(false)
  })

  it.each([
    ['short', '7317fd8'],
    ['uppercase', SHA.toUpperCase()],
    ['non-hex', 'z'.repeat(40)],
    ['the literal string unknown', 'unknown'],
  ])('fails on a %s HEAD rather than writing it', (_label, head) => {
    expect(deriveBuildInfo({ head, tree: TREE, porcelainZ: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'source_sha_malformed',
    })
  })

  it('fails on a malformed tree', () => {
    expect(deriveBuildInfo({ head: SHA, tree: 'nope', porcelainZ: '', builtAt: AT })).toEqual({
      ok: false,
      reason: 'source_tree_malformed',
    })
  })

  it('fails on a timestamp that is not an ISO-8601 UTC instant', () => {
    expect(deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: '2026-08-06 13:20' })).toEqual({
      ok: false,
      reason: 'built_at_malformed',
    })
  })

  it('records a dirty worktree instead of hiding it', () => {
    const r = deriveBuildInfo({
      head: SHA,
      tree: TREE,
      porcelainZ: z(' M artifacts/isola/app/api/onboard/whatsapp/route.ts'),
      builtAt: AT,
    })
    expect(r.info!.source_dirty).toBe(true)
  })

  it('is deterministic: identical input yields byte-identical output', () => {
    const a = renderBuildInfoModule(deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!)
    const b = renderBuildInfoModule(deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!)
    expect(a).toBe(b)
  })

  it('changed source changes the identity', () => {
    const a = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!
    const b = deriveBuildInfo({ head: 'a'.repeat(40), tree: 'b'.repeat(40), porcelainZ: '', builtAt: AT }).info!
    expect(a.source_sha).not.toBe(b.source_sha)
    expect(a.source_tree).not.toBe(b.source_tree)
    expect(renderBuildInfoModule(a)).not.toBe(renderBuildInfoModule(b))
  })
})

describe('dirt detection — every way a snapshot can differ from HEAD', () => {
  it('a clean committed tree is clean', () => {
    expect(dirtyPaths('')).toEqual([])
    expect(parsePorcelainZ('')).toEqual([])
  })

  it.each([
    ['modified tracked source', ' M artifacts/isola/lib/session.ts', 'artifacts/isola/lib/session.ts'],
    ['staged source', 'M  artifacts/isola/lib/session.ts', 'artifacts/isola/lib/session.ts'],
    ['staged and then modified', 'MM artifacts/isola/lib/session.ts', 'artifacts/isola/lib/session.ts'],
    ['deleted source', ' D artifacts/isola/lib/session.ts', 'artifacts/isola/lib/session.ts'],
    ['staged addition', 'A  artifacts/isola/lib/new.ts', 'artifacts/isola/lib/new.ts'],
    ['unmerged', 'UU artifacts/isola/lib/session.ts', 'artifacts/isola/lib/session.ts'],
    ['untracked source', '?? artifacts/isola/app/api/leak/route.ts', 'artifacts/isola/app/api/leak/route.ts'],
    [
      'deeply nested untracked source',
      '?? artifacts/isola/app/(admin)/deep/nested/again/route.ts',
      'artifacts/isola/app/(admin)/deep/nested/again/route.ts',
    ],
  ])('detects %s', (_label, record, expected) => {
    expect(dirtyPaths(z(record))).toEqual([expected])
  })

  it('detects an untracked filename containing spaces', () => {
    // The whole reason for -z: no quoting, so the path arrives intact and the
    // parser never has to guess where the status field stopped.
    expect(dirtyPaths(z('?? artifacts/isola/lib/my new file.ts'))).toEqual(['artifacts/isola/lib/my new file.ts'])
    expect(dirtyPaths(z('?? artifacts/isola/lib/  leading-spaces.ts'))).toEqual([
      'artifacts/isola/lib/  leading-spaces.ts',
    ])
  })

  it('reports BOTH sides of a rename — the source vanishing is also a change', () => {
    // -z emits the destination record, then the source path as its own record.
    expect(dirtyPaths(z('R  new/path.ts', 'old/path.ts'))).toEqual(['new/path.ts', 'old/path.ts'])
    expect(dirtyPaths(z('C  copy.ts', 'origin.ts'))).toEqual(['copy.ts', 'origin.ts'])
  })

  it('does not mistake a rename source record for the next entry', () => {
    expect(dirtyPaths(z('R  new/path.ts', 'old/path.ts', ' M other.ts'))).toEqual([
      'new/path.ts',
      'old/path.ts',
      'other.ts',
    ])
  })

  it('undoes C-style quoting if it is ever handed non -z output', () => {
    expect(unquotePath('"a file with \\"quotes\\".ts"')).toBe('a file with "quotes".ts')
    expect(unquotePath('"tab\\there.ts"')).toBe('tab\there.ts')
    expect(unquotePath('plain.ts')).toBe('plain.ts')
    expect(dirtyPaths(z('?? "quoted path.ts"'))).toEqual(['quoted path.ts'])
  })

  it('never silently drops a record it cannot parse', () => {
    // A record this parser does not understand is not evidence of a clean tree.
    expect(dirtyPaths(z('xx'))).toEqual(['xx'])
    expect(dirtyPaths(z('??not-a-porcelain-record'))).toEqual(['??not-a-porcelain-record'])
  })

  it('is not fooled by newlines — records are NUL-separated, not line-separated', () => {
    // A filename may legally contain a newline. A line-based parser would read
    // one dirty file as two paths, neither of which exists.
    expect(dirtyPaths(z('?? weird\nname.ts'))).toEqual(['weird\nname.ts'])
  })
})

describe('the generated-file exemption is exactly one exact path', () => {
  it('exempts the generator writing its own output, and only that', () => {
    expect(DIRT_EXEMPT_PATHS).toEqual([GENERATED_PATH])
    expect(dirtyPaths(z(` M ${GENERATED_PATH}`))).toEqual([])
    expect(isDirtExempt(GENERATED_PATH)).toBe(true)
  })

  it.each([
    ['a neighbour in the same directory', 'artifacts/isola/lib/build-info/contract.ts'],
    ['a similarly named file', 'artifacts/isola/lib/build-info/generated.ts.bak'],
    ['a prefix of the exempt path', 'artifacts/isola/lib/build-info/generated.t'],
    ['the containing directory', 'artifacts/isola/lib/build-info'],
    ['a same-named file elsewhere', 'artifacts/api-server/lib/build-info/generated.ts'],
    ['a Windows-separator spelling', 'artifacts\\isola\\lib\\build-info\\generated.ts'],
    ['a traversal spelling', 'artifacts/isola/lib/build-info/../build-info/generated.ts'],
    ['a leading-dot-slash spelling', './artifacts/isola/lib/build-info/generated.ts'],
    ['an absolute spelling', '/artifacts/isola/lib/build-info/generated.ts'],
  ])('does NOT exempt %s', (_label, path) => {
    expect(isDirtExempt(path)).toBe(false)
    expect(dirtyPaths(z(`?? ${path}`))).toEqual([path])
  })

  it('the exemption does not hide a second dirty path alongside it', () => {
    expect(dirtyPaths(z(` M ${GENERATED_PATH}`, '?? artifacts/isola/app/api/leak/route.ts'))).toEqual([
      'artifacts/isola/app/api/leak/route.ts',
    ])
  })

  it('an untracked file whose name merely contains the exempt path is still dirt', () => {
    const sneaky = `${GENERATED_PATH}.orig`
    expect(dirtyPaths(z(`?? ${sneaky}`))).toEqual([sneaky])
  })
})

describe('parseBuildInfoModule / staleness', () => {
  it('round-trips a rendered module', () => {
    const info = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!
    expect(parseBuildInfoModule(renderBuildInfoModule(info))).toEqual(info)
  })

  it('reads the committed development placeholder as development', () => {
    const parsed = parseBuildInfoModule(renderBuildInfoModule(DEVELOPMENT_BUILD_INFO))!
    expect(parsed.mode).toBe('development')
    expect(parsed.source_sha).toBeNull()
  })

  it('treats an absent or unparsable module as stale', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(null, fresh)).toBe(true)
    expect(isGeneratedIdentityStale(parseBuildInfoModule('not a module'), fresh)).toBe(true)
  })

  it('treats a file generated at a different source as stale', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!
    const older = deriveBuildInfo({ head: 'a'.repeat(40), tree: 'b'.repeat(40), porcelainZ: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(older)), fresh)).toBe(true)
  })

  it('treats the committed development placeholder as stale against a real build', () => {
    const fresh = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(DEVELOPMENT_BUILD_INFO)), fresh)).toBe(true)
  })

  it('ignores built_at drift — a timestamp says nothing about which source was compiled', () => {
    const a = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT }).info
    const b = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: '2026-08-07T09:00:00Z' }).info!
    expect(isGeneratedIdentityStale(parseBuildInfoModule(renderBuildInfoModule(a)), b)).toBe(false)
  })
})

describe('parseArgs', () => {
  it('reads the flags and defaults to none of them', () => {
    expect(parseArgs([])).toEqual({ requireIdentity: false, verify: false, preflight: false })
    expect(parseArgs(['--require-identity'])).toEqual({ requireIdentity: true, verify: false, preflight: false })
    expect(parseArgs(['--verify'])).toEqual({ requireIdentity: false, verify: true, preflight: false })
    expect(parseArgs(['--preflight'])).toEqual({ requireIdentity: false, verify: false, preflight: true })
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

// ── the build chain ─────────────────────────────────────────────────────────
//
// The tests above prove the generator's exit code. These prove the CONSEQUENCE
// of that exit code: that `next build` is not reached. `package.json` chains the
// two with `&&`, and the 2026-08-06 review showed that a mechanism which merely
// RECORDS dirt lets the compile and the promotion happen anyway. So the chain is
// executed for real against a real repository, with a stand-in for `next build`
// that records every invocation — reading the shell string proves nothing.

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

/** A real git repository laid out like the monorepo, with one committed source file. */
function makeRepo(gitignore?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'isola-chain-'))
  mkdirSync(join(dir, 'artifacts', 'isola', 'scripts'), { recursive: true })
  mkdirSync(dirname(join(dir, GENERATED_PATH)), { recursive: true })
  writeFileSync(join(dir, 'artifacts', 'isola', 'scripts', 'generate-build-info.mjs'), readFileSync(SCRIPT, 'utf8'))
  writeFileSync(join(dir, GENERATED_PATH), 'export const BUILD_INFO = "placeholder"\n')
  writeFileSync(join(dir, 'artifacts', 'isola', 'source.ts'), 'export const answer = 42\n')
  // The preflight reads the reviewed package-manager pin from the root manifest,
  // so a fixture repository needs one to be a faithful stand-in for the release.
  writeFileSync(
    join(dir, 'package.json'),
    `${JSON.stringify({ name: 'fixture', private: true, packageManager: 'pnpm@10.28.0' }, null, 2)}\n`,
  )
  if (gitignore !== undefined) writeFileSync(join(dir, '.gitignore'), gitignore)
  git(dir, ['init', '-q', '.'])
  git(dir, ['config', 'user.email', 'release@epic.dm'])
  git(dir, ['config', 'user.name', 'release'])
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'base'])
  return dir
}

/**
 * Run the real production chain: generator `&&` a stand-in for `next build` that
 * appends to a log every time it runs. Returns how many times it actually ran.
 */
function runChain(dir: string): { code: number; nextBuildRuns: number; output: string } {
  // The harness lives OUTSIDE the repository under test. Writing the stand-in or
  // its log inside `dir` would make the snapshot dirty by the act of measuring
  // it — which the gate duly caught the first time this test was written.
  const harness = mkdtempSync(join(tmpdir(), 'isola-chain-harness-'))
  const marker = join(harness, 'next-build-invocations.log')
  const fake = join(harness, 'fake-next-build.mjs')
  writeFileSync(fake, `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(marker)}, 'ran\\n')\n`)
  const generator = join(dir, 'artifacts', 'isola', 'scripts', 'generate-build-info.mjs')
  const node = process.execPath
  const result = spawnSync(`"${node}" "${generator}" --require-identity && "${node}" "${fake}"`, {
    cwd: dir,
    shell: true,
    encoding: 'utf8',
  })
  let nextBuildRuns = 0
  try {
    nextBuildRuns = readFileSync(marker, 'utf8').split('\n').filter(Boolean).length
  } catch {
    nextBuildRuns = 0
  }
  rmSync(harness, { recursive: true, force: true })
  return { code: result.status ?? 1, nextBuildRuns, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

describe('the declared production build command', () => {
  // artifact.toml runs `pnpm --filter @workspace/isola run build`, so this string
  // IS the deployment build. If the generator is ever dropped from it, the
  // committed development placeholder ships and /api/health refuses it in
  // production — fail-closed, but silently, and only after a publish.
  const pkg = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { scripts: Record<string, string> }

  it('runs the generator with --require-identity before next build', () => {
    const build = pkg.scripts.build
    expect(build).toContain('generate-build-info.mjs')
    expect(build).toContain('--require-identity')
    expect(build.indexOf('generate-build-info.mjs')).toBeLessThan(build.indexOf('next build'))
    // `&&`, not `;` or `&`: next build must not run when the generator refuses.
    expect(build).toMatch(/generate-build-info\.mjs\s+--require-identity\s*&&\s*next build/)
  })

  it('does not pass a flag that would relax the identity requirement', () => {
    expect(pkg.scripts.build).not.toContain('--allow-dirty')
    expect(pkg.scripts.start).not.toContain('generate-build-info')
    expect(pkg.scripts['start:prod']).not.toContain('generate-build-info')
  })

  it('the development script never claims a production identity', () => {
    expect(pkg.scripts.dev).toContain('generate-build-info.mjs')
    expect(pkg.scripts.dev).not.toContain('--require-identity')
  })
})

describe('production build chain: dirty source never reaches next build', () => {
  it('a clean snapshot builds — the gate is not simply refusing everything', () => {
    const dir = makeRepo()
    try {
      const r = runChain(dir)
      expect(r.output).toContain('BUILD_IDENTITY=OK')
      expect(r.output).toContain('source_dirty=false')
      expect(r.code).toBe(0)
      expect(r.nextBuildRuns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a MODIFIED TRACKED file stops the build before next build', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'artifacts', 'isola', 'source.ts'), 'export const answer = 43\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('BUILD_IDENTITY=FAIL')
      expect(r.output).toContain('source_snapshot_dirty')
      expect(r.output).toContain('artifacts/isola/source.ts')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('an UNTRACKED source file stops the build before next build', () => {
    // The exact hole the 2026-08-06 independent review proved: this used to
    // produce source_dirty=false, the reviewed tree, and a six-host PASS.
    const dir = makeRepo()
    try {
      mkdirSync(join(dir, 'artifacts', 'isola', 'app', 'api', 'leak'), { recursive: true })
      writeFileSync(join(dir, 'artifacts', 'isola', 'app', 'api', 'leak', 'route.ts'), 'export const GET = () => {}\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('source_snapshot_dirty')
      expect(r.output).toContain('artifacts/isola/app/api/leak/route.ts')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('an untracked file whose name contains spaces stops the build', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'artifacts', 'isola', 'a new route.ts'), 'export const GET = () => {}\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('artifacts/isola/a new route.ts')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('a DELETED tracked file stops the build before next build', () => {
    const dir = makeRepo()
    try {
      rmSync(join(dir, 'artifacts', 'isola', 'source.ts'))
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('source_snapshot_dirty')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('unavailable git metadata stops the build before next build', () => {
    const dir = makeRepo()
    try {
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('git_metadata_unavailable')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the generated file being modified is the ONE state that still builds', () => {
    // Every build after the first arrives in this state, because the generator
    // rewrote its own tracked output last time. If this were not exempt the gate
    // would reject every release; if the exemption were any wider it would hide
    // real source. Both halves are asserted here.
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, GENERATED_PATH), 'export const BUILD_INFO = "stale from a previous build"\n')
      const r = runChain(dir)
      expect(r.code).toBe(0)
      expect(r.output).toContain('source_dirty=false')
      expect(r.nextBuildRuns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the generated file plus ANY other dirt stops the build', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, GENERATED_PATH), 'export const BUILD_INFO = "stale"\n')
      writeFileSync(join(dir, 'artifacts', 'isola', 'sneaked-in.ts'), 'export const x = 1\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('artifacts/isola/sneaked-in.ts')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('there is no flag that relaxes --require-identity', () => {
    const dir = makeRepo()
    try {
      writeFileSync(join(dir, 'artifacts', 'isola', 'source.ts'), 'export const answer = 43\n')
      const generator = join(dir, 'artifacts', 'isola', 'scripts', 'generate-build-info.mjs')
      for (const flag of ['--allow-dirty', '--force', '--no-verify', '--skip-dirty-check']) {
        const r = runGenerator(['--require-identity', flag], dir, generator)
        expect(r.code, `${flag} must not relax the gate`).not.toBe(0)
        expect(`${r.stdout}${r.stderr}`).toContain('source_snapshot_dirty')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── The snapshot contract ───────────────────────────────────────────────────
//
// `.gitignore` describes what this repository TRACKS. Replit uploads the
// workspace FILESYSTEM. Treating the first as the second is what let an
// unreviewed `/dist` route compile into the artifact at head a896651 with
// source_dirty=false and the reviewed tree.
// dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06.

/** The repository's real ignore rules, so these tests cannot drift from it. */
const REAL_GITIGNORE = readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8')

describe('normalizeSnapshotPath — exactly one spelling may reach a comparison', () => {
  it('accepts a plain repository-relative path unchanged', () => {
    expect(normalizeSnapshotPath('artifacts/isola/app/page.tsx')).toBe('artifacts/isola/app/page.tsx')
  })

  it('strips the ONE trailing slash git puts on a collapsed ignored directory', () => {
    expect(normalizeSnapshotPath('node_modules/')).toBe('node_modules')
    expect(normalizeSnapshotPath('artifacts/isola/.next/')).toBe('artifacts/isola/.next')
  })

  it('refuses every spelling that did not come from git, rather than repairing it', () => {
    for (const bad of [
      '',
      '/',
      '//',
      '/artifacts/isola',
      'artifacts//isola',
      'artifacts\\isola\\app',
      './artifacts/isola',
      'artifacts/./isola',
      'artifacts/../artifacts/isola',
      '..',
      'C:/artifacts/isola',
    ]) {
      expect({ bad, got: normalizeSnapshotPath(bad) }).toEqual({ bad, got: null })
    }
    expect(normalizeSnapshotPath(undefined as unknown as string)).toBeNull()
    expect(normalizeSnapshotPath(42 as unknown as string)).toBeNull()
  })

  it('an unnormalisable path is DIRT, never quietly dropped', () => {
    const c = classifySnapshotPath('artifacts\\isola\\app\\page.tsx')
    expect(c.class).toBe(PATH_CLASS.dirty)
    expect(c.reason).toContain('unnormalisable')
  })
})

describe('classifySnapshotPath — every path lands in exactly one class', () => {
  it('class 2: the generator output, at its exact path only', () => {
    expect(classifySnapshotPath(GENERATED_PATH).class).toBe(PATH_CLASS.generatedExempt)
    expect(classifySnapshotPath(`${GENERATED_PATH}.bak`).class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/isola/lib/build-info').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/isola/lib/build-info/other.ts').class).toBe(PATH_CLASS.dirty)
  })

  it('class 3: paths .replitignore keeps out of the snapshot', () => {
    for (const prefix of SNAPSHOT_EXCLUDED_PREFIXES) {
      expect(classifySnapshotPath(prefix).class).toBe(PATH_CLASS.snapshotExcluded)
      expect(classifySnapshotPath(`${prefix}/`).class).toBe(PATH_CLASS.snapshotExcluded)
      expect(classifySnapshotPath(`${prefix}/deep/inside.js`).class).toBe(PATH_CLASS.snapshotExcluded)
    }
  })

  it('class 3 matches whole segments only — a lookalike neighbour is dirt', () => {
    expect(classifySnapshotPath('artifacts/isola/.next-evil/page.js').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/isola/.nextfoo').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('evil/artifacts/isola/.next/x').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/api-server/dist-evil').class).toBe(PATH_CLASS.dirty)
  })

  it('class 4: dependency trees at exact workspace locations, and NOWHERE else', () => {
    for (const p of DEPENDENCY_TREE_PATHS) {
      expect(classifySnapshotPath(`${p}/`).class).toBe(PATH_CLASS.dependencyTree)
      expect(classifySnapshotPath(`${p}/next/dist/index.js`).class).toBe(PATH_CLASS.dependencyTree)
    }
    // A node_modules the workspace does not declare is a review event, not an
    // exemption — the class is a list of exact locations, not a directory name.
    expect(classifySnapshotPath('artifacts/isola/app/node_modules/evil.ts').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('packages/new-thing/node_modules').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('node_modules_evil').class).toBe(PATH_CLASS.dirty)
  })

  it('the class-4 list is exactly one entry per pnpm workspace package, plus the root', () => {
    // Pinned against the real workspace so a new package cannot silently inherit
    // an exemption, and a removed one cannot leave a stale prefix behind.
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const manifests = [
      '',
      'artifacts/api-server',
      'artifacts/isola',
      'artifacts/mockup-sandbox',
      'lib/api-client-react',
      'lib/api-spec',
      'lib/api-zod',
      'lib/db',
      'scripts',
    ]
    for (const dir of manifests) {
      expect({ dir, hasManifest: existsSync(join(root, dir, 'package.json')) }).toEqual({ dir, hasManifest: true })
    }
    expect([...DEPENDENCY_TREE_PATHS].sort()).toEqual(
      manifests.map((d) => (d === '' ? 'node_modules' : `${d}/node_modules`)).sort(),
    )
  })

  it('class 5: anything the contract does not name', () => {
    expect(classifySnapshotPath('artifacts/isola/app/dist/page.tsx').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/isola/app/build/page.tsx').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('some/thing/nobody/thought/about').class).toBe(PATH_CLASS.dirty)
  })

  it('tsbuildinfo is forgiven at the two exact paths .replitignore names, and nowhere else', () => {
    expect(classifySnapshotPath('artifacts/isola/tsconfig.tsbuildinfo').class).toBe(PATH_CLASS.snapshotExcluded)
    expect(classifySnapshotPath('scripts/tsconfig.tsbuildinfo').class).toBe(PATH_CLASS.snapshotExcluded)
    // A glob would have forgiven these too. Exact paths do not.
    expect(classifySnapshotPath('lib/db/tsconfig.tsbuildinfo').class).toBe(PATH_CLASS.dirty)
    expect(classifySnapshotPath('artifacts/isola/app/tsconfig.tsbuildinfo').class).toBe(PATH_CLASS.dirty)
  })
})

describe('build-consumed environment files are never exemptable', () => {
  it('the list is pinned to the files Next.js actually loads', () => {
    // Pinned as a LITERAL, not derived from the constant under test. Every other
    // assertion here iterates BUILD_CONSUMED_ENV_FILES, so deleting an entry
    // would otherwise delete its own coverage and pass — a negative control
    // caught exactly that. Next.js loads `.env.${mode}.local`, `.env.local`,
    // `.env.${mode}` and `.env` (packages/next-env), for mode in
    // development | production | test.
    expect([...BUILD_CONSUMED_ENV_FILES].sort()).toEqual(
      [
        '.env',
        '.env.local',
        '.env.development',
        '.env.development.local',
        '.env.production',
        '.env.production.local',
        '.env.test',
        '.env.test.local',
      ].sort(),
    )
  })

  it('the probe covers the repository root and every workspace package', () => {
    expect([...ENV_PROBE_DIRECTORIES].sort()).toEqual(
      [
        '',
        'artifacts/api-server',
        'artifacts/isola',
        'artifacts/mockup-sandbox',
        'lib/api-client-react',
        'lib/api-spec',
        'lib/api-zod',
        'lib/db',
        'scripts',
      ].sort(),
    )
  })

  it('every filename the framework loads at build time is dirt, at any location', () => {
    for (const name of BUILD_CONSUMED_ENV_FILES) {
      for (const dir of ['', 'artifacts/isola/', 'lib/db/', 'deeply/nested/']) {
        const p = `${dir}${name}`
        const c = classifySnapshotPath(p)
        expect({ p, class: c.class }).toEqual({ p, class: PATH_CLASS.dirty })
        expect(c.reason).toContain('environment file')
      }
    }
  })

  it('the environment test runs BEFORE any exemption, so no prefix can shelter one', () => {
    // Inside a class-3 prefix and inside a class-4 prefix: still dirt.
    expect(classifySnapshotPath(`${SNAPSHOT_EXCLUDED_PREFIXES[0]}/${BUILD_CONSUMED_ENV_FILES[0]}`).class).toBe(
      PATH_CLASS.dirty,
    )
    expect(classifySnapshotPath(`node_modules/${BUILD_CONSUMED_ENV_FILES[1]}`).class).toBe(PATH_CLASS.dirty)
  })

  it('the example template is not treated as a build-consumed environment file', () => {
    // It is TRACKED (`.gitignore` negates it), so git never reports it and it is
    // never classified at all. What matters is that it is not on the list: if it
    // ever did show up it would be ordinary unaccounted-for dirt, not a special
    // "environment file" refusal naming a file the framework does not even read.
    expect(BUILD_CONSUMED_ENV_FILES).not.toContain('.env.example')
    expect(classifySnapshotPath('.env.example').reason).not.toContain('environment file')
  })

  it('probeEnvFiles reports paths and never opens a file', () => {
    const seen: string[] = []
    const target = join('artifacts', 'isola', BUILD_CONSUMED_ENV_FILES[1])
    const found = probeEnvFiles('/repo', (p: string) => {
      seen.push(p)
      return p.endsWith(target)
    })
    expect(found).toEqual([`artifacts/isola/${BUILD_CONSUMED_ENV_FILES[1]}`])
    expect(seen.length).toBe(ENV_PROBE_DIRECTORIES.length * BUILD_CONSUMED_ENV_FILES.length)
  })

  it('a probed environment file makes the identity dirty even if git never mentions it', () => {
    const probed = BUILD_CONSUMED_ENV_FILES[5]
    const d = deriveBuildInfo({ head: SHA, tree: TREE, porcelainZ: '', builtAt: AT, envFiles: [probed] })
    expect(d.ok).toBe(true)
    expect(d.info!.source_dirty).toBe(true)
    expect(d.dirty!).toContain(probed)
  })

  it('does not double-report a file git already named', () => {
    const probed = BUILD_CONSUMED_ENV_FILES[1]
    const d = deriveBuildInfo({
      head: SHA,
      tree: TREE,
      porcelainZ: z(`!! ${probed}`),
      builtAt: AT,
      envFiles: [probed],
    })
    expect(d.dirty!.filter((p: string) => p === probed)).toHaveLength(1)
  })
})

describe('ignored entries reach the identity decision at all', () => {
  it('the generator asks git for ignored entries', () => {
    const source = readFileSync(SCRIPT, 'utf8')
    expect(source).toContain("'--ignored=matching'")
    expect(source).toContain("'--untracked-files=all'")
    expect(source).toContain("'-z'")
  })

  it('an ignored record is parsed and classified like any other', () => {
    expect(parsePorcelainZ(z('!! artifacts/isola/app/dist/'))).toEqual(['artifacts/isola/app/dist/'])
    expect(dirtyPaths(z('!! artifacts/isola/app/dist/'))).toEqual(['artifacts/isola/app/dist'])
  })

  it('the accounted-for classes do not make the snapshot dirty', () => {
    const d = deriveBuildInfo({
      head: SHA,
      tree: TREE,
      builtAt: AT,
      porcelainZ: z(
        `!! ${SNAPSHOT_EXCLUDED_PREFIXES[0]}/`,
        '!! node_modules/',
        '!! artifacts/isola/node_modules/',
        ` M ${GENERATED_PATH}`,
      ),
    })
    expect(d.info!.source_dirty).toBe(false)
    expect(d.dirty!).toEqual([])
  })
})

describe('production build chain: IGNORED build inputs never reach next build', () => {
  const cases: Array<[string, string, string]> = [
    ['ignored application source under a bare `dist` rule', 'artifacts/isola/app/dist/page.tsx', 'dist'],
    ['ignored application source under a bare `build` rule', 'artifacts/isola/app/build/page.tsx', 'build'],
    ['ignored nested application source', 'artifacts/isola/lib/tmp/deep/helper.ts', 'tmp'],
    ['ignored route/page source', 'artifacts/isola/app/dist/api/route.ts', 'dist'],
    ['ignored path containing spaces', 'artifacts/isola/dist/a new file.ts', 'dist'],
    ['ignored non-ASCII path', 'artifacts/isola/dist/café-ñ.ts', 'dist'],
    ['ignored generated output NOT excluded by .replitignore', 'artifacts/isola/out-tsc/thing.js', 'out-tsc'],
  ]

  for (const [name, path, rule] of cases) {
    it(`${name} stops the build before next build`, () => {
      const dir = makeRepo(`${rule}\n`)
      try {
        const full = join(dir, ...path.split('/'))
        mkdirSync(dirname(full), { recursive: true })
        writeFileSync(full, 'export const value = 1\n')
        // The file really is invisible to the OLD check — that is the whole point.
        const oldView = execFileSync('git', ['-C', dir, 'status', '--porcelain', '-z', '--untracked-files=all'], {
          encoding: 'utf8',
        })
        expect(oldView).not.toContain(path.split('/').pop())

        const r = runChain(dir)
        expect(r.code).not.toBe(0)
        expect(r.output).toContain('BUILD_IDENTITY=FAIL')
        expect(r.nextBuildRuns).toBe(0)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 60_000)
  }

  for (const name of BUILD_CONSUMED_ENV_FILES) {
    for (const [label, dir] of [['at the repository root', ''], ['nested in the application', 'artifacts/isola/']]) {
      it(`an ignored ${name} ${label} stops the build`, () => {
        const repo = makeRepo('.env*\n')
        try {
          const rel = `${dir}${name}`
          const full = join(repo, ...rel.split('/'))
          mkdirSync(dirname(full), { recursive: true })
          writeFileSync(full, 'NEXT_PUBLIC_API=https://attacker.example\n')
          const r = runChain(repo)
          expect(r.code).not.toBe(0)
          expect(r.output).toContain('workspace_environment_file_present')
          expect(r.output).toContain(rel)
          // Paths only. The VALUE must never reach a build log.
          expect(r.output).not.toContain('attacker.example')
          expect(r.nextBuildRuns).toBe(0)
        } finally {
          rmSync(repo, { recursive: true, force: true })
        }
      }, 60_000)
    }
  }

  it('ignored generated output that IS excluded by .replitignore still builds', () => {
    const dir = makeRepo('artifacts/isola/.next/\n')
    try {
      mkdirSync(join(dir, 'artifacts', 'isola', '.next'), { recursive: true })
      writeFileSync(join(dir, 'artifacts', 'isola', '.next', 'BUILD_ID'), 'previous\n')
      const r = runChain(dir)
      expect(r.output).toContain('BUILD_IDENTITY=OK')
      expect(r.output).toContain('source_dirty=false')
      expect(r.nextBuildRuns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('an ignored dependency tree at a declared location still builds', () => {
    const dir = makeRepo('node_modules\n')
    try {
      mkdirSync(join(dir, 'node_modules', 'next'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'next', 'index.js'), 'module.exports = {}\n')
      const r = runChain(dir)
      expect(r.output).toContain('BUILD_IDENTITY=OK')
      expect(r.nextBuildRuns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('the generated file plus an IGNORED source file stops the build', () => {
    const dir = makeRepo('dist\n')
    try {
      writeFileSync(join(dir, GENERATED_PATH), 'export const BUILD_INFO = "regenerated"\n')
      mkdirSync(join(dir, 'artifacts', 'isola', 'dist'), { recursive: true })
      writeFileSync(join(dir, 'artifacts', 'isola', 'dist', 'page.tsx'), 'export default () => null\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('artifacts/isola/dist')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('clean tracked source still reaches next build exactly once under the REAL ignore rules', () => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      const r = runChain(dir)
      expect(r.output).toContain('BUILD_IDENTITY=OK')
      expect(r.output).toContain('source_dirty=false')
      expect(r.nextBuildRuns).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it("the reviewer's exact bypass — app/dist/page.tsx under the REAL .gitignore — is closed", () => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      mkdirSync(join(dir, 'artifacts', 'isola', 'app', 'dist'), { recursive: true })
      writeFileSync(join(dir, 'artifacts', 'isola', 'app', 'dist', 'page.tsx'), 'export default () => null\n')
      const r = runChain(dir)
      expect(r.code).not.toBe(0)
      expect(r.output).toContain('artifacts/isola/app/dist')
      expect(r.nextBuildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})

// ── The deterministic dependency chain ──────────────────────────────────────
//
// Replit describes a publish as "a snapshot of your app's files AND
// DEPENDENCIES", so an installed tree ships unless excluded — and a shipped tree
// is unreviewed code that next build compiles against. The reviewed lockfile
// describes what SHOULD be installed, not what IS.
// dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06 keeps the
// tree out of the snapshot and rebuilds it from reviewed inputs, frozen:
//
//   preflight -> pnpm install --frozen-lockfile -> generate-build-info -> next build

describe('evaluatePackageManagerPin', () => {
  it('accepts the reviewed pin when the running major matches', () => {
    expect(evaluatePackageManagerPin('pnpm@10.28.0', '10.28.0').ok).toBe(true)
    // Minor/patch drift installs the same tree from a frozen lockfile, so the
    // gate must not depend on the deployment image's exact pnpm build.
    expect(evaluatePackageManagerPin('pnpm@10.28.0', '10.4.1').ok).toBe(true)
  })

  it('refuses a MAJOR mismatch — that is what changes lockfile semantics', () => {
    const r = evaluatePackageManagerPin('pnpm@10.28.0', '9.15.0')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('pinned pnpm 10.x')
  })

  it('refuses a missing, malformed or foreign pin, and an unknown running version', () => {
    expect(evaluatePackageManagerPin(null, '10.28.0').ok).toBe(false)
    expect(evaluatePackageManagerPin('', '10.28.0').ok).toBe(false)
    expect(evaluatePackageManagerPin('pnpm', '10.28.0').ok).toBe(false)
    expect(evaluatePackageManagerPin('pnpm@latest', '10.28.0').ok).toBe(false)
    expect(evaluatePackageManagerPin('yarn@4.0.0', '10.28.0').ok).toBe(false)
    expect(evaluatePackageManagerPin('pnpm@10.28.0', null).ok).toBe(false)
    expect(evaluatePackageManagerPin('pnpm@10.28.0', 'not-a-version').ok).toBe(false)
  })

  it('the repository really does declare the pin the chain asserts', () => {
    const root = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../package.json', import.meta.url)), 'utf8'),
    ) as { packageManager?: string }
    expect(root.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/)
  })
})

describe('evaluatePreflight — what may run before pnpm install', () => {
  it('a clean snapshot passes', () => {
    expect(evaluatePreflight('').ok).toBe(true)
  })

  it('dependency trees are QUARANTINE, not dirt — they are excluded and about to be rebuilt', () => {
    const r = evaluatePreflight(z('!! node_modules/', '!! artifacts/isola/node_modules/'))
    expect(r.ok).toBe(true)
    expect(r.quarantine.map((e: { path: string }) => e.path)).toEqual(['node_modules', 'artifacts/isola/node_modules'])
    expect(r.blocking).toEqual([])
  })

  it('a malicious file inside a workspace dependency tree is quarantine, never a build input', () => {
    // It cannot reach the artifact: the tree is excluded from the snapshot and
    // the frozen install replaces it before anything is compiled.
    const r = evaluatePreflight(z('!! node_modules/', '!! artifacts/isola/node_modules/'))
    expect(r.ok).toBe(true)
  })

  it('a dependency tree at an UNDECLARED location blocks', () => {
    const r = evaluatePreflight(z('!! artifacts/isola/app/node_modules/'))
    expect(r.ok).toBe(false)
    expect(r.blocking.map((e: { path: string }) => e.path)).toEqual(['artifacts/isola/app/node_modules'])
  })

  it.each([
    ['untracked .npmrc in a package', '?? artifacts/isola/.npmrc'],
    ['ignored .npmrc', '!! .npmrc'],
    ['modified root .npmrc', ' M .npmrc'],
    ['modified lockfile', ' M pnpm-lock.yaml'],
    ['modified workspace definition', ' M pnpm-workspace.yaml'],
    ['modified root manifest', ' M package.json'],
    ['modified application manifest', ' M artifacts/isola/package.json'],
    ['untracked .pnpmfile.cjs', '?? .pnpmfile.cjs'],
    ['untracked pnpmfile.js in a package', '?? lib/db/pnpmfile.js'],
    ['untracked .yarnrc.yml', '?? .yarnrc.yml'],
  ])('%s blocks, and is named as a package-manager input', (_label, record) => {
    const r = evaluatePreflight(z(record))
    expect(r.ok).toBe(false)
    expect(r.packageConfig.length).toBeGreaterThan(0)
  })

  it('the package-manager input list is exactly the tracked configuration', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    for (const p of PACKAGE_MANAGER_INPUTS) {
      expect({ p, exists: existsSync(join(root, p)) }).toEqual({ p, exists: true })
    }
  })

  it('ignored source still blocks the install, not just the build', () => {
    const r = evaluatePreflight(z('!! artifacts/isola/app/dist/'))
    expect(r.ok).toBe(false)
  })

  it('a build-consumed environment file blocks before install', () => {
    expect(evaluatePreflight('', [BUILD_CONSUMED_ENV_FILES[1]]).ok).toBe(false)
    expect(evaluatePreflight(z(`!! ${BUILD_CONSUMED_ENV_FILES[0]}`)).ok).toBe(false)
  })

  it('the generated build-info file alone does not block installation', () => {
    expect(evaluatePreflight(z(` M ${GENERATED_PATH}`)).ok).toBe(true)
  })
})

describe('the canonical production build chain', () => {
  const pkg = (rel: string) =>
    JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')) as {
      scripts: Record<string, string>
    }

  it('isola: preflight, then frozen install, then generator, then next build — in that order', () => {
    const build = pkg('../package.json').scripts.build
    const order = ['--preflight', 'pnpm install --frozen-lockfile', '--require-identity', 'next build']
    let at = -1
    for (const step of order) {
      const i = build.indexOf(step)
      expect({ step, found: i >= 0 }).toEqual({ step, found: true })
      expect({ step, afterPrevious: i > at }).toEqual({ step, afterPrevious: true })
      at = i
    }
    // `&&` throughout: no stage may run after an earlier one failed. Strip the
    // legitimate `&&` first, then no shell separator may remain — `;` would run
    // the next stage regardless, and a single `&` would background it.
    expect(build.replace(/&&/g, '')).not.toMatch(/[;&|]/)
  })

  it('api-server: the other artifact build also preflights and installs frozen', () => {
    const build = pkg('../../api-server/package.json').scripts.build
    expect(build).toContain('--preflight')
    expect(build).toContain('pnpm install --frozen-lockfile')
    expect(build.indexOf('--preflight')).toBeLessThan(build.indexOf('pnpm install'))
    expect(build.indexOf('pnpm install')).toBeLessThan(build.indexOf('build.mjs'))
  })

  it('the install is frozen everywhere it appears — never a lockfile-updating install', () => {
    for (const rel of ['../package.json', '../../api-server/package.json']) {
      const scripts = pkg(rel).scripts
      for (const [name, body] of Object.entries(scripts)) {
        if (!body.includes('pnpm install')) continue
        expect({ rel, name, frozen: body.includes('pnpm install --frozen-lockfile') }).toEqual({
          rel,
          name,
          frozen: true,
        })
        expect(body).not.toContain('--no-frozen-lockfile')
        expect(body).not.toContain('--fix-lockfile')
        expect(body).not.toContain('--lockfile-only')
      }
    }
  })

  it('no artifact declares a build command that reaches a compiler another way', () => {
    // artifact.toml is the deployment build. If it ever called anything other
    // than the package script above, the whole chain would be bypassable.
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const isola = readFileSync(join(root, 'artifacts/isola/.replit-artifact/artifact.toml'), 'utf8')
    const api = readFileSync(join(root, 'artifacts/api-server/.replit-artifact/artifact.toml'), 'utf8')
    expect(isola).toContain('"pnpm", "--filter", "@workspace/isola", "run", "build"')
    expect(api).toContain('"pnpm", "--filter", "@workspace/api-server", "run", "build"')
    expect(isola).not.toContain('next build')
    expect(api).not.toContain('next build')
  })
})

/**
 * Run the real four-stage chain with observable stand-ins for install and build.
 *
 * The stand-ins live OUTSIDE the repository under test — writing them inside
 * would dirty the snapshot by the act of measuring it, which the gate duly
 * catches.
 */
function runDependencyChain(
  dir: string,
  opts: { installFails?: boolean } = {},
): { code: number; preflightRuns: number; installRuns: number; generatorRuns: number; buildRuns: number; output: string } {
  const harness = mkdtempSync(join(tmpdir(), 'isola-dep-harness-'))
  const log = join(harness, 'stages.log')
  const stage = (name: string, exitCode = 0) => {
    const p = join(harness, `${name}.mjs`)
    writeFileSync(
      p,
      `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(log)}, '${name}\\n')\nprocess.exit(${exitCode})\n`,
    )
    return p
  }
  const fakeInstall = stage('install', opts.installFails ? 1 : 0)
  const fakeBuild = stage('build')
  const generator = join(dir, 'artifacts', 'isola', 'scripts', 'generate-build-info.mjs')
  const node = process.execPath
  writeFileSync(log, '')
  const cmd = [
    `"${node}" "${generator}" --preflight`,
    `"${node}" "${fakeInstall}"`,
    `"${node}" "${generator}" --require-identity`,
    `"${node}" "${fakeBuild}"`,
  ].join(' && ')
  const result = spawnSync(cmd, { cwd: dir, shell: true, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean)
  rmSync(harness, { recursive: true, force: true })
  return {
    code: result.status ?? 1,
    preflightRuns: (output.match(/BUILD_PREFLIGHT=/g) ?? []).length,
    installRuns: lines.filter((l) => l === 'install').length,
    generatorRuns: (output.match(/BUILD_IDENTITY=/g) ?? []).length,
    buildRuns: lines.filter((l) => l === 'build').length,
    output,
  }
}

describe('dependency chain: invocation counts', () => {
  it('a clean snapshot installs once, generates once, builds once', () => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      const r = runDependencyChain(dir)
      expect({ install: r.installRuns, generator: r.generatorRuns, build: r.buildRuns }).toEqual({
        install: 1,
        generator: 1,
        build: 1,
      })
      expect(r.code).toBe(0)
      expect(r.output).toContain('BUILD_PREFLIGHT=OK')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('a quarantined dependency tree does not stop the chain — it is rebuilt', () => {
    const dir = makeRepo('node_modules\n')
    try {
      mkdirSync(join(dir, 'node_modules', 'evil-pkg'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', 'evil-pkg', 'index.js'), 'module.exports = "MALICIOUS"\n')
      mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', '.bin', 'next'), '#!/bin/sh\necho STALE_BIN\n')
      const r = runDependencyChain(dir)
      expect(r.output).toContain('BUILD_PREFLIGHT=OK')
      expect({ install: r.installRuns, build: r.buildRuns }).toEqual({ install: 1, build: 1 })
      // Nothing about the malicious content reaches the identity or the log.
      expect(r.output).not.toContain('MALICIOUS')
      expect(r.output).not.toContain('STALE_BIN')
      expect(r.output).toContain('source_dirty=false')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('an install FAILURE stops the chain: generator zero, build zero', () => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      const r = runDependencyChain(dir, { installFails: true })
      expect({ install: r.installRuns, generator: r.generatorRuns, build: r.buildRuns }).toEqual({
        install: 1,
        generator: 0,
        build: 0,
      })
      expect(r.code).not.toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it.each([
    ['an untracked .npmrc', '.npmrc', 'registry=https://attacker.example\n'],
    ['an untracked .pnpmfile.cjs', '.pnpmfile.cjs', 'module.exports = {}\n'],
    ['ignored application source', 'artifacts/isola/app/dist/page.tsx', 'export default () => null\n'],
  ])('%s stops the chain BEFORE install: install zero, generator zero, build zero', (_label, rel, body) => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      const full = join(dir, ...rel.split('/'))
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
      const r = runDependencyChain(dir)
      expect({ install: r.installRuns, generator: r.generatorRuns, build: r.buildRuns }).toEqual({
        install: 0,
        generator: 0,
        build: 0,
      })
      expect(r.output).toContain('BUILD_PREFLIGHT=FAIL')
      expect(r.output).not.toContain('attacker.example')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('a build-consumed environment file stops the chain before install', () => {
    const dir = makeRepo('.env*\n')
    try {
      writeFileSync(join(dir, BUILD_CONSUMED_ENV_FILES[0]), 'NEXT_PUBLIC_API=https://attacker.example\n')
      const r = runDependencyChain(dir)
      expect({ install: r.installRuns, build: r.buildRuns }).toEqual({ install: 0, build: 0 })
      expect(r.output).not.toContain('attacker.example')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)

  it('a generator failure after a successful install still yields build zero', () => {
    const dir = makeRepo(REAL_GITIGNORE)
    try {
      rmSync(join(dir, '.git'), { recursive: true, force: true })
      const r = runDependencyChain(dir)
      expect(r.buildRuns).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 90_000)
})
