/**
 * Isola Workspace — the Phone module body.
 *
 * THIS FILE IS A PROOF, NOT A FEATURE. Phone is a non-pinned module reached through *More*,
 * and it is deliberately ORDINARY: a couple of read-only sections, its own small props shape,
 * a source badge, and no special handling anywhere in the shell, the footer or the layout.
 *
 * If adding a service ever requires more than a file like this plus one registry entry and one
 * adapter, the module contract has been broken. Its plainness is the point.
 *
 * Facts are attributed to "the phone system" and to nothing more specific — an operator must
 * never learn which product answered.
 *
 * Pure presentation. No hooks, no state, no fetching.
 */

import { cn } from '@/lib/utils'
import {
  ExpandableDetails,
  KeyValueGrid,
  SourceBadge,
} from '@/components/isola-workspace/primitives'

import { ModuleCard, SectionLabel } from '../shared'

export interface PhoneLine {
  name: string
  detail: string
  status: string
}

export interface PhoneModuleData {
  /** e.g. "Daytime menu". */
  callMenu: string
  /** e.g. "Rings 20 seconds, then voicemail". */
  answeringRule: string
  lastCall: string
  lines: readonly PhoneLine[]
}

export function PhoneModuleView(props: {
  /** Absent means NOTHING HAS BEEN READ — see the not-read branch below. */
  data?: PhoneModuleData
  readAt?: string | null
  className?: string
}) {
  const { data } = props

  // "Not read" and "nothing there" are DIFFERENT FACTS and must never render the same way.
  // Falling through to the normal body with an empty list would tell an operator that this
  // customer has no lines, when the truth is that we have not looked.
  if (!data) {
    return (
      <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
        <ModuleCard as="section" className="gap-[4px]">
          <SectionLabel>Not read yet</SectionLabel>
          <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            Nothing has been read from the phone system for this customer, so there are no line or
            call details to show. Nothing here is out of date, because nothing has been loaded.
            Your conversation is not affected.
          </p>
        </ModuleCard>
      </div>
    )
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-[9px]', props.className)}>
      <ModuleCard as="section" className="gap-[7px]">
        <SectionLabel>How calls are handled</SectionLabel>
        <KeyValueGrid
          items={[
            { label: 'Incoming calls go to', value: data.callMenu },
            { label: 'If nobody answers', value: data.answeringRule },
          ]}
        />
        <p className="break-words text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
          Last call: {data.lastCall}
        </p>
        <div className="flex flex-wrap gap-[5px]">
          <SourceBadge source="phoneSystem" readAt={props.readAt ?? undefined} />
        </div>
      </ModuleCard>

      <ExpandableDetails
        title="Lines and extensions"
        summary={
          data.lines.length ? `${data.lines.length} lines on this account` : 'No lines recorded'
        }
      >
        {data.lines.length ? (
          <ul className="flex min-w-0 list-none flex-col gap-[6px] p-0">
            {data.lines.map((line) => (
              <li key={line.name} className="flex min-w-0 flex-col gap-[1px]">
                <span className="flex min-w-0 items-baseline justify-between gap-[8px]">
                  <span className="min-w-0 flex-1 break-words text-[12px] font-medium leading-[1.35] text-[var(--iso-fg)]">
                    {line.name}
                  </span>
                  <span className="flex-none text-[10.5px] font-semibold uppercase tracking-[0.05em] text-[var(--iso-fg-3)]">
                    {line.status}
                  </span>
                </span>
                <span className="break-words text-[11px] leading-[1.4] text-[var(--iso-fg-3)]">
                  {line.detail}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[11.5px] leading-[1.45] text-[var(--iso-fg-2)]">
            No lines are recorded against this customer yet.
          </p>
        )}
      </ExpandableDetails>
    </div>
  )
}
