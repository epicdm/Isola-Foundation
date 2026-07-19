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

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Section 10: authorization ───────────────────────────────────────────────

describe('setVoiceRouteMode — authorization', () => {
  it('global owner session is allowed to change routing', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app'),
      verified: true,
    });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app', sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(true);
  });

  it('global admin session is allowed to change routing', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.update.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app'),
      verified: true,
    });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isAdmin: true }) },
      { mode: 'app', sourceSurface: 'operator.routing' },
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
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app'),
      verified: true,
    });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession() },
      { mode: 'app', sourceSurface: 'operator.routing' },
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
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app'),
      verified: true,
    });

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
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app_then_cell', '9715551234'),
      verified: true,
    });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', sourceSurface: 'operator.routing' },
    );

    expect(result).toEqual({ ok: true, mode: 'app_then_cell', forwardToCellNumber: '9715551234' });
    expect(prismaMock.voiceLine.update).toHaveBeenCalledWith({
      where: { id: 'vl-1' },
      data: { voice_forward_to_cell: true, voice_cell_number: '9715551234' },
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.routing.set', meta: expect.objectContaining({ ok: true }) }));
  });

  it('does NOT report success merely because Magnus returned 200 — after-state mismatch fails the request', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockResolvedValue({
      before: routeState('app'),
      after: routeState('app'),
      verified: false,
    });

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'voice.routing.set_unverified',
        meta: expect.objectContaining({ ok: false, before_mode: 'app', after_mode: 'app' }),
      }),
    );
  });

  it('a connector/Magnus write failure never produces a false success', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    voiceRoutingSetMock.mockRejectedValue(new VoiceRoutingConnectorError('voice.routing.set: Magnus mutation failed: timeout'));

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'app_then_cell', forwardNumber: '9715551234', sourceSurface: 'operator.routing' },
    );

    expect(result.ok).toBe(false);
    expect(prismaMock.voiceLine.update).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.routing.set_failed' }));
  });

  it('a rejected guard (e.g. self-forward) never reaches the connector — no Magnus mutation is attempted', async () => {
    const voiceLine = operatorVoiceLine();
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine);
    prismaMock.voiceLine.findMany.mockResolvedValue([{ magnus_did_number: OWN_DID }]);

    const result = await setVoiceRouteMode(
      { kind: 'operator', session: operatorSession({ isOwner: true }) },
      { mode: 'cell', forwardNumber: OWN_DID, sourceSurface: 'operator.routing' },
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
