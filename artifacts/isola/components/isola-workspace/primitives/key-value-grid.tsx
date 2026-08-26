/**
 * Isola Workspace — label/value grid.
 *
 * A description list, not a table: these are attributes of one thing, and `<dl>` is what
 * carries that relationship to assistive technology without inventing rows and columns that
 * do not exist.
 *
 * `mono` is for values a person may have to read aloud, retype or compare character by
 * character — a reference, an identifier, a number. Proportional digits are where
 * transcription errors come from.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'

import { cn } from '@/lib/utils'

export function KeyValueGrid(props: {
  items: readonly { label: string; value: string; mono?: boolean }[]
  className?: string
}): JSX.Element {
  const { items, className } = props

  return (
    <dl className={cn('grid grid-cols-2 gap-[7px]', className)}>
      {items.map((item, i) => (
        <div key={`${item.label}-${i}`} className="min-w-0">
          <dt className="text-[10px] font-semibold uppercase tracking-[0.07em] text-[var(--iso-fg-3)]">
            {item.label}
          </dt>
          <dd
            className={cn(
              'mt-[2px] text-[11.5px] text-[var(--iso-fg)]',
              item.mono && 'font-[family-name:var(--iso-font-mono)] text-[11px]',
            )}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}
