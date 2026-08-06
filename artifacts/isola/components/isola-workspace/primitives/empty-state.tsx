/**
 * Isola Workspace — empty states.
 *
 * AN EMPTY STATE IS A SENTENCE, NOT AN ABSENCE. Each of these answers the same four
 * questions every state in this design must answer: what happened, might it be out of date,
 * what can I do next, and is customer-facing work affected. That is why `title` and `body`
 * are both REQUIRED — a bare "No results" tells an operator nothing about whether they have
 * finished their work or whether the system failed to look.
 *
 * The variants are not decoration either: "nothing to do" is good news and looks settled,
 * while "not configured" and "no data in your plan" are absences and are drawn as an
 * unfilled dashed outline, so the two never read as the same thing.
 *
 * AT MOST ONE PRIMARY ACTION. If a caller marks several, only the first is emphasised — two
 * primaries is no primary, and the operator is left choosing rather than acting.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'
import {
  CheckCircle2,
  PackageOpen,
  SearchX,
  Settings2,
  Users,
} from 'lucide-react'

import { cn } from '@/lib/utils'

export type EmptyStateVariant =
  | 'nothing-to-do'
  | 'no-customer-match'
  | 'multiple-matches'
  | 'not-configured'
  | 'no-data-in-plan'

interface VariantSpec {
  box: string
  glyph: string
  Icon: typeof SearchX
}

const VARIANTS: Record<EmptyStateVariant, VariantSpec> = {
  // Good news. A solid card, because the work really is done.
  'nothing-to-do': {
    box: 'rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)]',
    glyph: 'text-[var(--iso-ok)]',
    Icon: CheckCircle2,
  },
  // Something IS here — several somethings — so it keeps a solid card and asks for a choice.
  'multiple-matches': {
    box: 'rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)]',
    glyph: 'text-[var(--iso-fg-2)]',
    Icon: Users,
  },
  'no-customer-match': {
    box: 'rounded-[var(--iso-radius-lg)] border border-dashed border-[var(--iso-border-strong)] bg-transparent',
    glyph: 'text-[var(--iso-fg-3)]',
    Icon: SearchX,
  },
  'not-configured': {
    box: 'rounded-[var(--iso-radius-lg)] border border-dashed border-[var(--iso-border-strong)] bg-transparent',
    glyph: 'text-[var(--iso-fg-3)]',
    Icon: Settings2,
  },
  'no-data-in-plan': {
    box: 'rounded-[var(--iso-radius-lg)] border border-dashed border-[var(--iso-border-strong)] bg-transparent',
    glyph: 'text-[var(--iso-fg-3)]',
    Icon: PackageOpen,
  },
}

const PRIMARY_BUTTON =
  'inline-flex items-center rounded-[var(--iso-radius-sm)] bg-[var(--iso-accent)] px-[10px] py-[4px] text-[11px] font-semibold text-[var(--iso-on-accent)] hover:bg-[var(--iso-accent-hover)]'

const SECONDARY_BUTTON =
  'inline-flex items-center rounded-[var(--iso-radius-sm)] border border-[var(--iso-border-strong)] bg-[var(--iso-surface)] px-[10px] py-[4px] text-[11px] font-semibold text-[var(--iso-fg)] hover:bg-[var(--iso-surface-2)]'

export function EmptyState(props: {
  variant: EmptyStateVariant
  title: string
  body: string
  reassurance?: string
  actions?: { label: string; intent: string; primary?: boolean }[]
  className?: string
}): JSX.Element {
  const { variant, title, body, reassurance, actions, className } = props
  const spec = VARIANTS[variant]
  const Icon = spec.Icon

  // Only the FIRST action marked primary is emphasised; any later one falls back to
  // secondary rather than being dropped, so no caller silently loses a button.
  const primaryIndex = actions?.findIndex((a) => a.primary) ?? -1

  return (
    <div className={cn('p-[12px]', spec.box, className)}>
      <div className="flex items-start gap-[8px]">
        <Icon size={16} aria-hidden="true" className={cn('mt-[1px] flex-none', spec.glyph)} />

        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold text-[var(--iso-fg)]">{title}</p>
          <p className="mt-[3px] text-[11.5px] text-[var(--iso-fg-2)]">{body}</p>

          {reassurance ? (
            <p className="mt-[4px] text-[11px] text-[var(--iso-fg-3)]">{reassurance}</p>
          ) : null}

          {actions && actions.length > 0 ? (
            <div className="mt-[9px] flex flex-wrap items-center gap-[7px]">
              {actions.map((action, i) => (
                <button
                  key={`${action.intent}-${i}`}
                  type="button"
                  data-intent={action.intent}
                  className={i === primaryIndex ? PRIMARY_BUTTON : SECONDARY_BUTTON}
                >
                  {action.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
