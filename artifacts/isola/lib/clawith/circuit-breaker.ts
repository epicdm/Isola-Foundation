/**
 * Per-credential circuit breaker for the structured Clawith path.
 *
 * Foundation never learns the underlying provider or model name directly —
 * `designated_agent_id` (the Clawith agent id) is the finest-grained key it
 * controls, and it is 1:1 with a specific bound model/credential. Tripping
 * the breaker on that key stops a known-bad credential from being hammered
 * on every subsequent turn while it recovers, without touching any other
 * agent's traffic.
 *
 * In-memory and module-scoped: this is a short cooldown to stop pointless
 * repeat attempts within one process's uptime, not a durable state model. A
 * restart clears it, and that is fine — the worst case is one more real
 * attempt against a credential that was already failing.
 */

import type { ClawithFailureKind } from './errors';

/** Failure kinds that indicate the credential/model itself is the problem
 *  (not a transient blip) and should open the breaker immediately. */
const TRIPPING_KINDS: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>([
  'payment_required',
  'provider_error_leaked',
]);

/** How long a tripped breaker stays open before the next attempt is allowed
 *  to test the credential again. */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

const breakers = new Map<string, number>(); // agentId -> openUntil (epoch ms)

/** True when a request for this agent should be refused before any network
 *  attempt is made. */
export function isCircuitOpen(agentId: string, now: number = Date.now()): boolean {
  const openUntil = breakers.get(agentId);
  return typeof openUntil === 'number' && openUntil > now;
}

/** Record the outcome of a Clawith call attempt for this agent. A success
 *  clears any open breaker immediately — a credential that just worked is
 *  no longer "known failing". A tripping-kind failure opens the breaker for
 *  `CIRCUIT_BREAKER_COOLDOWN_MS`. Any other failure kind is left alone: a
 *  timeout or a single rate limit does not mean the credential is dead. */
export function recordClawithOutcome(
  agentId: string,
  kind: ClawithFailureKind | 'success',
  now: number = Date.now(),
): void {
  if (kind === 'success') {
    breakers.delete(agentId);
    return;
  }
  if (TRIPPING_KINDS.has(kind)) {
    breakers.set(agentId, now + CIRCUIT_BREAKER_COOLDOWN_MS);
  }
}

/** Test-only escape hatch — production code never needs to force a breaker
 *  closed mid-cooldown. */
export function resetCircuitBreaker(agentId: string): void {
  breakers.delete(agentId);
}

/** Test-only: clears every breaker so test files can run in isolation
 *  against this module-scoped Map without leaking state across suites. */
export function resetAllCircuitBreakers(): void {
  breakers.clear();
}
