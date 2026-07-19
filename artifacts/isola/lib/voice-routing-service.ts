/**
 * lib/voice-routing-service.ts — the ONE central Foundation routing
 * mutation implementation for S5. Every API surface that reads or changes a
 * VoiceLine's routing mode (the new canonical routing routes AND the legacy
 * /api/voice/forward, /api/consumer/voice/forward compatibility adapters)
 * calls through here — no route composes Magnus writes directly.
 *
 * Chain: authorize → resolve VoiceLine ownership → read current Magnus
 * snapshot → validate/guard → governed connector write → verify after-state
 * → audit → normalized response.
 *
 * Schema-free: this file never persists a routing-mode value in Neon. The
 * two pre-existing VoiceLine columns it DOES write (voice_forward_to_cell,
 * voice_cell_number) already existed before S5 — they're kept in sync purely
 * so lib/voice-provisioning.ts's existing extension-first reconciliation
 * (Step 3b, out of scope for this PR) keeps reading a consistent legacy
 * boolean and doesn't revert an app_then_cell/cell route on a future
 * re-provisioning run. The true mode is always re-derived live from Magnus.
 */

import { prisma } from './prisma';
import { audit } from './audit';
import type { SessionCtx } from './session';
import type { ConsumerSessionAccount } from './consumer-session';
import { can } from './permissions';
import { voiceRoutingRead, voiceRoutingSet, VoiceRoutingConnectorError } from './voice-routing-connector';
import { validateForwardTarget, isVoiceRoutingMode, type VoiceRoutingMode, type VoiceRoutingReadMode } from './voice-routing';
import type { VoiceLine } from '@prisma/client';

export class VoiceRouteError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export type VoiceRouteSourceSurface =
  | 'operator.routing'
  | 'operator.forward_compat'
  | 'consumer.routing'
  | 'consumer.forward_compat';

export type VoiceRouteSource =
  | { kind: 'operator'; session: SessionCtx }
  | { kind: 'consumer'; session: ConsumerSessionAccount };

export interface VoiceRouteStateResult {
  mode: VoiceRoutingReadMode;
  forwardToCellNumber: string | null;
  reason?: string;
  did: string | null;
}

export interface SetVoiceRouteModeParams {
  mode: VoiceRoutingMode;
  /** Only consulted for app_then_cell/cell. When omitted, falls back to the
   *  VoiceLine's currently-stored voice_cell_number (mirrors the legacy
   *  /forward endpoints' existing fallback behavior). */
  forwardNumber?: string;
  sourceSurface: VoiceRouteSourceSurface;
  requestId?: string;
}

export interface VoiceRouteMutationResult {
  ok: boolean;
  mode?: VoiceRoutingReadMode;
  forwardToCellNumber?: string | null;
  error?: string;
}

// ── VoiceLine resolution (owner_kind-specific; never cross-account) ─────────

async function resolveVoiceLine(source: VoiceRouteSource): Promise<VoiceLine> {
  const voiceLine =
    source.kind === 'operator'
      ? await prisma.voiceLine.findFirst({
          where: { tenant_id: source.session.effectiveTenantId, owner_kind: 'business' },
        })
      : await prisma.voiceLine.findFirst({
          where: { identity_id: source.session.identityId, owner_kind: 'consumer' },
        });

  if (!voiceLine) {
    throw new VoiceRouteError(404, 'Voice line not found');
  }
  if (!voiceLine.magnus_diddestination_id || !voiceLine.magnus_did_id || !voiceLine.magnus_did_number || voiceLine.provisioning_state !== 'completed') {
    throw new VoiceRouteError(400, 'Voice line is not provisioned yet');
  }
  return voiceLine;
}

function tenantScopeFor(source: VoiceRouteSource, voiceLine: VoiceLine): { tenantId: string } | { consumerAccountId: string } {
  if (source.kind === 'operator') {
    return { tenantId: source.session.effectiveTenantId };
  }
  return { consumerAccountId: source.session.id };
}

function auditActorFor(source: VoiceRouteSource): string {
  return source.kind === 'operator' ? source.session.user.id : 'system';
}

// ── authorization (Section 5) ────────────────────────────────────────────────
//
// Operator: only an authorized tenant owner/administrator may change routing
// — global admin/owner sessions always pass via can()'s existing
// ctx.isAdmin||ctx.isOwner short-circuit (this is also what correctly
// authorizes an admin act-as session against Demo Diner, which has zero
// Membership rows on file; a Membership-scoped staff actor is correctly
// denied there today by the same default-deny path, not a bug to repair).
// Consumer: no extra can() check — the guard is ownership itself (VoiceLine
// resolution above is already scoped to session.identityId; a consumer can
// never reach another account's VoiceLine through this path at all).
async function authorizeWrite(source: VoiceRouteSource): Promise<void> {
  if (source.kind === 'consumer') return;
  const ctx = source.session;
  const allowed = await can(
    { identityId: ctx.identityId, tenantId: ctx.effectiveTenantId, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner },
    'voice.route_change',
  );
  if (!allowed) {
    throw new VoiceRouteError(403, 'Not authorized to change voice routing for this tenant');
  }
}

// ── read ──────────────────────────────────────────────────────────────────────

export async function getVoiceRouteState(source: VoiceRouteSource): Promise<VoiceRouteStateResult> {
  const voiceLine = await resolveVoiceLine(source);
  const tenant = tenantScopeFor(source, voiceLine);

  try {
    const state = await voiceRoutingRead(tenant, { didId: voiceLine.magnus_did_id!, did: voiceLine.magnus_did_number! });
    return { mode: state.mode, forwardToCellNumber: state.forwardToCellNumber, reason: state.reason, did: voiceLine.magnus_did_number };
  } catch (err) {
    const message = err instanceof VoiceRoutingConnectorError ? err.message : 'Failed to read voice routing state';
    throw new VoiceRouteError(502, message);
  }
}

// ── write (Section 3 + 6 + 7 + 8) ───────────────────────────────────────────

export async function setVoiceRouteMode(source: VoiceRouteSource, params: SetVoiceRouteModeParams): Promise<VoiceRouteMutationResult> {
  if (!isVoiceRoutingMode(params.mode)) {
    throw new VoiceRouteError(400, `Unsupported routing mode: ${String(params.mode)}`);
  }

  await authorizeWrite(source);
  const voiceLine = await resolveVoiceLine(source);
  const tenant = tenantScopeFor(source, voiceLine);
  const actorId = auditActorFor(source);
  const auditBase = { ...tenant, actorId, entity: 'voice_line', entityId: voiceLine.id, requestId: params.requestId };

  // Section 6: forward-target validation — rejection happens BEFORE any
  // Magnus mutation is attempted.
  let normalizedForward: string | undefined;
  if (params.mode !== 'app') {
    const candidate = params.forwardNumber !== undefined ? params.forwardNumber : voiceLine.voice_cell_number ?? undefined;
    if (!candidate) {
      throw new VoiceRouteError(400, 'A forward number is required for this mode');
    }
    const managedDids = (
      await prisma.voiceLine.findMany({ where: { magnus_did_number: { not: null } }, select: { magnus_did_number: true } })
    )
      .map((v) => v.magnus_did_number)
      .filter((d): d is string => !!d);

    const validation = validateForwardTarget({
      ownDid: voiceLine.magnus_did_number!,
      candidate,
      managedDids,
    });

    if (!validation.ok) {
      await audit({
        ...auditBase,
        action: 'voice.routing.set_rejected',
        meta: {
          ok: false,
          requested_mode: params.mode,
          source_surface: params.sourceSurface,
          error: validation.error,
        },
      });
      return { ok: false, error: validation.error };
    }
    normalizedForward = validation.normalized;
  }

  // Section 3/7: governed connector write + before/after verification.
  let setResult;
  try {
    setResult = await voiceRoutingSet(tenant, {
      didId: voiceLine.magnus_did_id!,
      did: voiceLine.magnus_did_number!,
      targetMode: params.mode,
      forwardNumber: normalizedForward,
    });
  } catch (err) {
    const message = err instanceof VoiceRoutingConnectorError ? err.message : 'Voice routing mutation failed';
    await audit({
      ...auditBase,
      action: 'voice.routing.set_failed',
      meta: { ok: false, requested_mode: params.mode, source_surface: params.sourceSurface, error: message },
    });
    return { ok: false, error: message };
  }

  if (!setResult.verified) {
    // Do NOT report success merely because Magnus returned HTTP 200 — the
    // after-state read didn't derive to the mode we asked for.
    await audit({
      ...auditBase,
      action: 'voice.routing.set_unverified',
      meta: {
        ok: false,
        requested_mode: params.mode,
        source_surface: params.sourceSurface,
        before_mode: setResult.before.mode,
        after_mode: setResult.after.mode,
        error: 'post-write state did not match the requested mode',
      },
    });
    return { ok: false, error: 'Voice routing change could not be verified — the line may be in its previous state' };
  }

  // Keep the pre-existing (schema-existing, non-S5) VoiceLine columns in
  // sync so lib/voice-provisioning.ts's Step 3b reconciliation — which reads
  // voice_forward_to_cell/voice_cell_number, not Magnus — doesn't see a
  // stale boolean and revert this write on a future re-provisioning pass.
  await prisma.voiceLine.update({
    where: { id: voiceLine.id },
    data: {
      voice_forward_to_cell: params.mode !== 'app',
      ...(normalizedForward !== undefined && { voice_cell_number: normalizedForward }),
    },
  });

  await audit({
    ...auditBase,
    action: 'voice.routing.set',
    meta: {
      ok: true,
      requested_mode: params.mode,
      source_surface: params.sourceSurface,
      before_mode: setResult.before.mode,
      after_mode: setResult.after.mode,
    },
  });

  return { ok: true, mode: setResult.after.mode, forwardToCellNumber: setResult.after.forwardToCellNumber };
}
