/**
 * Isola Workspace — expandable section.
 *
 * WHY THE NATIVE `<details>` ELEMENT AND NOT A BUTTON PLUS STATE
 * -------------------------------------------------------------
 * `<details>`/`<summary>` is focusable and operable by keyboard, exposes its open state to
 * assistive technology, and expands with zero client JavaScript. That last property is the
 * one that matters structurally: it keeps this component renderable on the server with no
 * `"use client"` boundary, so a panel full of collapsed detail costs nothing to hydrate and
 * remains readable even before (or without) hydration.
 *
 * A hand-rolled disclosure would need state, an effect for the animation, an id to wire
 * `aria-controls`, and a client bundle — to reproduce behaviour the platform already ships
 * correctly.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX, ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

import { cn } from '@/lib/utils'

type DetailsVariant = 'section' | 'nested' | 'quiet'

const CONTAINER: Record<DetailsVariant, string> = {
  section:
    'rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)] bg-[var(--iso-surface)]',
  nested:
    'rounded-[var(--iso-radius-md)] border border-[var(--iso-border)] bg-[var(--iso-surface-2)]',
  // Quiet carries no chrome of its own. Used for "Technical details": present for whoever
  // needs it, visually subordinate to everything an operator acts on.
  quiet: 'rounded-[var(--iso-radius-md)] border border-transparent bg-transparent',
}

const TITLE: Record<DetailsVariant, string> = {
  section: 'text-[12.5px] font-semibold text-[var(--iso-fg)]',
  nested: 'text-[12.5px] font-semibold text-[var(--iso-fg)]',
  quiet: 'text-[12.5px] text-[var(--iso-fg-2)]',
}

export function ExpandableDetails(props: {
  title: string
  summary?: string
  variant?: 'section' | 'nested' | 'quiet'
  defaultOpen?: boolean
  children: ReactNode
  className?: string
}): JSX.Element {
  const { title, summary, variant = 'section', defaultOpen = false, children, className } = props

  return (
    <details open={defaultOpen} className={cn(CONTAINER[variant], className)}>
      <summary
        aria-expanded={defaultOpen}
        className={cn(
          'flex cursor-pointer list-none items-start gap-[8px] px-[12px] py-[10px]',
          // The default disclosure triangle is replaced by our own chevron; hiding it in
          // both engines keeps the two markers from appearing side by side.
          '[&::-webkit-details-marker]:hidden [&::marker]:content-none',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className={cn('block', TITLE[variant])}>{title}</span>
          {summary ? (
            <span className="mt-[2px] block text-[11.5px] text-[var(--iso-fg-2)]">{summary}</span>
          ) : null}
        </span>

        <ChevronDown
          size={16}
          aria-hidden="true"
          className={cn(
            'mt-[1px] flex-none text-[var(--iso-fg-3)] transition-transform duration-150',
            '[details[open]>summary_&]:rotate-180',
          )}
        />
      </summary>

      <div className="border-t border-[var(--iso-border)] px-[12px] py-[10px]">{children}</div>
    </details>
  )
}
