/**
 * Isola Workspace — the module sheet (pure view).
 *
 * WHY THIS SCREEN EXISTS
 * ----------------------
 * It is the answer to "where did my new service go?". The tab bar is fixed at four, so every
 * other installed module is listed here WITH ITS PURPOSE AND WHY IT IS AVAILABLE. Three
 * reasons, and they are not interchangeable:
 *
 *   "Always shown"       — a pinned module. Identical for every tenant and every role.
 *   "Added by your plan" — entitled and permitted. This is why the list differs per tenant.
 *   "Managers only"      — entitled but NOT permitted for this person. Listed on purpose.
 *
 * The third one is the whole reason this sheet lists unauthorized modules instead of hiding
 * them. An unentitled module is absent entirely (filtered on the server, `registry.ts`
 * stage 1) — the operator never learns it could exist. A FORBIDDEN module is visible and
 * explained, so the operator can escalate rather than be silently stuck.
 *
 * PURE VIEW. Roles only: focus trapping, `Esc`, backdrop-click and returning focus to `More`
 * belong to the client container. Every row carries `data-iso-module-id` for delegation.
 */

import type { JSX } from 'react'

import { IsoIcon } from '@/components/isola-workspace/primitives'
import type { AvailableModule } from '@/lib/isola-workspace/registry'
import { cn } from '@/lib/utils'

interface Availability {
  text: string
  /** Locked rows read in `fg-3`: present, reachable, visibly not yours to use. */
  muted: boolean
}

function availabilityFor(m: AvailableModule): Availability {
  // Order matters: permission is stated before plan, because "Managers only" is the fact the
  // operator needs in order to act. A locked pinned module must not read "Always shown".
  if (!m.authorized) return { text: 'Managers only', muted: true }
  if (m.pinned) return { text: 'Always shown', muted: false }
  return { text: 'Added by your plan', muted: false }
}

function Row(props: { module: AvailableModule; active: boolean; href?: string }): JSX.Element {
  const { module: m, active, href } = props
  const availability = availabilityFor(m)

  const className = cn(
    'flex min-h-[44px] w-full flex-col items-start gap-[2px] text-left',
    'rounded-[var(--iso-radius-md)] border px-[10px] py-[9px]',
    active
      ? 'border-[color:var(--iso-accent-ring)] bg-[var(--iso-accent-soft)]'
      : 'border-[color:var(--iso-border)] bg-[var(--iso-surface-2)]',
  )

  const inner = (
    <>
      <span className="flex w-full items-center gap-[8px]">
        {/* Decorative: the label beside it is the accessible name. */}
        <IsoIcon
          name={m.descriptor.icon}
          size={15}
          className={availability.muted ? 'text-[var(--iso-fg-3)]' : 'text-[var(--iso-fg-2)]'}
        />
        <span
          className={cn(
            'min-w-0 flex-1 text-[12.5px] font-semibold',
            availability.muted ? 'text-[var(--iso-fg-3)]' : 'text-[var(--iso-fg)]',
            'truncate',
          )}
        >
          {m.descriptor.label}
        </span>
        <span
          className={cn(
            'flex-none rounded-[var(--iso-radius-pill)] px-[6px] py-[1px]',
            'bg-[var(--iso-surface-3)] text-[10px] font-semibold leading-[15px]',
            availability.muted ? 'text-[var(--iso-fg-3)]' : 'text-[var(--iso-fg-2)]',
          )}
        >
          {availability.text}
        </span>
      </span>
      <span className="text-[11.5px] leading-[1.4] text-[var(--iso-fg-2)]">
        {m.descriptor.purpose}
      </span>
    </>
  )

  if (href) {
    return (
      <a href={href} data-iso-module-id={m.descriptor.id} className={className}>
        {inner}
      </a>
    )
  }

  return (
    <button type="button" data-iso-module-id={m.descriptor.id} className={className}>
      {inner}
    </button>
  )
}

export function ModuleSheetView(props: {
  modules: readonly AvailableModule[]
  activeModuleId: string | null
  open: boolean
  onSelectHref?: (moduleId: string) => string
  /** When supplied, backdrop and Close render as a real link (no client JS required). */
  closeHref?: string
}): JSX.Element | null {
  const { modules, activeModuleId, open, onSelectHref, closeHref } = props

  if (!open) return null

  return (
    <div className="absolute inset-0 z-50 flex flex-col justify-end">
      {/* Backdrop. Token-derived, never a hardcoded colour, so it dims correctly in both
          themes without any component branching on theme. A real link when `closeHref` is
          supplied, so the sheet is dismissible with zero client JS; `aria-hidden` either way —
          `Close` below is the accessible dismissal control. */}
      {closeHref ? (
        <a
          aria-hidden="true"
          tabIndex={-1}
          data-iso-sheet-backdrop=""
          href={closeHref}
          className="absolute inset-0 bg-[var(--iso-rail)] opacity-50"
        />
      ) : (
        <div
          aria-hidden="true"
          data-iso-sheet-backdrop=""
          className="absolute inset-0 bg-[var(--iso-rail)] opacity-50"
        />
      )}

      <div
        role="dialog"
        aria-modal="true"
        aria-label="All modules"
        className={cn(
          'iso-rise relative flex max-h-full w-full flex-col',
          'rounded-t-[var(--iso-radius-xl)] border-t border-[color:var(--iso-border)]',
          'bg-[var(--iso-surface)] shadow-[var(--iso-shadow-3)]',
        )}
      >
        <div className="flex flex-none items-start gap-[8px] px-[13px] pb-[8px] pt-[11px]">
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-[var(--iso-fg)]">All modules</p>
            <p className="text-[11px] text-[var(--iso-fg-3)]">
              Everything installed for this business, and why you can see it.
            </p>
          </div>
          {closeHref ? (
            <a
              data-iso-sheet-close=""
              aria-label="Close"
              href={closeHref}
              className={cn(
                'flex-none rounded-[var(--iso-radius-md)] border border-[color:var(--iso-border)]',
                'bg-[var(--iso-surface-2)] px-[8px] py-[5px] text-[11px] font-semibold',
                'text-[var(--iso-fg-2)]',
              )}
            >
              Close
            </a>
          ) : (
            <button
              type="button"
              data-iso-sheet-close=""
              aria-label="Close"
              className={cn(
                'flex-none rounded-[var(--iso-radius-md)] border border-[color:var(--iso-border)]',
                'bg-[var(--iso-surface-2)] px-[8px] py-[5px] text-[11px] font-semibold',
                'text-[var(--iso-fg-2)]',
              )}
            >
              Close
            </button>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-[11px] pb-[13px]">
          <div className="flex flex-col gap-[7px]">
            {modules.map((m) => (
              <Row
                key={m.descriptor.id}
                module={m}
                active={m.descriptor.id === activeModuleId}
                href={onSelectHref?.(m.descriptor.id)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
