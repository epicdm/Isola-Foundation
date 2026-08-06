/**
 * Isola Workspace — the Customer module body. THE FLAGSHIP SCREEN.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE
 * ----------------------------------------
 * An operator opening a conversation has ONE question: what do I do next? Everything that is
 * not the answer to that question is one tap away, not on the surface. So the ready state has
 * at most four top-level elements:
 *
 *   1. who this is                 (CustomerSummary)
 *   2. anything time-critical      (Alert)
 *   3. the decision                (the decision card — what they asked, what to do)
 *   4. everything else             (a single collapsed disclosure)
 *
 * A fifth top-level card would be a fifth thing to read before deciding, which is how a panel
 * becomes a dashboard. Nesting the rest costs one tap and buys the operator the whole screen.
 *
 * RAW IDENTIFIERS APPEAR IN EXACTLY ONE PLACE — the *Technical details* disclosure, in mono,
 * never on the initial view. `CustomerContext.technical` groups them so that "do not surface
 * these" is one reviewable decision rather than a judgement call per field.
 *
 * NO OPERATOR-VISIBLE STRING NAMES A SYSTEM. Facts are attributed to "the conversation",
 * "sales records", "the phone system", "billing" or "messaging" and to nothing else.
 *
 * Pure presentation: props in, markup out. No hooks, no state, no fetching. Interactive
 * affordances are `<button type="button">` carrying an intent for the container to wire.
 */

import { cn } from '@/lib/utils'
import {
  Alert,
  EmptyState,
  ExpandableDetails,
  KeyValueGrid,
  ReadbackResult,
  SourceBadge,
  StatusBadge,
  Timeline,
} from '@/components/isola-workspace/primitives'
import type { Readback } from '@/lib/isola-workspace/action-lifecycle'
import type {
  CustomerContext,
  CustomerIdentity,
  CustomerResolution,
} from '@/lib/isola-workspace/adapters/ports'

import { ModuleCard, SectionLabel } from '../shared'

/** One line, clipped with an ellipsis rather than allowed to widen the panel. */
const ONE_LINE = 'overflow-hidden text-ellipsis whitespace-nowrap'

// ── CustomerSummary ─────────────────────────────────────────────────────────

/**
 * THE ONE DOCUMENTED HARDCODED COLOUR PAIR IN THE WHOLE WORKSPACE.
 *
 * `#C9B6FF` on `#3A1B8C` is a FIXED IDENTITY colour, deliberately NOT `--iso-accent`. The
 * accent is tenant-brandable (`setTenantAccent`), so if the avatar rode the accent then two
 * tenants would render the same person in two different colours, and a tenant could brand
 * itself into the one mark an operator uses to recognise a customer at a glance. Identity
 * must be stable across every tenant, so it is not a token and must not become one.
 *
 * Status colours are likewise never brandable — but those already have their own `--iso-ok` /
 * `--iso-warn` / … tokens, so this avatar is the only place a literal pair is permitted.
 */
const IDENTITY_AVATAR_FG = '#C9B6FF'
const IDENTITY_AVATAR_BG = '#3A1B8C'

export function CustomerSummary(props: { customer: CustomerIdentity; className?: string }) {
  const { customer } = props
  return (
    // No card chrome. This sits directly on the panel background — it is who you are talking
    // to, not a fact about them, and boxing it would make it compete with the decision.
    <div className={cn('flex min-w-0 items-center gap-[9px]', props.className)}>
      <span
        aria-hidden="true"
        className="flex h-[32px] w-[32px] flex-none items-center justify-center rounded-[var(--iso-radius-pill)] text-[12px] font-semibold"
        style={{ color: IDENTITY_AVATAR_FG, background: IDENTITY_AVATAR_BG }}
      >
        {customer.initials}
      </span>
      <span className="flex min-w-0 flex-col">
        <span
          className={cn(
            ONE_LINE,
            'text-[14.5px] font-semibold tracking-[-0.01em] text-[var(--iso-fg)]',
          )}
        >
          {customer.name}
        </span>
        <span className={cn(ONE_LINE, 'text-[11.5px] text-[var(--iso-fg-2)]')}>
          {customer.statusLabel} · {customer.ownerName} looks after them
        </span>
      </span>
    </div>
  )
}

// ── The decision card ───────────────────────────────────────────────────────

/**
 * What they asked for, and the one thing to do about it.
 *
 * THERE IS NO BUTTON IN THIS CARD, and that is deliberate. The primary action lives in the
 * shell footer, which never scrolls away. A button here would be a second place to act,
 * reachable only after scrolling, and the two would eventually disagree.
 */
function DecisionCard(props: { context: CustomerContext }) {
  const { currentNeed, nextAction } = props.context
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col gap-[10px] rounded-[var(--iso-radius-lg)] p-[12px]',
        'bg-[var(--iso-surface)] border border-[var(--iso-accent-ring)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-[3px]">
        <SectionLabel>They are asking for</SectionLabel>
        <p className="break-words text-[12.5px] leading-[1.45] text-[var(--iso-fg)]">
          {currentNeed}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-[3px] border-t border-[var(--iso-border)] pt-[10px]">
        <SectionLabel tone="accent">Do this next</SectionLabel>
        <p className="break-words text-[13px] font-semibold leading-[1.4] text-[var(--iso-fg)]">
          {nextAction.title}
        </p>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          {nextAction.context}
        </p>
      </div>
    </section>
  )
}

// ── Nested disclosures ──────────────────────────────────────────────────────

function OpportunityDetails(props: { context: CustomerContext; readAt: string | null }) {
  const opportunity = props.context.opportunity
  if (!opportunity) {
    return (
      <ExpandableDetails
        title="Sales opportunity"
        summary="Nothing open for this customer"
        variant="nested"
      >
        <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          There is no open opportunity on this customer. Nothing is wrong and nothing is waiting
          on you.
        </p>
      </ExpandableDetails>
    )
  }

  return (
    <ExpandableDetails
      title="Sales opportunity"
      // The collapsed summary carries the DECISIVE value. "Details" would force the operator
      // to open it just to learn whether it was worth opening.
      summary={`${opportunity.name} · ${opportunity.value}`}
      variant="nested"
    >
      <div className="flex min-w-0 flex-col gap-[8px]">
        <div className="flex min-w-0 flex-col gap-[2px]">
          <p className="break-words text-[13px] font-semibold leading-[1.35] text-[var(--iso-fg)]">
            {opportunity.value}
            {opportunity.valueNote ? (
              <span className="ml-[5px] text-[11px] font-normal text-[var(--iso-fg-3)]">
                {opportunity.valueNote}
              </span>
            ) : null}
          </p>
          <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            {opportunity.stage}
            {opportunity.likelihood ? ` · ${opportunity.likelihood} likely` : ''}
            {opportunity.expectedClose ? ` · expected ${opportunity.expectedClose}` : ''}
          </p>
        </div>

        <ul className="flex min-w-0 list-none flex-col gap-[4px] p-0">
          {opportunity.lines.map((line) => (
            <li
              key={line.name}
              className="flex min-w-0 flex-col gap-[1px] border-t border-[var(--iso-border)] pt-[4px] first:border-t-0 first:pt-0"
            >
              <span className="break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                {line.name}
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {line.detail}
              </span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-[5px]">
          <SourceBadge
            source="salesRecords"
            readAt={props.readAt ?? undefined}
            href={opportunity.href}
          />
        </div>
      </div>
    </ExpandableDetails>
  )
}

function ServicesDetails(props: { context: CustomerContext }) {
  const services = props.context.services
  return (
    <ExpandableDetails
      title="Services in use"
      summary={
        services.length ? `${services.length} services on this account` : 'Nothing recorded yet'
      }
      variant="nested"
    >
      {services.length ? (
        <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
          {services.map((service) => (
            <li key={service.name} className="flex min-w-0 flex-col gap-[1px]">
              <span className="flex min-w-0 items-baseline justify-between gap-[8px]">
                <span className="min-w-0 flex-1 break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                  {service.name}
                </span>
                <span className="flex-none text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--iso-fg-3)]">
                  {service.status}
                </span>
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {service.detail}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          No services are recorded against this customer yet.
        </p>
      )}
    </ExpandableDetails>
  )
}

function RecentContactDetails(props: { context: CustomerContext }) {
  const items = props.context.recentContact
  return (
    <ExpandableDetails
      title="Recent contact"
      summary={items.length ? (items[0]?.meta ?? 'Recent history') : 'No contact in the last 30 days'}
      variant="nested"
    >
      {items.length ? (
        <Timeline items={items} />
      ) : (
        <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          No contact in the last 30 days. Nothing is wrong and nothing is waiting on you.
        </p>
      )}
    </ExpandableDetails>
  )
}

/**
 * Actions taken for this customer.
 *
 * A `completed` entry renders a `ReadbackResult` and never a bare "Done" — the readback is the
 * owning system's own statement of its own state, which is the only thing that entitles this
 * UI to say a change exists.
 */
function ActivityDetails(props: { context: CustomerContext }) {
  const entries = props.context.governedActivity
  return (
    <ExpandableDetails
      title="Actions taken for this customer"
      summary={entries.length ? `${entries.length} recorded` : 'Nothing has been changed yet'}
      variant="nested"
    >
      {entries.length ? (
        <ul className="flex min-w-0 list-none flex-col gap-[8px] p-0">
          {entries.map((entry) => {
            // The port carries the readback as a statement plus the time it was read. It is
            // rebuilt into the `Readback` shape here rather than in the port, so the port stays
            // a flat allowlist of scalars.
            const readback: Readback | null =
              entry.state === 'completed' && entry.readback
                ? { system: 'salesRecords', statement: entry.readback, readAt: entry.at }
                : null

            return (
              <li key={`${entry.title}-${entry.at}`} className="flex min-w-0 flex-col gap-[4px]">
                <span className="break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                  {entry.title}
                </span>
                <span className="flex flex-wrap items-center gap-[5px]">
                  <StatusBadge state={entry.state} />
                  <span className="text-[11px] text-[var(--iso-fg-3)]">
                    {entry.by} · {entry.at}
                  </span>
                </span>
                {readback ? <ReadbackResult readback={readback} /> : null}
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Nothing has been changed for this customer yet.
        </p>
      )}
    </ExpandableDetails>
  )
}

/**
 * THE ONLY PLACE RAW IDENTIFIERS MAY APPEAR. Quiet variant, mono values, collapsed, and nested
 * two levels deep — an operator never meets them while deciding what to do.
 */
function TechnicalDetails(props: { context: CustomerContext }) {
  const t = props.context.technical
  return (
    <ExpandableDetails
      title="Technical details"
      summary="Reference numbers, for support"
      variant="quiet"
    >
      <KeyValueGrid
        items={[
          { label: 'Conversation display id', value: String(t.conversationDisplayId), mono: true },
          { label: 'Account id', value: String(t.accountId), mono: true },
          { label: 'Inbox id', value: String(t.inboxId), mono: true },
          {
            label: 'Opportunity reference',
            value: t.opportunityReference ?? 'Not recorded',
            mono: true,
          },
          { label: 'Correlation id', value: t.correlationId ?? 'Not recorded', mono: true },
          { label: 'Last sync', value: t.lastSync ?? 'Not recorded', mono: true },
        ]}
      />
    </ExpandableDetails>
  )
}

// ── Alerts ──────────────────────────────────────────────────────────────────

/**
 * Alert severities map to alert variants explicitly. `block` becomes `degraded` rather than
 * `error`: a blocked read means something is paused, not that something broke.
 */
const ALERT_VARIANT: Record<'warn' | 'err' | 'block', 'warning' | 'error' | 'degraded'> = {
  warn: 'warning',
  err: 'error',
  block: 'degraded',
}

// ── The three resolutions ───────────────────────────────────────────────────

/**
 * The disambiguation list.
 *
 * NO CUSTOMER DATA IS SHOWN UNTIL ONE IS CHOSEN. Rendering the "most likely" match and letting
 * the operator correct it would mean the panel had already told them something about a
 * customer who may not be the one on the other end of the conversation.
 */
function CustomerChoiceList(props: {
  candidates: readonly { id: string; name: string; disambiguation: string }[]
  className?: string
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      <ModuleCard>
        <p className="text-[12.5px] font-semibold leading-[1.4] text-[var(--iso-fg)]">
          More than one customer matches this conversation
        </p>
        <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Pick the right one before anything is shown. Nothing has been read about any of them
          yet, and you can still reply normally in the meantime.
        </p>
      </ModuleCard>

      <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
        {props.candidates.map((candidate) => (
          <li key={candidate.id} className="min-w-0">
            <button
              type="button"
              data-intent={`customer.choose:${candidate.id}`}
              className={cn(
                'flex w-full min-w-0 flex-col gap-[2px] rounded-[var(--iso-radius-lg)] p-[10px_12px] text-left',
                'border border-[var(--iso-border)] bg-[var(--iso-surface)] hover:bg-[var(--iso-surface-2)]',
              )}
            >
              <span className="break-words text-[12.5px] font-semibold leading-[1.35] text-[var(--iso-fg)]">
                {candidate.name}
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {candidate.disambiguation}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── The module body ─────────────────────────────────────────────────────────

export function CustomerModuleView(props: {
  resolution: CustomerResolution
  readAt: string | null
  className?: string
}) {
  const { resolution } = props

  if (resolution.kind === 'none') {
    return (
      <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
        <EmptyState
          variant="no-customer-match"
          title="We could not match this conversation to a customer"
          body="Nobody on record matches this number or name yet, so there is no history to show. You can still reply normally."
          reassurance="Nothing is wrong and nothing is waiting on you here."
        />
      </div>
    )
  }

  if (resolution.kind === 'many') {
    return <CustomerChoiceList candidates={resolution.candidates} className={props.className} />
  }

  const context = resolution.context
  const alert = context.alerts[0]

  return (
    // Exactly four top-level elements. See the header note — a fifth is a design regression.
    <div className={cn('flex min-w-0 flex-col gap-[10px]', props.className)}>
      <CustomerSummary customer={context.customer} />

      {alert ? <Alert variant={ALERT_VARIANT[alert.severity]} title={alert.text} /> : null}

      <DecisionCard context={context} />

      <ExpandableDetails
        title="More about this customer"
        summary="Sales opportunity, services, history and past actions"
        defaultOpen={false}
      >
        <div className="flex min-w-0 flex-col gap-[6px]">
          <OpportunityDetails context={context} readAt={props.readAt} />
          <ServicesDetails context={context} />
          <RecentContactDetails context={context} />
          <ActivityDetails context={context} />
          <TechnicalDetails context={context} />
        </div>
      </ExpandableDetails>
    </div>
  )
}
