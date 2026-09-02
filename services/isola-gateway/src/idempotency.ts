/**
 * The delivery event id.
 *
 * Chatwoot retries a delivery on 429 and 500 only, three attempts, three
 * seconds apart — but it retries the SAME `X-Chatwoot-Delivery` id, and an
 * operator replaying a webhook by hand will too. A duplicate must acknowledge
 * with 200 and send absolutely nothing.
 *
 * This module is now only the KEY. The store behind it is `src/ledger.ts`: a
 * private, durable Postgres whose primary key is
 * `(tenant, binding, account, inbox, event id, action type)`, so uniqueness is
 * enforced by the database rather than by a `Map` that a container replacement
 * throws away.
 *
 * What used to live here — `MemoryIdempotencyStore` and the in-process
 * `WriteGuard` — is deleted rather than kept as a fallback. A de-duplication
 * store that silently degrades to "everything looks new" is worse than none,
 * because it fails in exactly the situation it exists for.
 */

export interface IdempotencyKeyParts {
  deliveryId: string | null;
  accountId: number | null;
  conversationId: number | null;
  messageId: number | null;
  event: string | null;
}

/**
 * Primary key is the delivery id. When Chatwoot omits the header, fall back to
 * `(account_id, conversation_id, message_id, event)` — which still identifies
 * one logical delivery, because Chatwoot emits one event per message per bot.
 *
 * Returns null when neither key can be formed. The caller treats that as
 * "cannot de-duplicate" and fails closed.
 */
export function idempotencyKey(parts: IdempotencyKeyParts): string | null {
  if (parts.deliveryId !== null && parts.deliveryId.length > 0) {
    return `delivery:${parts.deliveryId}`;
  }
  if (
    parts.accountId === null ||
    parts.conversationId === null ||
    parts.messageId === null ||
    parts.event === null ||
    parts.event.length === 0
  ) {
    return null;
  }
  return `msg:${parts.accountId}:${parts.conversationId}:${parts.messageId}:${parts.event}`;
}
