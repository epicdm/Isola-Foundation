/**
 * Isola Workspace — the shell-owned states (pure views).
 *
 * THE FOUR QUESTIONS (contracts.ts, `ModuleState`)
 * -----------------------------------------------
 * Every state below answers all four, in its copy:
 *   1. What happened?
 *   2. Might what I am seeing be out of date?
 *   3. What can I do next?
 *   4. Is customer-facing work affected?
 * A state that silently drops question 2 or 4 is the failure mode this file exists to
 * prevent — an operator who cannot tell whether a stale figure is safe to quote to a
 * customer will either quote it anyway or stop trusting the panel altogether.
 *
 * NAMING NOTE — `unavailable` IS the degraded case. `ShellState` is `ModuleState`, whose
 * union carries `unavailable` where the design bundle says "degraded". They are the same
 * condition: a service this panel depends on is not answering. It is rendered as DEGRADED
 * (the `block` family), never as failure, because nothing was attempted and lost.
 *
 * NO SYSTEM NAMES. Copy names sources the way `SourceRef` does — "the conversation", "your
 * sales records", "the phone service" — and never a vendor or internal product name.
 *
 * PURE VIEWS. No hooks, no state, no fetching.
 */

import type { JSX } from 'react'

import {
  Alert,
  CustomerPanelSkeleton,
  DegradedState,
  EmptyState,
  LoadingSkeleton,
} from '@/components/isola-workspace/primitives'
import type { ModuleContext, ShellState } from '@/lib/isola-workspace/contracts'

/**
 * The one string the design prototype got wrong. The prototype named two vendor systems in
 * place of "the conversation and your sales records" — the single place a system name leaked
 * into operator-visible copy. This is the corrected, authoritative production copy. Do not
 * carry the prototype string over, and do not reintroduce a vendor name here to "clarify"
 * which system is slow: the operator's vocabulary is `SourceRef`, and nothing else.
 */
const LOADING_SENTENCE = 'Loading customer record from the conversation and your sales records…'
const LOADING_REASSURANCE = 'You can keep replying in the conversation while this loads.'

/** Question 4, phrased for the surface the operator is actually looking at. */
function customerWorkUnaffected(context: ModuleContext): string {
  return context === 'conversation-panel'
    ? 'Replying to the customer is not affected.'
    : 'Nothing that reaches a customer is affected.'
}

function LoadingBody(props: { context: ModuleContext }): JSX.Element {
  const { context } = props
  return (
    // `aria-busy` belongs on the CONTAINER, not on the bars: the bars are decorative shapes
    // and the skeleton primitive already hides them from assistive technology.
    <div role="status" aria-busy="true" className="flex flex-col gap-[9px]">
      <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">{LOADING_SENTENCE}</p>

      {context === 'conversation-panel' ? (
        // A composed preset whose geometry matches the loaded panel, so nothing jumps when
        // the real content arrives.
        <CustomerPanelSkeleton />
      ) : (
        <LoadingSkeleton variant="line" count={4} />
      )}

      <p className="text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">{LOADING_REASSURANCE}</p>
    </div>
  )
}

function EmptyBody(props: { context: ModuleContext }): JSX.Element {
  return (
    <div role="status" className="flex flex-col gap-[9px]">
      <EmptyState
        variant="nothing-to-do"
        title="There is nothing here for you to do"
        body={
          'Everything this section covers has been read and nothing is outstanding. ' +
          'This was read just now, so it is current.'
        }
        reassurance={`Nothing is wrong and nothing is waiting on you. ${customerWorkUnaffected(
          props.context,
        )}`}
      />
    </div>
  )
}

/**
 * Shell-level unauthorized: this person may not see this customer's commercial detail at all.
 *
 * DELIBERATELY NOT AN `EmptyState`. Every `EmptyState` variant describes an ABSENCE OF DATA —
 * nothing matched, nothing configured, not in the plan. Reaching for `no-data-in-plan` here
 * would tell the operator their business has not bought something, when the truth is that
 * their ROLE does not include it. That is exactly the entitlement/permission conflation
 * `contracts.ts` exists to forbid, and it would send the operator to the wrong person.
 *
 * `timestampNote` carries question 2 explicitly: nothing was loaded, so there is no
 * out-of-date risk to reason about at all.
 */
function UnauthorizedBody(props: { context: ModuleContext }): JSX.Element {
  return (
    <Alert
      variant="neutral"
      title="You cannot see this customer's details"
      body={
        'Your role does not include this business’s commercial information, so nothing was ' +
        'loaded here. Ask a manager to give you access, or hand the conversation to one. ' +
        customerWorkUnaffected(props.context)
      }
      timestampNote="Out of date? Not applicable — nothing was loaded."
      action={{ label: 'Ask a manager for access', intent: 'request-access' }}
    />
  )
}

/**
 * `stale` is the WARN sibling of degraded: a read SUCCEEDED earlier and has not been refreshed
 * since. The module content below it still renders, from that last good read — the operator is
 * told how old it is rather than having it taken away.
 */
function StaleBody(props: { context: ModuleContext }): JSX.Element {
  return (
    <Alert
      variant="stale"
      title="Showing information from the last successful check."
      body={
        'One of the systems behind this panel has not answered since then, so what you see ' +
        'below may have changed. ' +
        customerWorkUnaffected(props.context)
      }
      timestampNote="Reload to read it again."
      action={{ label: 'Try again', intent: 'reload' }}
    />
  )
}

function DegradedBody(props: { context: ModuleContext }): JSX.Element {
  return (
    <DegradedState
      variant="module"
      service="A service this panel depends on"
      whatStillWorks={
        props.context === 'conversation-panel'
          ? 'The conversation is working normally and you can keep replying.'
          : 'Everything that does not depend on that service is working normally.'
      }
      whatIsPaused={
        'Changes are paused until it recovers, so anything shown below was read before it ' +
        'stopped answering and may have changed since.'
      }
    />
  )
}

function OfflineBody(props: { context: ModuleContext }): JSX.Element {
  return (
    <DegradedState
      variant="offline"
      service="the systems behind this panel"
      whatStillWorks={
        props.context === 'conversation-panel'
          ? 'Your typed reply is kept, and anything already sent has gone.'
          : 'Anything you have already saved has gone through.'
      }
      whatIsPaused={
        'Nothing here can be refreshed, so treat what you can see as out of date. Nothing you ' +
        'do now will reach a customer until the connection comes back.'
      }
    />
  )
}

/**
 * Render the shell-owned state body.
 *
 * Returns `null` for `ready` — the shell then renders the module itself.
 *
 * ROLE=STATUS PLACEMENT. `loading` and `empty` are wrapped here because they are composed
 * bodies. The others return their primitive directly: `Alert` and `DegradedState` each carry
 * `role="status"` themselves, and nesting one live region inside another makes the
 * announcement ambiguous.
 */
export function ShellStateBody(props: {
  state: ShellState
  context: ModuleContext
}): JSX.Element | null {
  const { state, context } = props

  switch (state) {
    case 'ready':
      return null
    case 'loading':
      return <LoadingBody context={context} />
    case 'empty':
      return <EmptyBody context={context} />
    case 'unauthorized':
      return <UnauthorizedBody context={context} />
    case 'stale':
      return <StaleBody context={context} />
    case 'unavailable':
      return <DegradedBody context={context} />
    case 'offline':
      return <OfflineBody context={context} />
    default:
      return null
  }
}

/**
 * Whether this state REPLACES the module body or sits above it as a banner.
 *
 * `stale` and `unavailable` keep the module's content: the last good read is still the best
 * information the operator has, and removing it would leave them with less than they had.
 * The blocking states have nothing trustworthy to show underneath, so they stand alone.
 */
export function stateReplacesModuleBody(state: ShellState): boolean {
  return (
    state === 'loading' || state === 'empty' || state === 'unauthorized' || state === 'offline'
  )
}
