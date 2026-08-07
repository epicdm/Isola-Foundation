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
 *     only the Workspace file itself, so a shared barrel re-exporting `can()` was invisible, and
 *     its first correction still compared only export-clause SPELLINGS, so renaming the binding on
 *     the way in laundered it. See `unsafeExportsOf` / `taintedLocalBindings`.
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

// ── Transitive exposure of the unsafe surface ───────────────────────────────
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
// onward to Workspace: "does this module make an unsafe binding importable from it?", asked
// transitively and cycle-safely.
//
// WHY THE FIRST VERSION OF THAT RULE WAS NOT ENOUGH
// -------------------------------------------------
// It compared only the SOURCE-SIDE NAME in an export clause against the unsafe list, so exposure
// was invisible the moment the binding was renamed on the way IN rather than on the way out. The
// second independent review reproduced three compile-valid bypasses that left this guard, the
// typechecker and the whole focused suite green while handing Workspace the identical `can`
// function object:
//
//   import { can as internalName } from '@/lib/permissions'; export { internalName as safeName }
//   import { can } from '@/lib/permissions'; export default can
//   import { can } from '@/lib/permissions'; export const allow = can
//
// So the analysis is now about BINDINGS, not spellings. A local identifier is TAINTED when it is
// bound to an unsafe export — under any name, through any number of barrels — and a module
// exposes the unsafe surface when it exports a tainted binding, however that export is written.
// Renaming is therefore free: it never launders anything.
//
// The line this must NOT cross is a NEW function. `export function authorized(ctx, p) { return
// can(ctx, p) }` declares its own binding; it is a bounded API whose author owns its signature,
// and it is exactly the shape `lib/workspace/authz.ts` uses. Forwarding an existing binding is
// the hazard; calling it inside a new one is the sanctioned pattern. Only identifier-to-identifier
// bindings propagate taint — no expression is ever evaluated or interpreted.

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

/** `export { a, b as c }` with NO `from` — re-exporting something bound earlier in the file. */
const LOCAL_EXPORT_LIST_PATTERN = /export\s*\{([^}]*)\}\s*(?!\s*from)/g

/** `import <clause> from 'X'`. The clause cannot contain a quote or a `;`, which bounds it. */
const IMPORT_STATEMENT_PATTERN = /import\s+([^;'"`]*?)\s+from\s*(['"`])([^'"`]+)\2/g

/**
 * `export default X` and `export const/let/var Y = X` where the right-hand side is a BARE
 * IDENTIFIER — the two ways to forward an existing binding without an export clause. An optional
 * `as SomeType` is tolerated because a cast changes the type, never the value. Anything else on
 * the right — a call, an arrow function, a member access, an object literal — is a NEW binding and
 * is deliberately not matched: this guard does not interpret expressions.
 */
const TRAILING_CAST = String.raw`\s*(?:as\s+[\w$.<>\[\]|\s]+?)?\s*(?:;|$)`
const EXPORT_DEFAULT_IDENTIFIER_PATTERN = new RegExp(
  String.raw`export\s+default\s+([A-Za-z_$][\w$]*)` + TRAILING_CAST,
  'gm',
)
const EXPORT_ASSIGNED_IDENTIFIER_PATTERN = new RegExp(
  String.raw`export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]+?)?\s*=\s*([A-Za-z_$][\w$]*)` +
    TRAILING_CAST,
  'gm',
)
/** A purely local rename: `const Y = X`. The one edge taint propagates along inside a file. */
const LOCAL_ALIAS_PATTERN = new RegExp(
  String.raw`(?:^|[\s;{}])(?:const|let|var)\s+([A-Za-z_$][\w$]*)(?:\s*:[^=]+?)?\s*=\s*([A-Za-z_$][\w$]*)` +
    TRAILING_CAST,
  'gm',
)

interface ClauseSpecifier {
  /** The name on the SOURCE side (`{ can as authorize }` -> `can`). */
  source: string
  /** The name it is visible as afterwards (`{ can as authorize }` -> `authorize`). */
  exported: string
}

/**
 * Split an import/export clause body into its specifiers. `type`-only specifiers are dropped: a
 * type can never carry the runtime `can` function, so treating one as exposure would be a false
 * accusation.
 */
function parseClause(inner: string): ClauseSpecifier[] {
  return inner
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^type\s/.test(part))
    .map((part) => {
      const [source, alias] = part.split(/\s+as\s+/)
      return { source: source.trim(), exported: (alias ?? source).trim() }
    })
}

interface ImportBindings {
  named: ClauseSpecifier[]
  defaultLocal: string | null
  namespaceLocal: string | null
}

function parseImportClause(clause: string): ImportBindings {
  const bindings: ImportBindings = { named: [], defaultLocal: null, namespaceLocal: null }
  let rest = clause.trim()
  if (/^type\b/.test(rest)) return bindings // `import type { … }` binds no value

  const braced = rest.match(/\{([^}]*)\}/)
  if (braced) {
    bindings.named = parseClause(braced[1])
    rest = rest.replace(/\{[^}]*\}/, '')
  }
  const namespace = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/)
  if (namespace) {
    bindings.namespaceLocal = namespace[1]
    rest = rest.replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, '')
  }
  const defaultBinding = rest.replace(/,/g, ' ').trim().match(/^([A-Za-z_$][\w$]*)$/)
  if (defaultBinding) bindings.defaultLocal = defaultBinding[1]
  return bindings
}

const EXPOSURE_CACHE = new Map<string, Set<string>>()
const IN_PROGRESS = new Set<string>()
/**
 * Bumped every time recursion is cut short by a cycle. A result computed while that happened is
 * only valid for the traversal order that produced it, so it is returned but never memoised —
 * which keeps the analysis deterministic regardless of which file the sweep reaches first.
 */
let CYCLE_CUTS = 0

function resetExposureAnalysis(): void {
  EXPOSURE_CACHE.clear()
  IN_PROGRESS.clear()
  CYCLE_CUTS = 0
}

/**
 * The local identifiers in `code` that are bound to an unsafe export — directly, or through any
 * chain of barrels and renames.
 */
function taintedLocalBindings(code: string, fileAbs: string): Set<string> {
  const tainted = new Set<string>()

  for (const match of code.matchAll(IMPORT_STATEMENT_PATTERN)) {
    const [, clause, , specifier] = match
    if (INTERPOLATION.test(specifier)) continue
    const target = resolveToLocalFile(specifier, fileAbs)
    if (!target) continue
    const unsafe = unsafeExportsOf(target)
    if (unsafe.size === 0) continue

    const bindings = parseImportClause(clause)
    for (const named of bindings.named) {
      if (unsafe.has(named.source)) tainted.add(named.exported)
    }
    if (bindings.defaultLocal && unsafe.has('default')) tainted.add(bindings.defaultLocal)
    // A namespace import hands over whatever the module exposes, under one name.
    if (bindings.namespaceLocal) tainted.add(bindings.namespaceLocal)
  }

  // `const Y = X` chains, iterated to a fixpoint so no number of trivial renames launders the
  // binding. Only identifier-to-identifier edges — see LOCAL_ALIAS_PATTERN.
  const aliasEdges = [...code.matchAll(LOCAL_ALIAS_PATTERN)].map((m) => [m[1], m[2]] as const)
  for (let grew = true; grew; ) {
    grew = false
    for (const [alias, source] of aliasEdges) {
      if (tainted.has(source) && !tainted.has(alias)) {
        tainted.add(alias)
        grew = true
      }
    }
  }

  return tainted
}

/**
 * Which of `fileAbs`'s own exported names hand out the unsafe surface. `'default'` appears in the
 * set when the module's default export is a forwarded unsafe binding. An empty set means importing
 * this module cannot yield `can`/`isAdmin`/`isOwner`, whatever it does internally.
 */
function unsafeExportsOf(fileAbs: string): Set<string> {
  if (stripResolutionSuffix(fileAbs) === UNSAFE_PERMISSIONS_PATH) {
    return new Set(UNSAFE_EXPORT_NAMES)
  }

  const cached = EXPOSURE_CACHE.get(fileAbs)
  if (cached) return cached
  if (IN_PROGRESS.has(fileAbs)) {
    CYCLE_CUTS += 1
    return new Set() // already being evaluated above us — A -> B -> A terminates here
  }
  IN_PROGRESS.add(fileAbs)
  const cutsBefore = CYCLE_CUTS

  const exposed = new Set<string>()
  try {
    const code = stripComments(readFileSync(fileAbs, 'utf8'))
    const tainted = taintedLocalBindings(code, fileAbs)

    // 1. `export … from 'X'` — forwarded without ever binding locally.
    for (const match of code.matchAll(REEXPORT_FROM_PATTERN)) {
      const [, clause, , specifier] = match
      if (INTERPOLATION.test(specifier)) continue
      const target = resolveToLocalFile(specifier, fileAbs)
      if (!target) continue
      const unsafe = unsafeExportsOf(target)
      if (unsafe.size === 0) continue

      const trimmed = clause.trim()
      if (trimmed.startsWith('*')) {
        const alias = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/)
        if (alias) {
          exposed.add(alias[1]) // the whole surface, under one name
        } else {
          // `export * from 'X'` forwards every NAMED export, never the default.
          for (const name of unsafe) if (name !== 'default') exposed.add(name)
        }
        continue
      }
      for (const spec of parseClause(trimmed)) {
        if (unsafe.has(spec.source)) exposed.add(spec.exported)
      }
    }

    // 2. `export { X }` / `export { X as Y }` — forwarding a tainted local binding.
    for (const match of code.matchAll(LOCAL_EXPORT_LIST_PATTERN)) {
      for (const spec of parseClause(match[1])) {
        if (tainted.has(spec.source)) exposed.add(spec.exported)
      }
    }

    // 3. `export default X`.
    for (const match of code.matchAll(EXPORT_DEFAULT_IDENTIFIER_PATTERN)) {
      if (tainted.has(match[1])) exposed.add('default')
    }

    // 4. `export const Y = X`.
    for (const match of code.matchAll(EXPORT_ASSIGNED_IDENTIFIER_PATTERN)) {
      if (tainted.has(match[2])) exposed.add(match[1])
    }
  } catch {
    // Unreadable — expose nothing rather than guess.
  }

  IN_PROGRESS.delete(fileAbs)
  if (CYCLE_CUTS === cutsBefore) EXPOSURE_CACHE.set(fileAbs, exposed)
  return exposed
}

/**
 * The transitive check applied to one guarded Workspace file: does anything it imports hand it
 * the unsafe surface, however many barrels and renames deep?
 */
function reachesUnsafeViaReExport(fromFileAbs: string, rawContent: string): string | null {
  for (const specifier of staticSpecifiers(rawContent)) {
    const target = resolveToLocalFile(specifier, fromFileAbs)
    if (!target) continue
    if (stripResolutionSuffix(target) === UNSAFE_PERMISSIONS_PATH) continue // direct check owns it
    if (unsafeExportsOf(target).size > 0) return specifier
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
        '(a re-export or local-rename chain — see unsafeExportsOf)',
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

const SHARED_DIR = join(ROOT, 'lib', 'workspace')
const WS_DIR = join(ROOT, 'lib', 'isola-workspace')

function withTempModules(files: Record<string, string>, assert: () => void): void {
  const written: string[] = []
  try {
    for (const [abs, content] of Object.entries(files)) {
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, content)
      written.push(abs)
    }
    resetExposureAnalysis()
    assert()
  } finally {
    for (const abs of written) rmSync(abs, { force: true })
    resetExposureAnalysis()
  }
}

/**
 * One exposure scenario: some shared modules outside the Workspace tree, plus the Workspace file
 * that imports them. `shared` is keyed by bare module name within `lib/workspace/`.
 */
interface ExposureCase {
  name: string
  shared: Record<string, string>
  /** What the Workspace production file imports, e.g. `{ can }` or `theDefault`. */
  imports: string
  /** Which shared module it imports it from. */
  entry: string
  caught: boolean
}

const EXPOSURE_CASES: readonly ExposureCase[] = [
  // ── Forwarding, in every shape that hands over an EXISTING binding ──────────
  {
    name: '1. direct `export { can } from` the unsafe module',
    shared: { 'zz-c1-a': `export { can } from '@/lib/permissions'\n` },
    imports: '{ can }',
    entry: 'zz-c1-a',
    caught: true,
  },
  {
    name: '2. direct `export { can as renamed } from` the unsafe module',
    shared: { 'zz-c2-a': `export { can as renamed } from '@/lib/permissions'\n` },
    imports: '{ renamed }',
    entry: 'zz-c2-a',
    caught: true,
  },
  {
    name: '3. `export *` from the unsafe module',
    shared: { 'zz-c3-a': `export * from '@/lib/permissions'\n` },
    imports: '{ can }',
    entry: 'zz-c3-a',
    caught: true,
  },
  {
    name: '4. `import { can }` then a bare `export { can }`',
    shared: { 'zz-c4-a': `import { can } from '@/lib/permissions'\nexport { can }\n` },
    imports: '{ can }',
    entry: 'zz-c4-a',
    caught: true,
  },
  {
    // The reviewer's control B, in its simplest form: renamed on the way IN.
    name: '5. `import { can as X }` then `export { X }`',
    shared: { 'zz-c5-a': `import { can as X } from '@/lib/permissions'\nexport { X }\n` },
    imports: '{ X }',
    entry: 'zz-c5-a',
    caught: true,
  },
  {
    // The reviewer's control B exactly: renamed on the way in AND on the way out.
    name: '6. `import { can as X }` then `export { X as safeLookingName }`',
    shared: {
      'zz-c6-a': `import { can as internalName } from '@/lib/permissions'\nexport { internalName as safeLookingName }\n`,
    },
    imports: '{ safeLookingName }',
    entry: 'zz-c6-a',
    caught: true,
  },
  {
    // The reviewer's control D.
    name: '7. `import { can }` then `export default can`',
    shared: { 'zz-c7-a': `import { can } from '@/lib/permissions'\nexport default can\n` },
    imports: 'theDefault',
    entry: 'zz-c7-a',
    caught: true,
  },
  {
    name: '8. `import { can as X }` then `export default X`',
    shared: { 'zz-c8-a': `import { can as X } from '@/lib/permissions'\nexport default X\n` },
    imports: 'theDefault',
    entry: 'zz-c8-a',
    caught: true,
  },
  {
    // The reviewer's control E.
    name: '9. `import { can }` then `export const allow = can`',
    shared: { 'zz-c9-a': `import { can } from '@/lib/permissions'\nexport const allow = can\n` },
    imports: '{ allow }',
    entry: 'zz-c9-a',
    caught: true,
  },
  {
    name: '10. `import { can as X }` then `export const allow = X`',
    shared: { 'zz-c10-a': `import { can as X } from '@/lib/permissions'\nexport const allow = X\n` },
    imports: '{ allow }',
    entry: 'zz-c10-a',
    caught: true,
  },
  {
    name: '11. an intermediate local rename: `const Y = X; export { Y }`',
    shared: {
      'zz-c11-a': `import { can as X } from '@/lib/permissions'\nconst Y = X\nexport { Y }\n`,
    },
    imports: '{ Y }',
    entry: 'zz-c11-a',
    caught: true,
  },
  {
    name: '12. a TWO-HOP renamed chain',
    shared: {
      'zz-c12-b': `import { can as inner } from '@/lib/permissions'\nexport { inner as hop1 }\n`,
      'zz-c12-a': `import { hop1 } from './zz-c12-b'\nexport const hop2 = hop1\n`,
    },
    imports: '{ hop2 }',
    entry: 'zz-c12-a',
    caught: true,
  },
  {
    name: '13. a THREE-HOP renamed chain',
    shared: {
      'zz-c13-c': `import { can as inner } from '@/lib/permissions'\nexport default inner\n`,
      'zz-c13-b': `import theDefault from './zz-c13-c'\nexport { theDefault as hop2 }\n`,
      'zz-c13-a': `import { hop2 } from './zz-c13-b'\nconst hop3 = hop2\nexport { hop3 }\n`,
    },
    imports: '{ hop3 }',
    entry: 'zz-c13-a',
    caught: true,
  },
  {
    name: '14. `export *` from a barrel that itself renamed the forward',
    shared: {
      'zz-c14-b': `export { can as renamedCan } from '@/lib/permissions'\n`,
      'zz-c14-a': `export * from './zz-c14-b'\n`,
    },
    imports: '{ renamedCan }',
    entry: 'zz-c14-a',
    caught: true,
  },
  {
    name: '15. the same laundering applied to `isOwner`, not `can`',
    shared: {
      'zz-c15-a': `import { isOwner as flag } from '@/lib/permissions'\nexport const ownerCheck = flag\n`,
    },
    imports: '{ ownerCheck }',
    entry: 'zz-c15-a',
    caught: true,
  },

  // ── What must stay ALLOWED ──────────────────────────────────────────────────
  {
    // Exactly `lib/workspace/authz.ts`'s shape: uses the shared machinery, exposes its own API.
    name: '16. a shared module that USES can() internally and exports a new function',
    shared: {
      'zz-c16-a': `import { can } from '@/lib/permissions'\nexport async function mayApprove(ctx: never): Promise<boolean> { return can(ctx, 'approval.decide' as never) }\n`,
    },
    imports: '{ mayApprove }',
    entry: 'zz-c16-a',
    caught: false,
  },
  {
    name: '17. a shared module with no unsafe dependency at all',
    shared: {
      'zz-c17-a': `export function formatTenantLabel(name: string): string { return name.trim() }\n`,
    },
    imports: '{ formatTenantLabel }',
    entry: 'zz-c17-a',
    caught: false,
  },
  {
    name: '18. a safe one-hop barrel',
    shared: {
      'zz-c18-b': `export function formatTenantLabel(name: string): string { return name.trim() }\n`,
      'zz-c18-a': `export * from './zz-c18-b'\n`,
    },
    imports: '{ formatTenantLabel }',
    entry: 'zz-c18-a',
    caught: false,
  },
  {
    name: '19. cyclic SAFE barrels terminate with no violation',
    shared: {
      'zz-c19-a': `export * from './zz-c19-b'\nexport const alpha = 1\n`,
      'zz-c19-b': `export * from './zz-c19-a'\nexport const beta = 2\n`,
    },
    imports: '{ alpha }',
    entry: 'zz-c19-a',
    caught: false,
  },
  {
    name: '20. a locally-defined wrapper assigned to a const arrow function',
    shared: {
      'zz-c20-a': `import { can } from '@/lib/permissions'\nexport const mayApprove = async (ctx: never) => can(ctx, 'approval.decide' as never)\n`,
    },
    imports: '{ mayApprove }',
    entry: 'zz-c20-a',
    caught: false,
  },
  {
    name: '21. an unrelated local identifier that merely happens to be named `can`',
    shared: {
      'zz-c21-a': `function can(x: string): string { return x }\nexport { can }\n`,
    },
    imports: '{ can }',
    entry: 'zz-c21-a',
    caught: false,
  },
]

describe('the guard follows re-export chains and local renames out of the Workspace tree', () => {
  // Written as REAL temporary modules, because the bypass by definition lives in a second file
  // the guard has to go and read — a synthetic string cannot express it. Each case uses its own
  // filenames, and every file is removed again in `finally`.
  it.each(EXPOSURE_CASES.map((c) => [c.name, c] as const))('%s', (_label, testCase) => {
    const consumer = join(WS_DIR, `${testCase.entry}-consumer.ts`)
    const files: Record<string, string> = {
      [consumer]: `import ${testCase.imports} from '@/lib/workspace/${testCase.entry}'\nexport const probe = ${
        testCase.imports.replace(/[{}]/g, '').trim().split(/\s*,\s*/)[0]
      }\n`,
    }
    for (const [name, content] of Object.entries(testCase.shared)) {
      files[join(SHARED_DIR, `${name}.ts`)] = content
    }

    withTempModules(files, () => {
      const found = violations(consumer, readFileSync(consumer, 'utf8'))
      if (testCase.caught) {
        expect(found.length, `expected a violation, got none`).toBeGreaterThan(0)
        expect(found.join(' ')).toContain('transitively')
      } else {
        expect(found, `expected no violation, got ${found.join(' | ')}`).toEqual([])
      }
    })
  })

  it('the real lib/workspace/authz.ts is not flagged, and is genuinely on the Workspace path', () => {
    // The sanctioned route — Workspace -> authz -> lib/permissions — must survive. If this ever
    // fails, the rule has drifted from EXPOSURE back to bare reachability.
    resetExposureAnalysis()
    const authz = resolveToLocalFile('@/lib/workspace/authz', join(WS_DIR, 'x.ts'))
    expect(authz).not.toBeNull()
    expect([...unsafeExportsOf(authz as string)]).toEqual([])

    const page = join(ROOT, 'app', 'isola-workspace', 'preview', 'page.tsx')
    expect(readFileSync(page, 'utf8')).toContain("from '@/lib/workspace/authz'")
    expect(violations(page, readFileSync(page, 'utf8'))).toEqual([])
  })
})
