/**
 * Isola Workspace — inline alert.
 *
 * `role="status"` — POLITE, ALWAYS. Never `role="alert"`.
 *
 * `role="alert"` is an assertive live region: it interrupts a screen-reader user mid-word.
 * Nothing this component renders is worth interrupting someone for — these are conditions
 * to notice (data may be old, a service is slow, something needs a decision), not
 * emergencies. Reserving assertive announcements for nothing at all is how a workspace ends
 * up shouting at the operator all day and being tuned out.
 *
 * Copy shape: a bold lead sentence that says what happened, then an explanation of what it
 * means for the work in front of the operator. A title alone leaves the operator to guess.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'
import { AlertCircle, AlertTriangle, Clock, Info } from 'lucide-react'

import { cn } from '@/lib/utils'

export type AlertVariant = 'warning' | 'stale' | 'degraded' | 'error' | 'neutral'

interface VariantSpec {
  /** Container tokens: soft fill + 1px border of the family. */
  box: string
  /** Glyph colour, matching the family's foreground. */
  glyph: string
  Icon: typeof AlertTriangle
}

const VARIANTS: Record<AlertVariant, VariantSpec> = {
  warning: {
    box: 'bg-[var(--iso-warn-soft)] border-[var(--iso-warn-border)]',
    glyph: 'text-[var(--iso-warn)]',
    Icon: AlertTriangle,
  },
  // Stale is a warning about TIME, not about a fault: same family, a clock rather than a
  // triangle, so the two are distinguishable without reading.
  stale: {
    box: 'bg-[var(--iso-warn-soft)] border-[var(--iso-warn-border)]',
    glyph: 'text-[var(--iso-warn)]',
    Icon: Clock,
  },
  // Degraded is the `block` family — deliberately NOT the error family. Nothing was
  // attempted and lost; a service is simply not answering right now.
  degraded: {
    box: 'bg-[var(--iso-block-soft)] border-[var(--iso-block-border)]',
    glyph: 'text-[var(--iso-block)]',
    Icon: AlertTriangle,
  },
  error: {
    box: 'bg-[var(--iso-err-soft)] border-[var(--iso-err-border)]',
    glyph: 'text-[var(--iso-err)]',
    Icon: AlertCircle,
  },
  neutral: {
    box: 'bg-[var(--iso-surface-3)] border-[var(--iso-border)]',
    glyph: 'text-[var(--iso-fg-2)]',
    Icon: Info,
  },
}

export function Alert(props: {
  variant: AlertVariant
  title: string
  body?: string
  timestampNote?: string
  action?: { label: string; intent: string }
  className?: string
}): JSX.Element {
  const { variant, title, body, timestampNote, action, className } = props
  const spec = VARIANTS[variant]
  const Icon = spec.Icon

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-[8px] rounded-[var(--iso-radius-md)] border p-[9px_10px] text-[11.5px]',
        spec.box,
        className,
      )}
    >
      <Icon size={15} aria-hidden="true" className={cn('mt-[1px] flex-none', spec.glyph)} />

      <div className="min-w-0 flex-1">
        <p className="font-semibold text-[var(--iso-fg)]">{title}</p>

        {body ? <p className="mt-[3px] text-[var(--iso-fg-2)]">{body}</p> : null}

        {timestampNote ? (
          <p className="mt-[3px] text-[11px] text-[var(--iso-fg-3)]">{timestampNote}</p>
        ) : null}

        {action ? (
          <button
            type="button"
            data-intent={action.intent}
            className={cn(
              'mt-[7px] inline-flex items-center rounded-[var(--iso-radius-sm)]',
              'border border-[var(--iso-border-strong)] bg-[var(--iso-surface)]',
              'px-[9px] py-[3px] text-[11px] font-semibold text-[var(--iso-fg)]',
              'hover:bg-[var(--iso-surface-2)]',
            )}
          >
            {action.label}
          </button>
        ) : null}
      </div>
    </div>
  )
}
