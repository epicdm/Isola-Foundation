import { redirect } from 'next/navigation'

import { IsolaWorkspaceView, type WorkspaceData } from '@/components/isola-workspace/isola-workspace-view'
import { createFixturePorts, fixtureTenant, type FixtureTenantId } from '@/lib/isola-workspace/adapters/fixture-adapter'
import { fixtureEntitlements } from '@/lib/isola-workspace/entitlements'
import { defaultRegistry } from '@/lib/isola-workspace/modules'
import { permissionsForRole } from '@/lib/isola-workspace/permissions'
import { resolveNavigation } from '@/lib/isola-workspace/registry'
import type {
  ModuleContext,
  ShellState,
  WorkspaceContext,
  WorkspaceRole,
} from '@/lib/isola-workspace/contracts'
import { getSession } from '@/lib/session'

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
 * IT IS STILL SESSION-GATED. Not because the fixture data is sensitive — it is not — but
 * because an unauthenticated page on a deployed Foundation host is a surface, and a surface
 * that renders a convincing operator console is one a stranger should not be able to browse
 * and screenshot. Cheap to gate, and the habit is the point.
 */

export const dynamic = 'force-dynamic'

type SearchParams = Promise<Record<string, string | string[] | undefined>>

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

export default async function IsolaWorkspacePreviewPage({
  searchParams,
}: {
  searchParams: SearchParams
}) {
  const session = await getSession()
  if (!session) redirect('/')

  const params = await searchParams
  const tenantId = (one(params.tenant) === 'marche' ? 'marche' : 'epic') as FixtureTenantId
  const role = normaliseRole(one(params.role))
  const context = normaliseContext(one(params.context))
  const state = normaliseState(one(params.state))

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
      <PreviewNotice tenantName={fixture.name} role={role} context={context} state={state} />
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
  tenantName: string
  role: WorkspaceRole
  context: ModuleContext
  state: ShellState
}) {
  return (
    <div className="rounded-md border border-warning bg-warning/10 p-3 text-sm">
      <strong>Fixture preview — not live data.</strong> Every value below is invented sample
      data. No external system is contacted and no action can be performed.
      <div className="mt-1 text-xs opacity-80">
        tenant <code>{props.tenantName}</code> · role <code>{props.role}</code> · context{' '}
        <code>{props.context}</code> · state <code>{props.state}</code>
        {' — change with '}
        <code>?tenant=epic|marche&amp;role=operator|manager|admin&amp;context=conversation-panel|workspace&amp;state=ready|loading|unavailable|stale|unauthorized|empty|offline&amp;module=customer|work|ai-team|today|phone|billing</code>
      </div>
    </div>
  )
}

function normaliseRole(v: string | undefined): WorkspaceRole {
  return v === 'operator' || v === 'manager' || v === 'admin' ? v : 'manager'
}

function normaliseContext(v: string | undefined): ModuleContext {
  return v === 'workspace' || v === 'onboarding' ? v : 'conversation-panel'
}

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
