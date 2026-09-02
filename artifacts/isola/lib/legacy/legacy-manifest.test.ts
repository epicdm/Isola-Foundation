import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  FORBIDDEN_IN_PERMANENT_MODULES,
  LEGACY_COMMUNICATIONS,
  LEGACY_PATHS,
  PERMANENT_MODULE_ROOTS,
} from './legacy-manifest'

const APP_ROOT = resolve(__dirname, '../..')

function walk(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

describe('legacy manifest is accurate', () => {
  it('every listed legacy path still exists', () => {
    const missing = LEGACY_PATHS.filter((p) => !existsSync(join(APP_ROOT, p)))
    // A missing path means someone removed legacy code without going through the
    // removal gate, OR the manifest drifted. Both need a human, not a silent pass.
    expect(missing).toEqual([])
  })

  it('has no duplicate entries', () => {
    expect(new Set(LEGACY_PATHS).size).toBe(LEGACY_PATHS.length)
  })

  it('every entry names a replacement contract and a removal prerequisite', () => {
    for (const m of LEGACY_COMMUNICATIONS) {
      expect(m.replacedBy.trim().length, `${m.path} replacedBy`).toBeGreaterThan(0)
      expect(m.removalPrerequisite.trim().length, `${m.path} prerequisite`).toBeGreaterThan(0)
    }
  })
})

describe('IMPORT BOUNDARY — permanent Foundation code may not depend on legacy transport', () => {
  const permanentFiles = PERMANENT_MODULE_ROOTS.flatMap((root) => walk(join(APP_ROOT, root)))

  it('finds permanent modules to check', () => {
    expect(permanentFiles.length).toBeGreaterThan(0)
  })

  it('no permanent module imports a legacy module', () => {
    const violations: string[] = []
    // Match the module specifier only: `from './x'`, `import('./x')`, `require('./x')`.
    const legacyStems = LEGACY_PATHS.map((p) => p.replace(/\.tsx?$/, ''))

    for (const file of permanentFiles) {
      if (/\.test\.tsx?$/.test(file)) continue
      const src = readFileSync(file, 'utf8')
      const specifiers = [...src.matchAll(/(?:from|import|require)\s*\(?\s*['"]([^'"]+)['"]/g)].map(
        (m) => m[1],
      )
      for (const spec of specifiers) {
        const normalized = spec.replace(/^@\//, '')
        for (const stem of legacyStems) {
          if (normalized === stem || normalized.endsWith('/' + stem)) {
            violations.push(`${relative(APP_ROOT, file)} -> ${spec}`)
          }
        }
      }
    }
    expect(violations).toEqual([])
  })

  it('no permanent module carries a provider hostname or credential env read', () => {
    const violations: string[] = []
    for (const file of permanentFiles) {
      const src = readFileSync(file, 'utf8')
      // Doc comments legitimately name providers; check code only.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      for (const pattern of FORBIDDEN_IN_PERMANENT_MODULES) {
        if (pattern.test(code)) violations.push(`${relative(APP_ROOT, file)} matches ${pattern}`)
      }
    }
    expect(violations).toEqual([])
  })
})
