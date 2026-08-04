/**
 * At-most-one approved fallback attempt for a failed structured Clawith
 * call. Shared by both staff chat and customer dispatch so "try one
 * approved fallback, then give up" is one implementation, not two.
 *
 * Foundation's wire contract has no notion of "model" — model/provider
 * selection lives entirely inside Clawith, addressed only by
 * `designated_agent_id`. A fallback is therefore: a SECOND, pre-existing
 * Clawith agent, explicitly paired with the primary in
 * `CLAWITH_APPROVED_FALLBACK_AGENTS`, that Foundation independently
 * verifies is bound to the SAME Foundation tenant before ever using it —
 * the env var alone is never trusted for tenant identity, only for which
 * pairing to check.
 *
 * Everything else about the request — tenant, business, contact,
 * conversation, exposure, allowed-tools envelope, correlation id — is
 * preserved by construction: the fallback attempt reuses the exact same
 * `ClawithRequest` object with only `designated_agent_id` swapped, so there
 * is no second place any of those fields could drift.
 */

import { prisma } from '../prisma';
import type { ClawithRequest } from './contract';
import { callClawithStructured, type ClawithCallResult, type ClawithClientOptions } from './client';
import { ClawithFailure, classifyThrown, isClawithFailure, isConfigurationFailure } from './errors';

export const CLAWITH_APPROVED_FALLBACK_AGENTS_ENV = 'CLAWITH_APPROVED_FALLBACK_AGENTS';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `primaryAgentId:fallbackAgentId` pairs, comma-separated. Malformed
 *  entries (not both UUIDs, or a self-pairing) are dropped rather than
 *  thrown on — one bad entry must not widen fallback to an agent that was
 *  never actually approved. */
function parseFallbackMap(env: NodeJS.ProcessEnv): ReadonlyMap<string, string> {
  const raw = env[CLAWITH_APPROVED_FALLBACK_AGENTS_ENV];
  const map = new Map<string, string>();
  if (typeof raw !== 'string' || raw.trim() === '') return map;
  for (const pair of raw.split(',')) {
    const [primary, fallback] = pair.split(':').map((s) => s.trim());
    if (primary && fallback && UUID_RE.test(primary) && UUID_RE.test(fallback) && primary !== fallback) {
      map.set(primary, fallback);
    }
  }
  return map;
}

export interface ResolveApprovedFallbackInput {
  /** Foundation tenant id — NOT the Clawith tenant namespace. */
  tenantId: string;
  primaryClawithAgentId: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves an approved fallback Clawith agent id for this Foundation
 * tenant, or `null` when none is configured, or when the configured
 * candidate is not actually bound to THIS tenant. A candidate named in the
 * env var but belonging to a different tenant's `ClawithBinding` (or no
 * binding at all) is refused, not silently accepted — this is what makes
 * "cross-tenant fallback" a real, DB-verified refusal rather than a promise
 * about the env var's own correctness.
 */
export async function resolveApprovedFallback(input: ResolveApprovedFallbackInput): Promise<string | null> {
  const env = input.env ?? process.env;
  const candidate = parseFallbackMap(env).get(input.primaryClawithAgentId);
  if (!candidate) return null;

  const binding = await prisma.clawithBinding.findFirst({
    where: { tenant_id: input.tenantId, clawith_agent_id: candidate },
    select: { clawith_agent_id: true },
  });
  return binding?.clawith_agent_id ?? null;
}

export interface CallClawithWithFallbackInput {
  request: ClawithRequest;
  /** Foundation tenant id — used only to verify a fallback candidate's
   *  ClawithBinding; never sent on the wire. */
  tenantId: string;
  clientOptions?: ClawithClientOptions;
  env?: NodeJS.ProcessEnv;
}

export interface CallClawithWithFallbackResult extends ClawithCallResult {
  usedFallback: boolean;
  /** Set only when a fallback was attempted — the primary's own failure,
   *  preserved for the caller's diagnostics/alert even though the fallback
   *  attempt's outcome is what's ultimately returned or thrown. */
  primaryFailure: ClawithFailure | null;
}

/**
 * Calls the primary agent. On any non-configuration failure, resolves an
 * approved, tenant-verified fallback and — if one exists — makes exactly
 * one further attempt against it. Configuration failures
 * (secret_missing/agent_missing/request_invalid/tenant_mismatch) never
 * attempt a fallback: a different Clawith agent cannot fix a request
 * Foundation itself refused to build or send. When no approved fallback
 * exists, the primary's failure is rethrown immediately — never a silent
 * retry, never a guess at another agent.
 */
export async function callClawithWithFallback(
  input: CallClawithWithFallbackInput,
): Promise<CallClawithWithFallbackResult> {
  const { request, tenantId, clientOptions, env } = input;

  try {
    const result = await callClawithStructured(request, clientOptions);
    return { ...result, usedFallback: false, primaryFailure: null };
  } catch (err) {
    const primaryFailure = isClawithFailure(err)
      ? err
      : new ClawithFailure(classifyThrown(err), (err as Error | null)?.message ?? null);

    if (isConfigurationFailure(primaryFailure.kind)) throw primaryFailure;

    const fallbackAgentId = await resolveApprovedFallback({
      tenantId,
      primaryClawithAgentId: request.designated_agent_id,
      env,
    });
    if (!fallbackAgentId) throw primaryFailure;

    // Same request, same tenant/business/contact/conversation/exposure/
    // allowed-tools/correlation identity — only the designated agent
    // (credential/model) changes.
    const fallbackRequest: ClawithRequest = { ...request, designated_agent_id: fallbackAgentId };
    try {
      const result = await callClawithStructured(fallbackRequest, clientOptions);
      return { ...result, usedFallback: true, primaryFailure };
    } catch (fallbackErr) {
      throw isClawithFailure(fallbackErr)
        ? fallbackErr
        : new ClawithFailure(classifyThrown(fallbackErr), (fallbackErr as Error | null)?.message ?? null);
    }
  }
}
