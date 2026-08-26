/**
 * Isola Workspace preview route — BEHAVIORAL authorization test.
 *
 * Closes `defect-pr82-authorization-wiring-test-control-flow-gap-2026-08-06`.
 *
 * THE GAP THIS FILE CLOSES
 * ------------------------
 * `authorization-wiring.test.ts` is a source-boundary check: it proves `page.tsx` calls the
 * right functions, but it cannot prove that the unauthorized branch's BODY actually withholds
 * anything. An independent reviewer demonstrated the consequence by negative control — keeping
 * the exact `if (!request.authorized)` line but changing its body to render
 * `<UnauthorizedPreview />` PLUS `fixtureTenant('epic').name` compiled cleanly and left
 * typecheck, the wiring tests and the entire focused suite green, while a denied actor received
 * fixture tenant data.
 *
 * `resolveWorkspacePreviewRequest` already proves the DECISION behaviorally
 * (`preview-authorization.test.ts`). This file proves the route's DISPATCH on that decision:
 * it renders the actual Server Component and asserts on the HTML a denied actor receives.
 *
 * WHY THIS IS POSSIBLE HERE
 * -------------------------
 * A Next.js async Server Component is, for this route, just an async function returning JSX.
 * The repository already has both halves of what that needs: `renderToStaticMarkup` (the
 * established rendering pattern in `isola-workspace-view.test.tsx`) and `vi.mock` (used by ~10
 * `app/api` route tests). The three server-only edges — session, Membership authorization and
 * `redirect` — are mocked; everything below them is the real page, the real registry, the real
 * fixture adapter and the real components.
 *
 * WHAT IS DELIBERATELY NOT MOCKED
 * -------------------------------
 * `resolveWorkspacePreviewRequest`, `toWorkspaceRole`, `narrowPreviewRole`, the registry and
 * the fixture adapter all run for real. Mocking any of them would make this test prove only
 * that mocks were wired, which is the failure mode the source-boundary test already has.
 */
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`)
  },
}))

const getSession = vi.fn()
const resolveWorkspaceAuthz = vi.fn()

vi.mock('@/lib/session', () => ({ getSession: () => getSession() }))
vi.mock('@/lib/workspace/authz', () => ({
  resolveWorkspaceAuthz: (ctx: unknown) => resolveWorkspaceAuthz(ctx),
}))

import Page from './page'

const SESSION = { user: { id: 'u-denied-1', name: 'Someone Without Access' } }

/**
 * Every distinctive string that only exists BEHIND the gate. A denied actor must receive none
 * of them. Listing the whole set — rather than one known tenant name — is the point: the
 * reviewer's control leaked a tenant name, but an equally plausible regression leaks a module
 * label, a permission id, a customer name or an opportunity value instead.
 *
 * Deliberately excludes strings that legitimately appear in the unauthorized notice itself
 * (e.g. bare `Work`, which is a substring of "Workspace" in that copy) — an assertion that
 * cannot fail teaches nothing.
 */
const FIXTURE_SENTINELS: readonly string[] = [
  // Tenant identity (fixture or otherwise).
  'EPIC Communications',
  'Marché Créole',
  'Angela Marcelle',
  'Claudette Régis',
  // Module labels / navigation.
  'AI Team',
  'Billing',
  'Customer',
  'Phone',
  'Today',
  // Permission names.
  'customer.read',
  'billing.read',
  'today.read.team',
  'work.approve',
  // Customer identity and commercial values.
  'Joss Boutique',
  'Eric Giraud',
  'Connectivity and AI Front Desk Package',
  'EC$4,850',
  'EC$305.00',
  'EC$14,050',
  // Telephony.
  '+1 767 555 0148',
  'extension 101',
  // AI team members.
  'Atlas',
  'Nova',
  // Scenario labels and fixture identifiers.
  'customer-none',
  'customer-many',
  'marche',
  'joss-boutique',
  'QT-1642-B',
  'epic-cz-revenue-loop1',
]

/** Shell/module chrome only ever emitted on the authorized path. */
const SHELL_MARKUP = /data-iso-(tab|module|intent|sheet|state)/

function expectDeniedOutput(html: string) {
  expect(html).toContain('You do not have access to this preview')
  for (const sentinel of FIXTURE_SENTINELS) {
    expect(html, `denied output must not contain "${sentinel}"`).not.toContain(sentinel)
  }
  expect(html).not.toMatch(SHELL_MARKUP)
}

async function renderPage(query: Record<string, string | string[]> = {}) {
  const element = (await Page({ searchParams: Promise.resolve(query) as never })) as ReactElement
  return renderToStaticMarkup(element)
}

/**
 * The widest query a denied actor could plausibly try: ask for the highest role, every fixture
 * scenario name, the deprecated tenant alias, and a specific module. None of it may help.
 */
const HOSTILE_QUERIES: readonly Record<string, string | string[]>[] = [
  {},
  { role: 'admin' },
  { role: 'admin', scenario: 'epic', module: 'billing' },
  { scenario: 'marche', module: 'phone' },
  { scenario: 'customer-none' },
  { scenario: 'customer-many', role: 'manager' },
  { tenant: 'marche' },
  { role: ['admin', 'operator'], scenario: ['epic', 'marche'] },
  { context: 'workspace', state: 'ready', sheet: '1' },
]

beforeEach(() => {
  getSession.mockReset()
  resolveWorkspaceAuthz.mockReset()
  getSession.mockResolvedValue(SESSION)
})

describe('preview route — a denied actor receives the notice and nothing else', () => {
  const DENIED_AUTHZ = [
    ['no Membership at all', { level: 'denied', basis: 'no-membership', membershipRole: null }],
    ['staff Membership', { level: 'denied', basis: 'staff', membershipRole: 'staff' }],
    // `toWorkspaceRole`'s switch is closed, so this cannot arise today; the route must still
    // fail closed if a future authz level is added without updating the mapping.
    ['a malformed authorization level', { level: 'something-new', basis: 'unknown', membershipRole: null }],
  ] as const

  for (const [label, authz] of DENIED_AUTHZ) {
    it(`${label}: no query combination yields any fixture, tenant, module or permission data`, async () => {
      resolveWorkspaceAuthz.mockResolvedValue(authz)
      for (const query of HOSTILE_QUERIES) {
        expectDeniedOutput(await renderPage(query))
      }
    })
  }

  it('the session gate still runs before authorization (no session redirects)', async () => {
    getSession.mockResolvedValue(null)
    resolveWorkspaceAuthz.mockResolvedValue({ level: 'owner', basis: 'platform-admin', membershipRole: null })
    await expect(renderPage()).rejects.toThrow('REDIRECT:/')
    expect(resolveWorkspaceAuthz).not.toHaveBeenCalled()
  })
})

describe('preview route — the authorized control case proves the assertions are not vacuous', () => {
  const MANAGER_AUTHZ = {
    level: 'manager',
    basis: 'membership',
    membershipRole: 'admin',
    canViewAudit: false,
    canViewConfiguration: false,
  }

  it('an authorized manager DOES receive the workspace shell, tenant and module data', async () => {
    resolveWorkspaceAuthz.mockResolvedValue(MANAGER_AUTHZ)
    const html = await renderPage({ module: 'customer' })

    expect(html).not.toContain('You do not have access to this preview')
    // The exact things withheld above are present here — otherwise the denied assertions could
    // pass simply because the strings never render anywhere.
    expect(html).toContain('EPIC Communications')
    expect(html).toContain('Joss Boutique')
    expect(html).toContain('AI Team')
    expect(html).toMatch(SHELL_MARKUP)
  })

  it('a manager cannot widen to admin through the query, but is still served', async () => {
    resolveWorkspaceAuthz.mockResolvedValue(MANAGER_AUTHZ)
    const html = await renderPage({ role: 'admin', module: 'customer' })
    expect(html).not.toContain('You do not have access to this preview')
    // Billing is admin-only in the fixture entitlement/permission tables; a manager who asked
    // for admin must not gain it.
    expect(html).not.toContain('EC$305.00')
  })
})
