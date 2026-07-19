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

import { getMagnusConfig } from './engines';
import type { TenantScope } from './connector';
import {
  deriveVoiceRoutingMode,
  readVoiceRoutingSnapshot,
  planRouteMutation,
  applyRouteMutation,
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

export interface VoiceRoutingSetResult {
  before: VoiceRoutingState;
  after: VoiceRoutingState;
  /** True only when the post-write derived mode actually matches
   *  `targetMode`. A caller must treat verified=false as a failed operation
   *  even though the Magnus writes themselves returned without error — see
   *  lib/voice-routing-service.ts Section 7 (before/after verification). */
  verified: boolean;
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
 * already-validated forward number, make the minimal Magnus write and verify
 * it took effect.
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

  const plan = planRouteMutation(params.targetMode, before.snapshot, params.forwardNumber);

  try {
    await applyRouteMutation(config, before.snapshot, plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown Magnus error';
    throw new VoiceRoutingConnectorError(`voice.routing.set: Magnus mutation failed: ${message}`);
  }

  let after: VoiceRoutingState;
  try {
    const afterSnapshot = await readVoiceRoutingSnapshot(config, params.didId, params.did);
    after = deriveVoiceRoutingMode(afterSnapshot);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown Magnus error';
    throw new VoiceRoutingConnectorError(`voice.routing.set: after-state read failed: ${message}`);
  }

  return { before, after, verified: after.mode === params.targetMode };
}
