/**
 * Fail-closed orchestration for the gated inbox-46 AI loop.
 *
 * §6 of the packet, and the FAILURE clause of
 * `dec-foundation-clawith-structured-response-contract-2026-07-29`: on the
 * gated path a Clawith timeout, authentication failure, invalid structured
 * output or missing designated agent must NEVER produce a reply from an
 * unrelated native brain.
 *
 * That rule is not stylistic. Between 2026-07-25 00:34Z and this commit,
 * every inbound message on inbox 46 hit the bridge, was rejected 401, and was
 * answered by native Claude — which to the customer is indistinguishable from
 * a working EPIC agent, and to us was invisible. A brain outage must look
 * like an outage.
 *
 * Every failure resolves to exactly one of the three approved outcomes:
 *   • `safe_unavailable` — the approved unavailability line, plus exactly one
 *     human escalation. Used for runtime faults, where something really did
 *     go wrong with this customer's turn.
 *   • `suppressed`       — recorded failure, nothing said to the customer.
 *     Used for OUR configuration defects, where claiming trouble would be a
 *     fabrication about their message.
 *   • `escalate`         — Clawith itself asked for a human.
 * There is no fourth branch, and in particular no native one.
 */

import { callClawithStructured, type ClawithClientOptions } from './client';
import type { ClawithRequest, ClawithResponse } from './contract';
import { ClawithFailure, isClawithFailure, isConfigurationFailure, type ClawithFailureKind } from './errors';
import { buildClawithRequest, type BuildClawithRequestInput } from './request';

/** The one approved thing Foundation says when its brain is unreachable.
 *  It claims nothing about the customer's request, promises no timeline, and
 *  does not assert that a human has already been engaged — the escalation
 *  that accompanies it is what makes the second sentence true. */
export const SAFE_UNAVAILABILITY_REPLY =
  "I'm not able to answer that right now. I've flagged this conversation so a member of the EPIC team can pick it up.";

export type ClawithOutcome =
  | { kind: 'reply'; text: string; needsHandoff: boolean; response: ClawithResponse }
  | { kind: 'escalate'; text: string | null; needsHandoff: true; response: ClawithResponse }
  | { kind: 'safe_unavailable'; text: string; needsHandoff: true; failure: ClawithFailureRecord }
  | { kind: 'suppressed'; text: null; needsHandoff: false; failure: ClawithFailureRecord };

export interface ClawithFailureRecord {
  kind: ClawithFailureKind;
  detail: string | null;
  status: number | null;
  correlationId: string;
  conversationId: string;
  inboundMessageId: string;
}

export interface InvokeClawithInput extends BuildClawithRequestInput {
  clientOptions?: ClawithClientOptions;
}

function record(
  failure: ClawithFailure,
  ctx: { correlationId: string; conversationId: string; inboundMessageId: string },
): ClawithFailureRecord {
  return {
    kind: failure.kind,
    detail: failure.detail,
    status: failure.status,
    correlationId: ctx.correlationId,
    conversationId: ctx.conversationId,
    inboundMessageId: ctx.inboundMessageId,
  };
}

/** Turn any classified failure into an approved outcome. Never native. */
export function outcomeForFailure(
  failure: ClawithFailure,
  ctx: { correlationId: string; conversationId: string; inboundMessageId: string },
): ClawithOutcome {
  const rec = record(failure, ctx);
  if (isConfigurationFailure(failure.kind)) {
    return { kind: 'suppressed', text: null, needsHandoff: false, failure: rec };
  }
  return {
    kind: 'safe_unavailable',
    text: SAFE_UNAVAILABILITY_REPLY,
    needsHandoff: true,
    failure: rec,
  };
}

/** Decide what a VALID response means. Escalation wins over a reply: a turn
 *  that asks for a human is a handoff, not a chat message that happens to
 *  mention one. */
export function outcomeForResponse(
  response: ClawithResponse,
  ctx: { correlationId: string; conversationId: string; inboundMessageId: string },
): ClawithOutcome {
  if (response.escalation.requested) {
    return {
      kind: 'escalate',
      text: response.escalation.customer_handoff_message ?? response.customer_reply,
      needsHandoff: true,
      response,
    };
  }
  if (response.customer_reply !== null) {
    return { kind: 'reply', text: response.customer_reply, needsHandoff: false, response };
  }
  // Tool-only turn: nothing to say to the customer yet. Foundation executes
  // the authorised tools and re-invokes; it does not improvise a reply and it
  // certainly does not ask a different brain for one.
  return {
    kind: 'suppressed',
    text: null,
    needsHandoff: false,
    failure: {
      kind: 'invalid_response',
      detail: 'tool-only turn — no customer reply this turn',
      status: null,
      correlationId: ctx.correlationId,
      conversationId: ctx.conversationId,
      inboundMessageId: ctx.inboundMessageId,
    },
  };
}

/**
 * The gated entry point. Resolves — it never throws, and it never returns a
 * native reply.
 */
export async function invokeClawithGated(input: InvokeClawithInput): Promise<ClawithOutcome> {
  const ctx = {
    correlationId: input.correlationId,
    conversationId: input.conversationId,
    inboundMessageId: input.inboundMessageId,
  };

  // A designated agent is a precondition, not an input to validate: with no
  // Clawith identity there is no brain to ask, and asking a DIFFERENT brain is
  // precisely what this path exists to prevent.
  if (!input.designatedAgentId || input.designatedAgentId.trim() === '') {
    const failure = new ClawithFailure('agent_missing', 'no designated Clawith agent for this tenant/agent');
    console.error('[clawith] no designated agent — suppressing turn rather than answering from another brain');
    return outcomeForFailure(failure, ctx);
  }

  let request: ClawithRequest;
  try {
    request = buildClawithRequest(input);
  } catch (err) {
    const failure = isClawithFailure(err)
      ? err
      : new ClawithFailure('request_invalid', (err as Error | null)?.message ?? null);
    console.error(`[clawith] request rejected (${failure.kind}): ${failure.detail ?? ''}`);
    return outcomeForFailure(failure, ctx);
  }

  try {
    const { response, attempts, latencyMs } = await callClawithStructured(request, input.clientOptions);
    console.log(
      `[clawith] turn ok corr=${request.correlation_id} agent=${request.designated_agent_id} ` +
        `attempts=${attempts} latency=${latencyMs}ms tools=${response.tool_requests.length} ` +
        `escalate=${response.escalation.requested}`,
    );
    return outcomeForResponse(response, ctx);
  } catch (err) {
    const failure = isClawithFailure(err)
      ? err
      : new ClawithFailure('network_error', (err as Error | null)?.message ?? null);
    console.error(
      `[clawith] turn FAILED CLOSED corr=${request.correlation_id} kind=${failure.kind} ` +
        `status=${failure.status ?? '-'} — no native fallback on the gated path`,
    );
    return outcomeForFailure(failure, ctx);
  }
}
