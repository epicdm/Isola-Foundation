/**
 * lib/voice-routing-connector.ts — narrow governed adapter for S5 voice
 * routing. Two allow-listed ops only: `voice.routing.read` / `voice.routing.set`.
 *
 * This is deliberately NOT wired through lib/connector.ts's `callEngine()`:
 * that module's own header explicitly excludes `lib/magnus-voice.ts` from its
 * ALLOW_LIST ("an allow-list entry per Magnus module/Odoo model would need to
 * be as wide as those primitives themselves... future work, not this floor's
 * scope"). Extending it here would mean allow-listing the DID/SIP/
 * diddestination primitives generally, which is exactly what that module
 * chose not to do. This file is the "equivalent narrow adapter consistent
 * with Foundation connector conventions" instead: tenant scoped (reuses
 * lib/connector.ts's own TenantScope dual-FK shape), allow-listed to just
 * these two routing actions, Magnus errors normalized into
 * VoiceRoutingConnectorError, bounded timeout (inherited from
 * engines/magnus.ts's magnusRequest, which already carries a 15s
 * AbortSignal.timeout), fail-closed (any read/write error rejects — never
 * silently reports a healthy-looking mode), structured before/after state,
 * and no secret leakage (VoiceRoutingState never carries sip.secret).
 *
 * Authorization and forward-target validation are NOT this file's job — see
 * lib/voice-routing-service.ts, the central orchestrator that calls into
 * this adapter only after both have already passed.
 */

import { getMagnusConfig, getVoiceRoutingRingTimeoutSeconds } from './engines';
import type { TenantScope } from './connector';
import {
  deriveVoiceRoutingMode,
  readVoiceRoutingSnapshot,
  planRouteMutation,
  applyRouteMutation,
  planRestoreMutation,
  applyRestoreMutation,
  type VoiceRoutingMode,
  type VoiceRoutingState,
} from './voice-routing';

export class VoiceRoutingConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceRoutingConnectorError';
  }
}

function assertTenantScope(tenant: TenantScope): void {
  const hasTenantId = !!tenant.tenantId;
  const hasConsumerAccountId = !!tenant.consumerAccountId;
  if (hasTenantId === hasConsumerAccountId) {
    throw new VoiceRoutingConnectorError(
      'voice-routing-connector requires exactly one of tenant.tenantId or tenant.consumerAccountId',
    );
  }
}

/**
 * `voice.routing.read` — fetch the current normalized routing state for a
 * single DID. Fail-closed: any Magnus/network error rejects rather than
 * returning a guessed mode.
 */
export async function voiceRoutingRead(
  tenant: TenantScope,
  params: { didId: string; did: string },
): Promise<VoiceRoutingState> {
  assertTenantScope(tenant);
  try {
    const config = getMagnusConfig();
    const snapshot = await readVoiceRoutingSnapshot(config, params.didId, params.did);
    return deriveVoiceRoutingMode(snapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown Magnus error';
    throw new VoiceRoutingConnectorError(`voice.routing.read failed: ${message}`);
  }
}

/** Distinct outcomes voiceRoutingSet can report. `success` is the only
 *  outcome where the requested change actually took effect — every other
 *  outcome is a failed route-change request, even `mutation_failed_rolled_back`
 *  / `unverified_rolled_back` where the line is confirmed restored. */
export type VoiceRoutingSetOutcome =
  | 'success'
  | 'mutation_failed_rolled_back'
  | 'unverified_rolled_back'
  | 'critical_degraded';

export interface VoiceRoutingSetResult {
  outcome: VoiceRoutingSetOutcome;
  before: VoiceRoutingState;
  /** Best-known after-state: the post-rollback-attempt read when a rollback
   *  was attempted, otherwise the original post-mutation read. */
  after: VoiceRoutingState;
  /** True only for outcome==='success' — the post-write derived mode
   *  actually matched `targetMode`. A caller must treat verified=false as a
   *  failed operation even though the Magnus writes themselves returned
   *  without error — see lib/voice-routing-service.ts (before/after
   *  verification). */
  verified: boolean;
  rollbackAttempted: boolean;
  /** null when no rollback was attempted (outcome==='success'). */
  rollbackVerified: boolean | null;
}

/**
 * `voice.routing.set` — apply an already-authorized, already-validated
 * routing-mode change and report structured before/after state.
 *
 * Deliberately does NOT perform authorization, ownership resolution, or
 * forward-target validation (self-forward/protected/managed-DID guards) —
 * those all run in lib/voice-routing-service.ts BEFORE this is ever called,
 * per "rejection must happen before any Magnus mutation" (Section 6). This
 * adapter's only contract is: given a target mode and (when required) an
 * already-validated forward number, make the minimal Magnus write, verify it
 * took effect, and — if it didn't, or if the write itself threw — attempt
 * exactly ONE bounded compensating rollback to the captured before-state
 * before reporting a result. Never retries the requested mutation, never
 * recurses through setVoiceRouteMode/voiceRoutingSet, never retries the
 * rollback itself.
 *
 * Flow: read before → plan (fails closed before any write if the plan can't
 * be safely computed, e.g. a conflicting-rows DID or no safe ring timeout) →
 * attempt the write → attempt an after-read → verify. On mutation-throw,
 * after-read-failure, or after-state-mismatch: build a restore plan from the
 * captured before-snapshot, attempt exactly one restore write, attempt one
 * verification read, and report one of mutation_failed_rolled_back /
 * unverified_rolled_back / critical_degraded (rollback couldn't be verified —
 * worst case, needs operator attention) — never a false success.
 */
export async function voiceRoutingSet(
  tenant: TenantScope,
  params: { didId: string; did: string; targetMode: VoiceRoutingMode; forwardNumber?: string },
): Promise<VoiceRoutingSetResult> {
  assertTenantScope(tenant);
  const config = getMagnusConfig();

  let before: VoiceRoutingState;
  try {
    const beforeSnapshot = await readVoiceRoutingSnapshot(config, params.didId, params.did);
    before = deriveVoiceRoutingMode(beforeSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown Magnus error';
    throw new VoiceRoutingConnectorError(`voice.routing.set: before-state read failed: ${message}`);
  }

  let plan;
  try {
    plan = planRouteMutation(params.targetMode, before.snapshot, params.forwardNumber, getVoiceRoutingRingTimeoutSeconds());
  } catch (err) {
    // Nothing was ever attempted against Magnus — no rollback is needed.
    const message = err instanceof Error ? err.message : 'unknown planning error';
    throw new VoiceRoutingConnectorError(`voice.routing.set: refusing to mutate — ${message}`);
  }

  let mutationThrew = false;
  try {
    await applyRouteMutation(config, before.snapshot, plan);
  } catch {
    // An HTTP-level failure here does not tell us whether the write actually
    // landed server-side before the error — treat the state as potentially
    // changed and fall through to the rollback path below rather than
    // assuming nothing happened.
    mutationThrew = true;
  }

  let after: VoiceRoutingState | null = null;
  try {
    const afterSnapshot = await readVoiceRoutingSnapshot(config, params.didId, params.did);
    after = deriveVoiceRoutingMode(afterSnapshot);
  } catch {
    after = null;
  }

  const verified = !mutationThrew && after !== null && after.mode === params.targetMode;

  if (verified) {
    return { outcome: 'success', before, after: after!, verified: true, rollbackAttempted: false, rollbackVerified: null };
  }

  // One bounded compensating rollback attempt to the captured before-state.
  // Never recurse through voiceRoutingSet/setVoiceRouteMode, never repeat the
  // requested mutation, never retry beyond this single attempt.
  const restorePlan = planRestoreMutation(before.snapshot);

  let rollbackWriteThrew = false;
  try {
    await applyRestoreMutation(config, before.snapshot, restorePlan);
  } catch {
    rollbackWriteThrew = true;
  }

  let rollbackAfter: VoiceRoutingState | null = null;
  try {
    const rollbackSnapshot = await readVoiceRoutingSnapshot(config, params.didId, params.did);
    rollbackAfter = deriveVoiceRoutingMode(rollbackSnapshot);
  } catch {
    rollbackAfter = null;
  }

  const rollbackVerified = !rollbackWriteThrew && rollbackAfter !== null && rollbackAfter.mode === before.mode;
  const finalAfter = rollbackAfter ?? after ?? before;

  if (!rollbackVerified) {
    return { outcome: 'critical_degraded', before, after: finalAfter, verified: false, rollbackAttempted: true, rollbackVerified: false };
  }

  return {
    outcome: mutationThrew ? 'mutation_failed_rolled_back' : 'unverified_rolled_back',
    before,
    after: finalAfter,
    verified: false,
    rollbackAttempted: true,
    rollbackVerified: true,
  };
}
