/**
 * Isola Workspace — timeline.
 *
 * An ordered list, because the order IS the information: what happened most recently sits
 * at the top and carries the accent dot, everything behind it fades to the strong border
 * colour. Rendering this as a stack of divs would leave a screen-reader user with no
 * sequence at all.
 *
 * `emphasis` lets a caller name the current item explicitly; when no caller says, the first
 * item is treated as the newest, which is the order this list is documented to arrive in.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'

import { cn } from '@/lib/utils'

export function Timeline(props: {
  items: readonly { title: string; meta: string; emphasis?: 'current' | 'past' }[]
  className?: string
}): JSX.Element {
  const { items, className } = props

  return (
    <ol
      className={cn(
        'flex flex-col gap-[11px] border-l-[1.5px] border-[var(--iso-border)] pl-[12px]',
        className,
      )}
    >
      {items.map((item, i) => {
        const isCurrent = item.emphasis ? item.emphasis === 'current' : i === 0

        return (
          <li key={`${item.title}-${i}`} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                'absolute left-[-16.75px] top-[4px] h-[8px] w-[8px] rounded-[var(--iso-radius-pill)]',
                isCurrent ? 'bg-[var(--iso-accent)]' : 'bg-[var(--iso-border-strong)]',
              )}
            />
            <p className="text-[12px] font-medium text-[var(--iso-fg)]">{item.title}</p>
            <p className="mt-[1px] text-[11px] text-[var(--iso-fg-3)]">{item.meta}</p>
          </li>
        )
      })}
    </ol>
  )
}
