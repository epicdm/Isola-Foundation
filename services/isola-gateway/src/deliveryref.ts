/**
 * Delivery identity: the atomic key, the payload digest and the deterministic
 * opaque delivery reference.
 *
 * Pure and dependency-free ON PURPOSE. `src/ledger.ts` is the only module in
 * this service allowed to import a database driver, and `src/chatwoot.ts` needs
 * the delivery-reference vocabulary too — so the vocabulary lives here rather
 * than dragging `pg` into the Chatwoot client's import graph.
 *
 * Nothing in this module touches customer content. Every input is an
 * identifier, and the two outputs are digests.
 */
import { createHash } from "node:crypto";

/**
 * Everything the atomic key is made of, minus the action.
 *
 * `bindingId` is derived from the RESOLVED binding, never read from the
 * payload — see `bindingIdentity`. A caller cannot address another tenant's
 * ledger rows by crafting a webhook body.
 */
export interface LedgerIdentity {
  tenantId: string;
  bindingId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  /** The webhook event id: `delivery:<uuid>` or the composite fallback. */
  eventId: string;
}

/**
 * The stable, non-secret identity of a binding. Built from routing identifiers
 * and the bot id, so rotating a secret does not orphan a tenant's ledger rows,
 * but re-pointing an inbox at a different bot does start a fresh key space.
 */
export function bindingIdentity(binding: {
  tenantId: string;
  chatwootAccountId: number;
  chatwootInboxId: number;
  chatwootAgentBotId: number;
}): string {
  return `${binding.tenantId}:${binding.chatwootAccountId}:${binding.chatwootInboxId}:${binding.chatwootAgentBotId}`;
}

/** The top-level reservation claimed before the webhook is acknowledged. */
export const DELIVERY_ACTION = "delivery";

/** sha256 over the RAW signed body. Never the body itself. */
export function payloadDigest(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * The deterministic opaque delivery identifier stamped on every Chatwoot
 * message this gateway sends.
 *
 * Deterministic so a resend after an ambiguous failure computes the SAME value
 * and can therefore be reconciled. Opaque so it discloses nothing: it is a
 * digest of identifiers, contains no customer content, no tenant name in the
 * clear and no secret. It is never placed in customer-visible text — it travels
 * in `content_attributes`, which Chatwoot does not render.
 */
export function deliveryRef(identity: LedgerIdentity, action: string): string {
  const canonical = [
    identity.tenantId,
    identity.bindingId,
    String(identity.chatwootAccountId),
    String(identity.chatwootInboxId),
    identity.eventId,
    action,
  ].join("\n");
  return `isola-${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`;
}

/** The Chatwoot `content_attributes` key carrying the delivery ref. */
export const DELIVERY_REF_ATTRIBUTE = "isola_delivery_ref";
