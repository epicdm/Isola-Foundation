/**
 * Isola Workspace — module navigation (pure view).
 *
 * THE INVARIANT THIS FILE PROTECTS
 * -------------------------------
 * The tab bar never grows. It renders exactly the pinned modules the registry handed us plus
 * one `More` tab. A new service reaches the operator through `More`, never through a fifth
 * top-level tab — see `registry.ts` `buildNavigationLayout`.
 *
 * Two rules that look cosmetic but are not:
 *
 *  1. Tabs are `flex-1` and SHORTEN their labels; the bar never scrolls horizontally. A tab
 *     bar that scrolls hides navigation from the operator at exactly the width where they
 *     have the least room to hunt for it.
 *
 *  2. A module with `authorized === false` renders a completely ORDINARY tab. It is not
 *     greyed, not padlocked, not annotated. The operator must be able to reach it and read
 *     why they cannot use it (the BODY renders unauthorized), because that is what lets them
 *     escalate instead of being stuck. Greying it out here would turn a governed capability
 *     into an unexplained dead end.
 *
 * PURE VIEW. No hooks, no state, no fetching — renderable by `renderToStaticMarkup`. A thin
 * client container owns selection, focus and the sheet's open/closed state; every tab carries
 * `data-iso-module-id` so that container can delegate a single click handler.
 */

import type { JSX } from 'react'

import type { AvailableModule, NavigationLayout } from '@/lib/isola-workspace/registry'
import { cn } from '@/lib/utils'

/** The synthetic id of the `More` tab. Never a real module id. */
export const MORE_TAB_ID = 'more'

/**
 * Narrow-width labels. Keyed by module id, not by label text, so a copy change to a label
 * cannot silently break the abbreviation. Anything absent keeps its full label at every
 * width (`Customer` stays `Customer`).
 */
const SHORT_LABELS: Readonly<Record<string, string>> = {
  'ai-team': 'AI',
}

function shortLabelFor(moduleId: string, label: string): string {
  return SHORT_LABELS[moduleId] ?? label
}

const TAB_BASE =
  'relative flex min-w-0 flex-1 items-center justify-center gap-[5px] ' +
  'min-h-[44px] px-[4px] py-[10px] border-b-2 ' +
  'text-[11.5px] font-semibold leading-none bg-[var(--iso-surface)]'

const TAB_ACTIVE = 'border-b-[color:var(--iso-accent)] text-[var(--iso-accent-fg)]'
const TAB_INACTIVE = 'border-b-[color:transparent] text-[var(--iso-fg-2)]'

/** A count of things needing attention on this tab. Warn family, never the tenant accent. */
function CountPill(props: { count: number }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex min-w-[16px] flex-none items-center justify-center',
        'rounded-[var(--iso-radius-pill)] border border-[var(--iso-warn-border)]',
        'bg-[var(--iso-warn-soft)] px-[4px] text-[10px] font-semibold leading-[15px]',
        'text-[var(--iso-warn)]',
      )}
    >
      {props.count}
      <span className="sr-only"> needing attention</span>
    </span>
  )
}

/** How many further modules sit behind `More`. Neutral, not an alarm. */
function OverflowPill(props: { count: number }): JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex min-w-[16px] flex-none items-center justify-center',
        'rounded-[var(--iso-radius-pill)] border border-[var(--iso-border)]',
        'bg-[var(--iso-surface-3)] px-[4px] text-[10px] font-semibold leading-[15px]',
        'text-[var(--iso-fg-2)]',
      )}
    >
      {props.count}
      <span className="sr-only"> more</span>
    </span>
  )
}

function TabInner(props: {
  fullLabel: string
  shortLabel: string
  trailing?: JSX.Element | null
}): JSX.Element {
  const { fullLabel, shortLabel, trailing } = props
  return (
    <>
      {fullLabel === shortLabel ? (
        <span className="min-w-0 truncate">{fullLabel}</span>
      ) : (
        <>
          {/* Container-relative, not viewport-relative: the panel shortens its own labels
              whether it is a 340px column or a full-width narrow layout. */}
          <span className="min-w-0 truncate @max-[364px]:hidden">{fullLabel}</span>
          <span className="hidden min-w-0 truncate @max-[364px]:inline">{shortLabel}</span>
        </>
      )}
      {trailing ?? null}
    </>
  )
}

function Tab(props: {
  id: string
  fullLabel: string
  shortLabel: string
  active: boolean
  href?: string
  trailing?: JSX.Element | null
  hasPopup?: boolean
}): JSX.Element {
  const { id, fullLabel, shortLabel, active, href, trailing, hasPopup } = props
  const className = cn(TAB_BASE, active ? TAB_ACTIVE : TAB_INACTIVE)
  const inner = <TabInner fullLabel={fullLabel} shortLabel={shortLabel} trailing={trailing} />

  if (href) {
    return (
      <a
        role="tab"
        aria-selected={active}
        aria-haspopup={hasPopup ? 'dialog' : undefined}
        href={href}
        data-iso-module-id={id}
        className={className}
      >
        {inner}
      </a>
    )
  }

  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-haspopup={hasPopup ? 'dialog' : undefined}
      data-iso-module-id={id}
      className={className}
    >
      {inner}
    </button>
  )
}

export function ModuleNavigationView(props: {
  layout: NavigationLayout
  activeModuleId: string | null
  counts?: Record<string, number>
  /** When supplied, tabs render as links. Otherwise as buttons for a container to delegate. */
  onSelectHref?: (moduleId: string) => string
}): JSX.Element {
  const { layout, activeModuleId, counts, onSelectHref } = props

  // `More` carries the active underline when the active module lives behind it.
  const activeIsOverflow =
    activeModuleId !== null &&
    layout.overflow.some((m: AvailableModule) => m.descriptor.id === activeModuleId)

  return (
    <div
      role="tablist"
      aria-label="Isola modules"
      className="flex w-full items-stretch bg-[var(--iso-surface)] px-[5px]"
    >
      {layout.pinned.map((m) => {
        const id = m.descriptor.id
        const count = counts?.[id] ?? 0
        return (
          <Tab
            key={id}
            id={id}
            fullLabel={m.descriptor.label}
            shortLabel={shortLabelFor(id, m.descriptor.label)}
            active={id === activeModuleId}
            href={onSelectHref?.(id)}
            trailing={count > 0 ? <CountPill count={count} /> : null}
          />
        )
      })}

      <Tab
        id={MORE_TAB_ID}
        fullLabel="More"
        shortLabel="More"
        active={activeIsOverflow}
        href={onSelectHref?.(MORE_TAB_ID)}
        hasPopup
        // Hidden when zero: a badge reading "0" is noise, and the tab still opens the sheet.
        trailing={
          layout.overflowCount > 0 ? <OverflowPill count={layout.overflowCount} /> : null
        }
      />
    </div>
  )
}
