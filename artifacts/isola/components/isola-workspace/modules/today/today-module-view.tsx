/**
 * Isola Workspace — the Today module body.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 * ------------------------------------
 * Today is a DECISION SURFACE, not a dashboard. A dashboard tells you how much happened; this
 * tells you what will go wrong if you do nothing. So:
 *
 *   · No chart. Anywhere. A chart answers "how are we trending", which nobody in a shop at
 *     09:34 is asking.
 *   · The decision bar is three numbers each with a SENTENCE — "2 customers waiting on a
 *     promise we broke" — not a KPI strip of bare figures whose meaning you must supply.
 *   · Volume metrics ("24 conversations today") are demoted to one quiet line. They are true
 *     and they are not a decision, so they sit below the things that are.
 *   · "Needs attention now" is ordered BY BUSINESS HARM, not by time. The oldest item is
 *     frequently the least important one, and sorting by age quietly buries the broken promise.
 *   · Exactly one accent button in the whole view, so "the next thing to do" is unambiguous.
 *
 * In the conversation panel this module renders a 2×2 count grid and a way into the full view
 * — and nothing else. A 384px column beside a live conversation is not a place to read a day.
 *
 * MANAGER-ONLY SECTIONS ARE ABSENT, NOT HIDDEN. When `canSeeTeam` is false the team cards are
 * not in the markup at all. CSS-hidden content is still shipped to the browser and still in
 * the DOM, which is not a permission boundary.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/isola-workspace/primitives'
import type { AttentionItem, TodaySummary } from '@/lib/isola-workspace/adapters/ports'

import { ModuleButton, ModuleCard, SectionLabel } from '../shared'

// ── Semantic colour maps (literal class strings only) ───────────────────────

const METRIC_TEXT: Record<'err' | 'warn' | 'neutral', string> = {
  err: 'text-[var(--iso-err)]',
  warn: 'text-[var(--iso-warn)]',
  neutral: 'text-[var(--iso-fg)]',
}

const SEVERITY_DOT: Record<AttentionItem['severity'], string> = {
  err: 'bg-[var(--iso-err)]',
  warn: 'bg-[var(--iso-warn)]',
  block: 'bg-[var(--iso-block)]',
}

/**
 * Business harm, in order.
 *
 * `err` is a promise already broken. `warn` is a promise about to be broken. `block` is a
 * service degraded but contained — it is real, and it is the least likely to cost a customer
 * today. Time is deliberately not an input.
 */
const HARM_RANK: Record<AttentionItem['severity'], number> = { err: 0, warn: 1, block: 2 }

export function orderByHarm(items: readonly AttentionItem[]): readonly AttentionItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => HARM_RANK[a.item.severity] - HARM_RANK[b.item.severity] || a.index - b.index)
    .map((entry) => entry.item)
}

// ── Conversation panel: counts and a way out ────────────────────────────────

function CountCell(props: { value: string; family: 'err' | 'warn' | 'neutral'; text: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[1px] rounded-[var(--iso-radius-md)] border border-[var(--iso-border)] bg-[var(--iso-surface)] p-[8px_9px]">
      <span className={cn('text-[17px] font-semibold leading-[1.15]', METRIC_TEXT[props.family])}>
        {props.value}
      </span>
      <span className="break-words text-[10.5px] leading-[1.35] text-[var(--iso-fg-2)]">
        {props.text}
      </span>
    </div>
  )
}

function TodayPanelView(props: { summary: TodaySummary; className?: string }) {
  // Four cells: the three decision counts plus how many things are waiting. The fourth is
  // derived here rather than added to the port, so the panel cannot drift from the full view.
  const cells: { value: string; family: 'err' | 'warn' | 'neutral'; text: string }[] = [
    ...props.summary.decisionMetrics.slice(0, 3).map((metric) => ({
      value: metric.value,
      family: metric.family,
      text: metric.text,
    })),
    {
      value: String(props.summary.needsAttention.length),
      family: 'neutral' as const,
      text: 'things needing attention now',
    },
  ]

  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      {/* The one grid wider than a single cell in the whole workspace. */}
      <div className="grid min-w-0 grid-cols-2 gap-[6px]">
        {cells.map((cell) => (
          <CountCell key={cell.text} value={cell.value} family={cell.family} text={cell.text} />
        ))}
      </div>
      <ModuleButton
        label="Open the full day view"
        intent="today.open-workspace"
        tone="accent"
        className="w-full"
      />
    </div>
  )
}

// ── Workspace: the decision bar ─────────────────────────────────────────────

function DecisionBar(props: { summary: TodaySummary }) {
  return (
    <section className="flex min-w-0 flex-col rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)]">
      {props.summary.decisionMetrics.map((metric, index) => (
        <div
          key={metric.text}
          className={cn(
            'flex min-w-0 items-baseline gap-[10px] p-[10px_12px]',
            index > 0 && 'border-t border-[var(--iso-border)]',
          )}
        >
          <span
            className={cn(
              'flex-none text-[20px] font-semibold leading-[1.1]',
              METRIC_TEXT[metric.family],
            )}
          >
            {metric.value}
          </span>
          {/* A number with a sentence. Never a bare figure under a two-word caption. */}
          <span className="min-w-0 break-words text-[12px] leading-[1.4] text-[var(--iso-fg-2)]">
            {metric.text}
          </span>
        </div>
      ))}
    </section>
  )
}

// ── Workspace: needs attention now ──────────────────────────────────────────

function AttentionRow(props: { item: AttentionItem; primary: boolean }) {
  const { item } = props
  return (
    <li className="flex min-w-0 flex-col gap-[5px] border-t border-[var(--iso-border)] p-[10px_12px] first:border-t-0">
      <div className="flex min-w-0 items-start gap-[8px]">
        <span
          aria-hidden="true"
          className={cn(
            'mt-[5px] h-[6px] w-[6px] flex-none rounded-[var(--iso-radius-pill)]',
            SEVERITY_DOT[item.severity],
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-[2px]">
          <span className="break-words text-[12.5px] font-semibold leading-[1.35] text-[var(--iso-fg)]">
            {item.title}
          </span>
          <span className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            {item.body}
          </span>
          {item.meta ? (
            <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
              {item.meta}
            </span>
          ) : null}
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap gap-[6px] pl-[14px]">
        <ModuleButton
          label={item.actionLabel}
          intent={`today.attention:${item.title}`}
          // ONLY the first row is accent. Two accents would be two "do this first"s.
          tone={props.primary ? 'accent' : 'outline'}
        />
      </div>
    </li>
  )
}

function NeedsAttention(props: { items: readonly AttentionItem[] }) {
  const ordered = orderByHarm(props.items)

  if (!ordered.length) {
    return (
      <EmptyState
        variant="nothing-to-do"
        title="Nothing needs attention right now"
        body="No broken promises, no overdue approvals and no service problems."
        reassurance="Nothing is wrong and nothing is waiting on you."
      />
    )
  }

  return (
    <section className="flex min-w-0 flex-col gap-[7px]">
      <SectionLabel>Needs attention now</SectionLabel>
      <ul className="flex min-w-0 list-none flex-col rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)] p-0">
        {ordered.map((item, index) => (
          <AttentionRow key={item.title} item={item} primary={index === 0} />
        ))}
      </ul>
    </section>
  )
}

// ── Workspace: manager-only ─────────────────────────────────────────────────

function TeamCards(props: { team: NonNullable<TodaySummary['team']> }) {
  return (
    <>
      <ModuleCard as="section" className="gap-[7px]">
        <SectionLabel>Who is carrying what</SectionLabel>
        <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
          {props.team.workload.map((person) => (
            <li key={person.name} className="flex min-w-0 flex-col gap-[1px]">
              <span className="break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                {person.name}
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {person.detail}
              </span>
            </li>
          ))}
        </ul>
      </ModuleCard>

      <ModuleCard as="section" className="gap-[7px]">
        <SectionLabel>Service problems</SectionLabel>
        <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
          {props.team.serviceProblems.map((problem) => (
            <li key={problem.title} className="flex min-w-0 flex-col gap-[1px]">
              <span className="break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                {problem.title}
              </span>
              <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                {problem.detail}
              </span>
            </li>
          ))}
        </ul>
      </ModuleCard>
    </>
  )
}

// ── The module body ─────────────────────────────────────────────────────────

export function TodayModuleView(props: {
  summary: TodaySummary
  canSeeTeam: boolean
  context: 'conversation-panel' | 'workspace'
  className?: string
}) {
  if (props.context === 'conversation-panel') {
    return <TodayPanelView summary={props.summary} className={props.className} />
  }

  const team = props.canSeeTeam ? props.summary.team : undefined

  return (
    <div className={cn('flex min-w-0 flex-col gap-[14px]', props.className)}>
      <header className="flex min-w-0 flex-col gap-[1px]">
        <h2 className="break-words text-[18px] font-semibold leading-[1.25] text-[var(--iso-fg)]">
          {props.summary.date}
        </h2>
        <p className="break-words text-[11.5px] text-[var(--iso-fg-3)]">{props.summary.time}</p>
      </header>

      <DecisionBar summary={props.summary} />

      {/* Volume, deliberately demoted: true, quiet, and not a decision. */}
      <p className="break-words text-[11px] leading-[1.45] text-[var(--iso-fg-3)]">
        {props.summary.activityLine}
      </p>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-[14px] min-[850px]:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-[14px]">
          <NeedsAttention items={props.summary.needsAttention} />
        </div>

        <div className="flex min-w-0 flex-col gap-[10px]">
          {team ? (
            <TeamCards team={team} />
          ) : (
            /* The team cards are ABSENT from this branch, not hidden. */
            <ModuleCard as="section" className="gap-[4px]">
              <SectionLabel>Your view</SectionLabel>
              <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
                You are seeing your own work. Team workload and service problems are shown to
                managers.
              </p>
            </ModuleCard>
          )}
        </div>
      </div>
    </div>
  )
}
