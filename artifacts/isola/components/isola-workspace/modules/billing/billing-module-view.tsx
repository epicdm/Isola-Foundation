/**
 * Isola Workspace — the Billing module body.
 *
 * The second half of the proof that a non-pinned module is ordinary. Same shape as Phone: its
 * own small props object, two read-only sections, one source badge, no shell involvement.
 *
 * Billing is also the module that demonstrates the entitlement/permission split, because an
 * ENTITLED tenant whose operator lacks `billing.read` sees this module listed and renders
 * `UnauthorizedModuleView` instead of this body — which is what lets them escalate rather than
 * quietly not know the capability exists.
 *
 * Facts are attributed to "billing". Money is stated, never explained away.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'
import {
  ExpandableDetails,
  KeyValueGrid,
  SourceBadge,
} from '@/components/isola-workspace/primitives'

import { ModuleCard, SectionLabel } from '../shared'

export interface BillingPayment {
  label: string
  detail: string
}

export interface BillingModuleData {
  /** Preformatted in the tenant's currency, e.g. "EC$0.00". */
  balance: string
  monthlyPlan: string
  lastPayment: string
  /** Plain English: "17 months, always on time". */
  historyNote: string
  payments: readonly BillingPayment[]
}

export function BillingModuleView(props: {
  /** Absent means NOTHING HAS BEEN READ — see the not-read branch below. */
  data?: BillingModuleData
  readAt?: string | null
  className?: string
}) {
  const { data } = props

  // "Not read" and "nothing owing" are DIFFERENT FACTS, and on a money screen the difference
  // is the whole point: rendering a balance of nothing because nothing was fetched is the one
  // mistake on this module that could reach a customer as a statement about their account.
  if (!data) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
        <ModuleCard as="section" className="gap-[4px]">
          <SectionLabel>Not read yet</SectionLabel>
          <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            Nothing has been read from billing for this customer, so no balance or payment history
            is shown. Do not tell the customer anything about their account from this screen.
            Nothing here is out of date, because nothing has been loaded.
          </p>
        </ModuleCard>
      </div>
    )
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      <ModuleCard as="section" className="gap-[7px]">
        <SectionLabel>Where this account stands</SectionLabel>
        <KeyValueGrid
          items={[
            { label: 'Balance owing', value: data.balance },
            { label: 'Monthly plan', value: data.monthlyPlan },
          ]}
        />
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Last payment: {data.lastPayment} · {data.historyNote}
        </p>
        <div className="flex flex-wrap gap-[5px]">
          <SourceBadge source="billing" readAt={props.readAt ?? undefined} />
        </div>
      </ModuleCard>

      <ExpandableDetails
        title="Payment history"
        summary={
          data.payments.length ? `${data.payments.length} recent payments` : 'No payments recorded'
        }
      >
        {data.payments.length ? (
          <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
            {data.payments.map((payment) => (
              <li key={payment.label} className="flex min-w-0 flex-col gap-[1px]">
                <span className="break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                  {payment.label}
                </span>
                <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                  {payment.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            No payments are recorded against this customer yet.
          </p>
        )}
      </ExpandableDetails>
    </div>
  )
}
