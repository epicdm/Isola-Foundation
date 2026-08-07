import type { JSX } from 'react'

import type {
  ModuleContext,
  ShellState,
  TenantIdentity,
  WorkspaceRole,
} from '@/lib/isola-workspace/contracts'
import type { ResolvedNavigation } from '@/lib/isola-workspace/registry'
import type {
  AiEmployee,
  CustomerResolution,
  InternalSuggestion,
  OnboardingState,
  TodaySummary,
} from '@/lib/isola-workspace/adapters/ports'
import type { GovernedActionInstance } from '@/lib/isola-workspace/action-lifecycle'
import { holdsAll, permissionsForRole } from '@/lib/isola-workspace/permissions'

import { EmptyState } from './primitives'
import { IsolaWorkspaceShellView, ShellStateBody, stateReplacesModuleBody } from './shell'
import {
  AiTeamModuleView,
  BillingModuleView,
  CustomerModuleView,
  OnboardingView,
  PhoneModuleView,
  TodayModuleView,
  UnauthorizedModuleView,
  WorkModuleView,
} from './modules'

/**
 * Isola Workspace — the composed application.
 *
 * The one place the shell, the registry and the module bodies meet. Deliberately
 * SYNCHRONOUS and pure: every port has already been awaited by the caller, so this whole
 * tree renders under `renderToStaticMarkup` in a node environment and every state can be
 * asserted over real rendered copy rather than over a claim about it.
 *
 * WHAT THIS FILE IS NOT
 * ---------------------
 * It is not a switchboard the shell consults. The shell knows nothing about any module; it
 * receives a `NavigationLayout` and renders whatever body it is handed as `children`. This
 * dispatcher is the ONLY place that maps a module id to a component, and it is intentionally
 * dumb — a `switch` with one arm per registered module.
 *
 * Adding a service therefore touches: an adapter, a registry entry, one arm here, and tests.
 * The shell, the navigation, the footer and every layout are untouched. If a future change
 * needs the shell edited to add a service, the contract in `contracts.ts` has been broken.
 */

export interface WorkspaceData {
  customer: { resolution: CustomerResolution; readAt: string | null } | null
  work: readonly GovernedActionInstance[]
  aiTeam: { employees: readonly AiEmployee[]; suggestion: InternalSuggestion | null }
  today: TodaySummary | null
  onboarding: OnboardingState | null
}

export interface IsolaWorkspaceViewProps {
  tenant: TenantIdentity
  role: WorkspaceRole
  context: ModuleContext
  state: ShellState
  navigation: ResolvedNavigation
  data: WorkspaceData
  /** Set only in narrow layouts; drives the back-to-conversation bar. */
  backToConversationLabel?: string
  /** See `IsolaWorkspaceShellView` — enables zero-JS tab and "More" sheet navigation. */
  buildModuleHref?: (moduleId: string) => string
  sheetOpen?: boolean
  closeSheetHref?: string
  className?: string
}

export function IsolaWorkspaceView(props: IsolaWorkspaceViewProps): JSX.Element {
  const {
    tenant,
    role,
    context,
    state,
    navigation,
    data,
    backToConversationLabel,
    buildModuleHref,
    sheetOpen,
    closeSheetHref,
    className,
  } = props

  const active = navigation.all.find((m) => m.descriptor.id === navigation.activeModuleId)

  // Counts are derived from the rows that ACTUALLY render, never from a separate tally that
  // could drift. Tenant gating changes the number for free.
  const counts: Record<string, number> = {}
  const awaiting = data.work.filter((w) => w.state === 'awaitingApproval').length
  if (awaiting > 0) counts.work = awaiting

  return (
    <IsolaWorkspaceShellView
      tenant={tenant}
      context={context}
      state={state}
      layout={navigation}
      activeModuleId={navigation.activeModuleId}
      counts={counts}
      primaryAction={primaryActionFor(
        navigation.activeModuleId,
        active?.authorized ?? false,
        data.customer?.resolution ?? null,
      )}
      backToConversationLabel={backToConversationLabel}
      onSelectModuleHref={buildModuleHref}
      sheetOpen={sheetOpen}
      closeSheetHref={closeSheetHref}
      className={className}
    >
      {stateReplacesModuleBody(state) ? (
        <ShellStateBody state={state} context={context} />
      ) : (
        <ModuleBody role={role} context={context} navigation={navigation} data={data} />
      )}
    </IsolaWorkspaceShellView>
  )
}

function ModuleBody(props: {
  role: WorkspaceRole
  context: ModuleContext
  navigation: ResolvedNavigation
  data: WorkspaceData
}): JSX.Element | null {
  const { role, context, navigation, data } = props
  const active = navigation.all.find((m) => m.descriptor.id === navigation.activeModuleId)

  // No module survived ENTITLEMENT filtering for this tenant (e.g. a suspended or
  // not-yet-provisioned tenant) — `navigation.activeModuleId` is `null` and there is nothing
  // to dispatch on. This must still say something: a literal blank panel here reads as a
  // failure, when the honest fact is "this business's plan does not reach this view yet."
  //
  // PLAN LANGUAGE IS ONLY CORRECT FOR A REAL ENTITLEMENT ABSENCE. An unsupported CONTEXT also
  // yields zero modules, and telling that operator their plan is limited would be false — the
  // cause is a surface nobody wired. The preview route rejects an unsupported context before it
  // can reach here (`defect-pr82-onboarding-context-false-plan-state-2026-08-07`).
  if (!active) {
    return (
      <EmptyState
        variant="no-data-in-plan"
        title="Nothing is available here for this business"
        body="This business's plan does not include any of the sections that would normally appear here."
        reassurance="Nothing is wrong with your access — there is genuinely nothing configured yet."
      />
    )
  }

  // PERMISSION DENIAL RENDERS, IT DOES NOT REDIRECT. The module stays selected and explains
  // itself in role terms, which is what lets the operator escalate rather than be stuck
  // wondering why a tab does nothing.
  if (!active.authorized) {
    return (
      <UnauthorizedModuleView
        moduleLabel={active.descriptor.label}
        reason={reasonFor(active.descriptor.label)}
        escalationPath={escalationFor(active.descriptor.id)}
      />
    )
  }

  switch (active.descriptor.id) {
    case 'customer':
      return data.customer ? (
        <CustomerModuleView
          resolution={data.customer.resolution}
          readAt={data.customer.readAt}
        />
      ) : null

    case 'work':
      return <WorkModuleView items={data.work} />

    case 'ai-team':
      return (
        <AiTeamModuleView
          employees={data.aiTeam.employees}
          suggestion={data.aiTeam.suggestion}
          outputState={data.aiTeam.suggestion ? 'result' : 'idle'}
        />
      )

    case 'today':
      return data.today ? (
        <TodayModuleView
          summary={data.today}
          // Team workload and service problems are gated on the DECLARED permission, not on
          // a raw role-string comparison — `role !== 'operator'` duplicated the grant table
          // in a component and would silently drift the moment PERMISSIONS_BY_ROLE changes.
          // The data is meant to be omitted server-side for anyone lacking the permission;
          // this flag only decides whether to ask for it.
          canSeeTeam={holdsAll(permissionsForRole(role), ['today.read.team'])}
          context={context === 'onboarding' ? 'workspace' : context}
        />
      ) : null

    case 'phone':
      return <PhoneModuleView />

    case 'billing':
      return <BillingModuleView />

    default:
      return null
  }
}

/**
 * Onboarding is a separate surface, not a module tab: it is administrator setup rather than
 * daily operator work, and mixing it into the four pinned tabs would put a one-time task
 * beside the things an operator touches dozens of times an hour.
 */
export function IsolaOnboardingView(props: {
  state: OnboardingState
  currentStageId: string
  className?: string
}): JSX.Element {
  return (
    <OnboardingView
      state={props.state}
      currentStageId={props.currentStageId}
      className={props.className}
    />
  )
}

/**
 * The footer's single accent action changes with the active module.
 *
 * Returns null rather than a disabled placeholder when a module has no natural next action —
 * the design permits exactly one accent button per view, and a greyed-out one still reads as
 * "there is something here for me to press".
 *
 * `customerResolution` is mandatory, not optional, so every call site is forced to supply what
 * it actually knows about customer identity — the bug this parameter closes was exactly a call
 * site that didn't have to think about it. `null` means "not yet resolved" (the port withheld
 * data, e.g. still loading or denied); it is treated identically to an explicit `none`/`many`,
 * because in every one of those cases there is no single authoritative customer to act on.
 *
 * A `stale` READ (the port's health, not this parameter) does not block the action: staleness
 * is a fact about how current the customer's DETAILS are, not about whether their IDENTITY is
 * known — a resolved customer with an out-of-date opportunity value is still the same customer,
 * which is why the state chip carries that warning instead of this function withholding the
 * button. Ambiguity (`many`) and absence (`none`) are the only conditions that withhold it,
 * because those are the cases where "prepare a follow-up" would not be for anyone in particular.
 */
function primaryActionFor(
  moduleId: string | null,
  authorized: boolean,
  customerResolution: CustomerResolution | null,
) {
  if (!moduleId || !authorized) return null

  switch (moduleId) {
    case 'customer':
      if (!customerResolution || customerResolution.kind !== 'one') return null
      return {
        label: 'Prepare follow-up',
        note: 'Due tomorrow · nothing sent yet.',
        intent: 'customer.prepare-follow-up',
      }
    case 'work':
      return {
        label: 'Approve the follow-up reminder',
        note: 'Nothing is sent to the customer.',
        intent: 'work.approve-oldest',
      }
    case 'ai-team':
      return {
        label: 'Ask Atlas about this customer',
        note: 'Nothing reaches the customer.',
        intent: 'ai.consult',
      }
    case 'today':
      return { label: 'Open the full Today workspace', intent: 'today.open-workspace' }
    case 'phone':
      return { label: 'Call this customer back', intent: 'phone.callback' }
    case 'billing':
      return { label: 'Prepare a credit for approval', intent: 'billing.prepare-credit' }
    default:
      return null
  }
}

/** Stated in ROLE terms, never policy or system terms. */
function reasonFor(label: string): string {
  return `${label} shows money details, and your role is set up for customer conversations rather than accounts.`
}

function escalationFor(moduleId: string): string {
  return moduleId === 'billing'
    ? 'If a customer asks about a bill, hand the conversation to a manager.'
    : 'Ask a manager if you need this for a customer.'
}
