import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  DEPENDENCY_TREE_PATHS,
  GENERATED_PATH,
  SNAPSHOT_EXCLUDED_PREFIXES,
} from '@/scripts/generate-build-info.mjs'

import {
  REQUIRED_GENERATED_EXCLUSIONS,
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

  it('adds no exclusion beyond the pnpm store and the three proven generated outputs', () => {
    // A broad rule that quietly dropped source or migrations would be the worst
    // possible outcome of a "hygiene" change, so the rule list itself is pinned.
    expect(rules.map((r) => r.pattern)).toEqual(['.local', ...REQUIRED_GENERATED_EXCLUSIONS])
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

  it('the api-server artifact builds dist before running it', () => {
    const toml = readFileSync(`${REPO_ROOT}artifacts/api-server/.replit-artifact/artifact.toml`, 'utf8')
    expect(toml).toContain('"@workspace/api-server", "run", "build"')
    expect(toml).toContain('artifacts/api-server/dist/index.mjs')
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

  it('the production start command is unchanged and starts from newly produced output', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts['start:prod']).toBe('prisma migrate deploy && next start')
  })

  it('the build refuses to run without proven source identity', () => {
    const pkg = JSON.parse(readFileSync(`${REPO_ROOT}artifacts/isola/package.json`, 'utf8')) as {
      scripts: Record<string, string>
    }
    expect(pkg.scripts.build).toBe('node ./scripts/generate-build-info.mjs --require-identity && next build')
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

  it('dependency trees are a DIFFERENT class and are not claimed to be excluded', () => {
    // They are not in .replitignore, and the generator does not pretend they are.
    // Whether Replit uploads them is an open owner question recorded in Port; the
    // exemption is explicit and bounded rather than dressed up as proven.
    for (const p of DEPENDENCY_TREE_PATHS) {
      expect({ p, excluded: isExcluded(p, rules) }).toEqual({ p, excluded: false })
      expect({ p, inExcludedList: SNAPSHOT_EXCLUDED_PREFIXES.includes(p) }).toEqual({ p, inExcludedList: false })
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
    const broad = ['dist', 'tmp', 'out-tsc', 'node_modules', '.env*', '*.bundle']
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
