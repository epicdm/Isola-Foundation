/**
 * The concrete ConversationSystem, backed by Chatwoot's Application API.
 *
 * WHY THIS LIVES BESIDE THE ROUTE AND NOT IN `lib/governed/executors/`
 * -------------------------------------------------------------------
 * `engines/chatwoot.ts` is on the legacy manifest (disposition: remove, to be
 * replaced by a Lane 2 send contract), and `lib/governed` is a PERMANENT module
 * root that a test forbids from importing legacy transport. That boundary is
 * right: the governed lane should know about a `ConversationSystem` PORT, not
 * about Chatwoot. So the port lives in `lib/governed/executors/conversation.ts`,
 * and this — the only file that names the provider — sits at the transport edge,
 * exactly as `createOdooRecordSystem` is injected from the customer-actions
 * route rather than reached for from inside the lifecycle.
 *
 * When Lane 2 ships its send contract, THIS file is what gets replaced, and
 * nothing under `lib/governed` has to change.
 *
 * This is the ONLY adapter permitted to put a customer-visible message on the
 * wire for S8. It posts into a conversation and lets that conversation's OWNING
 * channel deliver — there is no channel selection here, no number, no provider,
 * and deliberately no WhatsApp client. Foundation must never grow a second
 * outbound path beside the owning channel's; that is the recorded double-send
 * hazard, and the way to not walk into it is to have nowhere to walk.
 *
 * DEPENDENCY-DOWN VS WRITE-REFUSED
 * --------------------------------
 * The governed runtime treats these differently, and it can only do so if this
 * adapter tells them apart. Transport failures and 5xx become
 * `DependencyUnavailable` (retrying is sensible); a 4xx refusal stays a plain
 * Error (retrying the same request is not). Getting this wrong would either
 * bury an outage as a rejection or invite a retry storm against a refusal.
 */

import { addMessage, findMessage, type ChatwootConfig } from '@/engines/chatwoot'
import { DependencyUnavailable } from '@/lib/governed/action'
import type { ConversationSystem } from '@/lib/governed/executors/conversation'

/**
 * Chatwoot's client throws `Error("<fn> failed (<status>): <body>")`. The status
 * is the one bit that decides retry-ability, so it is parsed back out rather
 * than guessed. An unparseable error is treated as DOWN — the safer default,
 * because calling an outage a refusal strands a real send with no retry.
 */
function classify(err: unknown, dependency: string): never {
  const message = err instanceof Error ? err.message : String(err)
  const status = Number(/\((\d{3})\)/.exec(message)?.[1] ?? NaN)

  if (Number.isInteger(status) && status >= 400 && status < 500) {
    // A genuine refusal by the platform. Not a dependency outage.
    throw new Error(message)
  }
  throw new DependencyUnavailable(dependency, message)
}

export function createChatwootConversationSystem(
  config: ChatwootConfig,
): ConversationSystem {
  return {
    async postCustomerVisibleMessage({ conversationId, body }) {
      try {
        // `outgoing` = from the agent side; `addMessage` hard-codes private:false,
        // so a private note cannot be produced by this path even by mistake.
        const created = await addMessage(config, conversationId, body, 'outgoing')
        const id = Number(created?.id)
        if (!Number.isInteger(id) || id <= 0) {
          // A create response we cannot identify is not proof of anything. Say so
          // rather than inventing an id the readback would then fail to find.
          throw new Error('Chatwoot accepted the message but returned no usable id')
        }
        return { externalId: String(id) }
      } catch (err) {
        classify(err, 'chatwoot')
      }
    },

    async readMessage({ conversationId, externalId }) {
      const id = Number(externalId)
      if (!Number.isInteger(id) || id <= 0) return null
      try {
        return await findMessage(config, conversationId, id)
      } catch (err) {
        classify(err, 'chatwoot')
      }
    },
  }
}
