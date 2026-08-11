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

// ---------------------------------------------------------------------------
// Per-write idempotency, on the SAME store and the SAME delivery key
// ---------------------------------------------------------------------------

/**
 * `X-Chatwoot-Delivery` already gates the whole pipeline: a repeated delivery
 * is refused at the ACK and never reaches the asynchronous half at all. That is
 * the first line of defence and it is unchanged.
 *
 * This is the second: every individual Chatwoot WRITE — the note, the status
 * change, the assignment, the labels, the attributes, the customer message — is
 * additionally claimed under `<deliveryKey>#<write>` in the same store, so a
 * duplicate that ever did reach the pipeline still cannot produce a second
 * note, a second assignment or a second customer message.
 *
 * Deliberately the same `IdempotencyStore`, not a parallel mechanism: one TTL,
 * one cap, one eviction policy, one thing to make durable if that judgement
 * ever changes.
 *
 * Two consequences of sharing the store, both deliberate:
 *
 *  - a delivery now occupies roughly six entries rather than one, so
 *    `GATEWAY_IDEMPOTENCY_MAX_ENTRIES` buys proportionally fewer deliveries of
 *    de-duplication window. Raise it if that matters more than the memory.
 *  - eviction is oldest-first, and the delivery key is always claimed BEFORE
 *    its own write keys, so the delivery key is evicted first. A retry landing
 *    in that gap re-enters the pipeline and then finds every write already
 *    claimed — no second note, no second assignment, no second customer
 *    message. The write guard deliberately outlives the delivery guard.
 */
export const WRITE_KEY_SEPARATOR = "#";

export function writeKey(deliveryKey: string, write: string): string {
  return `${deliveryKey}${WRITE_KEY_SEPARATOR}${write}`;
}

export interface WriteGuard {
  /**
   * Run `fn` only the first time this (delivery, write) pair is seen.
   *
   * Returns true when `fn` ran, false when the write was already claimed.
   * Errors from `fn` propagate to the caller; the claim is NOT released,
   * because a failed customer-facing write must never be retried blind — a
   * duplicate answer to a customer is worse than a missing one.
   */
  once(write: string, fn: () => Promise<void>): Promise<boolean>;
}

export interface WriteGuardOptions {
  store: IdempotencyStore;
  /** The delivery key this pipeline run is operating under. */
  deliveryKey: string;
  now: () => number;
}

export function createWriteGuard(options: WriteGuardOptions): WriteGuard {
  return {
    async once(write: string, fn: () => Promise<void>): Promise<boolean> {
      if (!options.store.claim(writeKey(options.deliveryKey, write), options.now())) {
        return false;
      }
      await fn();
      return true;
    },
  };
}
