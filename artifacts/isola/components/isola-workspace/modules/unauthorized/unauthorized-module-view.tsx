/**
 * Isola Workspace — the unauthorized module body.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * A missing ENTITLEMENT hides a module completely: the tenant did not buy it and the operator
 * never learns it could exist. A missing PERMISSION is the opposite — the module is listed, and
 * renders this. The operator learns the capability exists and, crucially, WHO TO ASK. An
 * operator cannot escalate what they cannot see.
 *
 * THE REASON IS STATED IN ROLE TERMS, NEVER POLICY OR SYSTEM TERMS. "Billing is for managers"
 * is actionable. "Missing permission billing.read" is not: it names an internal rule, it tells
 * the operator nothing about what to do next, and it leaks the shape of the authorization model
 * to a surface embedded in a third-party host.
 *
 * NO CUSTOMER DATA IS FETCHED OR PRESENT. This component takes three strings and renders them.
 * It has no data props and no way to acquire any, which is why it can honestly say there is no
 * stale-data risk: nothing was read, so nothing can be out of date.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'

import { Inset, ModuleCard } from '../shared'

function PadlockTile() {
  return (
    <span
      aria-hidden="true"
      className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[var(--iso-radius-md)] border border-[var(--iso-border)] bg-[var(--iso-surface-2)] text-[var(--iso-fg-3)]"
    >
      <svg
        width="15"
        height="15"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3" />
      </svg>
    </span>
  )
}

export function UnauthorizedModuleView(props: {
  moduleLabel: string
  /** In ROLE terms: "Billing is handled by managers." Never a policy name or a system name. */
  reason: string
  /** What to do instead: "If a customer asks about a bill, hand the conversation to a manager." */
  escalationPath: string
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      <ModuleCard as="section" className="gap-[9px]">
        <div className="flex min-w-0 items-start gap-[9px]">
          <PadlockTile />
          <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <h2 className="break-words text-[13.5px] font-semibold leading-[1.3] text-[var(--iso-fg)]">
              {props.moduleLabel} is for managers
            </h2>
            <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
              {props.reason}
            </p>
          </div>
        </div>

        <Inset family="neutral" heading="Nothing was loaded">
          No customer information was read for this section, so there is nothing here that could
          be out of date. Your conversation is not affected — you can keep reading and replying
          exactly as normal.
        </Inset>

        <Inset family="accent" heading="What to do instead">
          {props.escalationPath}
        </Inset>
      </ModuleCard>
    </div>
  )
}
