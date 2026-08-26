/**
 * Isola Workspace — degraded state.
 *
 * DEGRADED IS NEVER RENDERED AS FAILURE.
 *
 * A failure means something was attempted and did not land, and it obliges the operator to
 * think about what the customer now believes. Degraded means the opposite: nothing was
 * attempted, so nothing was sent and nothing was lost. Painting it red would push an
 * operator into apologising to a customer for something that never happened — which is why
 * this component uses the `block` family and never the error family, and why it always
 * states BOTH what still works and what is paused. An operator who knows only that
 * "something is down" cannot decide what to do next; one who knows which half of their work
 * is unaffected can carry on with it.
 *
 * `service` arrives already in plain English — naming it is the caller's job, and it is
 * rendered exactly as given.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'
import { AlertTriangle, WifiOff } from 'lucide-react'

import { cn } from '@/lib/utils'

type DegradedVariant = 'banner' | 'module' | 'offline'

export function DegradedState(props: {
  variant?: 'banner' | 'module' | 'offline'
  service: string
  whatStillWorks: string
  whatIsPaused: string
  lastGoodRead?: string
  retrying?: boolean
  className?: string
}): JSX.Element {
  const {
    variant = 'module',
    service,
    whatStillWorks,
    whatIsPaused,
    lastGoodRead,
    retrying,
    className,
  } = props

  const Icon = variant === 'offline' ? WifiOff : AlertTriangle

  const heading: Record<DegradedVariant, string> = {
    banner: `${service} is answering slowly right now.`,
    module: `${service} is not answering right now.`,
    offline: `You are working offline, so ${service} cannot be reached.`,
  }

  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-[8px] border border-[var(--iso-block-border)] bg-[var(--iso-block-soft)] text-[11.5px] text-[var(--iso-block)]',
        variant === 'banner'
          ? 'rounded-[var(--iso-radius-md)] p-[8px_10px]'
          : 'rounded-[var(--iso-radius-lg)] p-[12px]',
        className,
      )}
    >
      <Icon size={15} aria-hidden="true" className="mt-[1px] flex-none" />

      <div className="min-w-0 flex-1">
        <p className="font-semibold">{heading[variant]}</p>

        <p className="mt-[4px]">
          <span className="font-semibold">Still working: </span>
          {whatStillWorks}
        </p>
        <p className="mt-[2px]">
          <span className="font-semibold">Paused for now: </span>
          {whatIsPaused}
        </p>

        {/* The single most important sentence here: this is not a failure. */}
        <p className="mt-[4px]">Nothing was sent and nothing has been lost.</p>

        {lastGoodRead ? (
          <p className="mt-[4px] text-[11px] text-[var(--iso-fg-3)]">
            Last read successfully at {lastGoodRead}.
          </p>
        ) : null}

        {retrying ? (
          <p className="mt-[4px] inline-flex items-center gap-[5px] text-[11px] text-[var(--iso-fg-3)]">
            <span
              aria-hidden="true"
              className="iso-pulse inline-block h-[5px] w-[5px] flex-none rounded-[var(--iso-radius-pill)] bg-current"
            />
            Trying again on its own — you do not need to do anything.
          </p>
        ) : null}
      </div>
    </div>
  )
}
