/**
 * staff-flow.ts — the WhatsApp Flow that carries the words a tap cannot.
 *
 * WHY THIS EXISTS. `staff-menu.ts` closed the "I have to type the commands"
 * problem: every action is now a tap. It opened a smaller, sharper one. A
 * WhatsApp quick-reply button has a frozen label and a developer payload and
 * NOTHING ELSE — there is no free-text slot in a button tap. So a tapped
 * "I'm blocked" recorded a blocker with NO REASON, and a tapped "Mark as done"
 * sent the manager a verification whose "Reported result" was empty. The system
 * never lied about it — the replies said "Blocked status recorded", not "moved
 * to Blocked" — but a reasonless blocker is not actionable by a manager, which
 * makes it close to worthless.
 *
 * The obvious fix is a pending-note state machine: tap, ask "what's blocking
 * you?", then treat the NEXT free-text message as the note. That was considered
 * and rejected. It puts conversational state on the server, and a stale prompt
 * then swallows an unrelated message — a staff member who taps BLOCKED, gets
 * distracted, and forty minutes later texts "MY TASKS" has just filed "MY
 * TASKS" as their blocker reason.
 *
 * A Flow removes the need for that state entirely. The action and the record
 * ride in `flow_token`, which Meta echoes back verbatim inside the completion
 * payload, so the message carries its own context and the server holds none.
 * An abandoned Flow is simply a Flow that never completes: no timer, no stale
 * prompt, nothing to clean up. That is the whole reason this is a Flow rather
 * than a conversation.
 *
 * ── Established truth this encodes (verified against Meta, 2026-07-30) ──────
 *
 *   - The Flow is ENDPOINTLESS. Its JSON declares no `data_api_version` and no
 *     `routing_model`, its single screen is `terminal: true`, and its Footer
 *     fires `complete` rather than `data_exchange`. Nothing is served at
 *     runtime, so there is no endpoint to keep up, no signature to rotate, and
 *     no new failure mode on the critical path of a staff reply.
 *
 *     This matters for a second reason. WABA 272252189309178 already carries a
 *     Flow called "EPIC Internal Staff Task Actions" (1516186056913032) whose
 *     `endpoint_uri` is `https://bff.epic.dm/api/whatsapp/flows` — the FROZEN
 *     BFF platform, outside this lane. Reusing it would have meant depending on
 *     a server this lane must not modify, for every screen transition. This
 *     Flow is the Foundation-native equivalent and depends on nothing.
 *
 *   - `flow_token` is business-generated, opaque to Meta, and returned inside
 *     `nfm_reply.response_json`. So it is reused here as EXACTLY the menu id
 *     codec (`encodeMenuId` / `decodeMenuId`) that button taps already use.
 *     One codec, one decode path, one authority check — a Flow completion
 *     resolves through the same `resolveInboundStaffTap` a button tap does.
 *     Minting a second identifier format would have created two things that
 *     both claim to say which record a reply is about.
 *
 *   - A free-form `interactive` message requires an OPEN 24-hour service
 *     window. That is always true here: this Flow is only ever sent as a reply
 *     to a tap the staff member just made, and their tap opened the window.
 *
 * The typed vocabulary is untouched and still wins: `BLOCKED 2410 <reason>`
 * arrives with its reason already attached and never sees a Flow.
 */

import { decodeMenuId, encodeMenuId, type StaffMenuAction } from './staff-menu'

/**
 * The published Flow on WABA 272252189309178.
 *
 * Env-overridable because the id is per-WABA: a second tenant on a different
 * WABA needs its own published Flow, and hardcoding would silently send a
 * foreign flow id that Meta rejects at send time. The literal is the default so
 * EPIC works with no configuration, matching how the staff template constant
 * behaves.
 */
export const STAFF_NOTE_FLOW_ID = process.env.STAFF_NOTE_FLOW_ID || '1533509148255651'

/** The entry screen id in the published Flow JSON. */
export const STAFF_NOTE_FLOW_SCREEN = 'NOTE'

/** Meta's Flow message envelope version. Currently "3". */
export const STAFF_NOTE_FLOW_MESSAGE_VERSION = '3'

/**
 * The actions that are meaningless without words.
 *
 * `ack` and `start` are deliberately absent. "I have seen it" and "I have
 * begun" are complete facts on their own — making a staff member open a form to
 * say them would be friction with nothing on the other side of it, and those
 * are the two taps that happen on a roof with one hand free.
 */
export const TEXT_BEARING_ACTIONS: readonly StaffMenuAction[] = ['update', 'blocked', 'done']

export function isTextBearingAction(action: string): action is StaffMenuAction {
  return (TEXT_BEARING_ACTIONS as readonly string[]).includes(action)
}

/** The question at the top of the form. Names the ask, not the mechanism. */
export function flowHeading(action: StaffMenuAction): string {
  switch (action) {
    case 'blocked':
      return "What's blocking you?"
    case 'done':
      return 'What was the result?'
    case 'update':
      return "What's the update?"
    default:
      return 'Add a note'
  }
}

/**
 * The button that opens the form. Meta advises 30 characters or fewer and no
 * emoji; asserted rather than trusted, because an over-long CTA is a 400 at
 * send time on a staff member's handset rather than a failure in a test.
 */
export const WA_FLOW_LIMITS = { cta: 30 } as const

export function flowCta(action: StaffMenuAction): string {
  const label =
    action === 'blocked' ? 'Describe the blocker'
    : action === 'done' ? 'Report the result'
    : 'Write the update'
  if (label.length > WA_FLOW_LIMITS.cta) {
    throw new Error(`flow CTA "${label}" exceeds ${WA_FLOW_LIMITS.cta} chars`)
  }
  return label
}

/** Everything the send adapter needs to put this Flow on the wire. */
export interface StaffFlowPrompt {
  flowId: string
  flowToken: string
  cta: string
  screen: string
  data: { heading: string; task: string }
}

/**
 * Build the Flow prompt for an action that needs words.
 *
 * `flowToken` is `encodeMenuId(action, correlationId)` — the SAME string a
 * button tap would have carried. That is the load-bearing decision in this
 * module: it means the completion decodes through `decodeMenuId` with no new
 * branch, resolves through `resolveInboundStaffTap` with no new authority rule,
 * and a Flow reply is indistinguishable downstream from a button tap that
 * happened to arrive with a note attached.
 */
export function buildStaffNoteFlow(input: {
  action: StaffMenuAction
  correlationId: string
  taskLabel: string
}): StaffFlowPrompt {
  return {
    flowId: STAFF_NOTE_FLOW_ID,
    flowToken: encodeMenuId(input.action, input.correlationId),
    cta: flowCta(input.action),
    screen: STAFF_NOTE_FLOW_SCREEN,
    data: {
      heading: flowHeading(input.action),
      // Shown under the heading so the person can see WHICH task they are
      // writing about. Flattened: the Flow renderer takes a plain string and an
      // Odoo task name is free text a human typed.
      task: flattenForFlow(input.taskLabel),
    },
  }
}

/** Newlines and tab runs collapse; an empty label becomes a readable fallback. */
export function flattenForFlow(value: string | null | undefined): string {
  const flat = (value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim()
  return flat.length > 0 ? flat : 'Your task'
}

/**
 * Decode a completed Flow.
 *
 * `response_json` is a STRINGIFIED JSON blob, not an object — parsing it is not
 * optional. Fails closed on every malformed shape: a Flow that cannot be
 * decoded falls through to the ordinary text path and earns help, which is the
 * honest answer, rather than being guessed at.
 */
export function decodeStaffFlowReply(responseJson: unknown): {
  action: StaffMenuAction
  correlationId: string
  note: string | null
} | null {
  if (typeof responseJson !== 'string' || !responseJson.trim()) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(responseJson)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const p = parsed as Record<string, unknown>
  const token = typeof p.flow_token === 'string' ? p.flow_token : ''
  const decoded = decodeMenuId(token)
  if (!decoded) return null
  const note = typeof p.note === 'string' && p.note.trim() ? p.note.trim() : null
  return { action: decoded.action as StaffMenuAction, correlationId: decoded.correlationId, note }
}
