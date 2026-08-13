/**
 * Provider-failure containment — stop infrastructure failure text from being
 * relayed to a customer as if it were an agent reply.
 *
 * WHY THIS EXISTS, WITH THE RECEIPT
 * ---------------------------------
 * On 2026-08-13 a customer asked EPIC "Hi, what time do close?" on WhatsApp and
 * received this, verbatim, as an outgoing non-private message from Foundation's
 * own agent bot (Chatwoot conv 233, msg 2784, 17:18:45):
 *
 *   任务执行未完成。
 *   错误：HTTP 402: {"error":{"message":"Insufficient Balance","type":"unknown_error",
 *                    "param":null,"code":"invalid_request_error"}}
 *   错误码：model_call_failed
 *   Run ID：0a4dcdfa-571f-4444-86cb-d7bcc1b1922e
 *
 * Untranslated, structurally internal, leaking a provider error body and an
 * internal run identifier to a paying customer.
 *
 * A second instance is latent rather than live: when an agent exceeds its daily
 * token cap, Clawith's `call_llm` RETURNS the quota notice as the reply text —
 * "⚠️ Daily token usage has reached the limit (506,492/200,000). Please try
 * again tomorrow or ask admin to increase the limit." — addressing the customer
 * as if they were the administrator. It does not fire today only because the
 * customer-facing agents have no cap set; NULL is the only thing protecting
 * them.
 *
 * WHY IT LIVES HERE AND NOT IN CLAWITH
 * ------------------------------------
 * CLAUDE.md law 2: zero upstream forks of Clawith. Both leaks originate in
 * Clawith's `app/services/llm/caller.py`, which this programme does not fork.
 * `generateReply()`'s single chokepoint in lib/brain-provider.ts is the only
 * reachable enforcement point for any provider's output — the same reasoning
 * that put the claim-guard there. Containing it here fixes both leaks at once,
 * for every provider, without touching the engine.
 *
 * This is containment, not diagnosis. It does not try to explain the failure to
 * the customer; it replaces it with the one deflection this codebase already
 * uses and escalates to a human.
 */

export interface ProviderFailureResult {
  /** True when the text is infrastructure output, not an agent reply. */
  leaks: boolean;
  /** Rule id, for audit only — never shown to a customer. */
  rule?: string;
}

/**
 * Patterns are anchored on structure (envelopes, status codes, identifiers)
 * rather than sentiment, because a genuine reply may legitimately discuss
 * errors, limits or balances. "Your balance is insufficient" from a billing
 * agent is a real answer; `HTTP 402: {"error":...}` never is.
 */
const FAILURE_RULES: { id: string; pattern: RegExp }[] = [
  // Clawith's own failure envelope, in the Chinese locale it ships with.
  { id: 'clawith_failure_envelope_zh', pattern: /任务执行未完成|错误码[:：]|运行\s*ID[:：]/ },
  // A raw HTTP status paired with a JSON error body — never a human sentence.
  { id: 'raw_http_error_body', pattern: /\bHTTP\s+[45]\d{2}\b[\s\S]{0,40}\{\s*"error"\s*:/i },
  // Provider error envelopes surfaced verbatim.
  { id: 'provider_error_json', pattern: /"error"\s*:\s*\{[\s\S]{0,80}"(?:message|code|type)"\s*:/ },
  // Clawith / LLM-layer error prefixes.
  { id: 'llm_error_prefix', pattern: /\[LLM (?:call )?Error\]|\bmodel_call_failed\b|\bprovider_error\b/i },
  // The token-quota notice returned AS a reply. Anchored on the admin-facing
  // instruction, which no customer-facing sentence would ever contain.
  { id: 'token_quota_notice', pattern: /(?:daily|monthly)\s+token\s+usage\s+has\s+reached\s+the\s+limit|ask\s+admin\s+to\s+increase\s+the\s+limit/i },
  // An internal run/trace identifier leaking into customer-visible text.
  { id: 'run_id_leak', pattern: /\bRun\s*ID\s*[:：]\s*[0-9a-f]{8}-[0-9a-f]{4}/i },
];

/**
 * Returns whether `text` is provider/infrastructure failure output rather than
 * an agent reply. Never throws — a detector that can throw would reintroduce
 * the failure it exists to contain.
 */
export function detectProviderFailure(text: string): ProviderFailureResult {
  if (typeof text !== 'string' || text.trim().length === 0) return { leaks: false };
  try {
    for (const rule of FAILURE_RULES) {
      if (rule.pattern.test(text)) return { leaks: true, rule: rule.id };
    }
  } catch {
    // A regex failure must not become a relayed leak. Fail closed is wrong here
    // (it would suppress every reply); fail open to the claim-guard, which is
    // the next gate and independently checks the same text.
    return { leaks: false };
  }
  return { leaks: false };
}
