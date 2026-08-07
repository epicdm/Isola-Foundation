import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `preview/page.tsx` is a Next.js Server Component. This repository has no `page.tsx` test
 * anywhere (checked: zero `page.test.tsx` files exist), so the pure logic it composes
 * (`narrowPreviewRole`, `resolvePreviewFixtureScenario` — both covered by
 * `lib/isola-workspace/preview-authorization.test.ts`) is the only part of the authorization
 * fix that ordinary behavioral tests can reach. This file closes the remaining gap the same
 * way `lib/isola-workspace/no-unsafe-permissions-import.test.ts` closes the `can()` gap: a
 * source-text guard that fails if the page stops calling the safe functions, or starts
 * reintroducing the exact patterns the correction removed (`?role=` trusted directly, an
 * absent-role default of `'manager'`, `?tenant=` treated as authorization).
 */

const PAGE_PATH = join(__dirname, 'page.tsx')
const MIDDLEWARE_PATH = join(__dirname, '..', '..', '..', 'middleware.ts')
const WORKSPACE_VIEW_PATH = join(
  __dirname,
  '..',
  '..',
  '..',
  'components',
  'isola-workspace',
  'isola-workspace-view.tsx',
)

function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

describe('the preview route composes real authorization, not URL trust', () => {
  const page = readFileSync(PAGE_PATH, 'utf8')
  const code = stripComments(page)

  it('resolves the real session and workspace authorization level', () => {
    expect(code).toMatch(/getSession\s*\(/)
    expect(code).toMatch(/resolveWorkspaceAuthz\s*\(/)
    expect(code).toMatch(/toWorkspaceRole\s*\(/)
  })

  it('narrows the role through the one function that refuses to widen it', () => {
    expect(code).toMatch(/narrowPreviewRole\s*\(/)
  })

  it('never assigns a params-derived role default of manager', () => {
    // The exact shape of the bug this correction fixed: `v === 'operator' || ... : 'manager'`.
    // A regression back to defaulting an absent/unknown role to 'manager' would match this.
    expect(code).not.toMatch(/:\s*['"]manager['"]\s*\n?\s*\}/)
    expect(code).not.toMatch(/normaliseRole/)
  })

  it('resolves the fixture scenario through the allowlisted, non-authoritative function', () => {
    expect(code).toMatch(/resolvePreviewFixtureScenario\s*\(/)
  })

  it('renders an unauthorized path when no authoritative role was resolved', () => {
    expect(code).toMatch(/if\s*\(\s*!authoritativeRole\s*\)/)
  })
})

describe('/isola-workspace has the same middleware authentication backstop as other protected routes', () => {
  const middleware = readFileSync(MIDDLEWARE_PATH, 'utf8')

  it('is listed in PROTECTED_PREFIXES', () => {
    const prefixesBlock = middleware.match(/PROTECTED_PREFIXES\s*=\s*\[[\s\S]*?\]/)?.[0] ?? ''
    expect(prefixesBlock).toContain("'/isola-workspace'")
  })

  it('is listed in the route matcher', () => {
    const matcherBlock = middleware.match(/matcher:\s*\[[\s\S]*?\]/)?.[0] ?? ''
    expect(matcherBlock).toContain("'/isola-workspace/:path*'")
  })
})

describe('Today team visibility stays gated on the declared permission', () => {
  it('never regresses to a bare role-string shortcut for canSeeTeam', () => {
    // Old shape this correction removed: `canSeeTeam={role !== 'operator'}`. Behaviorally
    // indistinguishable from the permission-based gate for TODAY's PERMISSIONS_BY_ROLE table
    // (operator lacks today.read.team; manager/admin hold it), which is exactly why a
    // behavioral render test can't catch a regression here — only a source check can.
    const view = stripComments(readFileSync(WORKSPACE_VIEW_PATH, 'utf8'))
    expect(view).not.toMatch(/canSeeTeam=\{?\s*role\s*!==\s*['"]operator['"]/)
    expect(view).toMatch(/canSeeTeam=\{holdsAll\(permissionsForRole\(role\),\s*\[['"]today\.read\.team['"]\]\)\}/)
  })
})
