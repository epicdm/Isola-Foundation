import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `preview/page.tsx` is a Next.js Server Component, and this file is a SOURCE-BOUNDARY check
 * only: it proves the route calls the right functions and never reintroduces a known-bad shape.
 * It cannot prove execution order or that the unauthorized branch's body actually withholds
 * anything — an independent re-review demonstrated exactly that gap by negative control
 * (`defect-pr82-authorization-wiring-test-control-flow-gap-2026-08-06`): keeping the
 * `if (!request.authorized)` line but changing its body to also render fixture tenant data left
 * every test in the previous version of this file green.
 *
 * BEHAVIORAL coverage now lives in two places, and this file is the third, narrowest layer:
 *
 *   - `lib/isola-workspace/preview-authorization.test.ts` proves the DECISION on the returned
 *     value of the pure `resolveWorkspacePreviewRequest`.
 *   - `page.test.tsx` (this directory) renders the actual Server Component with `getSession`,
 *     `resolveWorkspaceAuthz` and `next/navigation` mocked, and asserts on the HTML a denied
 *     actor receives — closing the branch-body gap above. An earlier version of this comment
 *     claimed no `page.test.tsx` could exist here; that was wrong, and the file next door is the
 *     correction.
 *   - THIS file proves `page.tsx` still routes its decision through the seam rather than
 *     reimplementing it inline, which neither of the other two can see.
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

describe('the preview route no longer normalises an unsupported context into a real one', () => {
  const page = readFileSync(PAGE_PATH, 'utf8')
  const code = stripComments(page)

  it('resolves context through resolvePreviewContext', () => {
    expect(code).toMatch(/resolvePreviewContext\s*\(/)
  })

  it('has no normaliseContext helper left to map onboarding onto a real ModuleContext', () => {
    // The exact shape of the defect: `v === 'workspace' || v === 'onboarding' ? v : ...`, which
    // produced zero modules and the zero-module body's false plan-limitation copy
    // (`defect-pr82-onboarding-context-false-plan-state-2026-08-07`).
    expect(code).not.toMatch(/function\s+normaliseContext/)
    expect(code).not.toMatch(/['"]onboarding['"]\s*\?\s*v/)
  })

  it('renders a dedicated unsupported-context state rather than falling through', () => {
    expect(code).toMatch(/UnsupportedContextPreview/)
    expect(code).toMatch(/contextResolution\.supported/)
  })

  it('resolves context AFTER the authorization decision, never before', () => {
    const authIndex = code.indexOf('resolveWorkspacePreviewRequest(')
    const denyIndex = code.indexOf('request.authorized')
    const ctxIndex = code.indexOf('resolvePreviewContext(')

    expect(authIndex).toBeGreaterThan(-1)
    expect(denyIndex).toBeGreaterThan(authIndex)
    expect(ctxIndex).toBeGreaterThan(denyIndex)
  })

  it('the unsupported-context copy denies being a plan limitation', () => {
    // The state it replaces asserted the opposite. If this sentence is ever dropped, the page
    // stops actively correcting the impression the old copy created.
    expect(page).toMatch(/not a limit on any business/i)
    expect(page).not.toMatch(/plan does not include any of the sections/)
  })
})
