import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { ACTION_STATE_LABEL } from './action-lifecycle'
import { ALL_MODULE_DESCRIPTORS } from './modules'

/**
 * THE LAW THIS FILE ENFORCES
 * --------------------------
 * An operator never learns a system name. Not in a label, a tooltip, an `aria-label`, a
 * `title`, a placeholder or an error string. Sources are described by what they hold —
 * "sales records", "the phone system", "billing", "messaging", "the conversation".
 *
 * This is enforced by scanning real source rather than trusted as a convention, because it
 * is exactly the kind of rule that decays: one hurried error message naming Odoo and the
 * abstraction the whole product rests on is gone.
 *
 * WHY A SOURCE SCAN AND NOT A RENDER ASSERTION
 * --------------------------------------------
 * A render assertion only covers the props a test happens to pass. A leak in an unexercised
 * error branch — precisely where it is most likely — would pass. Scanning the source catches
 * every string literal regardless of which branch produces it.
 *
 * The tradeoff is false positives on legitimate mentions in comments and imports, so the
 * scanner strips comments and import statements before checking, and only inspects string
 * and JSX-text content. Deliberately allowlist-shaped, following the discipline in
 * `scripts/src/guard-chatwoot-safe-read.ts`.
 */

/** Names an operator must never see. Case-insensitive, word-boundary matched. */
const FORBIDDEN_SYSTEM_NAMES = [
  'Odoo',
  'Clawith',
  'MagnusBilling',
  'Magnus',
  'PBX',
  'Chatwoot',
  'Atlas Foundation', // guard against the phrase, not the word "Foundation" alone
] as const

/**
 * `Foundation` and `Meta` are handled separately: both are ordinary English words
 * ("the foundation of", "meta description") and a naive match produces noise. They are
 * checked only in operator-facing copy contexts.
 */
const CONTEXT_SENSITIVE_NAMES = ['Foundation', 'Meta'] as const

const COMPONENT_ROOT = join(process.cwd(), 'components', 'isola-workspace')

function walk(dir: string): string[] {
  let out: string[] = []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out = out.concat(walk(full))
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full)
    }
  }
  return out
}

/**
 * Strip everything that is not operator-visible: comments (where naming a system is not
 * merely allowed but encouraged, for the next engineer), import statements, and the token
 * strings in className attributes.
 */
function operatorVisibleText(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ') // line comments, sparing `https://`
    .replace(/^\s*import\s[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, ' ') // imports
    .replace(/className=\{?["'`][\s\S]*?["'`]\}?/g, ' ') // utility classes
    .replace(/var\(--[a-z0-9-]+\)/gi, ' ') // css vars
}

describe('no operator-visible string names a system', () => {
  const files = walk(COMPONENT_ROOT)

  it('finds component source to scan', () => {
    // A silently-empty scan would pass forever and prove nothing.
    expect(files.length).toBeGreaterThan(0)
  })

  it.each(FORBIDDEN_SYSTEM_NAMES)('never says "%s"', (name) => {
    const pattern = new RegExp(`\\b${name}\\b`, 'i')
    const offenders: string[] = []

    for (const file of files) {
      const visible = operatorVisibleText(readFileSync(file, 'utf8'))
      if (pattern.test(visible)) {
        const line = visible.split('\n').find((l) => pattern.test(l))?.trim().slice(0, 120)
        offenders.push(`${file.replace(process.cwd(), '')}: ${line}`)
      }
    }

    expect(offenders).toEqual([])
  })

  it.each(CONTEXT_SENSITIVE_NAMES)('never says "%s" inside a user-facing attribute', (name) => {
    // aria-label, title, placeholder and alt are pure operator-facing copy: a system name in
    // any of them is a leak even though the bare word is ordinary English elsewhere.
    const pattern = new RegExp(
      `(aria-label|title|placeholder|alt)=\\{?["'\`][^"'\`]*\\b${name}\\b`,
      'i',
    )
    const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('the module vocabulary describes operator work, not systems', () => {
  it('every module label names an activity', () => {
    const labels = ALL_MODULE_DESCRIPTORS.map((m) => m.label)
    expect(labels).toEqual(['Customer', 'Work', 'AI Team', 'Today', 'Phone', 'Billing'])

    for (const label of labels) {
      for (const banned of FORBIDDEN_SYSTEM_NAMES) {
        expect(label.toLowerCase()).not.toContain(banned.toLowerCase())
      }
    }
  })

  it('every module label fits a pinned tab', () => {
    for (const m of ALL_MODULE_DESCRIPTORS) {
      expect(m.label.length).toBeLessThanOrEqual(10)
    }
  })

  it('every module states its purpose in operator language', () => {
    for (const m of ALL_MODULE_DESCRIPTORS) {
      expect(m.purpose.length).toBeGreaterThan(10)
      for (const banned of FORBIDDEN_SYSTEM_NAMES) {
        expect(m.purpose.toLowerCase()).not.toContain(banned.toLowerCase())
      }
    }
  })

  it('every governed action describes its owning system in plain English', () => {
    const plainEnglish = ['conversation', 'salesRecords', 'phoneSystem', 'billing', 'messaging']
    for (const m of ALL_MODULE_DESCRIPTORS) {
      for (const a of m.governedActions) {
        expect(plainEnglish).toContain(a.owningSystem)
      }
    }
  })

  it('every governed action consequence says whether the customer is contacted', () => {
    // An operator approving a change must know whether it reaches a customer. Every
    // consequence string therefore has to speak to that explicitly.
    for (const m of ALL_MODULE_DESCRIPTORS) {
      for (const a of m.governedActions) {
        expect(a.consequence.toLowerCase()).toMatch(/customer|caller/)
      }
    }
  })

  it('uses the reviewed status words, not product language', () => {
    expect(Object.values(ACTION_STATE_LABEL)).toEqual(
      expect.arrayContaining(['Done and confirmed', 'Did not work', 'Awaiting your approval']),
    )
  })
})
