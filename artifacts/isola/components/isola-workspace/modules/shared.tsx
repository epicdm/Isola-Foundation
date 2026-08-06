/**
 * Isola Workspace — small parts shared by the module bodies.
 *
 * These are NOT primitives (those live in `../primitives` and are owned elsewhere). They are
 * the two or three shapes every module body repeats, kept here so a label or a button does
 * not drift between Customer, Work, AI Team, Today and onboarding.
 *
 * EVERY COMPONENT IN THIS DIRECTORY IS PURE PRESENTATION. Props in, markup out. No hooks, no
 * state, no effects, no fetching, no `"use client"`. A module body must render under
 * `renderToStaticMarkup` in a node environment, because that is how its copy is asserted.
 *
 * Interactive affordances therefore render as `<button type="button">` carrying an `intent`
 * string. The container wires behaviour to the intent later; the body never knows what an
 * intent does, which is what keeps these files testable without a DOM.
 */

import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

// ── Buttons ─────────────────────────────────────────────────────────────────

/**
 * Deliberately NOT `components/ui/button.tsx`. That component's `outline` variant references
 * `--button-outline`, `hover-elevate` and `active-elevate-2`, none of which are defined in
 * this app — it would render an invisible border inside the panel. Isola Workspace styles
 * exclusively from the closed `--iso-*` set.
 */
export type ModuleButtonTone = 'accent' | 'outline' | 'quiet'

const TONE_CLASS: Record<ModuleButtonTone, string> = {
  accent:
    'bg-[var(--iso-accent)] text-[var(--iso-on-accent)] border border-[var(--iso-accent)] hover:bg-[var(--iso-accent-hover)]',
  outline:
    'bg-[var(--iso-surface)] text-[var(--iso-fg)] border border-[var(--iso-border-strong)] hover:bg-[var(--iso-surface-2)]',
  quiet:
    'bg-transparent text-[var(--iso-fg-2)] border border-transparent hover:bg-[var(--iso-surface-2)]',
}

export function ModuleButton(props: {
  label: string
  /** What invoking this means. The body never executes anything itself. */
  intent: string
  tone?: ModuleButtonTone
  disabled?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      data-intent={props.intent}
      disabled={props.disabled}
      className={cn(
        'inline-flex items-center justify-center gap-[5px] rounded-[var(--iso-radius-md)] px-[10px] py-[6px]',
        'text-[11.5px] font-semibold leading-[1.25] break-words text-center',
        'disabled:opacity-50',
        TONE_CLASS[props.tone ?? 'outline'],
        props.className,
      )}
    >
      {props.label}
    </button>
  )
}

/**
 * A chip that selects something (a filter, a prompt). Distinct from `ModuleButton` because it
 * carries a pressed state rather than performing an action.
 */
export function ModuleChip(props: {
  label: string
  intent: string
  pressed?: boolean
  className?: string
}) {
  return (
    <button
      type="button"
      data-intent={props.intent}
      aria-pressed={props.pressed ? true : false}
      className={cn(
        'inline-flex items-center rounded-[var(--iso-radius-pill)] px-[9px] py-[4px]',
        'text-[11px] font-medium leading-[1.3] break-words',
        props.pressed
          ? 'bg-[var(--iso-accent-soft)] text-[var(--iso-accent-fg)] border border-[var(--iso-accent-ring)]'
          : 'bg-[var(--iso-surface-2)] text-[var(--iso-fg-2)] border border-[var(--iso-border)]',
        props.className,
      )}
    >
      {props.label}
    </button>
  )
}

// ── Labels and text ─────────────────────────────────────────────────────────

/** The small uppercase label used above a decision, a consequence or a section. */
export function SectionLabel(props: { children: ReactNode; tone?: 'quiet' | 'accent'; className?: string }) {
  return (
    <div
      className={cn(
        'text-[10px] font-semibold uppercase tracking-[0.07em]',
        props.tone === 'accent' ? 'text-[var(--iso-accent-fg)]' : 'text-[var(--iso-fg-3)]',
        props.className,
      )}
    >
      {props.children}
    </div>
  )
}

/**
 * A soft-tinted inset. Used for a consequence, an explanation, or anything that qualifies the
 * line above it. Colour families are literal class strings, never assembled at runtime —
 * Tailwind cannot see a class it did not read in the source.
 */
export type InsetFamily = 'neutral' | 'warn' | 'err' | 'block' | 'info' | 'ok' | 'accent'

const INSET_CLASS: Record<InsetFamily, string> = {
  neutral: 'bg-[var(--iso-surface-2)] border-[var(--iso-border)] text-[var(--iso-fg-2)]',
  warn: 'bg-[var(--iso-warn-soft)] border-[var(--iso-warn-border)] text-[var(--iso-warn)]',
  err: 'bg-[var(--iso-err-soft)] border-[var(--iso-err-border)] text-[var(--iso-err)]',
  block: 'bg-[var(--iso-block-soft)] border-[var(--iso-block-border)] text-[var(--iso-block)]',
  info: 'bg-[var(--iso-info-soft)] border-[var(--iso-info-border)] text-[var(--iso-info)]',
  ok: 'bg-[var(--iso-ok-soft)] border-[var(--iso-ok-border)] text-[var(--iso-ok)]',
  accent:
    'bg-[var(--iso-accent-soft)] border-[var(--iso-accent-ring)] text-[var(--iso-accent-fg)]',
}

export function Inset(props: {
  family?: InsetFamily
  heading?: string
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-[4px] rounded-[var(--iso-radius-md)] border p-[8px_9px]',
        INSET_CLASS[props.family ?? 'neutral'],
        props.className,
      )}
    >
      {props.heading ? (
        <div className="text-[10px] font-semibold uppercase tracking-[0.07em]">{props.heading}</div>
      ) : null}
      <div className="text-[11.5px] leading-[1.45] break-words">{props.children}</div>
    </div>
  )
}

// ── Card ────────────────────────────────────────────────────────────────────

/**
 * The plain module card. One column, never wider than its container: a long value wraps or
 * clips, it never pushes the panel wide enough to scroll sideways.
 */
export function ModuleCard(props: {
  children: ReactNode
  className?: string
  as?: 'div' | 'article' | 'section'
}) {
  const Tag = props.as ?? 'div'
  return (
    <Tag
      className={cn(
        'flex min-w-0 flex-col gap-[8px] rounded-[var(--iso-radius-lg)] border border-[var(--iso-border)]',
        'bg-[var(--iso-surface)] p-[10px_12px]',
        props.className,
      )}
    >
      {props.children}
    </Tag>
  )
}
