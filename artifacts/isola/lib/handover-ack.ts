/**
 * Handover acknowledgement — the one system sentence sent after a conversation
 * has passed to a human.
 *
 * THE DEFECT THIS CLOSES
 * ----------------------
 * After a handover the AI correctly stops: `AI_REPLY_OWNERSHIP_STATES` excludes
 * HUMAN_REQUESTED / HUMAN_OWNED / HANDING_BACK, so every later inbound message
 * is refused. The refusal is total and SILENT, so a customer cannot tell "a
 * person has this" from "this channel is dead". Observed on conv 233
 * (2026-08-13): after a true escalation the customer asked "what is my balance?"
 * at 18:08:44 and again at 18:16:23, received nothing either time, and a human
 * replied ten minutes later.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not an AI reply. Not a second route by which a model reaches a customer. The
 * text is a pinned constant; no model, no template interpolation, no tool. The
 * AI stays exactly as silent as it was.
 *
 * WHY IT KEYS ON HUMAN_OWNED
 * --------------------------
 * Before PR #104, HUMAN_OWNED was written unconditionally — `surfaceHandoff`
 * returned void and swallowed its failures — so it asserted "a person can see
 * this" without checking. Keying an acknowledgement on that would have told
 * customers a person had their conversation on the strength of an unverified
 * claim. #104 gates the confirmation on the surface actually landing, so
 * HUMAN_OWNED now means what it says: a handoff that reached Chatwoot.
 *
 * HUMAN_REQUESTED is deliberately NOT acknowledged — it is the state a
 * conversation sits in when surfacing FAILED. HANDING_BACK is not either:
 * reconciliation is in progress and nobody speaks.
 */

/** Pinned byte for byte. Do not reword, do not template anything into it.
 *
 *  Constraints it satisfies, each load-bearing:
 *   - asserts only what is verifiably true at send time (the message is in the
 *     thread; a human owns the conversation, verified by #104's gate);
 *   - implies NO response time — no "shortly", no "soon", no duration, no
 *     business hours. The real wait on conv 233 was ten minutes;
 *   - reads as receipt, not as an answer, so it does not invite a reply loop.
 */
export const HANDOVER_ACK_TEXT =
  'Thanks — your message has been added to the conversation and a member of our team has it.';

export interface HandoverAckDeps {
  /** Conditional claim: returns the number of rows updated (0 or 1). */
  claimEpisode: (conversationId: string, episode: number) => Promise<number>;
  /** Posts the customer-visible message. Resolves true when it landed. */
  postMessage: (text: string) => Promise<boolean>;
}

export interface HandoverAckInput {
  conversationId: string;
  /** Authoritative ownership state, as read by lib/ownership. */
  ownershipState: string;
  ownershipEpisode: number;
  /** False on the legacy door, which has no episode semantics to key on. */
  ownershipAuthoritative: boolean;
  /** Fail closed: a payload without an explicit `false` is treated as private. */
  isPrivate: boolean;
  /** Only an inbound customer message earns an acknowledgement. */
  isIncoming: boolean;
  senderType?: string | null;
}

export type HandoverAckOutcome =
  | 'sent'
  | 'not_handed_over'
  | 'not_authoritative'
  | 'already_acked'
  | 'not_customer_message'
  | 'post_failed';

/**
 * Sends at most ONE acknowledgement per handover episode.
 *
 * Ordering is claim-then-send, deliberately. The episode is claimed with a
 * conditional UPDATE before the message is posted, so two inbound messages
 * arriving in the same instant cannot both send: the second sees 0 rows
 * updated and stops. If the post then fails we KEEP the claim and do not retry
 * — a duplicate acknowledgement is worse than the silence it replaces, and
 * re-posting on an ambiguous failure is how the duplicate-note P1 happened.
 */
export async function maybeAcknowledgeHandover(
  input: HandoverAckInput,
  deps: HandoverAckDeps,
): Promise<HandoverAckOutcome> {
  if (!input.isIncoming || input.isPrivate || input.senderType === 'agent_bot') {
    return 'not_customer_message';
  }
  // The legacy door decides silence from a boolean with no episode, so there is
  // nothing to make "once per episode" mean. Say nothing rather than guess.
  if (!input.ownershipAuthoritative) return 'not_authoritative';

  // HUMAN_OWNED only. HUMAN_REQUESTED is the state a failed surface leaves
  // behind, and HANDING_BACK is mid-reconciliation.
  if (input.ownershipState !== 'HUMAN_OWNED') return 'not_handed_over';

  const claimed = await deps.claimEpisode(input.conversationId, input.ownershipEpisode);
  if (claimed !== 1) return 'already_acked';

  const posted = await deps.postMessage(HANDOVER_ACK_TEXT);
  return posted ? 'sent' : 'post_failed';
}
