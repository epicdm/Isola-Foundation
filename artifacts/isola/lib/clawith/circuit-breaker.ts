/**
 * Per-tenant, per-agent circuit breaker for the structured Clawith path.
 *
 * Foundation never learns the underlying provider or model identity — not on
 * the wire contract (`ClawithRequest` in ./contract.ts has no model,
 * provider or credential field) and not in its own data model
 * (`ClawithBinding` in prisma/schema.prisma has no model or credential
 * column either). `designated_agent_id` (the Clawith agent id) is the
 * finest-grained identity Foundation actually controls.
 *
 * KNOWN LIMITATION (see ev-shared-model-failure-pr72-review-report-2026-08-04):
 * if Clawith configures two DIFFERENT agent ids to share the SAME underlying
 * provider credential, Foundation cannot detect that sharing — nothing
 * exposed to Foundation distinguishes it from two independent credentials —
 * so a failure on one will not open the breaker for the other. That is a
 * real gap, not an oversight: closing it needs Clawith to expose a stable,
 * non-secret model/credential identifier Foundation does not have today.
 * Keying on agent id is still correct for the ONE sharing case Foundation
 * *can* observe: two Foundation-side entry points that resolve to the same
 * Clawith agent id already send that identical id on the wire, so they
 * already trip the same breaker under this key. Widening the key to
 * something coarser (e.g. the Clawith company/org id) would "fix" the gap by
 * over-blocking instead — tripping the breaker for unrelated agents that
 * merely share an org, which fails the "a healthy fallback is not blocked by
 * the primary circuit" requirement far more often than it fails safe. Narrow
 * and occasionally under-inclusive beats coarse and routinely over-blocking.
 *
 * The key is namespaced by Foundation tenant id so breaker state can never
 * cross tenants — including in tests/fixtures, where the same agent-id
 * constant is deliberately reused across unrelated tenant fixtures.
 *
 * In-memory and module-scoped: short cooldown to stop pointless repeat
 * attempts within one process's uptime, not a durable state model. A restart
 * clears it, and that is fine — the worst case is one more real attempt
 * against a credential that was already failing.
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

const breakers = new Map<string, number>(); // circuitKey -> openUntil (epoch ms)

/** Builds the non-secret circuit key: Foundation tenant id + Clawith agent
 *  id. Never a credential, never a raw secret — safe to log. */
export function circuitKeyFor(tenantId: string, agentId: string): string {
  return `${tenantId}::${agentId}`;
}

/** True when a request for this circuit key should be refused before any
 *  network attempt is made. */
export function isCircuitOpen(circuitKey: string, now: number = Date.now()): boolean {
  const openUntil = breakers.get(circuitKey);
  return typeof openUntil === 'number' && openUntil > now;
}

/** Record the outcome of a Clawith call attempt for this circuit key. A
 *  success clears any open breaker immediately — a credential that just
 *  worked is no longer "known failing". A tripping-kind failure opens the
 *  breaker for `CIRCUIT_BREAKER_COOLDOWN_MS`. Any other failure kind is left
 *  alone: a timeout or a single rate limit does not mean the credential is
 *  dead. */
export function recordClawithOutcome(
  circuitKey: string,
  kind: ClawithFailureKind | 'success',
  now: number = Date.now(),
): void {
  if (kind === 'success') {
    breakers.delete(circuitKey);
    return;
  }
  if (TRIPPING_KINDS.has(kind)) {
    breakers.set(circuitKey, now + CIRCUIT_BREAKER_COOLDOWN_MS);
  }
}

/** Test-only escape hatch — production code never needs to force a breaker
 *  closed mid-cooldown. */
export function resetCircuitBreaker(circuitKey: string): void {
  breakers.delete(circuitKey);
}

/** Test-only: clears every breaker so test files can run in isolation
 *  against this module-scoped Map without leaking state across suites. */
export function resetAllCircuitBreakers(): void {
  breakers.clear();
}
