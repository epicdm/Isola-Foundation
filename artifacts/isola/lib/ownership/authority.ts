/**
 * Where the ownership model is AUTHORITATIVE.
 *
 * §8 of the Commit 2 packet requires two things that pull in opposite
 * directions unless they are separated explicitly:
 *
 *   • Gate OFF — "current customer routing remains unchanged; ownership data
 *     may be safely recorded where appropriate."
 *   • Gate ON  — "ownership state is authoritative; silent fallback is
 *     impossible; HUMAN states suppress AI."
 *
 * They are reconciled by regime, not by weakening either rule:
 *
 *   AUTHORITATIVE regime (a gated door)
 *     The ownership STATE decides whether an automated reply may be sent.
 *     `Conversation.human_handling` is a derived projection with no say.
 *     `conversation_resolved` records an observation and changes nothing.
 *
 *   LEGACY regime (every other door — i.e. everything, today)
 *     The legacy boolean keeps deciding, byte-for-byte as it does in
 *     production. Ownership is recorded alongside, and resolution applies
 *     the legacy clear to BOTH stores so they never drift apart.
 *
 * There is exactly one predicate for this, in one file, so "is ownership
 * authoritative here" can never be answered two different ways in two
 * different call sites. It delegates to the Commit 1 gate rather than
 * introducing a second switch: one flag, one door list, one answer.
 */

import { isAiLoopGatedDoor } from '@/lib/clawith/gate';

/**
 * True only when BOTH the master switch is on AND this exact
 * `<chatwoot_account_id>:<inbox_id>` door is listed. Identical conditions to
 * the gated Clawith path — a door whose brain is not on the structured
 * contract has no business being governed by the ownership model either.
 */
export function ownershipIsAuthoritative(
  chatwootAccountId: string | number,
  inboxId: string | number | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isAiLoopGatedDoor(chatwootAccountId, inboxId, env);
}
