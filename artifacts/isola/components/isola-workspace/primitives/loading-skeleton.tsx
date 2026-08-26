/**
 * Isola Workspace — loading skeletons.
 *
 * A skeleton is FURNITURE, not information. Every bar is `aria-hidden`, because a screen
 * reader announcing "blank, blank, blank" is worse than silence. The sentence that tells an
 * operator what is being fetched and whether it is slow is the CALLER's responsibility and
 * is deliberately not hardcoded here — a shared primitive cannot know what is loading, and a
 * generic "Loading…" is exactly the non-answer this design forbids.
 *
 * `CustomerPanelSkeleton` matches the geometry of the loaded Customer layout so that arrival
 * of the real data does not move anything. A skeleton whose shape differs from the content
 * it stands in for is a layout shift with extra steps.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'

import { cn } from '@/lib/utils'

type SkeletonVariant = 'line' | 'avatar' | 'block'

const VARIANT_SHAPE: Record<SkeletonVariant, string> = {
  line: 'h-[10px] w-full rounded-[var(--iso-radius-sm)]',
  avatar: 'h-[32px] w-[32px] flex-none rounded-[var(--iso-radius-pill)]',
  block: 'h-[54px] w-full rounded-[var(--iso-radius-md)]',
}

export function LoadingSkeleton(props: {
  variant?: 'line' | 'avatar' | 'block'
  width?: string
  count?: number
  className?: string
}): JSX.Element {
  const { variant = 'line', width, count = 1, className } = props
  const bars = Math.max(1, Math.floor(count))

  return (
    <div
      aria-hidden="true"
      className={cn(
        variant === 'avatar' ? 'flex flex-row gap-[7px]' : 'flex flex-col gap-[7px]',
        className,
      )}
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn('iso-shimmer block', VARIANT_SHAPE[variant])}
          style={width ? { width } : undefined}
        />
      ))}
    </div>
  )
}

/**
 * The Customer panel while it is being read.
 *
 * Header row (avatar + name + one meta line), then a card with a heading bar and a body
 * block — the same rhythm and the same heights as the loaded panel.
 */
export function CustomerPanelSkeleton(props: { className?: string }): JSX.Element {
  const { className } = props

  return (
    <div aria-hidden="true" className={cn('flex flex-col gap-[11px]', className)}>
      <div className="flex items-center gap-[9px]">
        <span className="iso-shimmer block h-[32px] w-[32px] flex-none rounded-[var(--iso-radius-pill)]" />
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          <span className="iso-shimmer block h-[11px] w-[58%] rounded-[var(--iso-radius-sm)]" />
          <span className="iso-shimmer block h-[9px] w-[38%] rounded-[var(--iso-radius-sm)]" />
        </div>
      </div>

      <div className="rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)] p-[12px]">
        <span className="iso-shimmer mb-[10px] block h-[10px] w-[42%] rounded-[var(--iso-radius-sm)]" />
        <span className="iso-shimmer block h-[54px] w-full rounded-[var(--iso-radius-md)]" />
      </div>
    </div>
  )
}
