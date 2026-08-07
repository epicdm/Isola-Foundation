/**
 * Architectural guard — closes the gap the PR #82 independent review demonstrated by negative
 * control: a correctly-typed call to `lib/permissions.ts`'s `can()` inside
 * `lib/isola-workspace/permissions.ts` passed typecheck and the full test suite with zero
 * detection. `permissions.ts`'s own header comment explains at length why `can()` is unsafe
 * here (`if (ctx.isAdmin || ctx.isOwner) return true`, and `User.role` defaults to `'owner'`
 * for every normal user) — but a comment is not a gate. This file is the gate.
 *
 * Closes `defect-pr82-unsafe-permissions-guard-relative-depth-gap-2026-08-06`: the first
 * version of this guard matched only a fixed set of import SHAPES (`@/lib/permissions`, one
 * literal level of `../permissions`), which a later independent re-review showed misses a
 * two-level-deep relative import such as `../../permissions` from the existing `adapters/`
 * subtree — a real, reachable path, not a hypothetical one. Rather than adding another fixed
 * pattern (which just moves the same gap one directory deeper), this version RESOLVES every
 * import/require/dynamic-import specifier it finds to an absolute path — following `@/...`
 * through the same alias root the app uses, and `../`/`./` through plain `node:path`
 * arithmetic relative to the importing file — and compares that resolved path to
 * `lib/permissions.ts`'s own absolute path. Depth no longer matters because nothing is matched
 * by shape; only where the specifier actually points to matters.
 *
 * Still no module is ever `import`ed or `require`d by this guard: only reading and resolving
 * path strings. Actually importing every file under test would pull in Prisma/next/headers
 * server-only code into vitest's `node` environment, which is exactly the kind of accidental
 * coupling this guard exists to prevent noticing too late.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(__dirname, '..', '..') // artifacts/isola

// Isola Workspace PRODUCTION source only. Test files are exempt so the negative-control test
// below can legitimately reference the forbidden import while proving this guard works.
const GUARDED_DIRS = [
  join(ROOT, 'lib', 'isola-workspace'),
  join(ROOT, 'components', 'isola-workspace'),
  join(ROOT, 'app', 'isola-workspace'),
]
const GUARDED_SINGLE_FILES = [join(ROOT, 'hooks', 'use-chatwoot-context.ts')]

const TEST_FILE_PATTERN = /\.test\.tsx?$/

function listSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full))
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    if (TEST_FILE_PATTERN.test(entry)) continue
    out.push(full)
  }
  return out
}

function productionFiles(): string[] {
  const files = GUARDED_DIRS.flatMap(listSourceFiles)
  for (const f of GUARDED_SINGLE_FILES) {
    if (!TEST_FILE_PATTERN.test(f)) files.push(f)
  }
  return files
}

/** The unsafe module's own absolute path, extension-stripped, once. */
const UNSAFE_PERMISSIONS_PATH = join(ROOT, 'lib', 'permissions')

/**
 * Every `from '...'`, `require('...')` and dynamic `import('...')` module specifier in a file,
 * whatever prefix introduces it. Deliberately shape-agnostic about WHAT follows the specifier
 * (named/default/namespace/renamed import, destructured `require`, awaited or bare
 * `import()`) — this guard cares only where the string points, never how the result is bound.
 */
const IMPORT_SPECIFIER_PATTERN = /(?:from\s+|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g

/**
 * `.ts`/`.tsx`/`.js`/`.jsx` and a trailing `/index` are the same module as the bare form for
 * resolution purposes. `lib/permissions.ts` is a FILE, not a directory with an `index`, so the
 * `/index` strip is defensive rather than a shape this repo's layout can currently produce —
 * kept anyway because a resolver that only handles the shapes known to exist today is exactly
 * how the previous, narrower version of this guard went stale.
 */
function stripResolutionSuffix(p: string): string {
  return p.replace(/\.(ts|tsx|js|jsx)$/, '').replace(/\/index$/, '')
}

/**
 * Resolve one import specifier to an absolute path, from the file that contains it.
 *
 * `@/...` is this repo's TypeScript path alias for `artifacts/isola/...` (see `tsconfig.json`
 * `paths`), used everywhere else in this codebase — so alias resolution does not depend on
 * which file the import lives in. A `.`-relative specifier is resolved with plain `node:path`
 * arithmetic against the importing file's own directory, which is exactly what the TypeScript
 * compiler and Node's own resolver do, and is depth-agnostic by construction. A bare specifier
 * (no `@/`, no leading `.`) is an npm package — never this repo's own `lib/permissions.ts` —
 * and resolves to `null` so it is never compared to anything.
 */
function resolveSpecifier(specifier: string, fromFileAbs: string): string | null {
  if (specifier.startsWith('@/')) return resolve(ROOT, specifier.slice(2))
  if (specifier.startsWith('.')) return resolve(dirname(fromFileAbs), specifier)
  return null
}

function importsUnsafePermissions(fromFileAbs: string, rawContent: string): boolean {
  for (const match of rawContent.matchAll(IMPORT_SPECIFIER_PATTERN)) {
    const resolved = resolveSpecifier(match[1], fromFileAbs)
    if (resolved && stripResolutionSuffix(resolved) === UNSAFE_PERMISSIONS_PATH) return true
  }
  return false
}

/**
 * The SessionCtx booleans that make `can()` unsafe (`if (ctx.isAdmin || ctx.isOwner)`).
 * Isola Workspace authorization must derive a role from `toWorkspaceRole(authz.level)` only —
 * it has no legitimate reason to read either of these fields directly.
 */
const FORBIDDEN_SHORTCUT_PATTERNS = [/\bisAdmin\b/, /\bisOwner\b/]

/**
 * Naive but adequate: strip `//` and `/* *\/` comments before checking for the shortcut
 * fields, so a file that explains in prose *why* `isAdmin`/`isOwner` are unsafe (as
 * `permissions.ts`'s own header does, at length) isn't flagged for saying so. Import
 * specifiers are still resolved against the RAW content — a commented-out import is not a
 * live violation, but this guard errs toward the simpler, stricter reading for imports since
 * a real import specifier can never legitimately appear only in prose (no file in this tree
 * currently writes one, so this costs nothing today).
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function violations(path: string, content: string): string[] {
  const found: string[] = []
  if (importsUnsafePermissions(path, content)) {
    found.push('imports the unsafe lib/permissions.ts module (resolved by path, any depth/shape)')
  }
  const code = stripComments(content)
  for (const p of FORBIDDEN_SHORTCUT_PATTERNS) {
    if (p.test(code)) found.push(`references the owner/admin shortcut field ${p}`)
  }
  return found
}

describe('Isola Workspace production code never imports the unsafe permissions helper', () => {
  const files = productionFiles()

  it('scanned at least the expected number of production files', () => {
    // A sanity floor, not an exact count — catches the guard silently scanning zero files
    // after a future directory rename, which would make every other assertion vacuously pass.
    expect(files.length).toBeGreaterThan(20)
  })

  it.each(files.map((f) => [f.slice(ROOT.length + 1).split(sep).join('/'), f] as const))(
    '%s does not import lib/permissions.ts or reference isAdmin/isOwner',
    (_relative, absolute) => {
      const content = readFileSync(absolute, 'utf8')
      expect(violations(absolute, content)).toEqual([])
    },
  )
})

describe('the guard itself detects a reintroduction (negative control, inline)', () => {
  it('flags a synthetic file containing the forbidden alias import', () => {
    const synthetic = `import { can } from '@/lib/permissions'\nexport const x = can\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  it('flags a synthetic file referencing isAdmin/isOwner directly', () => {
    const synthetic = `export function f(ctx: { isAdmin: boolean }) { return ctx.isAdmin }\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  it('does not flag the safe lib/isola-workspace/permissions.ts self-reference shape', () => {
    const synthetic = `import type { Permission, WorkspaceRole } from './contracts'\n`
    expect(violations('synthetic.ts', synthetic)).toEqual([])
  })

  it('flags a renamed import of the alias form', () => {
    const synthetic = `import { can as authorize } from '@/lib/permissions'\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  it('flags a namespace import of the alias form', () => {
    const synthetic = `import * as unsafePermissions from '@/lib/permissions'\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  it('flags require() of the alias form', () => {
    const synthetic = `const { can } = require('@/lib/permissions')\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  it('flags dynamic import() of the alias form', () => {
    const synthetic = `export async function f() { const { can } = await import('@/lib/permissions'); return can }\n`
    expect(violations('synthetic.ts', synthetic).length).toBeGreaterThan(0)
  })

  // ── The regression this hardening pass closes ──────────────────────────────
  //
  // `defect-pr82-unsafe-permissions-guard-relative-depth-gap-2026-08-06`: the previous version
  // of this guard had a single fixed pattern for one literal level of `../permissions` and
  // missed everything deeper. These use a REAL path under the existing `adapters/` subtree —
  // not a hypothetical directory — because that is exactly where the gap was demonstrated.

  const adaptersFile = join(ROOT, 'lib', 'isola-workspace', 'adapters', 'synthetic.ts')
  const nestedAdaptersFile = join(ROOT, 'lib', 'isola-workspace', 'adapters', 'nested', 'synthetic.ts')
  const workspaceRootFile = join(ROOT, 'lib', 'isola-workspace', 'synthetic.ts')

  it('flags a two-level-deep relative import from the adapters/ subtree (the exact reported miss)', () => {
    const synthetic = `import { can } from '../../permissions'\nexport const x = can\n`
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a three-level-deep relative import', () => {
    const synthetic = `import { can } from '../../../permissions'\n`
    expect(violations(nestedAdaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a one-level-deep relative import (the previously-covered shape, still covered)', () => {
    const synthetic = `import { can } from '../permissions'\n`
    expect(violations(workspaceRootFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags an extension-present relative import', () => {
    const synthetic = `import { can } from '../../permissions.ts'\n`
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a deep relative require()', () => {
    const synthetic = `const { can } = require('../../permissions')\n`
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a deep relative dynamic import()', () => {
    const synthetic = `export async function f() { return (await import('../../permissions')).can }\n`
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('does not flag an unrelated relative import from the same nested directory (false-positive check)', () => {
    const synthetic = `import type { CustomerResolution } from '../ports'\n`
    expect(violations(adaptersFile, synthetic)).toEqual([])
  })

  it('does not flag a bare package specifier that happens to be named "permissions"', () => {
    const synthetic = `import { can } from 'permissions'\n`
    expect(violations(adaptersFile, synthetic)).toEqual([])
  })

  it('does not flag a relative import of the safe lib/isola-workspace/permissions.ts from a nested directory', () => {
    // lib/isola-workspace/adapters/x.ts -> ../permissions == lib/isola-workspace/permissions.ts
    // (the SAFE module), never lib/permissions.ts (the unsafe one, which needs one more `../`).
    const synthetic = `import { permissionsForRole } from '../permissions'\n`
    expect(violations(adaptersFile, synthetic)).toEqual([])
  })
})
