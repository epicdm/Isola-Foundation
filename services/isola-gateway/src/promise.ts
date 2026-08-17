/**
 * THE AGENT'S OWN PROMISE, READ BACK.
 *
 * Escalation used to fire on exactly two conditions — no usable text, and
 * runtime failure. BOTH ARE FAILURES. There was no path for "the AI decided a
 * human is needed", so an agent that told a customer *"I'll have a colleague
 * confirm that — what's your callback number?"*, took the number, and moved on
 * produced NOTHING: no note, no assignment, no notification. The customer was
 * promised a callback that nobody on the business side ever heard about.
 *
 * Measured 2026-08-17 on the owner's own transcript. Nothing errored. Nothing
 * looked broken. That is the point — A CONFIDENT PROMISE NOBODY IS TOLD ABOUT
 * IS WORSE THAN AN ERROR MESSAGE, because an error at least surfaces.
 *
 * WHY PHRASES AND NOT A TOKEN THE MODEL EMITS: this estate has already leaked
 * an internal control token (`[ask_owner: …]`) to a customer. A marker the model
 * must remember to hide will eventually be shown. We read what it already says
 * instead — the induction §6 tells it to state plainly that it is bringing in a
 * colleague, so the vocabulary is ours, not a new convention it must learn.
 *
 * WHY THE LIST IS TIGHT: a match does not merely notify — IT HANDS THE
 * CONVERSATION TO A HUMAN AND THE AI STOPS ANSWERING until handback. So a false
 * positive costs a customer their AI for ten minutes on a conversation where
 * nothing was wrong. An alert that only TELLS should over-fire; an alert that
 * also ACTS must not. Phrases that occur in ordinary answers are excluded:
 *
 *   REJECTED  "follow up"        — "I'll follow up on that" is conversational
 *   REJECTED  "get back to you"  — same
 *   REJECTED  "confirm ... for you" — said while the agent is still helping
 *   REJECTED  bare "colleague"/"team member" — occurs as plain fact,
 *             e.g. "a colleague handles installations"
 *
 * KEPT: phrases that essentially only occur when handing over.
 */

/**
 * Normalised so punctuation, casing and smart quotes cannot defeat a match.
 * Collapsing whitespace matters because a reply may wrap mid-phrase.
 */
export function normaliseForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The approved list. Each entry is matched against the NORMALISED reply.
 *
 * `have a colleague`/`have someone` are included in the "have" family because
 * the live transcript used *"have a colleague confirm"* — the exact sentence
 * this mechanism exists to catch.
 */
export const ESCALATION_PHRASES: readonly string[] = [
  // NARROWED 2026-08-17 (review). Bare "connect you" is ordinary ISP sales
  // copy — "this router can connect you to Wi-Fi", "this plan can connect you
  // to the internet" — and matching it would silence the AI for ten minutes on
  // a conversation where nothing was wrong. The handover sense always names a
  // person or is offered as an action.
  "connect you with",
  "connect you to a colleague",
  "connect you to someone",
  "connect you to a team member",
  "connect you to our team",
  "have someone",
  "have a colleague",
  "have a team member",
  "pass this to",
  "pass it to",
  "passing this to",
  "passing it to",
  "a colleague will",
  "a team member will",
  "a colleague can",
  "a team member can",
];

export interface PromiseVerdict {
  promised: boolean;
  /** The phrases that matched, for the log line. Never the customer's text. */
  matched: string[];
}

/**
 * Did this reply promise a human? Returns the matched phrases so the decision is
 * auditable from the log rather than re-derived by reading the reply.
 */
export function detectHumanPromise(replyText: string | null): PromiseVerdict {
  if (replyText === null) return { promised: false, matched: [] };
  const hay = normaliseForMatch(replyText);
  if (hay.length === 0) return { promised: false, matched: [] };
  const matched = ESCALATION_PHRASES.filter((p) => hay.includes(p));
  return { promised: matched.length > 0, matched };
}
