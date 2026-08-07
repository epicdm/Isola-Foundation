import { redirect } from 'next/navigation'

import { IsolaWorkspaceView, type WorkspaceData } from '@/components/isola-workspace/isola-workspace-view'
import { createFixturePorts, fixtureTenant } from '@/lib/isola-workspace/adapters/fixture-adapter'
import { fixtureEntitlements } from '@/lib/isola-workspace/entitlements'
import { defaultRegistry } from '@/lib/isola-workspace/modules'
import { permissionsForRole, toWorkspaceRole } from '@/lib/isola-workspace/permissions'
import {
  customerResolutionOverrideFor,
  extractSingleQueryValue,
  resolvePreviewContext,
  resolveWorkspacePreviewRequest,
  underlyingFixtureTenant,
  type SupportedPreviewContext,
} from '@/lib/isola-workspace/preview-authorization'
import { MORE_TAB_ID } from '@/components/isola-workspace/shell'
import { resolveNavigation } from '@/lib/isola-workspace/registry'
import type {
  ModuleContext,
  ShellState,
  WorkspaceContext,
  WorkspaceRole,
} from '@/lib/isola-workspace/contracts'
import { getSession } from '@/lib/session'
import { resolveWorkspaceAuthz } from '@/lib/workspace/authz'

/**
 * Isola Workspace — the fixture state gallery.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * This repository has no Storybook and no jsdom, so there is no component workshop to browse
 * and no way to click through a state. Without a surface like this, the fourteen required
 * states would be asserted only in tests and never actually LOOKED at by a person — and the
 * whole point of the design is how it reads to an operator under stress.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not the product. Every byte it renders comes from `sample-data.json`, which is
 * invented. It performs no Chatwoot call, reads no tenant record, and can perform no write.
 *
 * IT IS STILL SESSION-GATED, AND ROLE-AUTHORIZED. Not because the fixture data is sensitive —
 * it is not — but because an unauthenticated (or unauthorized) page on a deployed Foundation
 * host is a surface, and a surface that renders a convincing operator console is one a
 * stranger — or a signed-in employee with no real workspace access — should not be able to
 * browse and screenshot. The actor's REAL workspace role is resolved server-side via
 * `resolveWorkspaceAuthz`/`toWorkspaceRole` before anything fixture-related is touched; a
 * `?role=` query parameter may only NARROW that real role for a QA preview, never widen or
 * replace it (`lib/isola-workspace/preview-authorization.ts`). `?scenario=` (and the
 * deprecated `?tenant=` alias) select which invented fixture dataset renders and carry no
 * authorization weight at all.
 */

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

/**
 * Build a link back to this same preview page with `overrides` applied on top of `base`.
 * A key set to `undefined` in `overrides` removes it; anything falsy in the merged result is
 * dropped entirely so the URL never grows stray empty parameters.
 */
function buildPreviewHref(
  base: Record<string, string | undefined>,
  overrides: Record<string, string | undefined>,
): string {
  const merged = { ...base, ...overrides }
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(merged)) {
    if (value) qs.set(key, value)
  }
  const query = qs.toString()
  return query ? `/isola-workspace/preview?${query}` : '/isola-workspace/preview'
}

export default async function IsolaWorkspacePreviewPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const session = await getSession()
  if (!session) redirect('/')

  // The actor's REAL workspace role, resolved server-side from Foundation membership —
  // never from anything the browser sent. A `?role=` query value is consulted only below,
  // and only to NARROW this, never to replace it.
  const authz = await resolveWorkspaceAuthz(session)
  const rawAuthoritativeRole = toWorkspaceRole(authz.level)

  const params = await searchParams

  // The ONE authorization decision for this route, made by a pure function that performs no
  // I/O and no rendering (`lib/isola-workspace/preview-authorization.ts`). Denied (no
  // membership, `Membership.role === 'staff'`, or a malformed authoritative role) never
  // reaches the fixture machinery at all: no module list, no tenant name — fixture or real —
  // no permission names, nothing. This is deliberately the ONLY place `params.role`,
  // `params.scenario` and `params.tenant` are read for authorization purposes — everything
  // below this point (`context`/`state`/`sheet`/`module`) is presentation-only and carries no
  // authority regardless of order.
  const request = resolveWorkspacePreviewRequest(rawAuthoritativeRole, {
    role: params.role,
    scenario: params.scenario,
    tenant: params.tenant,
  })

  if (!request.authorized) {
    return <UnauthorizedPreview />
  }

  // Echoed back by `request` rather than reused from `rawAuthoritativeRole` above so the type
  // system itself proves this value can only be a real, known `WorkspaceRole` here — the same
  // guarantee `resolveWorkspacePreviewRequest`'s `{ authorized: false }` branch enforces at
  // runtime.
  const { authoritativeRole, role, scenario } = request

  // Presentation-only, and resolved strictly AFTER the authorization decision above so a denied
  // actor can neither obtain fixture data through it nor learn which contexts exist. An
  // unsupported context is reported as unsupported rather than normalised onto a real
  // `ModuleContext` no module declares — which produced zero modules and, with them, the
  // zero-module body's false claim about the tenant's plan
  // (`defect-pr82-onboarding-context-false-plan-state-2026-08-07`).
  const contextResolution = resolvePreviewContext(extractSingleQueryValue(params.context))
  if (!contextResolution.supported) {
    return <UnsupportedContextPreview requested={contextResolution.requested} />
  }
  const context = contextResolution.context
  const state = normaliseState(one(params.state))
  const sheetOpen = one(params.sheet) === '1'

  // The whole route is query-param-driven with zero client JS (matching `role`/`context`/
  // `state` above), so "click a tab" and "open/close the More sheet" are just links back to
  // this same page with one parameter changed. `MORE_TAB_ID` opens the sheet rather than
  // selecting a module — it is documented as "never a real module id" precisely so a
  // consumer can special-case it like this.
  const hrefBase: Record<string, string | undefined> = {
    role: extractSingleQueryValue(params.role) ?? undefined,
    scenario,
    context,
    state: one(params.state),
    module: one(params.module),
  }
  function buildModuleHref(moduleId: string): string {
    if (moduleId === MORE_TAB_ID) return buildPreviewHref(hrefBase, { sheet: '1' })
    return buildPreviewHref(hrefBase, { module: moduleId, sheet: undefined })
  }
  const closeSheetHref = buildPreviewHref(hrefBase, { sheet: undefined })

  // `customer-none`/`customer-many` are not tenants — they ride on `epic`'s identity and
  // entitlements with only the Customer port's resolution kind forced. See
  // `underlyingFixtureTenant`/`customerResolutionOverrideFor`.
  const tenantId = underlyingFixtureTenant(scenario)
  const fixture = fixtureTenant(tenantId)
  const ports = createFixturePorts(tenantId, {
    // Drive the degraded and stale reads straight from the URL so every one of them can be
    // reached deliberately rather than only when something upstream happens to break.
    //
    // Note the shell state is `unavailable` while the PORT health is `degraded`: the shell
    // describes what the operator sees, the port describes what the upstream did. Keeping
    // the two vocabularies separate is deliberate — a degraded port can still yield a
    // perfectly renderable panel from its last good read.
    customer:
      state === 'unavailable' ? 'degraded' : state === 'stale' ? 'stale' : undefined,
    customerResolution: customerResolutionOverrideFor(scenario),
  })

  const workspaceContext: WorkspaceContext = {
    tenant: { id: fixture.id, name: fixture.name, accent: fixture.accent },
    actor: { id: session.user.id, name: session.user.name ?? 'Operator', role },
    context,
    conversation:
      context === 'conversation-panel'
        ? { accountId: 5, inboxId: 46, conversationDisplayId: 131 }
        : null,
    customerMatches: 1,
    entitlements: fixtureEntitlements(fixture.entitlements),
    permissions: permissionsForRole(role),
  }

  const navigation = resolveNavigation(
    defaultRegistry(),
    workspaceContext,
    one(params.module) ?? null,
  )

  const [customer, work, employees, suggestion, today, onboarding] = await Promise.all([
    ports.customer.resolveForConversation({
      accountId: 5,
      inboxId: 46,
      conversationDisplayId: 131,
    }),
    ports.work.listForActor(session.user.id),
    ports.aiTeam.listEmployees(),
    ports.aiTeam.consult('Summarise this customer'),
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

  return (
    <main className="min-h-dvh bg-[var(--iso-bg)] p-[20px]">
      <PreviewNotice
        scenarioName={fixture.name}
        authoritativeRole={authoritativeRole}
        role={role}
        context={context}
        state={state}
      />
      <div
        className={
          context === 'conversation-panel'
            ? 'mt-[14px] h-[720px] w-[384px] overflow-hidden rounded-[var(--iso-radius-xl)] shadow-[var(--iso-shadow-2)]'
            : 'mt-[14px] h-[720px] w-full overflow-hidden rounded-[var(--iso-radius-xl)] shadow-[var(--iso-shadow-2)]'
        }
      >
        <IsolaWorkspaceView
          tenant={workspaceContext.tenant}
          role={role}
          context={context}
          state={state}
          navigation={navigation}
          data={data}
          buildModuleHref={buildModuleHref}
          sheetOpen={sheetOpen}
          closeSheetHref={closeSheetHref}
        />
      </div>
    </main>
  )
}

/**
 * The one place in this tree where naming systems is correct: this strip is addressed to an
 * ENGINEER browsing the gallery, not to an operator, and it exists to make absolutely sure
 * nobody mistakes fixture output for live customer data.
 */
function PreviewNotice(props: {
  scenarioName: string
  authoritativeRole: WorkspaceRole
  role: WorkspaceRole
  context: SupportedPreviewContext
  state: ShellState
}) {
  const narrowed = props.role !== props.authoritativeRole
  return (
    <div className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
      <strong>Fixture preview — not live data.</strong> Every value below is invented sample
      data. No external system is contacted and no action can be performed.
      <div className="mt-1 text-xs opacity-80">
        fixture scenario <code>{props.scenarioName}</code> · role <code>{props.role}</code>
        {narrowed ? (
          <>
            {' '}(narrowed from your real role <code>{props.authoritativeRole}</code>)
          </>
        ) : null}
        {' · context '}
        <code>{props.context}</code> · state <code>{props.state}</code>
        {' — change with '}
        <code>?scenario=epic|marche|customer-none|customer-many&amp;role=operator|manager|admin&amp;context=conversation-panel|workspace&amp;state=ready|loading|unavailable|stale|unauthorized|empty|offline&amp;module=customer|work|ai-team|today|phone|billing</code>
        {' — '}
        <code>role</code> can only narrow your real workspace role, never widen it.
      </div>
    </div>
  )
}

/**
 * What a signed-in-but-not-a-member (or `Membership.role === 'staff'`) actor sees: enough to
 * know why, nothing about what exists behind the gate. No tenant name — real or fixture — no
 * module list, no permission name, no fixture data of any kind.
 */
/**
 * A context the module contract recognizes but this preview has no surface for.
 *
 * The copy names the real cause and says explicitly that it is NOT a plan limitation, because
 * the state it replaces said the opposite. An operator who reads "your plan does not include
 * this" may repeat it to a customer; an operator who reads "this view is not built yet" will
 * not. It reveals nothing about entitlement, and it is only reachable by an already-authorized
 * actor.
 */
function UnsupportedContextPreview(props: { requested: string }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--iso-bg)] p-[20px]">
      <div
        role="alert"
        className="max-w-[460px] rounded-md border border-warning bg-warning/10 p-4 text-sm"
      >
        <strong>This preview cannot show that view yet.</strong>
        <p className="mt-1 text-[var(--iso-fg-2)]">
          The <code>{props.requested}</code> view has been designed but is not wired to a page, so
          there is nothing to render here. This is not a limit on any business&rsquo;s plan and
          nothing is wrong with your access.
        </p>
        <p className="mt-2 text-[var(--iso-fg-2)]">
          Try <code>context=conversation-panel</code> or <code>context=workspace</code>.
        </p>
      </div>
    </main>
  )
}

function UnauthorizedPreview() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-[var(--iso-bg)] p-[20px]">
      <div
        role="alert"
        className="max-w-[420px] rounded-md border border-warning bg-warning/10 p-4 text-sm"
      >
        <strong>You do not have access to this preview.</strong>
        <p className="mt-1 text-[var(--iso-fg-2)]">
          This tool previews the Isola Workspace design for people with a workspace role. Ask
          your workspace owner or manager if you believe this is wrong.
        </p>
      </div>
    </main>
  )
}

/* `normaliseContext` is gone. It mapped `context=onboarding` onto a real `ModuleContext` that
   no module declares and no route renders, producing zero modules and the zero-module body's
   false plan-limitation copy. Context resolution now lives in `resolvePreviewContext`, which
   reports an unsupported context as unsupported. */

function normaliseState(v: string | undefined): ShellState {
  const allowed: ShellState[] = [
    'ready',
    'loading',
    'empty',
    'unavailable',
    'unauthorized',
    'stale',
    'offline',
  ]
  return allowed.includes(v as ShellState) ? (v as ShellState) : 'ready'
}
