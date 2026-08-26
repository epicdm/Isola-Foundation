/**
 * Isola Workspace — status badge.
 *
 * THE TEXT LABEL IS ALWAYS PRESENT. Colour is a second signal, never the only one: an
 * operator with a colour-vision difference, a monochrome screenshot pasted into a chat, or a
 * high-contrast forced-colours mode must all still read the state in words.
 *
 * The words themselves come from `ACTION_STATE_LABEL` and the colour family from
 * `ACTION_STATE_FAMILY`, both in the lifecycle module. Neither is re-derived here, so a
 * badge cannot drift from the state machine — in particular `executing` is `info`, never
 * `ok`, and no green can appear while something is still running.
 *
 * Pure presentation: props in, markup out. No hooks, no state, no client boundary.
 */

import type { JSX } from 'react'
import { Lock } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { ActionState } from '@/lib/isola-workspace/contracts'
import {
  ACTION_STATE_FAMILY,
  ACTION_STATE_LABEL,
} from '@/lib/isola-workspace/action-lifecycle'

/**
 * Family -> token triple. `neutral` deliberately has no status family of its own: a state
 * with nothing to say must look like plain furniture, not a muted warning.
 */
const FAMILY_CLASS: Record<
  (typeof ACTION_STATE_FAMILY)[ActionState],
  string
> = {
  ok: 'bg-[var(--iso-ok-soft)] text-[var(--iso-ok)] border-[var(--iso-ok-border)]',
  warn: 'bg-[var(--iso-warn-soft)] text-[var(--iso-warn)] border-[var(--iso-warn-border)]',
  err: 'bg-[var(--iso-err-soft)] text-[var(--iso-err)] border-[var(--iso-err-border)]',
  info: 'bg-[var(--iso-info-soft)] text-[var(--iso-info)] border-[var(--iso-info-border)]',
  block: 'bg-[var(--iso-block-soft)] text-[var(--iso-block)] border-[var(--iso-block-border)]',
  neutral: 'bg-[var(--iso-surface-3)] text-[var(--iso-fg-2)] border-[var(--iso-border)]',
}

export function StatusBadge(props: {
  state: ActionState
  className?: string
}): JSX.Element {
  const { state, className } = props
  const family = ACTION_STATE_FAMILY[state]

  return (
    <span
      className={cn(
        'inline-flex items-center gap-[4px] px-[7px] py-[2px]',
        'rounded-[var(--iso-radius-pill)] text-[10px] font-semibold border align-middle',
        FAMILY_CLASS[family],
        // Dashed = "we cannot prove this landed". A solid outline would read as settled.
        state === 'unconfirmed' && 'border-dashed',
        className,
      )}
    >
      {state === 'executing' ? (
        <span
          aria-hidden="true"
          className="iso-pulse inline-block h-[5px] w-[5px] flex-none rounded-[var(--iso-radius-pill)] bg-current"
        />
      ) : null}
      {state === 'blocked' ? (
        <Lock size={11} aria-hidden="true" className="flex-none" />
      ) : null}
      {ACTION_STATE_LABEL[state]}
    </span>
  )
}
