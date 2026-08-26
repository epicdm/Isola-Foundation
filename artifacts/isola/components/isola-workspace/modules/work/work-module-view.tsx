/**
 * Isola Workspace — the Work module body.
 *
 * THIS IS WHERE THE LIFECYCLE BECOMES VISIBLE. `action-lifecycle.ts` guarantees a state can
 * never be constructed dishonestly; this file guarantees it is never RENDERED dishonestly:
 *
 *   executing    — info, a pulsing dot and an indeterminate bar. NEVER green, never a tick,
 *                  never the word "done". It says outright that it is not finished until the
 *                  owning system confirms it.
 *   completed    — a `ReadbackResult` quoting the owning system's own statement. Never a bare
 *                  "Done", because "Done" is a claim about our request, not about their state.
 *   unconfirmed  — dashed, and offers NO action at all. A retry could do the thing twice; a
 *                  tick would be a lie. The only honest affordance is none.
 *   blocked      — states that nothing was attempted and the customer has not been told.
 *   failed       — states what did NOT change and what the customer still believes.
 *
 * Ordering is by what the operator must deal with first, not by time: approvals block other
 * people, overdue work is already late, and a finished item is the last thing worth reading.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'
import {
  EmptyState,
  ReadbackResult,
  StatusBadge,
} from '@/components/isola-workspace/primitives'
import type { GovernedActionInstance } from '@/lib/isola-workspace/action-lifecycle'
import type { ActionState } from '@/lib/isola-workspace/contracts'

import { Inset, ModuleButton, ModuleChip, SectionLabel } from '../shared'

// ── Filters ─────────────────────────────────────────────────────────────────

export const WORK_FILTERS = [
  { id: 'this-customer', label: 'This customer' },
  { id: 'mine', label: 'Mine' },
  { id: 'needs-approval', label: 'Needs approval' },
] as const

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * "Overdue" is a PRESENTATIONAL sub-case of `proposed`, not an eighth lifecycle state — adding
 * one would mean a governed action could be overdue and blocked at the same time, which the
 * state machine forbids for good reason. Until the port carries a due date this reads the
 * subtitle, which is where the deadline is written for the operator anyway.
 */
export function isOverdue(item: GovernedActionInstance): boolean {
  return item.state === 'proposed' && /\b(late|overdue|was due)\b/i.test(item.subtitle ?? '')
}

const STATE_RANK: Record<ActionState, number> = {
  awaitingApproval: 0,
  // `executing` sits directly under approvals: it is in flight right now, and an operator who
  // cannot see it may approve or retry the same thing twice.
  executing: 1,
  // rank 2 is reserved for overdue, which is `proposed` plus a passed deadline.
  proposed: 3,
  blocked: 4,
  failed: 5,
  unconfirmed: 6,
  completed: 7,
}

export function workOrderRank(item: GovernedActionInstance): number {
  return isOverdue(item) ? 2 : STATE_RANK[item.state]
}

/** Stable: equal ranks keep the order the port returned, so nothing jumps between renders. */
export function orderWorkItems(
  items: readonly GovernedActionInstance[],
): readonly GovernedActionInstance[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => workOrderRank(a.item) - workOrderRank(b.item) || a.index - b.index)
    .map((entry) => entry.item)
}

// ── Card chrome ─────────────────────────────────────────────────────────────

const CARD_BASE =
  'flex min-w-0 flex-col gap-[6px] rounded-[var(--iso-radius-lg)] bg-[var(--iso-surface)] p-[10px_12px] border border-[var(--iso-border)]'

/** A 3px left border in the semantic family. Literal strings — Tailwind cannot see a built one. */
const LEFT_BORDER: Record<'warn' | 'block' | 'err', string> = {
  warn: 'border-l-[3px] border-l-[var(--iso-warn)]',
  block: 'border-l-[3px] border-l-[var(--iso-block)]',
  err: 'border-l-[3px] border-l-[var(--iso-err)]',
}

function preparedByLine(item: GovernedActionInstance): string {
  return item.requestedBy.kind === 'ai'
    ? `Prepared by ${item.requestedBy.name} · AI assistant`
    : `Requested by ${item.requestedBy.name}`
}

function CardTitle(props: { children: string }) {
  // Titles WRAP and are never shortened. A shortened title is the one thing on this card an
  // operator cannot recover by looking harder.
  return (
    <h3 className="min-w-0 break-words text-[12.5px] font-semibold leading-[1.35] text-[var(--iso-fg)]">
      {props.children}
    </h3>
  )
}

function CardSubtitle(props: { children: string }) {
  return (
    <p className="min-w-0 break-words text-[11.5px] leading-[1.4] text-[var(--iso-fg-2)]">
      {props.children}
    </p>
  )
}

/** Actions wrap under the text — they are never a second column competing with the title. */
function CardActions(props: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-wrap gap-[6px] pt-[1px]">{props.children}</div>
}

// ── ApprovalCard ────────────────────────────────────────────────────────────

/**
 * A human authorising a governed action, having been told exactly what will change.
 *
 * The consequence block is MANDATORY and must say whether anything reaches the customer. An
 * approval without a stated consequence is not informed consent, it is a button.
 *
 * Approve is the accent button AND FIRST IN DOM ORDER — the keyboard order and the visual
 * order agree, so a screen-reader user meets the same primary action a sighted one does.
 */
export function ApprovalCard(props: { item: GovernedActionInstance; className?: string }) {
  const { item } = props
  return (
    <article className={cn(CARD_BASE, LEFT_BORDER.warn, 'gap-[7px]', props.className)}>
      <CardTitle>{item.title}</CardTitle>
      {item.subtitle ? <CardSubtitle>{item.subtitle}</CardSubtitle> : null}

      <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
        <StatusBadge state={item.state} />
        <span className="break-words text-[11px] text-[var(--iso-fg-3)]">
          {preparedByLine(item)}
        </span>
      </div>

      <div className="flex min-w-0 flex-col gap-[4px] rounded-[var(--iso-radius-md)] border border-[var(--iso-border)] bg-[var(--iso-surface-2)] p-[8px_9px]">
        <SectionLabel>What will happen if you approve</SectionLabel>
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          {item.consequence}
        </p>
      </div>

      <CardActions>
        <ModuleButton label="Approve" intent={`work.approve:${item.id}`} tone="accent" />
        <ModuleButton label="Decline" intent={`work.decline:${item.id}`} tone="outline" />
      </CardActions>
    </article>
  )
}

// ── ActionCard ──────────────────────────────────────────────────────────────

/**
 * One unit of work, with its true state and what to do about it.
 *
 * Each terminal state renders its own honest tail. The tails are written out per state rather
 * than driven from a table, because the WORDS are the product here and a table would invite
 * someone to add a state whose copy nobody wrote.
 */
export function ActionCard(props: { item: GovernedActionInstance; className?: string }) {
  const { item } = props
  const overdue = isOverdue(item)

  const edge =
    item.state === 'blocked'
      ? LEFT_BORDER.block
      : item.state === 'failed'
        ? LEFT_BORDER.err
        : overdue
          ? LEFT_BORDER.warn
          : null

  return (
    <article
      className={cn(
        CARD_BASE,
        edge,
        // `unconfirmed` is dashed on every side: the card itself is provisional.
        item.state === 'unconfirmed' && 'border-dashed border-[var(--iso-border-strong)]',
        props.className,
      )}
    >
      <CardTitle>{item.title}</CardTitle>
      {item.subtitle ? <CardSubtitle>{item.subtitle}</CardSubtitle> : null}

      <div className="flex min-w-0 flex-wrap items-center gap-[6px]">
        <StatusBadge state={item.state} />
        {overdue ? (
          <span className="text-[11px] font-semibold text-[var(--iso-warn)]">Already late</span>
        ) : null}
        <span className="break-words text-[11px] text-[var(--iso-fg-3)]">
          {preparedByLine(item)}
        </span>
      </div>

      {/* ── executing ───────────────────────────────────────────────────────
          NEVER a success state. No ok/green token appears anywhere in this branch. */}
      {item.state === 'executing' ? (
        <div className="flex min-w-0 flex-col gap-[6px]">
          <div className="flex min-w-0 items-center gap-[6px]">
            <span
              aria-hidden="true"
              className="iso-pulse h-[5px] w-[5px] flex-none rounded-[var(--iso-radius-pill)] bg-[var(--iso-info)]"
            />
            <span className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-info)]">
              This is not finished until the sales system confirms it.
            </span>
          </div>
          <div
            aria-hidden="true"
            className="iso-shimmer h-[4px] w-full rounded-[var(--iso-radius-pill)]"
          />
        </div>
      ) : null}

      {/* ── completed ───────────────────────────────────────────────────────
          A readback or nothing. There is no branch here that prints "Done". */}
      {item.state === 'completed' && item.readback ? (
        <ReadbackResult readback={item.readback} />
      ) : null}

      {/* ── blocked ─────────────────────────────────────────────────────────
          Nothing was attempted, and the customer has not been told. */}
      {item.state === 'blocked' ? (
        <>
          <Inset family="block">
            {item.explanation} Nothing was attempted and nothing has been changed. The customer has
            not been told anything.
          </Inset>
          <CardActions>
            <ModuleButton
              label="Send to a manager"
              intent={`work.escalate:${item.id}`}
              tone="outline"
            />
          </CardActions>
        </>
      ) : null}

      {/* ── failed ──────────────────────────────────────────────────────────
          What did NOT change, and what the customer still believes. */}
      {item.state === 'failed' ? (
        <>
          <Inset family="err" heading="What did not change">
            {item.explanation}
          </Inset>
          {item.customerImpact ? (
            <Inset family="err" heading="What the customer still believes">
              {item.customerImpact}
            </Inset>
          ) : null}
          <CardActions>
            <ModuleButton label="Try again" intent={`work.retry:${item.id}`} tone="outline" />
          </CardActions>
        </>
      ) : null}

      {/* ── unconfirmed ─────────────────────────────────────────────────────
          NO ACTION AT ALL. We do not know whether the effect landed, so a retry could do it
          twice and a tick would be a lie. The absence of a button is the honest answer. */}
      {item.state === 'unconfirmed' ? (
        <Inset family="neutral">
          {item.explanation} Do not tell the customer it arrived yet. There is nothing to press:
          trying again could do it twice.
        </Inset>
      ) : null}

      {/* ── proposed / overdue ──────────────────────────────────────────────
          Ordinary outstanding work. One quiet way in, no accent — the accent in this module
          belongs to Approve. */}
      {item.state === 'proposed' ? (
        <CardActions>
          <ModuleButton label="Open" intent={`work.open:${item.id}`} tone="outline" />
        </CardActions>
      ) : null}
    </article>
  )
}

// ── The module body ─────────────────────────────────────────────────────────

export function WorkModuleView(props: {
  items: readonly GovernedActionInstance[]
  filter?: string
  className?: string
}) {
  const ordered = orderWorkItems(props.items)

  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      <div className="flex min-w-0 flex-wrap gap-[5px]" role="group" aria-label="Filter work">
        {WORK_FILTERS.map((filter) => (
          <ModuleChip
            key={filter.id}
            label={filter.label}
            intent={`work.filter:${filter.id}`}
            pressed={props.filter === filter.id}
          />
        ))}
      </div>

      {ordered.length ? (
        <div className="flex min-w-0 flex-col gap-[7px]">
          {ordered.map((item) =>
            item.state === 'awaitingApproval' ? (
              <ApprovalCard key={item.id} item={item} />
            ) : (
              <ActionCard key={item.id} item={item} />
            ),
          )}
        </div>
      ) : (
        <EmptyState
          variant="nothing-to-do"
          title="Nothing is waiting on you here"
          body="There are no follow-ups, approvals or failed changes under this filter."
          reassurance="Nothing is wrong and nothing is waiting on you."
        />
      )}
    </div>
  )
}
