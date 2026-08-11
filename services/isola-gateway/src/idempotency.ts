/**
 * Delivery idempotency.
 *
 * Chatwoot retries a delivery on 429 and 500 only, three attempts, three
 * seconds apart — but it retries the SAME `X-Chatwoot-Delivery` id, and an
 * operator replaying a webhook by hand will too. A duplicate must acknowledge
 * with 200 and send absolutely nothing.
 *
 * The store is in-memory on purpose: it is a de-duplication window, not a
 * ledger. A container replacement loses it, which at worst allows one duplicate
 * reply for a delivery that was in flight across the restart. Making it durable
 * would mean giving this service a filesystem or a database, and neither is
 * worth it for the only publicly-exposed component in the system. `BindingStore`
 * has a replacement path; if durability is ever needed, `IdempotencyStore` has
 * the same shape.
 */

export interface IdempotencyStore {
  /** True when this key is newly claimed, false when it was already seen. */
  claim(key: string, nowMs: number): boolean;
  size(): number;
}

export interface MemoryIdempotencyOptions {
  ttlMs: number;
  maxEntries: number;
}

export class MemoryIdempotencyStore implements IdempotencyStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(options: MemoryIdempotencyOptions) {
    this.ttlMs = Math.max(1, options.ttlMs);
    this.maxEntries = Math.max(1, options.maxEntries);
  }

  claim(key: string, nowMs: number): boolean {
    this.prune(nowMs);
    const existing = this.seen.get(key);
    if (existing !== undefined && nowMs - existing < this.ttlMs) return false;
    this.seen.set(key, nowMs);
    // Map iteration is insertion-ordered, so the head is the oldest claim.
    while (this.seen.size > this.maxEntries) {
      const oldest = this.seen.keys().next();
      if (oldest.done === true) break;
      this.seen.delete(oldest.value);
    }
    return true;
  }

  size(): number {
    return this.seen.size;
  }

  private prune(nowMs: number): void {
    if (this.seen.size === 0) return;
    for (const [key, at] of this.seen) {
      if (nowMs - at < this.ttlMs) break; // insertion-ordered: the rest are newer
      this.seen.delete(key);
    }
  }
}

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
