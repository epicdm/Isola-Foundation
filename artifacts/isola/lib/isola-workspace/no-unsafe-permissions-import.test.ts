/**
 * Architectural guard — closes the gap the PR #82 independent review demonstrated by negative
 * control: a correctly-typed call to `lib/permissions.ts`'s `can()` inside
 * `lib/isola-workspace/permissions.ts` passed typecheck and the full test suite with zero
 * detection. `permissions.ts`'s own header comment explains at length why `can()` is unsafe
 * here (`if (ctx.isAdmin || ctx.isOwner) return true`, and `User.role` defaults to `'owner'`
 * for every normal user) — but a comment is not a gate. This file is the gate.
 *
 * Scanning source text rather than importing modules deliberately: importing every file under
 * test would pull in Prisma/next/headers server-only code into vitest's `node` environment,
 * which is exactly the kind of accidental coupling this guard exists to prevent noticing too
 * late. A grep-shaped check is slower to write and faster to trust.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
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

/**
 * The unsafe module, however it might be imported. `@/lib/permissions` is the alias form used
 * everywhere else in this repo; the relative forms only apply from outside `lib/isola-workspace`
 * (a file at `lib/isola-workspace/x.ts` reaching `lib/permissions.ts` needs `../permissions`,
 * never a bare `./permissions` — that stays the SAFE `lib/isola-workspace/permissions.ts`).
 */
const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+['"]@\/lib\/permissions['"]/,
  /require\(\s*['"]@\/lib\/permissions['"]\s*\)/,
  /from\s+['"]\.\.\/permissions['"]/, // lib/isola-workspace/**/x.ts -> ../permissions == lib/permissions.ts
]

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
 * statements are still checked against the raw content — a commented-out import is not a
 * live violation, but this guard errs toward the simpler, stricter reading for imports since
 * a real import can never legitimately appear only in prose.
 */
function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

function violations(path: string, content: string): string[] {
  const found: string[] = []
  for (const p of FORBIDDEN_IMPORT_PATTERNS) {
    if (p.test(content)) found.push(`imports the unsafe lib/permissions.ts module (matched ${p})`)
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
  it('flags a synthetic file containing the forbidden import', () => {
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
})
