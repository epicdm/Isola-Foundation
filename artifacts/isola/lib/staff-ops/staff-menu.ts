/**
 * staff-menu.ts — tappable staff menus over WhatsApp.
 *
 * WHY THIS EXISTS. Typing `ACK SL 001` works — it is verified against
 * production — but it is not what a person on a roof with one hand free
 * actually does. The owner's instruction was blunt: "me having to type those
 * things in manually is not really practical". So the command vocabulary
 * becomes a fallback, and the primary interface is a tap.
 *
 * ── Three rules Meta imposes, which shape everything below ──────────────────
 *
 *  1. The FIRST proactive message must be a template, and template buttons are
 *     frozen at approval time. A template menu therefore cannot be stage-aware.
 *  2. Every message inside the 24-hour service window may be free-form
 *     `interactive`, needs no approval, and CAN be built per-record. That is
 *     where the stage-aware menu lives.
 *  3. `button` replies cap at THREE. A `list` allows ten rows but renders as
 *     "tap to open a menu" rather than inline buttons.
 *
 * ── Why the id encoding matters more than the buttons ──────────────────────
 *
 * A tap returns a developer-defined id, so the id carries BOTH the action and
 * the exact work reference. That removes label matching from the tapped path
 * entirely: no normalisation, no prefix/word-boundary rule, no
 * `needs_disambiguation`, and no "staff say DW 2060, Odoo says #2249" problem.
 * The reference cannot be mistyped because it is never typed.
 *
 * Typed commands still work. This is an addition, not a replacement.
 */

import type { OdooWorkRecord } from './odoo-work'
import { classifyStage } from './stage-classifier'

/** Actions a staff member can reach from a menu. `correct` is deliberately
 *  absent — it is a repair verb for a mistaken entry, not a normal next step. */
export type StaffMenuAction = 'ack' | 'start' | 'update' | 'blocked' | 'done'

/**
 * The two outcomes a MANAGER can reach from a verification menu.
 *
 * Declared here rather than in `manager-verdict.ts` so that `MenuItem` can name
 * it without this module importing that one — the dependency runs one way only,
 * and a cycle between the menu model and the verdict codec would be a hazard
 * with no upside. The codec itself lives in `manager-verdict.ts` and re-exports
 * this type.
 */
export type ManagerVerdict = 'approve' | 'return'

/**
 * Anything a tap can carry. Staff actions and manager verdicts share the menu
 * MODEL — one id codec shape, one rendering, one send path — while remaining
 * separate vocabularies with separate authority rules. Widening here is what
 * lets a manager menu reuse `MenuRendering` instead of growing a parallel type
 * that would then need its own renderer and its own send path.
 */
export type MenuAction = StaffMenuAction | ManagerVerdict

/** Namespace prefix so a menu id can never be confused with any other payload. */
const MENU_ID_PREFIX = 'sa'

/** Meta's hard limits. Exceeding any of these is a 400, not a truncation. */
export const WA_LIMITS = {
  buttonId: 256,
  buttonTitle: 20,
  rowTitle: 24,
  rowDescription: 72,
  maxButtons: 3,
  maxRows: 10,
  /**
   * A TEMPLATE quick-reply payload is capped at 128 — HALF the free-form
   * interactive button-id limit. Same codec, tighter ceiling, so it is
   * asserted separately rather than assumed to pass because `buttonId` did.
   */
  templateButtonPayload: 128,
  /** Meta allows at most three quick-reply buttons on one template. */
  maxTemplateButtons: 3,
} as const

/**
 * Encode `action` + work reference into one tap id.
 *
 * Format: `sa:<action>:<correlationId>`. The correlation id is already the
 * durable episode key used by the outbox dedupe and by `StaffWorkAction`, so
 * the tap lands on exactly the episode that was dispatched.
 */
export function encodeMenuId(action: StaffMenuAction, correlationId: string): string {
  const id = `${MENU_ID_PREFIX}:${action}:${correlationId}`
  if (id.length > WA_LIMITS.buttonId) {
    throw new Error(`menu id exceeds ${WA_LIMITS.buttonId} chars: ${id.length}`)
  }
  return id
}

/**
 * Decode a tap id. Fail-closed: anything that is not exactly our shape returns
 * null so the caller falls back to text parsing rather than guessing.
 */
export function decodeMenuId(
  raw: string | null | undefined,
): { action: StaffMenuAction; correlationId: string } | null {
  if (!raw) return null
  const parts = raw.split(':')
  if (parts.length !== 3) return null
  const [prefix, action, correlationId] = parts
  if (prefix !== MENU_ID_PREFIX) return null
  if (!correlationId) return null
  if (!isStaffMenuAction(action)) return null
  return { action, correlationId }
}

/**
 * Mint a TEMPLATE quick-reply payload.
 *
 * Deliberately the SAME codec as `encodeMenuId`, because a template tap and a
 * free-form interactive tap must decode through the same `decodeMenuId` and
 * reach the same resolver. Two codecs would mean two state machines, and the
 * second one would be the one nobody tests.
 *
 * Template button LABELS are frozen at approval time, but the payload is
 * supplied per send — which is the only reason a frozen template button can
 * carry a per-episode correlation id at all. Meta caps that payload at 128
 * characters rather than 256, so the ceiling is asserted here: a payload that
 * would 400 at send time fails in a test instead of on a staff handset.
 */
export function encodeTemplateQuickReplyPayload(
  action: StaffMenuAction,
  correlationId: string,
): string {
  const payload = encodeMenuId(action, correlationId)
  if (payload.length > WA_LIMITS.templateButtonPayload) {
    throw new Error(
      `template quick-reply payload exceeds ${WA_LIMITS.templateButtonPayload} chars: ${payload.length}`,
    )
  }
  return payload
}

function isStaffMenuAction(v: string): v is StaffMenuAction {
  return v === 'ack' || v === 'start' || v === 'update' || v === 'blocked' || v === 'done'
}

/**
 * The actions that make sense for this record RIGHT NOW.
 *
 * Stage-aware by design — the owner asked for the menu to follow "what strategy
 * it is", i.e. where the task actually sits on the board. Offering DONE on a
 * task nobody has started, or START on one already in progress, is the same
 * class of defect as advertising a command the system does not implement.
 *
 * Matching is on substrings of the normalised stage name because Odoo stage
 * names are per-project free text: `New`, `Inbox`, `To Do`, `In-Progress`,
 * `In Progress`, `Blocked`, `Done`, `Solved` all occur across EPIC's boards.
 * Unknown stage falls through to the full set, which is safe: every action is
 * individually authority-checked and audited downstream.
 */
export function deriveStageMenu(record: OdooWorkRecord): StaffMenuAction[] {
  // mail.activity has no project stage and does not support blocking.
  if (record.odooModel === 'mail.activity') return ['ack', 'update', 'done']

  switch (classifyStage(record.stageName)) {
    // The episode is over for the staff member.
    case 'terminal':
      return []
    case 'blocked':
      return ['start', 'update', 'done']
    case 'active':
      return ['update', 'done', 'blocked']
    case 'new':
      return ['ack', 'start', 'blocked']
    default:
      // UNKNOWN VOCABULARY — reduced and safe, never the full set.
      //
      // The old fallback offered every action, which meant a stage nobody had
      // classified advertised DONE and BLOCKED as if they were known-valid. The
      // owner ruled that unacceptable, and it is the same defect as advertising
      // a command the system cannot honour.
      //
      // ACK and UPDATE are the only two actions that are true regardless of
      // where the record sits: "I have seen it" and "here is progress". START,
      // BLOCKED and DONE all assert something about the current state, so they
      // are withheld until the stage can actually be classified. The staff
      // member can still type any command explicitly.
      console.warn(
        `[staff-menu] unclassified Odoo stage "${record.stageName ?? '(none)'}" on ${record.odooModel}#${record.odooId} — offering reduced menu`,
      )
      return ['ack', 'update']
  }
}

/** Button/row copy. `start` reads as "Resume" once work was blocked, because
 *  that is the word the person has in their head at that moment. */
export function menuLabel(action: StaffMenuAction, opts?: { resuming?: boolean }): string {
  switch (action) {
    case 'ack':
      return 'Acknowledge'
    case 'start':
      return opts?.resuming ? 'Resume work' : 'Start work'
    case 'update':
      return 'Post an update'
    case 'blocked':
      return "I'm blocked"
    case 'done':
      return 'Mark as done'
  }
}

/** One line of help under each row, list rendering only. */
export function menuDescription(action: StaffMenuAction): string {
  switch (action) {
    case 'ack':
      return 'Confirm you have seen this task'
    case 'start':
      return 'Move it to In-Progress in Odoo'
    case 'update':
      return 'Send progress without closing it'
    case 'blocked':
      return 'Flag a blocker and say why'
    case 'done':
      return 'Report it finished for verification'
  }
}

export interface MenuItem {
  id: string
  title: string
  description: string
  /** Staff action or manager verdict — see `MenuAction`. */
  action: MenuAction
}

export type MenuRendering =
  | { kind: 'none' }
  | { kind: 'buttons'; items: MenuItem[] }
  | { kind: 'list'; items: MenuItem[] }

/**
 * Choose the rendering. Three or fewer actions become inline buttons — one tap,
 * nothing hidden. More than three must become a list, because Meta rejects a
 * fourth button outright rather than dropping it.
 *
 * Titles are asserted against Meta's limits here rather than at send time, so a
 * copy change that would 400 fails in a test instead of on a staff handset.
 */
export function buildMenu(
  record: OdooWorkRecord,
  correlationId: string,
  actions?: StaffMenuAction[],
): MenuRendering {
  const chosen = actions ?? deriveStageMenu(record)
  if (chosen.length === 0) return { kind: 'none' }

  const resuming = classifyStage(record.stageName) === 'blocked'
  const items: MenuItem[] = chosen.slice(0, WA_LIMITS.maxRows).map((action) => {
    const title = menuLabel(action, { resuming })
    if (title.length > WA_LIMITS.rowTitle) {
      throw new Error(`menu title "${title}" exceeds ${WA_LIMITS.rowTitle} chars`)
    }
    return { id: encodeMenuId(action, correlationId), title, description: menuDescription(action), action }
  })

  if (items.length <= WA_LIMITS.maxButtons) {
    for (const it of items) {
      if (it.title.length > WA_LIMITS.buttonTitle) {
        throw new Error(`button title "${it.title}" exceeds ${WA_LIMITS.buttonTitle} chars`)
      }
    }
    return { kind: 'buttons', items }
  }
  return { kind: 'list', items }
}
