/**
 * staff-action.ts — the StaffAction contract and its pure decision core.
 *
 * A StaffAction is a thing a staff member asked Foundation to do to an
 * authoritative Odoo record. It is NOT work state. Foundation stores that an
 * action was requested and applied (for idempotency and audit); Odoo stores
 * what the work now is. If those two ever disagree, Odoo is right.
 *
 * ── Why this parser is strict, and what it is refusing to repeat ────────────
 *
 * The legacy BFF parser required `ACK OPS-nnn` and returned UNKNOWN for a bare
 * `ACK`. That mattered because a bare `ACK` is literally what a human sends —
 * it is what Eric sent on 2026-07-28, and what any acceptance test sends. A fix
 * that gated on the strict parser alone would have compiled, passed review, and
 * left the defect in place (`ev-staff-inbound-ack-routing-2026-07-27` §2).
 * So bare verbs ARE accepted here.
 *
 * The opposite error is just as real and is recorded as a near-miss on the same
 * packet: a fuzzy matcher that treats any message containing the word "done" or
 * "can't" as a staff action will hijack ordinary prose — including an owner's
 * business question — and will report a PASS while acknowledging nothing. So a
 * sentence is NEVER a command here. Only these shapes are:
 *
 *     ACK                      bare verb, resolved against the sender's open work
 *     ACK #2292                verb + explicit Odoo record
 *     ACK project.task#2292    verb + model-qualified record
 *     UPDATE waiting on parts  verb + note, resolved against the sender's open work
 *     BLOCKED no access to site
 *     DONE
 *     HELP
 *     CORRECT ...
 *
 * A bare verb with zero or several open work refs does not guess. It returns
 * `needs_disambiguation`, which is an operator-visible outcome, not a silent
 * best-effort. Guessing is how a staff ACK lands on the wrong task.
 */

import { isWorkRefModel, type WorkRefModel } from './work-ref'

export const STAFF_ACTIONS = ['ack', 'update', 'blocked', 'done', 'help', 'correct'] as const
export type StaffActionKind = (typeof STAFF_ACTIONS)[number]

/** Verb spellings a human actually types, mapped to the canonical action. */
const VERB_ALIASES: Record<string, StaffActionKind> = {
  ack: 'ack',
   acknowledge: 'ack',
  acknowledged: 'ack',
  update: 'update',
  progress: 'update',
  blocked: 'blocked',
  block: 'blocked',
  stuck: 'blocked',
  done: 'done',
  complete: 'done',
  completed: 'done',
  finish: 'done',
  finished: 'done',
  help: 'help',
  correct: 'correct',
  correction: 'correct',
}

/**
 * Verbs that carry a free-text remainder as their note. `ack` does not:
 * `DONE the printer was replaced` is still a DONE, and the remainder is kept as
 * a note, but the ACTION never depends on the remainder.
 */
const NOTE_BEARING: ReadonlySet<StaffActionKind> = new Set(['update', 'blocked', 'correct', 'done'])

export interface OpenWorkRefCandidate {
  odooModel: WorkRefModel
  odooId: number
  correlationId: string
  /** Short human label, only used to render a disambiguation prompt. */
  label?: string
}

export interface ParseStaffCommandInput {
  text: string
  /**
   * The sender's currently open, Foundation-dispatched work. Supplied by the
   * caller (never read in here) so this stays a pure function.
   */
  openWork: OpenWorkRefCandidate[]
}

export type ParseStaffCommandResult =
  | {
      matched: true
      action: StaffActionKind
      /** Resolved target. Always present when matched. */
      target: OpenWorkRefCandidate
      note: string | null
      /** How the target was resolved — recorded so evidence can distinguish them. */
      resolution: 'explicit_ref' | 'sole_open_work'
      /** How the verb was recognised. Both are first-class; neither is a fallback. */
      grammar: 'strict' | 'bare'
    }
  | {
      matched: false
      reason:
        | 'not_a_command'
        | 'needs_disambiguation'
        | 'no_open_work'
        | 'unknown_reference'
    }
      & { action?: StaffActionKind; candidates?: OpenWorkRefCandidate[] }

/**
 * Extract an explicit Odoo record reference from the token after the verb.
 * Accepts `#2292`, `2292`, `project.task#2292`. Returns null when the token is
 * not a reference (which is normal — it is usually the start of a note).
 */
function parseExplicitRef(token: string | undefined): { model?: WorkRefModel; id: number } | null {
  if (!token) return null

  const qualified = /^([a-z_.]+)#(\d+)$/i.exec(token)
  if (qualified) {
    const model = qualified[1].toLowerCase()
    if (!isWorkRefModel(model)) return null
    return { model, id: Number(qualified[2]) }
  }

  const hashed = /^#(\d+)$/.exec(token)
  if (hashed) return { id: Number(hashed[1]) }

  // A bare integer is only a reference if it is plausibly an Odoo id. A single
  // digit is far more likely to be a disambiguation choice or the start of a
  // note, so it is deliberately not treated as a record id here.
  const bare = /^(\d{2,})$/.exec(token)
  if (bare) return { id: Number(bare[1]) }

  return null
}

/**
 * The pure decision core. No I/O, no clock, no randomness.
 */
export function parseStaffCommand(input: ParseStaffCommandInput): ParseStaffCommandResult {
  const raw = (input.text ?? '').trim()
  if (!raw) return { matched: false, reason: 'not_a_command' }

  // Strip trailing punctuation from the first token only — "ACK." and "ACK!"
  // are the same intent as "ACK".
  const tokens = raw.split(/\s+/)
  const verbToken = tokens[0].toLowerCase().replace(/[.!,;:]+$/, '')
  const action = VERB_ALIASES[verbToken]
  if (!action) return { matched: false, reason: 'not_a_command' }

  const explicit = parseExplicitRef(tokens[1])
  const noteTokens = explicit ? tokens.slice(2) : tokens.slice(1)
  const rawNote = noteTokens.join(' ').trim()
  const note = NOTE_BEARING.has(action) && rawNote ? rawNote : null

  // HELP never targets a record — it is a request for the command contract.
  // It is reported as matched with a synthetic target only when there is one;
  // otherwise it still matches, because refusing HELP to someone with no open
  // work would be perverse.
  if (action === 'help') {
    const sole = input.openWork.length === 1 ? input.openWork[0] : null
    if (sole) {
      return {
        matched: true,
        action,
        target: sole,
        note: null,
        resolution: 'sole_open_work',
        grammar: explicit ? 'strict' : 'bare',
      }
    }
    return { matched: false, reason: 'no_open_work', action }
  }

  if (explicit) {
    const target = input.openWork.find(
      (w) => w.odooId === explicit.id && (!explicit.model || w.odooModel === explicit.model),
    )
    // An explicit reference the sender does not hold is NOT silently retargeted
    // at their only other task. It fails closed.
    if (!target) return { matched: false, reason: 'unknown_reference', action }
    return { matched: true, action, target, note, resolution: 'explicit_ref', grammar: 'strict' }
  }

  if (input.openWork.length === 0) return { matched: false, reason: 'no_open_work', action }
  if (input.openWork.length > 1) {
    return { matched: false, reason: 'needs_disambiguation', action, candidates: input.openWork }
  }

  return {
    matched: true,
    action,
    target: input.openWork[0],
    note,
    resolution: 'sole_open_work',
    grammar: 'bare',
  }
}

/**
 * Idempotency key for a StaffAction.
 *
 * Deliberately includes the note: a staff member sending `UPDATE on site now`
 * and later `UPDATE parts fitted` is two distinct actions on the same task and
 * both must land. But the SAME text re-delivered by Meta (a webhook retry) must
 * collapse to one. `providerMessageId` is therefore the primary discriminator
 * when present — Meta guarantees it is stable across retries of the same
 * inbound — and the note only matters when it is absent.
 */
export function staffActionIdempotencyKey(params: {
  tenantId: string
  correlationId: string
  action: StaffActionKind
  providerMessageId?: string | null
  note?: string | null
}): string {
  const discriminator =
    params.providerMessageId?.trim() ||
    `note:${(params.note ?? '').trim().toLowerCase().replace(/\s+/g, ' ')}`
  return `sa:${params.tenantId}:${params.correlationId}:${params.action}:${discriminator}`
}
