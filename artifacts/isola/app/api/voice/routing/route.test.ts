import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';
import type { VoiceRouteMutationResult } from '@/lib/voice-routing-service';

const { getSessionFromCookieMock, isMagnusConfiguredMock, setVoiceRouteModeMock, getVoiceRouteStateMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  isMagnusConfiguredMock: vi.fn(),
  setVoiceRouteModeMock: vi.fn(),
  getVoiceRouteStateMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/engines', () => ({ isMagnusConfigured: isMagnusConfiguredMock }));
vi.mock('@/lib/voice-routing-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice-routing-service')>();
  return { ...actual, setVoiceRouteMode: setVoiceRouteModeMock, getVoiceRouteState: getVoiceRouteStateMock };
});

import { GET, POST } from './route';

function session(): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-1' } as User & { tenant: Tenant },
    effectiveTenantId: 'tenant-1',
    effectiveTenant: {} as Tenant,
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/voice/routing', {
    method: 'POST',
    headers: { cookie: 'sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CRITICAL_RESULT: VoiceRouteMutationResult = {
  ok: false,
  error: 'Voice routing change could not be completed or safely rolled back — this line requires operator attention',
  outcome: 'critical_degraded',
  rollbackAttempted: true,
  rollbackVerified: false,
  critical: {
    tenantId: 'tenant-1',
    voiceLineId: 'vl-1',
    did: '17678182219',
    requestedMode: 'app',
    beforeMode: 'cell',
    observedAfterMode: 'unknown',
    rollbackAttempted: true,
    rollbackVerified: false,
    operatorActionRequired: true,
  },
};

const REJECTED_RESULT: VoiceRouteMutationResult = {
  ok: false,
  error: 'Cannot forward to your own number',
  outcome: 'rejected',
};

const ROLLED_BACK_RESULT: VoiceRouteMutationResult = {
  ok: false,
  error: 'Voice routing change could not be verified — the line has been safely restored to its previous state',
  outcome: 'unverified_rolled_back',
  rollbackAttempted: true,
  rollbackVerified: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(session());
  isMagnusConfiguredMock.mockReturnValue(true);
});

describe('POST /api/voice/routing', () => {
  it('an ordinary validation rejection returns a safe 422 with outcome=rejected and no critical field', async () => {
    setVoiceRouteModeMock.mockResolvedValue(REJECTED_RESULT);
    const res = await POST(postRequest({ mode: 'cell', forward_number: '17678182219' }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error).toBe(REJECTED_RESULT.error);
    expect(body.outcome).toBe('rejected');
    expect(body.critical).toBeUndefined();
    expect(body.operatorActionRequired).toBeUndefined();
  });

  it('a verified-rollback failure returns 422 with rollback fields set and no critical field', async () => {
    setVoiceRouteModeMock.mockResolvedValue(ROLLED_BACK_RESULT);
    const res = await POST(postRequest({ mode: 'app' }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.outcome).toBe('unverified_rolled_back');
    expect(body.rollbackAttempted).toBe(true);
    expect(body.rollbackVerified).toBe(true);
    expect(body.critical).toBeUndefined();
  });

  it('a critical_degraded outcome is distinguishable via a server-error status and carries operatorActionRequired', async () => {
    setVoiceRouteModeMock.mockResolvedValue(CRITICAL_RESULT);
    const res = await POST(postRequest({ mode: 'app' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(422);
    expect(body.outcome).toBe('critical_degraded');
    expect(body.operatorActionRequired).toBe(true);
    expect(body.critical).toEqual(CRITICAL_RESULT.critical);
  });

  it('never leaks secrets or raw Magnus payloads in a critical response', async () => {
    setVoiceRouteModeMock.mockResolvedValue(CRITICAL_RESULT);
    const res = await POST(postRequest({ mode: 'app' }));
    const raw = JSON.stringify(await res.json()).toLowerCase();

    expect(raw).not.toContain('password');
    expect(raw).not.toContain('secret');
    expect(raw).not.toContain('authorization');
    expect(raw).not.toContain('sip_password');
  });

  it('a successful change is unaffected by the new error-shaping logic', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: true, mode: 'app', forwardToCellNumber: null, outcome: 'success' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ mode: 'app' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ mode: 'app', forward_to_cell_number: null });
  });
});

describe('GET /api/voice/routing', () => {
  it('returns the current mode for an authorized session', async () => {
    getVoiceRouteStateMock.mockResolvedValue({ mode: 'app', forwardToCellNumber: null, did: '17678182219' });
    const res = await GET(new NextRequest('http://localhost/api/voice/routing', { headers: { cookie: 'sid=abc' } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mode).toBe('app');
  });
});
