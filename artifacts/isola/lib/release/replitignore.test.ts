import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DEPENDENCY_TREE_PATHS,
  GENERATED_PATH,
  PATH_CLASS,
  SHIPPED_GENERATED_PREFIXES,
  SNAPSHOT_EXCLUDED_PREFIXES,
  classifySnapshotPath,
  evaluatePreflight,
} from '@/scripts/generate-build-info.mjs'

import {
  REQUIRED_GENERATED_EXCLUSIONS,
  REQUIRED_SHIPPED_GENERATED,
  REQUIRED_SNAPSHOT_PATHS,
  isExcluded,
  matchesPattern,
  parseReplitignore,
} from './replitignore'

const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const REPLITIGNORE = `${REPO_ROOT}.replitignore`

const rules = parseReplitignore(readFileSync(REPLITIGNORE, 'utf8'))

describe('matchesPattern', () => {
  it('matches a directory and everything beneath it', () => {
    expect(matchesPattern('artifacts/isola/.next', 'artifacts/isola/.next')).toBe(true)
    expect(matchesPattern('artifacts/isola/.next/BUILD_ID', 'artifacts/isola/.next')).toBe(true)
    expect(matchesPattern('artifacts/isola/.next/server/app/api/health/route.js', 'artifacts/isola/.next')).toBe(true)
  })

  it('does not match a sibling that merely shares a prefix', () => {
    expect(matchesPattern('artifacts/isola/.next-preview/x', 'artifacts/isola/.next')).toBe(false)
    expect(matchesPattern('artifacts/isola/.nextconfig', 'artifacts/isola/.next')).toBe(false)
  })

  it('is anchored at the start', () => {
    expect(matchesPattern('vendor/artifacts/isola/.next', 'artifacts/isola/.next')).toBe(false)
  })

  it('treats * as not crossing a slash and ** as crossing it', () => {
    expect(matchesPattern('a/b', 'a/*')).toBe(true)
    expect(matchesPattern('a/b/c', 'a/*/c')).toBe(true)
    expect(matchesPattern('a/b/c/d', 'a/**/d')).toBe(true)
  })
})

describe('parseReplitignore', () => {
  it('drops comments and blank lines', () => {
    const parsed = parseReplitignore('# a comment\n\n.local\n!keep\n')
    expect(parsed).toEqual([
      { pattern: '.local', negated: false },
      { pattern: 'keep', negated: true },
    ])
  })
})

describe('the real .replitignore', () => {
  it('exists at the repository root', () => {
    expect(existsSync(REPLITIGNORE)).toBe(true)
  })

  it('still excludes the pnpm store, as it always did', () => {
    expect(isExcluded('.local/share/pnpm/store/v3/files/00/abc', rules)).toBe(true)
  })

  it.each(REQUIRED_GENERATED_EXCLUSIONS.map((p) => [p]))('excludes the generated output %s', (path) => {
    expect(isExcluded(path, rules)).toBe(true)
    expect(isExcluded(`${path}/anything/inside.js`, rules)).toBe(true)
  })

  it('excludes the compiled Next.js server bundle for the CB-0 routes specifically', () => {
    // The bundles whose staleness could not be ruled out on 2026-08-06.
    expect(isExcluded('artifacts/isola/.next/server/app/api/onboard/whatsapp/route.js', rules)).toBe(true)
    expect(isExcluded('artifacts/isola/.next/server/app/api/health/route.js', rules)).toBe(true)
    expect(isExcluded('artifacts/isola/.next/BUILD_ID', rules)).toBe(true)
    expect(isExcluded('artifacts/api-server/dist/index.mjs', rules)).toBe(true)
  })

  it.each(REQUIRED_SNAPSHOT_PATHS.map((p) => [p]))('keeps %s in the deployment snapshot', (path) => {
    expect(isExcluded(path, rules)).toBe(false)
  })

  it('keeps every Prisma migration, not just the lock file', () => {
    expect(isExcluded('artifacts/isola/prisma/migrations/20260731120000_cw00/migration.sql', rules)).toBe(false)
  })

  it('keeps the whole of the application source tree', () => {
    for (const path of [
      'artifacts/isola/app/page.tsx',
      'artifacts/isola/components/ui/button.tsx',
      'artifacts/isola/lib/session.ts',
      'artifacts/isola/lib/consumer-session.ts',
      'artifacts/api-server/src/index.ts',
      'lib/api-client-react/src/index.ts',
      'scripts/src/guard-not-prod-db.ts',
    ]) {
      expect(isExcluded(path, rules)).toBe(false)
    }
  })

  it('keeps source-controlled public assets', () => {
    expect(isExcluded('artifacts/isola/public/logo.svg', rules)).toBe(false)
    expect(isExcluded('artifacts/isola/public/images/hero.png', rules)).toBe(false)
  })

  it('adds no exclusion beyond the pnpm store, the generated outputs and the dependency trees', () => {
    // A broad rule that quietly dropped source or migrations would be the worst
    // possible outcome of a "hygiene" change, so the rule list itself is pinned.
    // The dependency-tree half is pinned against the real workspace topology in
    // "workspace dependency trees are excluded from the deployment snapshot".
    const generated = rules.map((r) => r.pattern).filter((p) => !p.endsWith('node_modules'))
    expect(generated).toEqual(['.local', ...REQUIRED_GENERATED_EXCLUSIONS])
    expect(rules.every((r) => !r.negated)).toBe(true)
  })
})

describe('the excluded paths really are rebuilt', () => {
  it('the isola artifact declares a build step that produces .next', () => {
    const toml = readFileSync(`${REPO_ROOT}artifacts/isola/.replit-artifact/artifact.toml`, 'utf8')
    expect(toml).toContain('"@workspace/isola", "run", "build"')
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toContain('next build')
  })

  it('the api-server artifact builds dist, then runs from the staged .deploy copy', () => {
    const toml = readFileSync(`${REPO_ROOT}artifacts/api-server/.replit-artifact/artifact.toml`, 'utf8')
    expect(toml).toContain('"@workspace/api-server", "run", "build"')
    // Not artifacts/api-server/dist/index.mjs directly: real Replit Autoscale
    // builds lost that path between the build phase completing and the
    // runtime container starting (builds 5867f18a, 464d486f/c8331dd1) despite
    // esbuild's own log confirming it had just been created. build.mjs stages
    // an explicit copy at .deploy/api-server/ and asserts it exists before
    // the build is allowed to succeed; the run command points there instead.
    //
    // Exact string, not a substring: a substring check cannot tell a correct
    // path from a `../../`-prefixed one that resolves somewhere else entirely.
    // Replit runs this artifact with cwd = repo root, so there is no prefix.
    // The resolution itself is asserted below, from that same cwd.
    expect(toml).toContain('args = ["node", "--enable-source-maps", ".deploy/api-server/index.mjs"]')
    expect(toml).not.toContain('artifacts/api-server/dist/index.mjs')
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/api-server/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toBeTruthy()
  })

  it('.next-preview is written only by the preview workflow, which next.config falls back from', () => {
    const preview = readFileSync(`${REPO_ROOT}artifacts/isola/scripts/run-replit-preview.sh`, 'utf8')
    expect(preview).toContain('NEXT_DIST_DIR')
    expect(preview).toContain('.next-preview')
    const config = readFileSync(`${REPO_ROOT}artifacts/isola/next.config.ts`, 'utf8')
    expect(config).toContain("process.env.NEXT_DIST_DIR || '.next'")
  })

  it('the production start command runs from the staged standalone server, not next start directly', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    // Not `next start`: plain `next build` output still needs the full
    // workspace node_modules at runtime, and real Replit Autoscale builds
    // lost `.next` between the build phase completing and the runtime
    // container starting at least once (isola's port never opened in the
    // same incidents that took down api-server's dist/index.mjs). Standalone
    // output is staged into .deploy/isola/ (generate-deploy-staging.mjs) and
    // the start command points at that staged server.js instead.
    expect(pkg.scripts['start:prod']).toBe(
      'prisma migrate deploy && node ../../.deploy/isola/artifacts/isola/server.js',
    )
  })

  it('the build refuses to run without proven source identity, then stages a self-contained runtime copy', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toBe(
      'node ./scripts/generate-build-info.mjs --preflight && pnpm install --frozen-lockfile && node ./scripts/generate-build-info.mjs --require-identity && next build && node ./scripts/generate-deploy-staging.mjs',
    )
  })

  it('Next.js standalone output is enabled, so the staged copy is self-contained', () => {
    const config = readFileSync(`${REPO_ROOT}artifacts/isola/next.config.ts`, 'utf8')
    expect(config).toContain("output: 'standalone'")
  })
})

// ── Production run commands must resolve the staged payload ────────────────
//
// Replit starts BOTH artifact processes with cwd = the repository root. The
// runtime log labels them `artifact=artifacts/api-server` and
// `artifact=artifacts/isola`, but that string is a label, not a working
// directory — PR88 read it as one and broke the api-server entrypoint. The
// proof is arithmetic: with a `../../` prefix the real runtime resolved
// `/home/.deploy/api-server/index.mjs`, which is reachable only from cwd
// `/home/runner/workspace`.
//
// The two commands are therefore NOT symmetric, and that asymmetry is the
// thing worth pinning:
//
//   api-server  bare `node`            cwd stays repo root      → no prefix
//   isola       via `pnpm --filter`    pnpm re-anchors cwd to
//                                      the package directory    → `../../`
//
// Each is checked against the cwd its own launcher actually produces, so a
// future edit that "makes them consistent" fails here instead of at promote.
describe('production run commands resolve to the repo-root staged payload', () => {
  const REPO_ROOT_DIR = REPO_ROOT.replace(/\/$/, '')
  const ISOLA_DIR = `${REPO_ROOT}artifacts/isola`
  const API_SERVER_ENTRYPOINT = `${REPO_ROOT}.deploy/api-server/index.mjs`
  const ISOLA_ENTRYPOINT = `${REPO_ROOT}.deploy/isola/artifacts/isola/server.js`

  function extractApiServerRunArg(): string {
    const toml = readFileSync(`${REPO_ROOT}artifacts/api-server/.replit-artifact/artifact.toml`, 'utf8')
    const match = toml.match(/args = \["node", "--enable-source-maps", "([^"]+)"\]/)
    if (!match) throw new Error('could not find the api-server production run args in artifact.toml')
    return match[1]
  }

  function extractIsolaRunArg(): string {
    const pkg = JSON.parse(readFileSync(`${ISOLA_DIR}/package.json`, 'utf8')) as { scripts: Record<string, string> }
    const match = pkg.scripts['start:prod'].match(/node (\S+)$/)
    if (!match) throw new Error('could not find the isola start:prod node entrypoint')
    return match[1]
  }

  it('the api-server run path resolves to the staged entrypoint from cwd=repo root', () => {
    expect(resolvePath(REPO_ROOT_DIR, extractApiServerRunArg())).toBe(API_SERVER_ENTRYPOINT)
  })

  it('the isola start:prod path resolves to the staged entrypoint from the package directory pnpm anchors it to', () => {
    expect(resolvePath(ISOLA_DIR, extractIsolaRunArg())).toBe(ISOLA_ENTRYPOINT)
  })

  it('the isola artifact runs through pnpm --filter, which is what re-anchors its cwd', () => {
    // If this ever becomes a bare `node` invocation, isola's `../../` prefix
    // silently becomes wrong in exactly the way PR88's did.
    const toml = readFileSync(`${ISOLA_DIR}/.replit-artifact/artifact.toml`, 'utf8')
    expect(toml).toContain('args = ["pnpm", "--filter", "@workspace/isola", "run", "start:prod"]')
  })

  // Gated on the artifact actually having been built (`pnpm --filter ... run build`
  // first) — these are child-process integration tests, not unit tests, and skip
  // cleanly rather than false-failing on a checkout where the build hasn't run.
  it.skipIf(!existsSync(API_SERVER_ENTRYPOINT))(
    'spawning the literal api-server production command from cwd=repo root resolves the module',
    () => {
      const result = spawnSync(process.execPath, ['--enable-source-maps', extractApiServerRunArg()], {
        cwd: REPO_ROOT_DIR,
        timeout: 5000,
        encoding: 'utf8',
      })
      // Deliberately no DATABASE_URL is set — the app is expected to fail past
      // module resolution (e.g. on its own env validation). Only module
      // resolution failure is the regression this test guards against.
      expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
      expect(result.stderr).not.toContain('Cannot find module')
    },
  )

  it.skipIf(!existsSync(ISOLA_ENTRYPOINT))(
    'spawning the literal isola staged server.js from the directory pnpm anchors it to resolves the module',
    () => {
      const result = spawnSync(process.execPath, [extractIsolaRunArg()], {
        cwd: ISOLA_DIR,
        timeout: 5000,
        encoding: 'utf8',
      })
      expect(result.stderr).not.toContain('MODULE_NOT_FOUND')
      expect(result.stderr).not.toContain('Cannot find module')
    },
  )
})

// ── The staged runtime payload must SHIP ───────────────────────────────────
//
// This is the guard that would have stopped PR87. `.deploy` is forgiven by the
// preflight through SHIPPED_GENERATED_PREFIXES, NOT through `.replitignore`
// exclusion — and it must never be excluded, because the runtime starts from
// it. Every path missing at runtime across this incident was a path listed in
// `.replitignore`: `artifacts/api-server/dist/index.mjs`, `artifacts/isola/.next`
// (isola's port never opened), and then `.deploy` itself.
describe('the staged runtime payload is forgiven by the preflight without being excluded from the publish', () => {
  it('every shipped-generated path is NOT excluded by .replitignore', () => {
    for (const prefix of REQUIRED_SHIPPED_GENERATED) {
      expect({ prefix, excluded: isExcluded(prefix, rules) }).toEqual({ prefix, excluded: false })
    }
  })

  it('the entrypoints the run commands name are inside a shipped-generated path', () => {
    for (const entrypoint of ['.deploy/api-server/index.mjs', '.deploy/isola/artifacts/isola/server.js']) {
      expect({ entrypoint, excluded: isExcluded(entrypoint, rules) }).toEqual({ entrypoint, excluded: false })
    }
  })

  it('the generator forgives shipped-generated paths, and the two lists are disjoint', () => {
    expect([...SHIPPED_GENERATED_PREFIXES]).toEqual([...REQUIRED_SHIPPED_GENERATED])
    for (const prefix of SHIPPED_GENERATED_PREFIXES) {
      expect(SNAPSHOT_EXCLUDED_PREFIXES).not.toContain(prefix)
    }
  })

  it('the preflight accounts for a staged payload without calling the snapshot dirty', () => {
    const staged = classifySnapshotPath('.deploy/api-server/index.mjs')
    expect(staged.class).toBe(PATH_CLASS.shippedGenerated)
    expect(evaluatePreflight('?? .deploy/api-server/index.mjs\0').ok).toBe(true)
  })

  it('a path merely resembling the staged payload is still dirt', () => {
    // `.deploy` is a prefix, not a substring or a basename: neither a sibling
    // nor a nested copy elsewhere may inherit the exemption.
    for (const path of ['.deploybak/index.mjs', 'artifacts/isola/.deploy/index.mjs']) {
      expect({ path, class: classifySnapshotPath(path).class }).toEqual({ path, class: PATH_CLASS.dirty })
    }
  })
})

// ── One snapshot contract, two files, pinned to each other ──────────────────
//
// `generate-build-info.mjs` refuses to build when the workspace holds anything
// the reviewed tree does not describe. The ONLY reason it may forgive a path is
// that `.replitignore` keeps that path out of the snapshot entirely. If the two
// lists ever drift apart, the generator is forgiving something that does ship —
// which is the exact shape of the bypass this contract exists to close.
// dec-pr81-ignored-snapshot-and-six-host-coverage-must-fail-closed-2026-08-06.

describe('the generator and .replitignore agree on what leaves the snapshot', () => {
  it('every path the generator treats as snapshot-excluded really is excluded', () => {
    for (const prefix of SNAPSHOT_EXCLUDED_PREFIXES) {
      expect({ prefix, excluded: isExcluded(prefix, rules) }).toEqual({ prefix, excluded: true })
      expect({ prefix, childExcluded: isExcluded(`${prefix}/anything/at/all`, rules) }).toEqual({
        prefix,
        childExcluded: true,
      })
    }
  })

  it('every generated output .replitignore excludes is one the generator knows about', () => {
    for (const p of REQUIRED_GENERATED_EXCLUSIONS) {
      expect({ p, known: SNAPSHOT_EXCLUDED_PREFIXES.includes(p) }).toEqual({ p, known: true })
    }
  })

  it('the generator does NOT forgive anything that still ships', () => {
    // A path that .replitignore does not exclude must never appear in the
    // generator's exemption list, no matter how harmless it looks.
    for (const shipped of [
      'artifacts/isola/app',
      'artifacts/isola/lib',
      'artifacts/isola/prisma/schema.prisma',
      'pnpm-lock.yaml',
      '.replit',
      'artifacts/isola/app/dist',
      'artifacts/isola/app/build',
      'artifacts/isola/out-tsc',
    ]) {
      expect({ shipped, excluded: isExcluded(shipped, rules) }).toEqual({ shipped, excluded: false })
      expect({ shipped, exempt: SNAPSHOT_EXCLUDED_PREFIXES.includes(shipped) }).toEqual({ shipped, exempt: false })
    }
  })

  it('dependency trees are their own class, and that class IS now snapshot-excluded', () => {
    // Superseded by dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06.
    // The previous revision left them forgiven-but-unproven; they are now kept out
    // of the snapshot outright and rebuilt from the frozen lockfile, so the class
    // stays separate (it has its own justification and its own build stage) while
    // its exclusion is real rather than assumed.
    for (const p of DEPENDENCY_TREE_PATHS) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: true })
      // Still not in the generated-output list: a dependency tree is not build output.
      expect({ p, inGeneratedList: SNAPSHOT_EXCLUDED_PREFIXES.includes(p) }).toEqual({ p, inGeneratedList: false })
    }
  })

  it('no exemption prefix overlaps another — each path has exactly one class', () => {
    const all = [...SNAPSHOT_EXCLUDED_PREFIXES, ...DEPENDENCY_TREE_PATHS, GENERATED_PATH]
    for (const a of all) {
      for (const b of all) {
        if (a === b) continue
        expect({ a, b, overlaps: a === b || a.startsWith(`${b}/`) }).toEqual({ a, b, overlaps: false })
      }
    }
  })

  it('required source is still uploaded — narrowing the snapshot must not lose the build', () => {
    for (const p of REQUIRED_SNAPSHOT_PATHS) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: false })
    }
  })

  it('broad .gitignore patterns are NOT inherited as deployment exclusions', () => {
    // `.gitignore` says what this repository tracks. It is not the snapshot
    // boundary, and copying it here is how a source directory called `dist`
    // becomes invisible instead of blocking.
    const gitignore = readFileSync(`${REPO_ROOT}.gitignore`, 'utf8')
    // `node_modules` is deliberately absent from this list: it IS a deployment
    // exclusion now, but as exact per-package paths pinned to the workspace
    // topology, not as the bare recursive pattern `.gitignore` uses.
    const broad = ['dist', 'tmp', 'out-tsc', '.env*', '*.bundle']
    for (const pattern of broad) {
      expect({ pattern, inGitignore: gitignore.includes(pattern) }).toEqual({ pattern, inGitignore: true })
      const replitignore = readFileSync(REPLITIGNORE, 'utf8')
      const asOwnRule = replitignore
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'))
      expect({ pattern, adoptedWholesale: asOwnRule.includes(pattern) }).toEqual({ pattern, adoptedWholesale: false })
    }
  })
})

// ── Dependency trees leave the snapshot ─────────────────────────────────────
//
// Replit snapshots "files AND dependencies", so an installed tree ships unless
// it is excluded here — and a shipped tree is unreviewed code that `next build`
// compiles against. These assertions run the REAL dockerignore matcher over the
// REAL file; they are not "the string appears in .replitignore".
// dec-pr81-node-modules-excluded-and-lockfile-reinstalled-2026-08-06.

describe('workspace dependency trees are excluded from the deployment snapshot', () => {
  const REPO = fileURLToPath(new URL('../../../../', import.meta.url))

  /** Every directory that owns a tracked manifest, i.e. can hold a node_modules. */
  const manifestDirs = readFileSync(`${REPO}pnpm-lock.yaml`, 'utf8')
    ? [
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
    : []

  it('the workspace topology is what these rules were written against', () => {
    // Fails when a package is added or removed, so its dependency-directory
    // policy has to be considered rather than silently inherited.
    for (const dir of manifestDirs) {
      expect({ dir, hasManifest: existsSync(`${REPO}${dir === '' ? '' : `${dir}/`}package.json`) }).toEqual({
        dir,
        hasManifest: true,
      })
    }
    const declared = readFileSync(`${REPO}pnpm-workspace.yaml`, 'utf8')
    for (const glob of ['artifacts/*', 'lib/*', 'scripts']) {
      expect({ glob, declared: declared.includes(glob) }).toEqual({ glob, declared: true })
    }
  })

  it('every workspace dependency directory is excluded, contents and all', () => {
    for (const dir of manifestDirs) {
      const nm = dir === '' ? 'node_modules' : `${dir}/node_modules`
      expect({ nm, excluded: isExcluded(nm, rules) }).toEqual({ nm, excluded: true })
      // The thing that actually matters: a file INSIDE the tree never ships.
      for (const inside of [
        `${nm}/next/dist/server/next-server.js`,
        `${nm}/.bin/next`,
        `${nm}/.pnpm/lock.yaml`,
        `${nm}/evil-package/index.js`,
        `${nm}/@scope/pkg/malicious.mjs`,
      ]) {
        expect({ inside, excluded: isExcluded(inside, rules) }).toEqual({ inside, excluded: true })
      }
    }
  })

  it('the generator and .replitignore name the SAME dependency directories', () => {
    expect([...DEPENDENCY_TREE_PATHS].sort()).toEqual(
      manifestDirs.map((d) => (d === '' ? 'node_modules' : `${d}/node_modules`)).sort(),
    )
    for (const p of DEPENDENCY_TREE_PATHS) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: true })
    }
  })

  it('a similarly named directory that is NOT a declared package tree still ships', () => {
    // If these were excluded, real source would silently vanish from the build.
    for (const p of [
      'artifacts/isola/app/node_modules/page.tsx',
      'artifacts/isola/lib/node_modules_helper.ts',
      'node_modules_backup/x.js',
      'docs/node_modules.md',
      'artifacts/isola/components/node_modules-explainer.tsx',
    ]) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: false })
    }
  })

  it('excluding the trees does not exclude anything the install needs', () => {
    // The build reconstructs dependencies from these, so losing one would turn a
    // provenance fix into an outage.
    for (const p of [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.npmrc',
      'artifacts/isola/package.json',
      'artifacts/api-server/package.json',
      'lib/db/package.json',
      'scripts/package.json',
      'artifacts/isola/scripts/generate-build-info.mjs',
      'artifacts/api-server/build.mjs',
    ]) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: false })
    }
  })

  it('the rule list is still exactly the pnpm store, the generated outputs and the dependency trees', () => {
    const dependencyRules = manifestDirs.map((d) => (d === '' ? 'node_modules' : `${d}/node_modules`))
    expect(rules.map((r) => r.pattern)).toEqual([
      '.local',
      ...REQUIRED_GENERATED_EXCLUSIONS,
      ...dependencyRules,
    ])
    expect(rules.every((r) => !r.negated)).toBe(true)
  })
})
