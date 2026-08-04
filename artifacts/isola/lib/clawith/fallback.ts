/**
 * Single call to the structured Clawith path. Automatic fallback to a
 * DIFFERENT Clawith agent is DISABLED — see
 * ev-shared-model-failure-pr72-review-report-2026-08-04.
 *
 * The prior version of this module treated "approved fallback" as retrying
 * with `designated_agent_id` swapped to a second, pre-configured Clawith
 * agent pinned to the same Foundation tenant. That is not a same-agent
 * model/credential retry — it is a different Clawith agent, and each
 * Clawith agent owns its own prompt, tools and model (see
 * dec-clawith-single-org-foundation-owns-agent-exposure-2026-07-31:
 * "Clawith owns reasoning, memory, skills, agent behaviour"). Swapping
 * `designated_agent_id` can silently change persona, tools and PUBLIC/
 * INTERNAL exposure — the exact failure mode this must never produce (e.g.
 * Atlas work answered by EMA).
 *
 * Foundation has no way to do better today: `ClawithRequest` (./contract.ts)
 * carries no model/provider/credential field at all, and neither does
 * `ClawithBinding` in prisma/schema.prisma — provider/model selection is
 * entirely Clawith-side configuration Foundation cannot see or override per
 * request. There is therefore no existing, supported contract through which
 * Foundation could ask the SAME logical agent to retry on a different
 * approved model, and building one by using a second agent id would be
 * emulating same-agent fallback with a duplicate agent, which is exactly
 * what is not acceptable.
 *
 * Until Clawith exposes a real same-agent model/credential override that
 * Foundation can address on the wire, a primary failure is rethrown
 * immediately and the caller (invoke.ts / staff-agent-chat.ts) returns the
 * sanitized degraded response. `usedFallback`/`primaryFailure` stay in the
 * result shape, always `false`/`null`, so those two callers do not need to
 * change when a real mechanism lands.
 */

import type { ClawithRequest } from './contract';
import { callClawithStructured, type ClawithCallResult, type ClawithClientOptions } from './client';
import { ClawithFailure, classifyThrown, isClawithFailure } from './errors';

export interface CallClawithWithFallbackInput {
  request: ClawithRequest;
  /** Unused while fallback is disabled — kept so call sites do not need to
   *  change when a real same-agent mechanism lands. */
  tenantId: string;
  clientOptions?: ClawithClientOptions;
  env?: NodeJS.ProcessEnv;
}

export interface CallClawithWithFallbackResult extends ClawithCallResult {
  usedFallback: false;
  primaryFailure: null;
}

/**
 * Calls the primary agent exactly once. Any failure is rethrown immediately
 * — no second agent is ever attempted.
 */
export async function callClawithWithFallback(
  input: CallClawithWithFallbackInput,
): Promise<CallClawithWithFallbackResult> {
  try {
    const result = await callClawithStructured(input.request, input.clientOptions);
    return { ...result, usedFallback: false, primaryFailure: null };
  } catch (err) {
    throw isClawithFailure(err)
      ? err
      : new ClawithFailure(classifyThrown(err), (err as Error | null)?.message ?? null);
  }
}
