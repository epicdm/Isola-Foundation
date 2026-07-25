/**
 * The escalation "card" — the private note a human agent sees when the AI
 * hands a conversation over.
 *
 * Previously surfaceHandoff() posted a fixed string:
 *   "🤖 Clawith flagged this conversation for human review."
 * which told the agent that something happened but nothing about WHAT the
 * customer wanted, so every takeover began by scrolling back through the
 * thread. This composes the same note from the context already in scope at
 * the handoff point.
 *
 * Chatwoot's own automation rules cannot produce this: a rule can only insert
 * static text. Routing and labelling belong to Chatwoot; the content of the
 * handoff is ours, and this is the boundary between them.
 *
 * The note is PRIVATE — visible to agents, never delivered to the customer.
 * It is still written on the assumption that a customer could one day see it
 * (a mis-set `private` flag is a one-character bug), so it contains no
 * internal identifiers, no tokens, and no model or prompt detail.
 */

/** Longest a quoted message may be before it is trimmed, in characters. */
export const QUOTE_LIMIT = 280;

export interface EscalationCardInput {
  /** What the customer last said. */
  customerMessage?: string | null;
  /** What the assistant answered, if it answered at all. */
  aiReply?: string | null;
  /**
   * Why this escalated — e.g. 'low-confidence', 'human-request',
   * 'out-of-scope', or a claim-guard block. Free text is fine.
   */
  reason?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
}

/** Collapse whitespace and trim to `limit`, marking the cut. */
export function truncateForNote(text: string, limit: number = QUOTE_LIMIT): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit).trimEnd()}…`;
}

/** Render a multi-line block as a markdown blockquote. */
function quote(text: string): string {
  return truncateForNote(text)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Keys are the categories lib/escalation-intent.ts actually emits, plus the
 * `escalated:*` label suffixes already in use in Chatwoot. Both spellings are
 * accepted because the two vocabularies differ (`human_request` vs
 * `human-request`) and normalising them here is cheaper than a migration.
 */
const REASON_LABELS: Record<string, string> = {
  // lib/escalation-intent.ts categories
  cancellation: 'The customer wants to cancel or close their service.',
  contract_legal: 'The customer raised a contractual or legal matter.',
  refund_billing_dispute: 'The customer is disputing a charge or asking for a refund.',
  price_negotiation: 'The customer is asking for custom pricing or a discount.',
  human_request: 'The customer asked to speak to a person.',
  complaint: 'The customer raised a complaint.',
  // escalated:* labels already present on live conversations
  'low-confidence': 'The assistant was not confident in its answer.',
  'human-request': 'The customer asked to speak to a person.',
  'out-of-scope': 'The question is outside what the assistant handles.',
  'safety-emergency': 'Possible safety or emergency situation.',
  'follow-up-delayed': 'A promised follow-up is overdue.',
  'claim-guard': 'The assistant was blocked from making an unapproved claim.',
};

/** Human-readable reason line. Unknown reasons pass through verbatim. */
export function describeReason(reason?: string | null): string {
  if (!reason) return 'The assistant flagged this conversation for human review.';
  const key = reason.replace(/^escalated:/, '').trim();
  return REASON_LABELS[key] ?? truncateForNote(reason, 160);
}

/**
 * Build the private-note body. Always returns a non-empty string so a handoff
 * is never silently surfaced with no explanation, even with no context at all.
 */
export function buildEscalationCard(input: EscalationCardInput): string {
  const lines: string[] = ['🔔 **Human help needed**', '', describeReason(input.reason)];

  const customer = input.customerMessage?.trim();
  if (customer) {
    lines.push('', '**Customer asked:**', quote(customer));
  }

  const reply = input.aiReply?.trim();
  if (reply) {
    lines.push('', '**Assistant replied:**', quote(reply));
  }

  const who = [input.contactName?.trim(), input.contactPhone?.trim()]
    .filter((v): v is string => Boolean(v))
    .join(' · ');
  if (who) {
    lines.push('', `**Contact:** ${who}`);
  }

  return lines.join('\n');
}
