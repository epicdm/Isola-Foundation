/**
 * Isola Workspace — source badge.
 *
 * Attribution, and nothing else. A fact shown to an operator says where it came from in
 * plain English, and the vocabulary here is the ONLY vocabulary permitted for that — a
 * vendor or product name must never reach an operator's screen.
 *
 * SOURCE BADGES NEVER GET THEIR OWN COLOUR. Colour in this design is reserved for state:
 * something is fine, something needs you, something did not happen. A source is none of
 * those, and colouring it would compete with the signals that actually mean something.
 *
 * Pure presentation: props in, markup out.
 */

import type { JSX } from 'react'

import { cn } from '@/lib/utils'
import type { SourceRef } from '@/lib/isola-workspace/contracts'

/**
 * The plain-English label for each source, as it appears in a badge.
 *
 * Shared with `ReadbackResult` so a single vocabulary governs both attribution and
 * confirmation copy, and adding a source can never leave one of them naming a system.
 */
export const SOURCE_LABEL: Record<SourceRef, string> = {
  conversation: 'The conversation',
  salesRecords: 'Sales records',
  phoneSystem: 'Phone system',
  billing: 'Billing',
  messaging: 'Messaging',
}

/**
 * The same vocabulary in sentence position — "Confirmed by <subject>".
 *
 * Kept beside `SOURCE_LABEL` rather than reconstructed by lower-casing it, because English
 * articles do not fall out of a label map ("Confirmed by Billing" and "Confirmed by phone
 * system" are both wrong) and a grammar hack would be a second place for a name to leak.
 */
export const SOURCE_SUBJECT: Record<SourceRef, string> = {
  conversation: 'the conversation',
  salesRecords: 'the sales records',
  phoneSystem: 'the phone system',
  billing: 'billing',
  messaging: 'messaging',
}

const BADGE_CLASS =
  'inline-flex items-center px-[8px] py-[2px] rounded-[var(--iso-radius-sm)] text-[10px] font-medium bg-[var(--iso-surface-2)] border border-[var(--iso-border)] text-[var(--iso-fg-2)]'

export function SourceBadge(props: {
  source: SourceRef
  readAt?: string
  href?: string
  className?: string
}): JSX.Element {
  const { source, readAt, href, className } = props

  // "Sales records · read at 09:14" — the read time is part of the attribution, because a
  // fact an operator may repeat to a customer is only as good as the moment it was read.
  const text = readAt ? `${SOURCE_LABEL[source]} · read at ${readAt}` : SOURCE_LABEL[source]

  if (href) {
    return (
      <a
        href={href}
        className={cn(
          BADGE_CLASS,
          'hover:bg-[var(--iso-surface-3)] hover:text-[var(--iso-fg)] no-underline hover:no-underline',
          className,
        )}
      >
        {text}
      </a>
    )
  }

  return <span className={cn(BADGE_CLASS, className)}>{text}</span>
}
