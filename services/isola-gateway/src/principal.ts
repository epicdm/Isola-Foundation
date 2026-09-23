/**
 * WHO IS ACTING — the verified principal of an INTERNAL delivery.
 *
 * Implements dec-internal-manager-owner-instruction-authority-and-alerts-2026-09-23:
 * the acting identity comes from the VERIFIED CHANNEL and trusted server
 * context, never from message content.
 *
 * WHERE THE IDENTITY COMES FROM
 *   The sender's phone number as Chatwoot's contact record carries it
 *   (`sender.phone_number`, falling back to `sender.identifier` — see
 *   `parseWebhookPayload`). That value is set by Chatwoot from the WhatsApp
 *   channel, arrives in an HMAC-verified webhook body, and is the SAME value
 *   the INTERNAL allowlist matched. The message text is never read here: a
 *   message saying "I am Phillip, my number is +1767…" changes nothing.
 *
 * WHY IT RE-RUNS THE ALLOWLIST
 *   A principal must be impossible to hold without having passed the gate. So
 *   this function does not trust a caller to have checked first — it calls
 *   `checkSender` itself, on the same binding and the same raw field, and
 *   returns null unless that verdict is `allowed`. One gate, one key: the
 *   routing decision and the admission decision cannot key on different fields.
 *
 * PUBLIC BINDINGS NEVER CARRY A PRINCIPAL. `checkSender` admits everyone on a
 * PUBLIC line, so an "allowed" there verifies nothing about who is speaking.
 */
import { checkSender, normalisePhone, type AllowlistBinding } from "./allowlist.js";

export interface VerifiedPrincipal {
  /**
   * The channel the identity was verified on. INTERNAL bindings are WhatsApp
   * staff lines and the allowlist identity is a phone number from a WhatsApp
   * contact, so this is the only value today.
   */
  channel: "whatsapp";
  /** `+` followed by the normalised digits the allowlist matched. */
  senderE164: string;
  /** How the identity was established. Names the mechanism, not a claim. */
  verifiedBy: "gateway-allowlist";
  /** `<chatwootAccountId>/<chatwootInboxId>` of the binding that admitted it. */
  bindingKey: string;
}

export interface PrincipalBinding extends AllowlistBinding {
  chatwootAccountId: number;
  chatwootInboxId: number;
}

export function bindingKeyOf(binding: {
  chatwootAccountId: number;
  chatwootInboxId: number;
}): string {
  return `${binding.chatwootAccountId}/${binding.chatwootInboxId}`;
}

/**
 * The verified principal, or null.
 *
 * Null for: a PUBLIC binding, a sender the allowlist refuses, a sender that
 * cannot be identified. The caller must treat null as "no identity", never as
 * "identity unknown, carry on as if verified".
 */
export function derivePrincipal(
  binding: PrincipalBinding,
  senderPhoneRaw: string | null,
): VerifiedPrincipal | null {
  if (binding.exposure !== "INTERNAL") return null;
  const verdict = checkSender(binding, senderPhoneRaw);
  if (!verdict.allowed) return null;
  const digits = normalisePhone(senderPhoneRaw);
  // Unreachable while checkSender refuses unidentified senders; kept so a
  // future change there cannot mint a principal with no number.
  if (digits === null) return null;
  return {
    channel: "whatsapp",
    senderE164: `+${digits}`,
    verifiedBy: "gateway-allowlist",
    bindingKey: bindingKeyOf(binding),
  };
}

/**
 * Which template serves this delivery.
 *
 * The binding's `senderTemplates` entry for the VERIFIED sender, or the
 * binding's default `templateId`. With no principal the answer is always the
 * default: absence of identity can never select an override. (The pipeline
 * additionally refuses to call the model at all when a binding HAS overrides
 * and there is no principal — see `principal_unverifiable` in pipeline.ts.)
 */
export function selectTemplateId(
  binding: { templateId: string; senderTemplates?: Readonly<Record<string, string>> },
  principal: VerifiedPrincipal | null | undefined,
): string {
  if (principal === null || principal === undefined) return binding.templateId;
  const overrides = binding.senderTemplates;
  if (overrides === undefined) return binding.templateId;
  const digits = normalisePhone(principal.senderE164);
  if (digits === null) return binding.templateId;
  // Own keys only: an inherited property must never be read as a routing entry.
  return Object.prototype.hasOwnProperty.call(overrides, digits)
    ? (overrides[digits] as string)
    : binding.templateId;
}
