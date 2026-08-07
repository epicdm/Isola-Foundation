import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `preview/page.tsx` is a Next.js Server Component. This repository has no `page.tsx` test
 * anywhere (checked: zero `page.test.tsx` files exist), so this file is a SOURCE-BOUNDARY
 * check only: it proves the route calls the right functions and never reintroduces a known-bad
 * shape, but it cannot prove EXECUTION ORDER or that the unauthorized branch's body actually
 * returns — a later independent re-review demonstrated exactly that gap by negative control
 * (`defect-pr82-authorization-wiring-test-control-flow-gap-2026-08-06`): altering the
 * unauthorized branch while leaving its `if` line untouched left every test in the previous
 * version of this file green.
 *
 * The real fix is `lib/isola-workspace/preview-authorization.ts`'s
 * `resolveWorkspacePreviewRequest` — a PURE function extracted out of the page specifically so
 * order, denied-branch output and no-fixture-on-denied can be proven BEHAVIORALLY, on the
 * function's return value, in `preview-authorization.test.ts`. This file is retained only to
 * prove `page.tsx` actually calls that seam rather than reimplementing the decision inline —
 * "do not rely on source text alone" means the behavioral coverage lives elsewhere, not that
 * this file is unnecessary.
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

describe('the preview route composes real authorization, not URL trust (source boundary)', () => {
  const page = readFileSync(PAGE_PATH, 'utf8')
  const code = stripComments(page)

  it('resolves the real session and workspace authorization level', () => {
    expect(code).toMatch(/getSession\s*\(/)
    expect(code).toMatch(/resolveWorkspaceAuthz\s*\(/)
    expect(code).toMatch(/toWorkspaceRole\s*\(/)
  })

  it('decides authorization through the one pure route-decision seam, not inline logic', () => {
    expect(code).toMatch(/resolveWorkspacePreviewRequest\s*\(/)
    // narrowPreviewRole/resolvePreviewFixtureScenario are exercised BEHAVIORALLY, through
    // resolveWorkspacePreviewRequest, in preview-authorization.test.ts. If either reappears
    // here directly, the decision has been duplicated back into the page — the seam this
    // hardening pass introduced would be bypassed even though both underlying functions still
    // individually behave correctly.
    expect(code).not.toMatch(/narrowPreviewRole\s*\(/)
    expect(code).not.toMatch(/resolvePreviewFixtureScenario\s*\(/)
  })

  it('never assigns a params-derived role default of manager', () => {
    // The exact shape of the bug this correction fixed: `v === 'operator' || ... : 'manager'`.
    // A regression back to defaulting an absent/unknown role to 'manager' would match this.
    expect(code).not.toMatch(/:\s*['"]manager['"]\s*\n?\s*\}/)
    expect(code).not.toMatch(/normaliseRole/)
  })

  it('renders an unauthorized path when the route-decision function denies the request', () => {
    expect(code).toMatch(/if\s*\(\s*!request\.authorized\s*\)/)
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
