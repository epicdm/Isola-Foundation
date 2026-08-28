/**
 * Conversation executors — the ONE governed action that speaks to a customer.
 *
 * WHY THIS IS A SEPARATE FILE FROM `./index.ts`
 * --------------------------------------------
 * `./index.ts` opens by stating, and a test asserts, that nothing in it "sends a
 * message, opens a conversation, picks a channel or touches a provider". That is
 * a deliberate boundary: those executors write BUSINESS FACTS to the system of
 * record, and telling a human about them is a different lane with different
 * consequences. Adding a sender there would have quietly deleted an invariant
 * someone chose. So the sending lane lives here instead, and that file's promise
 * remains true.
 *
 * WHAT THIS DOES NOT DO
 * ---------------------
 *   - It does not pick a channel, a number, or a provider. It posts into ONE
 *     Chatwoot conversation; the conversation's OWNING channel delivers it. That
 *     is the "one canonical outbound per number-owner" rule — there is no
 *     Foundation-side WhatsApp sender here and there must never be one.
 *   - It does not compose the message. The body arrives already composed from
 *     verified Odoo fields (`lib/customer-360/document-message.ts`).
 *   - It does not decide whether sending is appropriate. A human clicked confirm.
 *
 * READBACK IS STRICTER THAN "A MESSAGE EXISTS"
 * -------------------------------------------
 * The readback proves the message is present, that its content is byte-identical
 * to what was authorised, AND that it is not private. A private note posted where
 * a customer-visible reply was authorised is a silent failure of exactly the kind
 * this lifecycle exists to catch: the operator would be told the customer had
 * been answered when nobody had been.
 */

import { type ActionExecutor, type ActionProposal } from '../action'

import { SENDABLE_KINDS } from '@/lib/customer-360/document-message'

/**
 * The conversation platform (Chatwoot today). Injected so tests need no network.
 */
export interface ConversationSystem {
  /** Post a CUSTOMER-VISIBLE message. Never a private note. */
  postCustomerVisibleMessage(input: {
    conversationId: number
    body: string
  }): Promise<{ externalId: string }>
  /** Read one message back from the platform. The only proof it was sent. */
  readMessage(input: {
    conversationId: number
    externalId: string
  }): Promise<Record<string, unknown> | null>
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** Accepts a positive integer given as a number or a numeric string. */
function positiveInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(str(v))
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Chatwoot rejects very long bodies; refuse before the network does. */
export const MAX_MESSAGE_BODY = 4000

export function buildConversationExecutors(
  conv: ConversationSystem,
): readonly ActionExecutor[] {
  return [
    {
      actionType: 'document.send',
      // Customer-visible and not retractable. Risk is stated honestly even
      // though no approval gate is wired: the human confirm click is the gate.
      riskLevel: 'high',
      allowedRoles: ['staff', 'manager', 'owner'],
      validate: (payload) => {
        if (positiveInt(payload.conversationId) === null) {
          return { ok: false, detail: 'conversationId is required' }
        }
        if (positiveInt(payload.documentId) === null) {
          return { ok: false, detail: 'documentId is required' }
        }
        const kind = str(payload.documentKind)
        if (!(SENDABLE_KINDS as readonly string[]).includes(kind)) {
          return {
            ok: false,
            detail: `documentKind must be one of ${SENDABLE_KINDS.join(', ')}`,
          }
        }
        if (!str(payload.documentReference)) {
          return { ok: false, detail: 'documentReference is required' }
        }
        const body = str(payload.body)
        if (!body) return { ok: false, detail: 'body is required' }
        if (body.length > MAX_MESSAGE_BODY) {
          return { ok: false, detail: `body exceeds ${MAX_MESSAGE_BODY} characters` }
        }
        return { ok: true }
      },
      execute: async (p: ActionProposal) =>
        conv.postCustomerVisibleMessage({
          conversationId: positiveInt(p.payload.conversationId)!,
          body: str(p.payload.body),
        }),
      readback: async (externalId, p) => {
        const row = await conv.readMessage({
          conversationId: positiveInt(p.payload.conversationId)!,
          externalId,
        })
        if (!row) return null
        // Byte-identical content, and provably not private. Either failing means
        // we cannot claim the customer was sent what was authorised.
        if (str(row.content) !== str(p.payload.body)) return null
        if (row.private !== false) return null
        return row
      },
    },
  ]
}
