/**
 * Isola Workspace — the shell (pure view).
 *
 * There is exactly ONE of these. Every service — phone, billing, payments, field visits,
 * anything future — is a module inside it. Adding a service must never require editing this
 * file; if it does, the module contract has been broken (see `contracts.ts`).
 *
 * THREE STRUCTURAL RULES THAT LOOK COSMETIC AND ARE NOT
 * ----------------------------------------------------
 * 1. THE SCROLLER IS NOT THE FLEX COLUMN. The scroll container is `flex-1 overflow-auto`, and
 *    its single child is the `flex flex-col gap-[9px]` stack. If the scroller itself were the
 *    flex column, its children would shrink to fit instead of overflowing and every card
 *    would clip. This is the single most easily reintroduced defect in the panel.
 *
 * 2. HEADER AND FOOTER SURVIVE EVERY STATE. Loading, unauthorized, offline, degraded — the
 *    body is replaced, never the chrome. The operator must always be able to see WHICH
 *    BUSINESS they are looking at, and must always have a way out. A full-panel error that
 *    swallows the tenant name is how an operator ends up acting on the wrong customer.
 *
 * 3. THE PRIMARY BUTTON LIVES OUTSIDE THE SCROLLER AND IS THE LAST TAB STOP. It is therefore
 *    reachable at any scroll position, and it is last in DOM order (visual order is restored
 *    with `order-*`), so keyboard users land on the consequential control last rather than
 *    passing through it on the way into the body.
 *
 * EXACTLY ONE ACCENT-FILLED BUTTON exists in this view: the footer primary. Everything else
 * is outline or quiet. Two filled buttons is two primary actions, which is no primary action.
 *
 * PURE VIEW. No hooks, no state, no fetching — renderable by `renderToStaticMarkup`.
 */

import type { CSSProperties, JSX, ReactNode } from 'react'

import type {
  ModuleContext,
  PrimaryAction,
  ShellState,
  TenantIdentity,
} from '@/lib/isola-workspace/contracts'
import type { NavigationLayout } from '@/lib/isola-workspace/registry'
import { cn } from '@/lib/utils'

import { ModuleNavigationView } from './module-navigation-view'
import { ModuleSheetView } from './module-sheet-view'
import { ShellStateBody, stateReplacesModuleBody } from './state-renderers'

// ── Tenant accent ───────────────────────────────────────────────────────────

/**
 * Apply the tenant's brand colour by overriding ONLY the accent family.
 *
 * STATUS COLOURS ARE UNTOUCHABLE. `--iso-ok`, `--iso-warn`, `--iso-err`, `--iso-info` and
 * `--iso-block` are deliberately absent from this function and must never be added to it. A
 * tenant whose brand colour could reach the status scale could make "failed" look like
 * "done" in their own workspace, which is a safety property, not a styling preference.
 *
 * `--iso-on-accent` is also left alone: it is the foreground that must contrast with the
 * accent, and it cannot be derived here. Tenant accents are validated for contrast against it
 * upstream, at the point the accent is stored.
 */
function tenantAccentStyle(accent: string | undefined): CSSProperties | undefined {
  if (!accent) return undefined
  return {
    '--iso-accent': accent,
    '--iso-accent-hover': accent,
    '--iso-accent-ring': accent,
    '--iso-accent-fg': accent,
    // No hardcoded colour: the soft tint is mixed from the accent itself, so it lands
    // correctly in either theme without this component ever branching on theme.
    '--iso-accent-soft': `color-mix(in srgb, ${accent} 12%, transparent)`,
  } as CSSProperties
}

// ── State chip ──────────────────────────────────────────────────────────────

interface ChipSpec {
  label: string
  className: string
}

const CHIP_WARN =
  'border-[color:var(--iso-warn-border)] bg-[var(--iso-warn-soft)] text-[var(--iso-warn)]'
const CHIP_BLOCK =
  'border-[color:var(--iso-block-border)] bg-[var(--iso-block-soft)] text-[var(--iso-block)]'
const CHIP_ERR =
  'border-[color:var(--iso-err-border)] bg-[var(--iso-err-soft)] text-[var(--iso-err)]'
const CHIP_INFO =
  'border-[color:var(--iso-info-border)] bg-[var(--iso-info-soft)] text-[var(--iso-info)]'

/** `ready` and `empty` get no chip: neither is a condition the operator must be warned about. */
function chipFor(state: ShellState): ChipSpec | null {
  switch (state) {
    case 'loading':
      return { label: 'Loading', className: CHIP_INFO }
    case 'stale':
      return { label: 'May be out of date', className: CHIP_WARN }
    // `unavailable` is the degraded case in this repository's state union. Never phrased as
    // a failure — nothing was attempted and lost.
    case 'unavailable':
      return { label: 'Answering slowly', className: CHIP_BLOCK }
    case 'unauthorized':
      return { label: 'No access', className: CHIP_BLOCK }
    case 'offline':
      return { label: 'Offline', className: CHIP_ERR }
    default:
      return null
  }
}

function StateChip(props: { state: ShellState }): JSX.Element | null {
  const chip = chipFor(props.state)
  if (!chip) return null
  return (
    <span
      className={cn(
        'flex-none rounded-[var(--iso-radius-pill)] border px-[6px] py-[1px]',
        'text-[10px] font-semibold leading-[15px] whitespace-nowrap',
        chip.className,
      )}
    >
      {chip.label}
    </span>
  )
}

// ── Footer buttons ──────────────────────────────────────────────────────────

const BUTTON_BASE =
  'inline-flex min-h-[36px] items-center justify-center rounded-[var(--iso-radius-md)] ' +
  'px-[12px] text-[12px] font-semibold leading-none'

/**
 * Plain elements, deliberately. The repository's shared button component's `outline` variant
 * references `--button-outline`, `hover-elevate` and `active-elevate-2`, none of which are
 * defined here, so it renders unstyled borders. These are token-styled from `--iso-*` only.
 */
function PrimaryButton(props: { action: PrimaryAction }): JSX.Element {
  const { action } = props
  return (
    <button
      type="button"
      data-iso-intent={action.intent}
      disabled={action.disabled}
      className={cn(
        BUTTON_BASE,
        // THE ONLY accent-filled button in this view.
        'order-1 flex-1 bg-[var(--iso-accent)] text-[var(--iso-on-accent)]',
        'shadow-[var(--iso-shadow-1)] disabled:opacity-50',
      )}
    >
      {action.label}
    </button>
  )
}

function SecondaryButton(props: { label: string; intent: string }): JSX.Element {
  return (
    <button
      type="button"
      data-iso-intent={props.intent}
      className={cn(
        BUTTON_BASE,
        'order-2 flex-none border border-[color:var(--iso-border-strong)]',
        'bg-[var(--iso-surface)] text-[var(--iso-fg-2)]',
      )}
    >
      {props.label}
    </button>
  )
}

// ── Shell ───────────────────────────────────────────────────────────────────

export function IsolaWorkspaceShellView(props: {
  tenant: TenantIdentity
  context: ModuleContext
  state: ShellState
  layout: NavigationLayout
  activeModuleId: string | null
  counts?: Record<string, number>
  primaryAction?: PrimaryAction | null
  secondaryAction?: { label: string; intent: string } | null
  /** Rendered inside the scroll container. */
  children: ReactNode
  /** Narrow layouts show a back-to-conversation bar with this label. */
  backToConversationLabel?: string
  /**
   * When supplied, every tab and every "More" sheet row renders as a real `<a href>` built by
   * this function, so navigation works with zero client JS — the same convention `role`,
   * `context` and `state` already use on this route. `MORE_TAB_ID` (from
   * `./module-navigation-view`) is a valid argument: the caller decides what "open the sheet"
   * means (e.g. an added `sheet=1` query parameter), not this view.
   */
  onSelectModuleHref?: (moduleId: string) => string
  /** Whether the "All modules" sheet is currently open. Server-decided, e.g. from the URL. */
  sheetOpen?: boolean
  /** Href for the sheet's backdrop and Close control. Omit to leave them JS-only no-ops. */
  closeSheetHref?: string
  className?: string
}): JSX.Element {
  const {
    tenant,
    context,
    state,
    layout,
    activeModuleId,
    counts,
    primaryAction,
    secondaryAction,
    children,
    backToConversationLabel,
    onSelectModuleHref,
    sheetOpen,
    closeSheetHref,
    className,
  } = props

  const isPanel = context === 'conversation-panel'
  const showBackBar = isPanel && Boolean(backToConversationLabel)
  const bodyIsReplaced = stateReplacesModuleBody(state)

  return (
    <aside
      aria-label="Isola Workspace"
      style={tenantAccentStyle(tenant.accent)}
      className={cn(
        // `@container` makes every width decision below relative to the panel itself, so the
        // same markup is correct in a 384px column, a 340px column and a full-width host.
        'iso-root @container relative flex h-full flex-col overflow-hidden',
        'bg-[var(--iso-bg)]',
        isPanel
          ? // No breakpoint needed: a wide host gets the 384px column, a narrow host gets the
            // whole width. `min(340px,100%)` keeps the floor from forcing horizontal scroll
            // in a host narrower than the floor.
            'w-full max-w-[384px] min-w-[min(340px,100%)]'
          : 'w-full',
        className,
      )}
    >
      {showBackBar ? (
        // The one viewport-relative rule in the shell, and it is viewport-relative on
        // purpose: this bar answers "is Isola currently the whole screen?", which the panel
        // cannot know from its own width (a 390px phone and a 384px desktop column are the
        // same width and need opposite answers).
        <div
          className={cn(
            'hidden flex-none items-center gap-[8px] p-[9px_12px] max-[849px]:flex',
            'bg-[var(--iso-rail)]',
          )}
        >
          <button
            type="button"
            data-iso-intent="back-to-conversation"
            aria-label="Back to the conversation"
            className={cn(
              'flex min-h-[28px] flex-none items-center gap-[5px] rounded-[var(--iso-radius-md)]',
              'px-[6px] text-[11px] font-semibold text-[var(--iso-rail-fg)]',
              'bg-[var(--iso-rail-active)]',
            )}
          >
            {/* The glyph is decorative; "Back" plus the aria-label is the accessible name.
                `IsoIcon` is deliberately not used here — its map is the MODULE icon set and
                an unknown key silently renders a neutral circle, which would read as a
                broken control rather than a back arrow. */}
            <span aria-hidden="true">&#8592;</span>
            <span>Back</span>
          </button>
          <span
            className={cn(
              'min-w-0 flex-1 text-[12.5px] font-semibold text-[var(--iso-rail-fg)]',
              'truncate',
            )}
          >
            {backToConversationLabel}
          </span>
        </div>
      ) : null}

      {/* ── Header. Never replaced by a shell state. ── */}
      <header
        className={cn(
          'flex-none border-b border-[color:var(--iso-border)]',
          'bg-[var(--iso-surface)]',
        )}
      >
        <div className="flex items-center gap-[7px] px-[11px] py-[9px]">
          <span
            aria-hidden="true"
            className={cn(
              'h-[18px] w-[18px] flex-none rounded-[var(--iso-radius-md)]',
              'bg-[var(--iso-accent)]',
            )}
          />
          <span className="flex-none text-[12.5px] font-semibold whitespace-nowrap text-[var(--iso-fg)]">
            Isola Workspace
          </span>
          <span
            className={cn(
              'min-w-0 flex-1 text-[10.5px] text-[var(--iso-fg-3)]',
              'truncate',
            )}
          >
            {tenant.name}
          </span>
          <StateChip state={state} />
        </div>

        <ModuleNavigationView
          layout={layout}
          activeModuleId={activeModuleId}
          counts={counts}
          onSelectHref={onSelectModuleHref}
        />
      </header>

      {/* ── Scroll container. NOT the flex column — see rule 1 at the top of this file. ── */}
      <div
        aria-busy={state === 'loading' ? true : undefined}
        className="min-h-0 flex-1 overflow-auto p-[10px_11px_16px]"
      >
        {/* REQUIRED inner stack. Children overflow this; they never shrink to fit. */}
        <div className="flex flex-col gap-[9px]">
          <ShellStateBody state={state} context={context} />
          {/* `stale` and `unavailable` keep the module body beneath their banner: the last
              good read is still the best information the operator has. */}
          {bodyIsReplaced ? null : children}
        </div>
      </div>

      {/* ── Footer. Never replaced by a shell state; never scrolls away. ── */}
      <footer
        className={cn(
          'flex-none border-t border-[color:var(--iso-border)]',
          'bg-[var(--iso-surface)] p-[9px_11px]',
        )}
      >
        {primaryAction?.note ? (
          <p className="mb-[6px] text-[10.5px] leading-[1.4] text-[var(--iso-fg-3)]">
            {primaryAction.note}
          </p>
        ) : null}

        {primaryAction || secondaryAction ? (
          // DOM order is secondary-then-primary so the primary is the LAST TAB STOP;
          // `order-1`/`order-2` restore the visual order [ primary ][ secondary ].
          <div className="flex items-center gap-[7px]">
            {secondaryAction ? (
              <SecondaryButton
                label={secondaryAction.label}
                intent={secondaryAction.intent}
              />
            ) : null}
            {primaryAction ? <PrimaryButton action={primaryAction} /> : null}
          </div>
        ) : null}
      </footer>

      <ModuleSheetView
        // `NavigationLayout` (unlike `ResolvedNavigation`) has no `.all` — `pinned` and
        // `overflow` are a strict partition of it (`registry.ts` `buildNavigationLayout`), so
        // this is exactly the full entitled+annotated module list, same as `.all` would be.
        modules={[...layout.pinned, ...layout.overflow]}
        activeModuleId={activeModuleId}
        open={sheetOpen ?? false}
        onSelectHref={onSelectModuleHref}
        closeHref={closeSheetHref}
      />
    </aside>
  )
}
