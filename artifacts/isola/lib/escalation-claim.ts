/**
 * Escalation-CLAIM detector — forces a human handoff whenever the AI's OWN
 * reply text asserts that a human has already been (or is about to be)
 * engaged for this conversation, even when the brain itself returned
 * needs_handoff=false for that turn.
 *
 * Why here: defect-lite-concierge-stale-owner-active-silent-drop-2026-07-21
 * (Chatwoot conversation #100, inbox 38/46) — the brain replied "I've
 * already escalated your request to a human team member... someone from
 * EPIC will be with you shortly!" while returning needs_handoff=false.
 * Chrome UAT confirmed Assigned Team=None, Assigned Agent=None, and no
 * ai-handoff label on that conversation — nobody was actually notified.
 * generateReply()'s single chokepoint sees the full reply text regardless
 * of which provider (native/Flowise/Hermes/Clawith) produced it, so this is
 * the reachable, deterministic backstop.
 *
 * Complements lib/escalation-intent.ts (forces handoff on high-stakes
 * INBOUND intent) and lib/claim-guard.ts (forces handoff on a BLOCKED
 * fabrication): this forces handoff on an escalation CLAIM in the OUTBOUND
 * reply itself. UNLIKE those two, this is NOT scoped to SALES_TENANT_IDS —
 * a false "a human is handling this" promise is unsafe for any tenant, and
 * (unlike escalation-intent's broad inbound-keyword matching, which would
 * false-positive too often across arbitrary businesses) the phrasing
 * matched here is narrow: an assertion tied to THIS conversation having
 * been escalated, not a general "here's how to reach us" statement. Fail-
 * safe: only ever ADDS a handoff, never suppresses one.
 */

const CLAIM_PATTERNS: { id: string; pattern: RegExp }[] = [
  // "already escalated" / "already flagged" / "already connected you" / "already looped in"
  { id: 'already_escalated', pattern: /\balready\s+(?:escalat(?:ed|e)|flagged|notified|connected you|looped in)\b/i },
  // "escalated this/it/your request to a human/team/person/agent/someone"
  { id: 'escalated_to_human', pattern: /\bescalat(?:e|ed|ing)\b[^.?!]{0,40}\b(?:human|team(?:\s*member)?|person|agent|someone)\b/i },
  // "connected you with/to a human/team/person/agent/someone"
  { id: 'connected_to_human', pattern: /\bconnect(?:ed|ing)\s+you\b[^.?!]{0,30}\b(?:human|team(?:\s*member)?|person|agent|someone)\b/i },
  // "a human/team member/someone will be with you / reach out / follow up / contact you / assist you / get back to you / help you"
  { id: 'human_will_assist', pattern: /\b(?:a\s+|the\s+)?(?:human|person|team(?:\s*member)?|agent|someone)\b[^.?!]{0,30}\b(?:will|is going to|'ll)\b[^.?!]{0,25}\b(?:be with you|reach out|follow up|contact you|assist you|get back to you|help you)\b/i },
  // "flagged/notified ... team/human/person/agent" (matches claim-guard's own DEFLECTION text too — harmless, needsHandoff is already true on that path)
  { id: 'flagged_for_team', pattern: /\b(?:flagged|notified)\b[^.?!]{0,40}\b(?:team|human|person|agent)\b/i },
];

// A conditional/instructional lead-in ("if you'd like...", "just reply 'agent'...")
// describes a standing OPTION the customer may invoke, not a claim that escalation
// has already happened for this conversation — same sentence-scoped technique as
// claim-guard.ts's isNegatedClaim().
const CONDITIONAL_WORDS = /\b(?:if you|just ask|just reply|just type|would you like|want (?:me )?to|feel free to)\b/i;

function isConditionalOffer(text: string, matchIndex: number): boolean {
  let sentenceStart = 0;
  for (let i = matchIndex - 1; i >= 0; i--) {
    if (text[i] === '.' || text[i] === '?' || text[i] === '!') {
      sentenceStart = i + 1;
      break;
    }
  }
  return CONDITIONAL_WORDS.test(text.slice(sentenceStart, matchIndex));
}

export interface EscalationClaimResult {
  claims: boolean;
  /** Matched pattern id, for audit logging only — never shown to the customer. */
  rule?: string;
}

/**
 * Returns { claims: true, rule } if `text` (an outbound AI reply) asserts
 * that a human has been engaged for this conversation, and that assertion
 * is not itself framed as a conditional/instructional offer.
 */
export function detectEscalationClaim(text: string): EscalationClaimResult {
  for (const { id, pattern } of CLAIM_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
    for (const m of text.matchAll(global)) {
      if (!isConditionalOffer(text, m.index ?? 0)) return { claims: true, rule: id };
    }
  }
  return { claims: false };
}
