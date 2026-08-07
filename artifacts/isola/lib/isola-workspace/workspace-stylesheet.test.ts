/**
 * `defect-pr82-workspace-accessibility-semantics-contrast-2026-08-06`, tab-colour subfinding.
 *
 * WHY A STYLESHEET TEST EXISTS AT ALL
 * -----------------------------------
 * The whole suite renders markup with `renderToStaticMarkup` and never applies CSS, so a
 * negative control that reverted `.iso-root a:not([data-iso-nav])` back to `.iso-root a` was
 * caught by NOTHING — every markup assertion still passed while all five navigation tabs went
 * back to 3.13:1 accent purple in a browser. The component-side guard (`data-iso-nav` is
 * present on every nav link) is necessary but only half the pair: the attribute is inert unless
 * the selector honours it.
 *
 * So this asserts the other half, at the only level where it is observable without a browser:
 * the stylesheet source. It is a source guard, deliberately narrow, and it is not a substitute
 * for the measured contrast evidence — that is recorded from the built stylesheet in a real
 * rendering.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS_PATH = join(__dirname, '..', '..', 'styles', 'isola-workspace.css')

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '')
}

describe('the panel link rule never swallows module navigation', () => {
  const css = stripCssComments(readFileSync(CSS_PATH, 'utf8'))

  it('has no unqualified `.iso-root a` colour rule', () => {
    // The exact regression: an element selector (0,1,1) that outranks the utility class (0,1,0)
    // carrying each tab's own active/inactive colour.
    const unqualified = css.match(/\.iso-root\s+a\s*\{[^}]*\}/g) ?? []
    for (const rule of unqualified) {
      expect(rule).not.toMatch(/\bcolor\s*:/)
    }
  })

  it('colours content links only, excluding navigation', () => {
    expect(css).toMatch(/\.iso-root\s+a:not\(\[data-iso-nav\]\)\s*\{[^}]*color\s*:/)
  })

  it('applies the same exclusion to the hover colour', () => {
    expect(css).toMatch(/\.iso-root\s+a:not\(\[data-iso-nav\]\):hover\s*\{[^}]*color\s*:/)
  })

  it('does not reach for !important to win the specificity fight', () => {
    // An `!important` here would beat the utility in the other direction and make a tab's own
    // colour unsettable — trading one override bug for its mirror image.
    const linkRules = css.match(/\.iso-root\s+a[^{]*\{[^}]*\}/g) ?? []
    for (const rule of linkRules) {
      expect(rule).not.toContain('!important')
    }
  })

  it('still defines the focus ring every interactive element depends on', () => {
    // The correction touches link styling; the focus indicator must survive it untouched.
    expect(css).toMatch(/\.iso-root\s+:focus-visible\s*\{[^}]*outline\s*:/)
  })
})
