/**
 * Escalation-intent detector — forces a human handoff for sales tenants when the
 * INBOUND customer message signals a high-stakes request that must reach a person,
 * even when the AI's own reply is a correct, on-message deflection
 * (def-ema-needs-handoff-flag-inconsistent, 2026-07-18 acceptance test 2).
 *
 * Why here: the brain (Clawith) sets needs_handoff itself, but was observed to
 * return needs_handoff=false on a contract-cancellation / custom-price request that
 * its own text correctly deflected — so the "a person will follow up" promise was
 * never actually routed to a human. This is the reachable, deterministic backstop:
 * generateReply()'s single chokepoint sees both the inbound message and tenantId,
 * so both the Chatwoot agent-bot path and the direct-webhook path get it.
 *
 * Complements lib/claim-guard.ts: the guard forces handoff on a BLOCKED fabrication
 * (reply-side); this forces handoff on high-stakes inbound intent. Scoped to
 * SALES_TENANT_IDS — zero effect on any other tenant. Fail-safe: it only ever ADDS
 * a handoff, never suppresses one.
 */
import { SALES_TENANT_IDS } from './claim-guard';

export interface EscalationResult {
  escalate: boolean;
  /** Matched category, for audit logging only — never shown to the customer. */
  category?: string;
}

const INTENTS: { category: string; pattern: RegExp }[] = [
  { category: 'cancellation', pattern: /\bcancel(?:l?ing|l?ed|l?ation)?\b|\bterminat(?:e|ing|ion)\b|\bclose (?:my|the|this) (?:account|service|subscription)\b|\bend (?:my|the) (?:service|subscription|plan|contract)\b|\bstop (?:my|the) (?:service|subscription|plan)\b|\bunsubscribe\b|\bopt(?:ing)?[\s-]?out\b/i },
  { category: 'contract_legal', pattern: /\bcontract\b|\blawyer\b|\battorney\b|\blegal\b|\bsue\b|\blawsuit\b|\bbreach of\b/i },
  { category: 'refund_billing_dispute', pattern: /\brefund\b|\bcharge[\s-]?backs?\b|\bover[\s-]?charg(?:e|ed|ing)\b|\bwrong(?:ly)? charged?\b|\bdispute (?:the|this|a|my) (?:charge|bill|payment|invoice)\b|\bbilling (?:error|problem|issue|mistake|dispute)\b|\bmoney back\b|\bdouble[\s-]?charg(?:e|ed)\b/i },
  { category: 'price_negotiation', pattern: /\bcustom (?:price|pricing|quote|deal|rate)\b|\bnegotiat(?:e|ing|ion)\b|\bdiscount\b|\bbetter (?:price|rate|deal|offer)\b|\blower (?:the )?(?:price|rate)\b|\bspecial (?:deal|price|rate|offer)\b|\bmatch (?:a )?competitor\b|\bcheaper\b/i },
  { category: 'human_request', pattern: /\b(?:speak|talk|connect|transfer)(?:\s+me)?\s+(?:to|with)\s+(?:a |an |the )?(?:human|person|agent|representative|rep|someone|somebody|manager|supervisor|real person)\b|\breal (?:human|person)\b|\bhuman (?:agent|being|please|rep)\b|\bmanager\b|\bsupervisor\b/i },
  { category: 'complaint', pattern: /\bcomplaints?\b|\bcomplain(?:ing)?\b|\b(?:really |very |so )?(?:unhappy|dissatisfied|disappointed|frustrated|angry|upset)\b|\bterrible (?:service|experience)\b|\bworst\b|\bscam\b|\bripp?ed off\b/i },
];

/**
 * Returns { escalate: true, category } if `text` (an inbound customer message) for a
 * SALES tenant signals an escalation-worthy intent. Non-sales tenants always return
 * { escalate: false }.
 */
export function detectEscalationIntent(text: string, tenantId: string): EscalationResult {
  if (!SALES_TENANT_IDS.has(tenantId)) return { escalate: false };
  for (const { category, pattern } of INTENTS) {
    if (pattern.test(text)) return { escalate: true, category };
  }
  return { escalate: false };
}
