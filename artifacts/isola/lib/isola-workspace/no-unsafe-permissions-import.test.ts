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
 * Two further gaps, both found by independent review of that resolver version, are closed here:
 *
 *   - `defect-pr82-unsafe-permissions-guard-template-literal-gap-2026-08-07` — the extractor
 *     accepted only `'` and `"`, so a static backtick specifier slipped through. See
 *     `TEMPLATE_SPECIFIER_PATTERN`.
 *   - `defect-pr82-unsafe-permissions-guard-transitive-barrel-gap-2026-08-07` — the guard read
 *     only the Workspace file itself, so a shared barrel re-exporting `can()` was invisible. See
 *     `exposesUnsafePermissions`.
 *
 * Still no module is ever `import`ed or `require`d by this guard: only reading and resolving
 * path strings. Actually importing every file under test would pull in Prisma/next/headers
 * server-only code into vitest's `node` environment, which is exactly the kind of accidental
 * coupling this guard exists to prevent noticing too late.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * The same three introducers, but delimited by BACKTICKS.
 *
 * Closes `defect-pr82-unsafe-permissions-guard-template-literal-gap-2026-08-07`: an independent
 * reviewer showed that `import(\`@/lib/permissions\`)` and `require(\`../../permissions\`)` both
 * typecheck and left the previous guard green, because it only accepted `'` and `"`. A static
 * template literal is exactly as much a compile-time constant path as a quoted one, so it is
 * resolved identically.
 *
 * An INTERPOLATED template (`` `../../${name}` ``) is deliberately NOT resolved: its target is
 * not knowable without evaluating code, and this guard never evaluates code. Guessing at a
 * substitution would produce either false accusations or false comfort, so such specifiers are
 * skipped entirely and reported separately by `interpolatedSpecifiers` below, which the
 * production sweep asserts stays empty — an interpolated module path in Isola Workspace source
 * would be a hole this guard genuinely cannot see through, and must be caught as its own
 * failure rather than silently ignored.
 */
const TEMPLATE_SPECIFIER_PATTERN = /(?:from\s+|require\(\s*|import\(\s*)`([^`]*)`/g

const INTERPOLATION = /\$\{/

/** Every statically-knowable module specifier: quoted, or a template literal with no `${}`. */
function staticSpecifiers(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(IMPORT_SPECIFIER_PATTERN)) out.push(m[1])
  for (const m of content.matchAll(TEMPLATE_SPECIFIER_PATTERN)) {
    if (INTERPOLATION.test(m[1])) continue
    out.push(m[1])
  }
  return out
}

/** Template-literal specifiers this guard refuses to resolve, so callers can fail on them. */
function interpolatedSpecifiers(content: string): string[] {
  const out: string[] = []
  for (const m of content.matchAll(TEMPLATE_SPECIFIER_PATTERN)) {
    if (INTERPOLATION.test(m[1])) out.push(m[1])
  }
  return out
}

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
  for (const specifier of staticSpecifiers(rawContent)) {
    const resolved = resolveSpecifier(specifier, fromFileAbs)
    if (resolved && stripResolutionSuffix(resolved) === UNSAFE_PERMISSIONS_PATH) return true
  }
  return false
}

// ── Transitive re-export reachability ───────────────────────────────────────
//
// Closes `defect-pr82-unsafe-permissions-guard-transitive-barrel-gap-2026-08-07`. An independent
// reviewer proved the bypass: a module OUTSIDE `lib/isola-workspace` doing
// `export { can } from '@/lib/permissions'`, imported by Workspace production code, typechecked
// and left the guard green — the direct check above only ever looked at the Workspace file's own
// specifier, which pointed at an innocent-looking barrel.
//
// The rule this implements is deliberately about EXPOSURE, not mere reachability. A shared module
// is entitled to use `lib/permissions` internally — `lib/workspace/authz.ts` legitimately imports
// `getMembershipRole` from it, and Workspace legitimately imports `resolveWorkspaceAuthz` from
// that. What is forbidden is a module handing the UNSAFE SURFACE (`can`, `isAdmin`, `isOwner`)
// onward to Workspace. So the graph follows RE-EXPORT edges, not every import edge: "does this
// module make an unsafe name importable from it?", asked transitively and cycle-safely.

/** The names whose exposure to Isola Workspace is the actual hazard. */
const UNSAFE_EXPORT_NAMES = ['can', 'isAdmin', 'isOwner']

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx']

/**
 * Resolve a specifier to a real local source FILE, or `null` for an npm package / something that
 * does not exist on disk. Mirrors TypeScript's own resolution order closely enough for a static
 * guard: exact path, then each extension, then `index` inside a directory.
 */
function resolveToLocalFile(specifier: string, fromFileAbs: string): string | null {
  const base = resolveSpecifier(specifier, fromFileAbs)
  if (base === null) return null
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((e) => base + e),
    ...SOURCE_EXTENSIONS.map((e) => join(base, `index${e}`)),
  ]
  for (const c of candidates) {
    try {
      if (statSync(c).isFile()) return c
    } catch {
      // Does not exist — try the next candidate.
    }
  }
  return null
}

/**
 * `export * from 'X'`, `export * as ns from 'X'`, `export { a, b as c } from 'X'` — in any of the
 * three quote styles, including a static template literal.
 */
const REEXPORT_FROM_PATTERN =
  /export\s+(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*(['"`])([^'"`]+)\2/g

/** `export { a, b as c }` with NO `from` — re-exporting something imported earlier in the file. */
const LOCAL_EXPORT_LIST_PATTERN = /export\s*\{([^}]*)\}\s*(?!\s*from)/g

/** The SOURCE-side names in an export clause (`{ can as authorize }` -> `can`). */
function clauseSourceNames(clause: string): string[] {
  return clause
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((part) => part.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, ''))
    .filter(Boolean)
}

/**
 * Does importing `fileAbs` make any unsafe permissions name reachable?
 *
 * `seen` makes this cycle-safe: a module already being evaluated higher in the stack returns
 * `false` rather than recursing forever, so `A -> B -> A` terminates. Results are memoised in
 * `cache` so the sweep stays linear in the number of local modules.
 */
function exposesUnsafePermissions(
  fileAbs: string,
  seen: Set<string> = new Set(),
  cache: Map<string, boolean> = EXPOSURE_CACHE,
): boolean {
  if (stripResolutionSuffix(fileAbs) === UNSAFE_PERMISSIONS_PATH) return true

  const cached = cache.get(fileAbs)
  if (cached !== undefined) return cached
  if (seen.has(fileAbs)) return false // cycle — already being evaluated above us
  seen.add(fileAbs)

  let content: string
  try {
    content = readFileSync(fileAbs, 'utf8')
  } catch {
    return false
  }
  const code = stripComments(content)

  let exposes = false

  // 1. Explicit re-export edges: `export ... from 'X'`.
  for (const match of code.matchAll(REEXPORT_FROM_PATTERN)) {
    const [, clause, , specifier] = match
    if (INTERPOLATION.test(specifier)) continue
    const target = resolveToLocalFile(specifier, fileAbs)
    if (!target) continue

    const forwardsEverything = clause.trim().startsWith('*')
    const forwardsUnsafeName =
      !forwardsEverything &&
      clauseSourceNames(clause).some((n) => UNSAFE_EXPORT_NAMES.includes(n))

    if (!forwardsEverything && !forwardsUnsafeName) continue
    if (exposesUnsafePermissions(target, seen, cache)) {
      exposes = true
      break
    }
  }

  // 2. `import { can } from 'X'` followed by a bare `export { can }` — the same forwarding,
  //    written in two statements instead of one.
  if (!exposes) {
    const locallyExported = new Set(
      [...code.matchAll(LOCAL_EXPORT_LIST_PATTERN)].flatMap((m) => clauseSourceNames(m[1])),
    )
    if (UNSAFE_EXPORT_NAMES.some((n) => locallyExported.has(n))) {
      for (const specifier of staticSpecifiers(code)) {
        const target = resolveToLocalFile(specifier, fileAbs)
        if (target && exposesUnsafePermissions(target, seen, cache)) {
          exposes = true
          break
        }
      }
    }
  }

  seen.delete(fileAbs)
  cache.set(fileAbs, exposes)
  return exposes
}

const EXPOSURE_CACHE = new Map<string, boolean>()

/**
 * The transitive check applied to one guarded Workspace file: does anything it imports hand it
 * the unsafe surface, however many barrels deep?
 */
function reachesUnsafeViaReExport(fromFileAbs: string, rawContent: string): string | null {
  for (const specifier of staticSpecifiers(rawContent)) {
    const target = resolveToLocalFile(specifier, fromFileAbs)
    if (!target) continue
    if (stripResolutionSuffix(target) === UNSAFE_PERMISSIONS_PATH) continue // direct check owns it
    if (exposesUnsafePermissions(target, new Set(), EXPOSURE_CACHE)) return specifier
  }
  return null
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
  const indirect = reachesUnsafeViaReExport(path, content)
  if (indirect) {
    found.push(
      `reaches the unsafe lib/permissions.ts surface transitively through "${indirect}" ` +
        '(a re-export chain — see exposesUnsafePermissions)',
    )
  }
  for (const specifier of interpolatedSpecifiers(content)) {
    found.push(
      `uses an interpolated module specifier \`${specifier}\` this guard cannot statically ` +
        'resolve — write a literal path instead',
    )
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

  // ── Static template-literal specifiers ─────────────────────────────────────
  //
  // `defect-pr82-unsafe-permissions-guard-template-literal-gap-2026-08-07`: both of these
  // typecheck, and both left the previous quote-only extractor completely green.

  it('flags a template-literal dynamic import of the alias form', () => {
    const synthetic = 'export async function f() { return (await import(`@/lib/permissions`)).can }\n'
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a template-literal deep-relative dynamic import', () => {
    const synthetic = 'export async function f() { return (await import(`../../permissions`)).can }\n'
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a template-literal require of the alias form', () => {
    const synthetic = 'const { can } = require(`@/lib/permissions`)\n'
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a template-literal deep-relative require', () => {
    const synthetic = 'const { can } = require(`../../permissions`)\n'
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('flags a template-literal `from` clause', () => {
    const synthetic = 'export { can } from `@/lib/permissions`\n'
    expect(violations(adaptersFile, synthetic).length).toBeGreaterThan(0)
  })

  it('does not flag a template-literal specifier pointing somewhere safe', () => {
    const synthetic = 'export async function f() { return (await import(`../ports`)) }\n'
    expect(violations(adaptersFile, synthetic)).toEqual([])
  })

  it('never GUESSES at an interpolated specifier — it reports it as unresolvable instead', () => {
    const synthetic = 'export async function f(name: string) { return await import(`../../${name}`) }\n'
    const found = violations(adaptersFile, synthetic)
    // Reported, but explicitly NOT as an unsafe-permissions import: the guard does not evaluate
    // code and must not pretend to know where `${name}` points.
    expect(found.length).toBeGreaterThan(0)
    expect(found.join(' ')).toContain('interpolated module specifier')
    expect(found.join(' ')).not.toContain('imports the unsafe lib/permissions.ts module')
  })
})

// ── Transitive / barrel re-export reachability ───────────────────────────────
//
// `defect-pr82-unsafe-permissions-guard-transitive-barrel-gap-2026-08-07`. These write REAL
// temporary modules, because the whole point of the bypass is that it lives in a second file the
// guard has to go and read — a synthetic string cannot express it. Every file is removed again in
// `finally`, and each test uses its own filenames so a failure cannot leak into the next.

describe('the guard follows re-export chains out of the Workspace tree', () => {
  const SHARED_DIR = join(ROOT, 'lib', 'workspace')
  const WS_DIR = join(ROOT, 'lib', 'isola-workspace')

  function withTempModules(
    files: Record<string, string>,
    assert: () => void,
  ): void {
    const written: string[] = []
    try {
      for (const [abs, content] of Object.entries(files)) {
        mkdirSync(dirname(abs), { recursive: true })
        writeFileSync(abs, content)
        written.push(abs)
      }
      EXPOSURE_CACHE.clear()
      assert()
    } finally {
      for (const abs of written) rmSync(abs, { force: true })
      EXPOSURE_CACHE.clear()
    }
  }

  it('flags a ONE-HOP barrel: Workspace -> shared barrel -> lib/permissions', () => {
    const barrel = join(SHARED_DIR, 'zz-guard-barrel-a.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer.ts')
    withTempModules(
      {
        [barrel]: `export { can } from '@/lib/permissions'\n`,
        [consumer]: `import { can } from '@/lib/workspace/zz-guard-barrel-a'\nexport const x = can\n`,
      },
      () => {
        const found = violations(consumer, readFileSync(consumer, 'utf8'))
        expect(found.length).toBeGreaterThan(0)
        expect(found.join(' ')).toContain('transitively')
      },
    )
  })

  it('flags a TWO-HOP chain: Workspace -> barrel A -> barrel B -> lib/permissions', () => {
    const barrelB = join(SHARED_DIR, 'zz-guard-barrel-b2.ts')
    const barrelA = join(SHARED_DIR, 'zz-guard-barrel-a2.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer2.ts')
    withTempModules(
      {
        [barrelB]: `export { can } from '@/lib/permissions'\n`,
        [barrelA]: `export { can } from './zz-guard-barrel-b2'\n`,
        [consumer]: `import { can } from '@/lib/workspace/zz-guard-barrel-a2'\nexport const x = can\n`,
      },
      () => {
        expect(violations(consumer, readFileSync(consumer, 'utf8')).length).toBeGreaterThan(0)
      },
    )
  })

  it('flags `export * from` forwarding, which names nothing explicitly', () => {
    const barrel = join(SHARED_DIR, 'zz-guard-star.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer3.ts')
    withTempModules(
      {
        [barrel]: `export * from '@/lib/permissions'\n`,
        [consumer]: `import { can } from '@/lib/workspace/zz-guard-star'\nexport const x = can\n`,
      },
      () => {
        expect(violations(consumer, readFileSync(consumer, 'utf8')).length).toBeGreaterThan(0)
      },
    )
  })

  it('flags the two-statement form: `import { can }` then a bare `export { can }`', () => {
    const barrel = join(SHARED_DIR, 'zz-guard-twostep.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer4.ts')
    withTempModules(
      {
        [barrel]: `import { can } from '@/lib/permissions'\nexport { can }\n`,
        [consumer]: `import { can } from '@/lib/workspace/zz-guard-twostep'\nexport const x = can\n`,
      },
      () => {
        expect(violations(consumer, readFileSync(consumer, 'utf8')).length).toBeGreaterThan(0)
      },
    )
  })

  it('terminates safely on a cycle (A -> B -> A) instead of recursing forever', () => {
    const a = join(SHARED_DIR, 'zz-guard-cycle-a.ts')
    const b = join(SHARED_DIR, 'zz-guard-cycle-b.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer5.ts')
    withTempModules(
      {
        [a]: `export * from './zz-guard-cycle-b'\nexport const alpha = 1\n`,
        [b]: `export * from './zz-guard-cycle-a'\nexport const beta = 2\n`,
        [consumer]: `import { alpha } from '@/lib/workspace/zz-guard-cycle-a'\nexport const x = alpha\n`,
      },
      () => {
        // The assertion that matters is that this RETURNS AT ALL; the cycle is safe, so no
        // violation either.
        expect(violations(consumer, readFileSync(consumer, 'utf8'))).toEqual([])
      },
    )
  })

  it('still allows a legitimate shared module that has no unsafe dependency', () => {
    const shared = join(SHARED_DIR, 'zz-guard-safe-shared.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer6.ts')
    withTempModules(
      {
        [shared]: `export function formatTenantLabel(name: string): string { return name.trim() }\n`,
        [consumer]: `import { formatTenantLabel } from '@/lib/workspace/zz-guard-safe-shared'\nexport const x = formatTenantLabel\n`,
      },
      () => {
        expect(violations(consumer, readFileSync(consumer, 'utf8'))).toEqual([])
      },
    )
  })

  it('still allows a shared module that USES lib/permissions internally without re-exporting it', () => {
    // This is exactly `lib/workspace/authz.ts`: it imports `getMembershipRole` from the unsafe
    // module and exposes only its own governed API. Flagging this would make the guard
    // unusable — Workspace's real authorization path goes through such a module.
    const shared = join(SHARED_DIR, 'zz-guard-wrapper.ts')
    const consumer = join(WS_DIR, 'zz-guard-consumer7.ts')
    withTempModules(
      {
        [shared]: `import { can } from '@/lib/permissions'\nexport async function mayApprove(ctx: never): Promise<boolean> { return can(ctx, 'approval.decide' as never) }\n`,
        [consumer]: `import { mayApprove } from '@/lib/workspace/zz-guard-wrapper'\nexport const x = mayApprove\n`,
      },
      () => {
        expect(violations(consumer, readFileSync(consumer, 'utf8'))).toEqual([])
      },
    )
  })
})
