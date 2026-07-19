import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VoiceLine, User, Tenant, ConsumerAccount } from '@prisma/client';
import type { SessionCtx } from './session';
import type { ConsumerSessionAccount } from './consumer-session';

const { prismaMock, auditMock, voiceRoutingReadMock, voiceRoutingSetMock } = vi.hoisted(() => ({
  prismaMock: {
    voiceLine: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    membership: {
      findUnique: vi.fn(),
    },
    approvalRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
  auditMock: vi.fn(),
  voiceRoutingReadMock: vi.fn(),
  voiceRoutingSetMock: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./audit', () => ({ audit: auditMock }));
vi.mock('./voice-routing-connector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-routing-connector')>();
  return { ...actual, voiceRoutingRead: voiceRoutingReadMock, voiceRoutingSet: voiceRoutingSetMock };
});

import { setVoiceRouteMode, getVoiceRouteState } from './voice-routing-service';
import { VoiceRoutingConnectorError } from './voice-routing-connector';

const OWN_DID = '17678185000';

function operatorVoiceLine(overrides: Partial<VoiceLine> = {}): VoiceLine {
  return {
    id: 'vl-1',
    owner_kind: 'business',
    tenant_id: 'tenant-1',
    identity_id: null,
    magnus_user_id: 'mu-1',
    magnus_sip_id: 'sip-1',
    magnus_sip_username: 'sipuser',
    magnus_sip_password: 'secret',
    magnus_callerid_id: 'cid-1',
    magnus_did_id: 'did-1',
    magnus_did_number: OWN_DID,
    magnus_diddestination_id: 'dd-1',
    voice_forward_to_cell: false,
    voice_cell_number: null,
    provisioning_state: 'completed',
    provisioning_error: null,
    ...overrides,
  } as VoiceLine;
}

function operatorSession(overrides: Partial<SessionCtx> = {}): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-1' } as User & { tenant: Tenant },
    effectiveTenantId: 'tenant-1',
    effectiveTenant: {} as Tenant,
    isAdmin: false,
    isOwner: false,
    identityId: 'identity-1',
    ...overrides,
  };
}

function consumerSession(overrides: Partial<ConsumerSessionAccount> = {}): ConsumerSessionAccount {
  return {
    id: 'acct-1',
    identityId: 'identity-c1',
    ...overrides,
  } as ConsumerSessionAccount;
}

function routeState(mode: string, forwardToCellNumber: string | null = null) {
  return { mode, forwardToCellNumber, snapshot: {} as any } as any;
}

function setSuccess(before: string, after: string, forwardToCellNumber: string | null = null) {
  return {
    outcome: 'success',
    before: routeState(before),
    after: routeState(after, forwardToCellNumber),
    verified: true,
    rollbackAttempted: false,
    rollbackVerified: null,
  };
}

function setRolledBack(
  outcome: 'mutation_failed_rolled_back' | 'unverified_rolled_back',
  before: string,
  after: string,
) {
  return {
    outcome,
    before: routeState(before),
    after: routeState(after),
    verified: false,
    rollbackAttempted: true,
    rollbackVerified: true,
  };
}

function setCriticalDegraded(before: string, after: string) {
  return {
    outcome: 'critical_degraded' as const,
    before: routeState(before),
    after: routeState(after),
    verified: false,
    rollbackAttempted: true,
    rollbackVerified: false,
  };
}

const APPROVAL_TOKEN = 'test-approval-token';

/** Seeds prismaMock.approvalRequest so a redeem call with APPROVAL_TOKEN
 *  succeeds — mirrors an already-approved, unexpired, params-matching row. */
function seedApprovedApproval(overrides: {
  tenantId?: string;
  targetId?: string;
  did?: string;
  mode?: string;
  forwardNumber?: string | null;
  expiresAt?: Date;
  status?: string;
} = {}) {
  prismaMock.approvalRequest.findUnique.mockResolvedValue({
    tenant_id: overrides.tenantId ?? 'tenant-1',
    action: 'voice.route.set',
    target_id: overrides.targetId ?? 'vl-1',
    status: overrides.status ?? 'approved',
    expires_at: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    payload: { did: overrides.did ?? OWN_DID, mode: overrides.mode, forwardNumber: overrides.forwardNumber ?? null },
  });
  prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Section 10: authorization ───────────────────────────────────────────────

describe('setVoiceRouteMode — authorization', () => {
  it('global owner session is allowed to change routing', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));
    seedApprovedApproval({ mode: 'app', forwardNumber: null });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(true);
  });

  it('global admin session is allowed to change routing', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));
    seedApprovedApproval({ mode: 'app', forwardNumber: null });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isAdmin: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(true);
  });

  it('a staff Membership role is denied (voice.route_change defaults to admin minimum)', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(operatorVoiceLine());
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'staff' });

    await expect(
      setVoiceRouteMode({ kind: 'operator', session: operatorSession() }, { mode: 'app', sourceSurface: 'operator.routing' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('an admin Membership role is allowed (meets the admin minimum)', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    prismaMock.membership.findUnique.mockResolvedValue({ role: 'admin' });
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));
    seedApprovedApproval({ mode: 'app', forwardNumber: null });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession() },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );
    expect(result.ok).toBe(true);
  });

  it('cross-tenant caller (no Membership row for this tenant) is denied', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(operatorVoiceLine());
    prismaMock.membership.findUnique.mockResolvedValue(null);

    await expect(
      setVoiceRouteMode({ kind: 'operator', session: operatorSession() }, { mode: 'app', sourceSurface: 'operator.routing' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('an unauthenticated-edge-case session (no identityId, no admin/owner) is denied', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(operatorVoiceLine());

    await expect(
      setVoiceRouteMode(
        { kind: 'operator', session: operatorSession({ identityId: null }) },
        { mode: 'app', sourceSurface: 'operator.routing' },
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(prismaMock.membership.findUnique).not.toHaveBeenCalled();
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('a consumer changing their own resolved voice line is allowed with no extra can() check', async () => {
    const voiceLine = operatorVoiceLine({ owner_kind: 'consumer', tenant_id: null, identity_id: 'identity-c1' });
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));

    const result = await setVoiceRouteMode(
      { kind: 'consumer', session: consumerSession() },
      { mode: 'app', sourceSurface: 'consumer.routing' },
    );

    expect(result.ok).toBe(true);
    expect(prismaMock.membership.findUnique).not.toHaveBeenCalled();
  });

  it('a consumer with no resolvable voice line under their own identity is denied (404, not a leaked cross-account line)', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(null);

    await expect(
      setVoiceRouteMode({ kind: 'consumer', session: consumerSession() }, { mode: 'app', sourceSurface: 'consumer.routing' }),
    ).rejects.toMatchObject({ status: 404 });
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });
});

// ── Section 10: before/after verification ───────────────────────────────────

describe('setVoiceRouteMode — before/after verification', () => {
  it('reports success only after the connector confirms the after-state matches the requested mode', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.findMany.mockResolvedValue([{ magnus_did_number: OWN_DID }]);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app_then_cell', '9715551234'));
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result).toEqual({ ok: true, mode: 'app_then_cell', forwardToCellNumber: '9715551234', outcome: 'success' });
    expect(prismaMock.voiceLine.update).toHaveBeenCalledWith({
      where: { id: 'vl-1' },
      data: { voice_forward_to_cell: true, voice_cell_number: '9715551234' },
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.routing.set', meta: expect.objectContaining({ ok: true }) }));
  });

  it('does NOT report success merely because Magnus returned 200 — after-state mismatch triggers a verified rollback and fails the request', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setRolledBack('unverified_rolled_back', 'app', 'app'));
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'voice.routing.set_unverified_rolled_back',
        meta: expect.objectContaining({ ok: false, before_mode: 'app', after_mode: 'app', rollback_verified: true }),
      }),
    );
  });

  it('when the write itself throws (not merely unverified), the rollback is reported as set_failed_rolled_back', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setRolledBack('mutation_failed_rolled_back', 'app', 'app'));
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'voice.routing.set_failed_rolled_back',
        meta: expect.objectContaining({ ok: false, before_mode: 'app', after_mode: 'app', rollback_verified: true }),
      }),
    );
  });

  it('critical_degraded (rollback itself could not be verified) returns a safe-identifiers-only critical payload and never a false success', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setCriticalDegraded('app', 'degraded'));
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(false);
    expect(result.critical).toEqual({
      tenantId: 'tenant-1',
      voiceLineId: 'vl-1',
      did: OWN_DID,
      requestedMode: 'app_then_cell',
      beforeMode: 'app',
      observedAfterMode: 'degraded',
      rollbackAttempted: true,
      rollbackVerified: false,
      operatorActionRequired: true,
    });
    // Safe-identifiers-only: no secret/raw-Magnus-payload keys anywhere on the critical object.
    expect(Object.keys(result.critical!).sort()).toEqual(
      [
        'tenantId',
        'voiceLineId',
        'did',
        'requestedMode',
        'beforeMode',
        'observedAfterMode',
        'rollbackAttempted',
        'rollbackVerified',
        'operatorActionRequired',
      ].sort(),
    );
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'voice.routing.critical_degraded',
        meta: expect.objectContaining({
          ok: false,
          before_mode: 'app',
          after_mode: 'degraded',
          rollback_attempted: true,
          rollback_verified: false,
        }),
      }),
    );
  });

  it('critical_degraded for a consumer-owned line scopes the critical payload to consumerAccountId, never tenantId', async () => {
    const voiceLine = operatorVoiceLine({ owner_kind: 'consumer', tenant_id: null, identity_id: 'identity-c1' });
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setCriticalDegraded('app', 'unknown'));

    const result = await setVoiceRouteMode(
      { kind: 'consumer', session: consumerSession() },
      { mode: 'app_then_cell', forwardNumber: '9715551234', sourceSurface: 'consumer.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.critical).toMatchObject({ consumerAccountId: 'acct-1' });
    expect(result.critical?.tenantId).toBeUndefined();
  });

  it('a connector/Magnus write failure that never even attempted a mutation (before-read or planning failed) never produces a false success', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockRejectedValue(new VoiceRoutingConnectorError('voice.routing.set: Magnus mutation failed: timeout'));
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.routing.set_failed' }));
  });

  it('a rejected guard (e.g. self-forward) never reaches the connector — no Magnus mutation is attempted', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.findMany.mockResolvedValue([{ magnus_did_number: OWN_DID }]);
    seedApprovedApproval({ mode: 'cell', forwardNumber: OWN_DID });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'cell', forwardNumber: OWN_DID, approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.routing.set_rejected' }));
  });

  it('a read failure on the state-read path surfaces a normalized error and never a guessed mode', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(operatorVoiceLine());
    voiceRoutingReadMock.mockRejectedValue(new VoiceRoutingConnectorError('voice.routing.read failed: timeout'));

    await expect(getVoiceRouteState({ kind: 'operator', session: operatorSession({ isOwner: true }) })).rejects.toMatchObject({
      status: 502,
    });
  });
});

// ── S6: approval gate (mint → approve → redeem) ─────────────────────────────

describe('setVoiceRouteMode — S6 approval gate', () => {
  it('mint: no token ⇒ returns approval_required, mints a pending ApprovalRequest, and attempts no Magnus write', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.approvalRequest.create.mockResolvedValue({ id: 'appr-1', expires_at: new Date('2026-07-19T12:15:00.000Z') });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', sourceSurface: 'operator.routing' },
    );

    expect(result).toMatchObject({ ok: false, outcome: 'approval_required', approvalRequestId: 'appr-1' });
    expect(result.approvalExpiresAt).toBe('2026-07-19T12:15:00.000Z');
    expect(prismaMock.approvalRequest.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenant_id: 'tenant-1',
          action: 'voice.route.set',
          target_entity: 'voice_line',
          target_id: 'vl-1',
          payload: { did: OWN_DID, mode: 'app', forwardNumber: null },
          status: 'pending',
          requested_by: 'user-1',
        }),
      }),
    );
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.route.approval_requested' }));
  });

  it('redeem: a valid approved, params-matching token proceeds and consumes the token', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));
    seedApprovedApproval({ mode: 'app', forwardNumber: null });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(true);
    expect(prismaMock.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { token: APPROVAL_TOKEN, status: 'approved', expires_at: { gt: expect.any(Date) } },
      data: { status: 'consumed', consumed_at: expect.any(Date) },
    });
  });

  it('redeem: reusing an already-consumed token is rejected (single-use)', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, status: 'consumed' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it('redeem: an expired token is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, expiresAt: new Date(Date.now() - 1000) });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('redeem: a still-pending (never approved) token is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, status: 'pending' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('redeem: a token approved for a different tenant is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, tenantId: 'tenant-OTHER' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('redeem: a token approved for a different voice line is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, targetId: 'vl-OTHER' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('redeem: a token approved for a different mode is rejected and NOT consumed', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'cell', forwardNumber: '9715551234' }); // approved for 'cell', requesting 'app'

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it('redeem: a token approved for a different forwardNumber is rejected and NOT consumed', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app_then_cell', forwardNumber: '9715551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715559999', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
    expect(prismaMock.approvalRequest.updateMany).not.toHaveBeenCalled();
  });

  it('redeem: a token approved for a different DID (different voice line target) is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null, did: '19995551234' });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('redeem: a lost claim race (already consumed between read and atomic claim) is rejected', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    seedApprovedApproval({ mode: 'app', forwardNumber: null });
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 0 });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', approvalToken: APPROVAL_TOKEN, sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(result.outcome).toBe('rejected');
    expect(voiceRoutingSetMock).not.toHaveBeenCalled();
  });

  it('a consumer changing their own line is never gated — no token needed, no ApprovalRequest touched', async () => {
    const voiceLine = operatorVoiceLine({ owner_kind: 'consumer', tenant_id: null, identity_id: 'identity-c1' });
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue(setSuccess('app', 'app'));

    const result = await setVoiceRouteMode(
      { kind: 'consumer', session: consumerSession() },
      { mode: 'app', sourceSurface: 'consumer.routing' },
    );

    expect(result.ok).toBe(true);
    expect(prismaMock.approvalRequest.create).not.toHaveBeenCalled();
    expect(prismaMock.approvalRequest.findUnique).not.toHaveBeenCalled();
  });
});
