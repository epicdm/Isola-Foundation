/**
 * Isola Workspace — readback result.
 *
 * THIS IS THE ONLY COMPONENT IN THE SYSTEM ALLOWED TO DECLARE SUCCESS.
 *
 * It can only do so because a `Readback` is, by construction, the owning system's own
 * statement of its own state plus the time we read it — see `action-lifecycle.ts`, where an
 * action cannot reach `completed` without one. Every other component therefore has nothing
 * green to say, and green in this product means exactly one thing: somebody else confirmed
 * it, and here are their words.
 *
 * The rendered line quotes `readback.statement` verbatim. It NEVER says "Action completed
 * successfully" — that is a claim about the request we sent rather than about their state,
 * and it is precisely the lie this whole mechanism exists to prevent.
 *
 * `pending` deliberately gets no success colour at all. Waiting for confirmation is not a
 * lesser kind of confirmation.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'
import { Check, Clock } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { Readback } from '@/lib/isola-workspace/action-lifecycle'

import { SOURCE_SUBJECT } from './source-badge'

export function ReadbackResult(props: {
  readback: Readback
  variant?: 'confirmed' | 'pending'
  className?: string
}): JSX.Element {
  const { readback, variant = 'confirmed', className } = props
  const subject = SOURCE_SUBJECT[readback.system]
  const confirmed = variant === 'confirmed'

  return (
    <div
      className={cn(
        'iso-rise rounded-[var(--iso-radius-md)] border p-[8px_9px]',
        confirmed
          ? 'border-[var(--iso-ok-border)] bg-[var(--iso-ok-soft)]'
          : 'border-[var(--iso-border)] bg-[var(--iso-surface-2)]',
        className,
      )}
    >
      <p
        className={cn(
          'flex items-start gap-[5px] text-[11.5px] font-semibold',
          confirmed ? 'text-[var(--iso-ok)]' : 'text-[var(--iso-fg-2)]',
        )}
      >
        {confirmed ? (
          <Check size={14} aria-hidden="true" className="mt-[1px] flex-none" />
        ) : (
          <Clock size={14} aria-hidden="true" className="mt-[1px] flex-none" />
        )}
        <span>
          {confirmed
            ? `Confirmed by ${subject}`
            : `Waiting for ${subject} to confirm this`}
        </span>
      </p>

      {/* Their words, not ours. */}
      <p className="mt-[4px] text-[11.5px] text-[var(--iso-fg-2)]">{readback.statement}</p>

      <p className="mt-[3px] text-[11px] text-[var(--iso-fg-3)]">Read at {readback.readAt}</p>

      {readback.href ? (
        <a
          href={readback.href}
          className="mt-[4px] inline-block text-[11px] font-medium text-[var(--iso-accent)]"
        >
          Open the record
        </a>
      ) : null}
    </div>
  )
}
