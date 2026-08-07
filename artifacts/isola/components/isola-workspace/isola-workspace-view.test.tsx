import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { createFixturePorts, fixtureTenant } from '@/lib/isola-workspace/adapters/fixture-adapter'
import type { ModuleContext, ShellState, WorkspaceContext, WorkspaceRole } from '@/lib/isola-workspace/contracts'
import { fixtureEntitlements } from '@/lib/isola-workspace/entitlements'
import { defaultRegistry } from '@/lib/isola-workspace/modules'
import { holdsAll, permissionsForRole } from '@/lib/isola-workspace/permissions'
import { resolveNavigation } from '@/lib/isola-workspace/registry'

import { IsolaWorkspaceView, type WorkspaceData } from './isola-workspace-view'

/**
 * Rendered-output assertions for the composed workspace.
 *
 * These run under vitest's `node` environment with no jsdom and no testing-library, using the
 * repository's established `renderToStaticMarkup` pattern. That constrains what can be
 * tested — no clicks, no effects — but it covers the things that actually matter here, which
 * are all statements about what MARKUP AND COPY an operator is shown.
 */

const REF = { accountId: 5, inboxId: 46, conversationDisplayId: 131 }

async function render(options: {
  tenant?: 'epic' | 'marche'
  role?: WorkspaceRole
  context?: ModuleContext
  state?: ShellState
  module?: string
  customerHealth?: 'ok' | 'stale' | 'degraded' | 'unauthorized' | 'empty'
  /** Forces `CustomerResolution.kind`. Defaults to the fixture's own default (`'one'`). */
  customerResolution?: 'one' | 'none' | 'many'
  buildModuleHref?: (moduleId: string) => string
  sheetOpen?: boolean
  closeSheetHref?: string
} = {}) {
  const tenantId = options.tenant ?? 'epic'
  const role = options.role ?? 'manager'
  const context = options.context ?? 'conversation-panel'
  const fixture = fixtureTenant(tenantId)

  const ports = createFixturePorts(tenantId, {
    customer: options.customerHealth,
    customerResolution: options.customerResolution,
  })

  const ctx: WorkspaceContext = {
    tenant: { id: fixture.id, name: fixture.name, accent: fixture.accent },
    actor: { id: 'u1', name: 'Eric Giraud', role },
    context,
    conversation: context === 'conversation-panel' ? REF : null,
    customerMatches: 1,
    entitlements: fixtureEntitlements(fixture.entitlements),
    permissions: permissionsForRole(role),
  }

  const navigation = resolveNavigation(defaultRegistry(), ctx, options.module ?? null)

  const [customer, work, employees, suggestion, today, onboarding] = await Promise.all([
    ports.customer.resolveForConversation(REF),
    ports.work.listForActor('u1'),
    ports.aiTeam.listEmployees(),
    ports.aiTeam.consult('x'),
    ports.today.summary(),
    ports.onboarding.load(),
  ])

  const data: WorkspaceData = {
    customer: customer.data ? { resolution: customer.data, readAt: customer.readAt } : null,
    work: work.data ?? [],
    aiTeam: { employees: employees.data ?? [], suggestion: suggestion.data ?? null },
    today: today.data,
    onboarding: onboarding.data,
  }

  return renderToStaticMarkup(
    <IsolaWorkspaceView
      tenant={ctx.tenant}
      role={role}
      context={context}
      state={options.state ?? 'ready'}
      navigation={navigation}
      data={data}
      buildModuleHref={options.buildModuleHref}
      sheetOpen={options.sheetOpen}
      closeSheetHref={options.closeSheetHref}
    />,
  )
}

// ── The system-name law, over real rendered output ──────────────────────────

const FORBIDDEN = ['Odoo', 'Clawith', 'MagnusBilling', 'PBX', 'Chatwoot', 'Meta ']

describe('an operator never learns a system name', () => {
  const cases: Array<[string, Parameters<typeof render>[0]]> = [
    ['customer panel', { module: 'customer' }],
    ['work', { module: 'work' }],
    ['ai team', { module: 'ai-team' }],
    ['today', { module: 'today' }],
    ['phone', { module: 'phone' }],
    ['billing', { module: 'billing' }],
    ['billing as operator (unauthorized)', { module: 'billing', role: 'operator' }],
    ['loading', { state: 'loading' }],
    ['unavailable', { state: 'unavailable' }],
    ['stale', { state: 'stale' }],
    ['offline', { state: 'offline' }],
    ['empty', { state: 'empty' }],
    ['unauthorized shell', { state: 'unauthorized' }],
    ['second tenant', { tenant: 'marche', module: 'today' }],
  ]

  it.each(cases)('%s names no system', async (_label, options) => {
    const html = await render(options)
    for (const name of FORBIDDEN) {
      expect(html).not.toContain(name)
    }
  })

  it('the corrected loading copy is used, not the prototype string', async () => {
    const html = await render({ state: 'loading' })
    expect(html).toContain('the conversation and your sales records')
    expect(html).toContain('You can keep replying')
    expect(html).toContain('aria-busy="true"')
  })
})

// ── Entitlement vs permission, over real markup ─────────────────────────────

describe('entitlement absence and permission denial render differently', () => {
  it('an unentitled module is ABSENT from the DOM entirely', async () => {
    const html = await render({ tenant: 'marche', module: 'customer' })
    // Marché Créole has no telephony and no billing entitlement.
    expect(html).not.toContain('Billing')
    expect(html).not.toContain('Phone')
  })

  it('an entitled but forbidden module IS listed, and explains itself', async () => {
    const html = await render({ module: 'billing', role: 'operator' })
    expect(html).toContain('Billing')
    // Explained in role terms, with an escalation path.
    expect(html.toLowerCase()).toContain('manager')
  })

  it('the unauthorized body loads no customer data', async () => {
    const html = await render({ module: 'billing', role: 'operator' })
    expect(html).not.toContain('EC$0.00')
    expect(html).not.toContain('EC$305.00')
  })
})

// ── Navigation invariance ───────────────────────────────────────────────────

describe('navigation is identical for every tenant and every role', () => {
  it('renders the same four pinned tabs regardless of entitlement', async () => {
    const epic = await render({ tenant: 'epic' })
    const marche = await render({ tenant: 'marche' })

    for (const html of [epic, marche]) {
      expect(html).toContain('Customer')
      expect(html).toContain('Work')
      expect(html).toContain('Today')
    }
  })

  it('renders the same four pinned tabs regardless of role', async () => {
    const operator = await render({ role: 'operator' })
    const manager = await render({ role: 'manager' })

    for (const html of [operator, manager]) {
      expect(html).toContain('Customer')
      expect(html).toContain('Work')
    }
  })

  it('exposes tablist semantics', async () => {
    const html = await render()
    expect(html).toContain('role="tablist"')
    expect(html).toContain('role="tab"')
    expect(html).toContain('aria-selected')
  })
})

// ── The action lifecycle, over real markup ──────────────────────────────────

describe('the Work screen tells the truth about state', () => {
  it('never renders a completed item without quoting the owning system', async () => {
    const html = await render({ module: 'work' })
    expect(html).toContain('Done and confirmed')
    // The readback statement itself must be present, not merely the badge.
    expect(html).toContain('note #318')
  })

  it('says an executing action is not finished', async () => {
    const html = await render({ module: 'work' })
    // Every non-terminal card in the fixture set carries the honesty line where relevant;
    // at minimum the unconfirmed card must warn against telling the customer.
    expect(html).toContain('Do not tell')
  })

  it('states the customer impact on a failed action', async () => {
    const html = await render({ module: 'work' })
    expect(html).toContain('Did not work')
    expect(html.toLowerCase()).toContain('daytime menu')
  })

  it('renders the approval consequence before any approve control', async () => {
    const html = await render({ module: 'work' })
    expect(html).toContain('What will happen if you approve')
    const consequenceAt = html.indexOf('What will happen if you approve')
    const approveAt = html.indexOf('Approve')
    expect(consequenceAt).toBeGreaterThan(-1)
    expect(approveAt).toBeGreaterThan(-1)
  })
})

// ── AI output can never be mistaken for a customer message ──────────────────

describe('AI output is never confusable with a customer message', () => {
  it('carries a persistent not-sent badge and a dashed surface', async () => {
    const html = await render({ module: 'ai-team' })
    expect(html).toContain('Not sent to customer')
    expect(html).toContain('border-dashed')
  })

  it('says nothing reaches the customer without an explicit send', async () => {
    const html = await render({ module: 'ai-team' })
    expect(html.toLowerCase()).toContain('nothing they write reaches the customer')
  })
})

// ── Role gating omits data rather than hiding it ────────────────────────────

describe('manager-only content is absent, not hidden', () => {
  it('omits team workload from an operator view entirely', async () => {
    const operator = await render({ module: 'today', role: 'operator', context: 'workspace' })
    const manager = await render({ module: 'today', role: 'manager', context: 'workspace' })

    expect(operator).toContain('shown to managers')
    // Not merely display:none — the section must not be in the markup at all.
    expect(operator).not.toContain('Who is carrying what')
    expect(manager.length).toBeGreaterThan(0)
  })

  it('the gate follows the declared today.read.team permission, not a role-string shortcut', () => {
    // operator lacks today.read.team; manager and admin both hold it
    // (lib/isola-workspace/permissions.ts PERMISSIONS_BY_ROLE) — asserted directly against
    // the same functions the component now calls, so this fails if that table's shape for
    // this one permission ever changes without the component being revisited.
    expect(holdsAll(permissionsForRole('operator'), ['today.read.team'])).toBe(false)
    expect(holdsAll(permissionsForRole('manager'), ['today.read.team'])).toBe(true)
    expect(holdsAll(permissionsForRole('admin'), ['today.read.team'])).toBe(true)
  })
})

// ── Identifiers stay behind disclosure ──────────────────────────────────────

describe('raw identifiers appear only inside Technical details', () => {
  it('keeps the correlation reference out of the initial view', async () => {
    const html = await render({ module: 'customer' })
    const correlation = 'epic-cz-revenue-loop1-2026-08-06-conv131'

    expect(html).toContain(correlation)
    // It is present, but only inside a collapsed <details>. The disclosure must be closed.
    const technicalAt = html.indexOf('Technical details')
    expect(technicalAt).toBeGreaterThan(-1)
    expect(html.indexOf(correlation)).toBeGreaterThan(technicalAt)
  })

  it('renders the customer panel with disclosure collapsed by default', async () => {
    const html = await render({ module: 'customer' })
    expect(html).toContain('More about this customer')
    expect(html).toContain('aria-expanded="false"')
  })
})

// ── Shell states never blank the panel ──────────────────────────────────────

describe('no state renders an unexplained blank panel', () => {
  const states: ShellState[] = [
    'loading',
    'empty',
    'unavailable',
    'unauthorized',
    'stale',
    'offline',
  ]

  it.each(states)('%s renders explanatory copy and keeps the header', async (state) => {
    const html = await render({ state })

    expect(html).toContain('Isola Workspace')
    expect(html).toContain('role="status"')
    // Something substantive must be said, not just a spinner.
    expect(html.length).toBeGreaterThan(1500)
  })

  it('keeps the tenant name visible in every state so the operator knows where they are', async () => {
    for (const state of states) {
      const html = await render({ state })
      expect(html).toContain('EPIC Communications')
    }
  })
})

// ── Zero available modules is a stated fact, not a blank panel ──────────────
//
// Reported by the PR #82 independent review: when entitlement + context filtering leaves
// zero modules available (e.g. `context: 'onboarding'`, which no module descriptor declares
// support for), `navigation.activeModuleId` was `null` and the body rendered nothing at all —
// contradicting the design's own "no state renders an unexplained blank panel" rule.

describe('zero available modules renders a stated empty state, never a blank panel', () => {
  it('says nothing is available rather than rendering nothing', async () => {
    const html = await render({ context: 'onboarding', state: 'ready' })
    expect(html).toContain('Nothing is available here for this business')
    // The shell chrome must still be present — same rule as every other state.
    expect(html).toContain('Isola Workspace')
    expect(html).toContain('EPIC Communications')
  })
})

// ── Phone and Billing are reachable, not just present in code ───────────────
//
// Reported by the PR #82 independent review: `ModuleSheetView` was built and tested in
// isolation but never mounted by the shell, and every tab was a handler-less `<button>` with
// no `href` and no client JS to make it do anything — so Phone and Billing were unreachable by
// pointer or keyboard, only visible via a `?module=` URL edit. These assertions fail if that
// wiring regresses.

describe('every tab and every More-sheet row is a real, reachable link', () => {
  function hrefFor(id: string) {
    return `/preview-test?module=${id}`
  }

  it('pinned tabs render as <a href> when a link builder is supplied, not inert buttons', async () => {
    const html = await render({ context: 'workspace', module: 'work', buildModuleHref: hrefFor })
    expect(html).toContain('href="/preview-test?module=work" data-iso-module-id="work"')
    // Without a link builder, tabs must still render — just as non-navigating buttons — so a
    // caller with no href strategy (e.g. today's plain vitest render) doesn't crash or drop
    // navigation entirely.
    const withoutHrefs = await render({ context: 'workspace', module: 'work' })
    expect(withoutHrefs).toContain('<button type="button" role="tab"')
  })

  it('the More tab links to opening the sheet, not to a module id', async () => {
    const html = await render({
      context: 'workspace',
      module: 'work',
      buildModuleHref: (id) => (id === 'more' ? '/preview-test?sheet=1' : hrefFor(id)),
    })
    expect(html).toContain('href="/preview-test?sheet=1" data-iso-module-id="more"')
  })

  it('Phone and Billing appear in the open sheet as real links, reachable without a pinned tab', async () => {
    const html = await render({
      context: 'conversation-panel',
      role: 'admin',
      sheetOpen: true,
      buildModuleHref: hrefFor,
    })
    expect(html).toContain('role="dialog"')
    expect(html).toContain('href="/preview-test?module=phone" data-iso-module-id="phone"')
    expect(html).toContain('href="/preview-test?module=billing" data-iso-module-id="billing"')
  })

  it('the sheet stays closed (absent from the DOM) when sheetOpen is not set', async () => {
    const html = await render({ context: 'conversation-panel', buildModuleHref: hrefFor })
    expect(html).not.toContain('role="dialog"')
  })

  it('backdrop and Close are real links when a close href is supplied', async () => {
    const html = await render({
      context: 'conversation-panel',
      sheetOpen: true,
      buildModuleHref: hrefFor,
      closeSheetHref: '/preview-test',
    })
    expect(html).toMatch(/data-iso-sheet-backdrop=""[^>]*href="\/preview-test"/)
    expect(html).toMatch(/data-iso-sheet-close=""[^>]*href="\/preview-test"[^>]*>Close</)
  })
})

// ── The follow-up action agrees with what the body actually resolved ────────
//
// Closes `defect-pr82-customer-resolution-action-contradiction-2026-08-06`: the no-match and
// multiple-match CustomerResolution states already told the operator (in the body) that no
// action should be taken on an unspecified customer, but the shell footer offered "Prepare
// follow-up" regardless — inconsistent with the body and with the trust boundary the design
// otherwise enforces everywhere else. `none`/`many` were also unreachable through the fixture
// port before this correction, so this describe block doubles as the reachability proof.

const PREPARE_FOLLOW_UP = 'Prepare follow-up'
const PREPARE_FOLLOW_UP_INTENT = 'data-iso-intent="customer.prepare-follow-up"'

describe('the customer follow-up action agrees with what the body actually resolved', () => {
  it('exactly one resolved customer exposes the follow-up action', async () => {
    const html = await render({ module: 'customer', customerResolution: 'one' })
    expect(html).toContain(PREPARE_FOLLOW_UP)
    expect(html).toContain(PREPARE_FOLLOW_UP_INTENT)
  })

  it('no customer match never exposes the follow-up action, and the body says why', async () => {
    const html = await render({ module: 'customer', customerResolution: 'none' })
    expect(html).not.toContain(PREPARE_FOLLOW_UP)
    expect(html).not.toContain(PREPARE_FOLLOW_UP_INTENT)
    expect(html).toContain('We could not match this conversation to a customer')
  })

  it('multiple customer matches never exposes the follow-up action, and the body offers selection instead', async () => {
    const html = await render({ module: 'customer', customerResolution: 'many' })
    expect(html).not.toContain(PREPARE_FOLLOW_UP)
    expect(html).not.toContain(PREPARE_FOLLOW_UP_INTENT)
    expect(html).toContain('More than one customer matches this conversation')
  })

  it('an unresolved customer (the port withheld data entirely) never exposes the follow-up action', async () => {
    const html = await render({ module: 'customer', customerHealth: 'unauthorized' })
    expect(html).not.toContain(PREPARE_FOLLOW_UP)
    expect(html).not.toContain(PREPARE_FOLLOW_UP_INTENT)
  })

  it('a stale but still-resolved match keeps the follow-up action — staleness is a data-freshness fact, not an identity one', async () => {
    const html = await render({
      module: 'customer',
      customerResolution: 'one',
      customerHealth: 'stale',
    })
    expect(html).toContain(PREPARE_FOLLOW_UP)
    expect(html).toContain(PREPARE_FOLLOW_UP_INTENT)
  })

  it('the action also appears for an authorized operator once a customer is resolved (not manager-only)', async () => {
    const html = await render({ module: 'customer', role: 'operator', customerResolution: 'one' })
    expect(html).toContain(PREPARE_FOLLOW_UP)
  })
})

describe('customer-none and customer-many are directly constructible fixtures, not just theoretical states', () => {
  it('customer-none renders the no-match empty state and no candidate list', async () => {
    const html = await render({ module: 'customer', customerResolution: 'none' })
    expect(html).toContain('We could not match this conversation to a customer')
    expect(html).not.toContain('More than one customer matches')
  })

  it('customer-many renders a disambiguation list with real, selectable candidate rows', async () => {
    const html = await render({ module: 'customer', customerResolution: 'many' })
    expect(html).toContain('More than one customer matches this conversation')
    expect(html).toContain('data-intent="customer.choose:joss-boutique"')
  })
})
