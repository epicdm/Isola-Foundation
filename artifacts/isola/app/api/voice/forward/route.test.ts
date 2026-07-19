import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';
import type { VoiceRouteMutationResult } from '@/lib/voice-routing-service';

const { getSessionFromCookieMock, isMagnusConfiguredMock, setVoiceRouteModeMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  isMagnusConfiguredMock: vi.fn(),
  setVoiceRouteModeMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/engines', () => ({ isMagnusConfigured: isMagnusConfiguredMock }));
vi.mock('@/lib/voice-routing-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice-routing-service')>();
  return { ...actual, setVoiceRouteMode: setVoiceRouteModeMock };
});

import { POST } from './route';

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
  return new NextRequest('http://localhost/api/voice/forward', {
    method: 'POST',
    headers: { cookie: 'sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(session());
  isMagnusConfiguredMock.mockReturnValue(true);
});

describe('POST /api/voice/forward (legacy compat)', () => {
  it('preserves the exact success contract: { forward_to_cell, cell_number }', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: true, mode: 'cell', forwardToCellNumber: '17678182220', outcome: 'success' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ forward_to_cell: true, cell_number: '17678182220' });
  });

  it('a required-field rejection keeps its pre-existing 400 status', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: false, error: 'A forward number is required for this mode', outcome: 'rejected' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/required/i);
  });

  it('an ordinary non-required rejection keeps its pre-existing 502 status', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: false, error: 'Cannot forward to your own number', outcome: 'rejected' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182219' }));
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.error).toBe('Cannot forward to your own number');
  });

  it('a critical_degraded outcome is NOT silently folded into the ordinary 502 — it gets its own status and safe extra fields, while the boolean-compat `error` field is preserved', async () => {
    const critical: VoiceRouteMutationResult = {
      ok: false,
      error: 'Voice routing change could not be completed or safely rolled back — this line requires operator attention',
      outcome: 'critical_degraded',
      rollbackAttempted: true,
      rollbackVerified: false,
      critical: {
        tenantId: 'tenant-1',
        voiceLineId: 'vl-1',
        did: '17678182219',
        requestedMode: 'cell',
        beforeMode: 'app',
        observedAfterMode: 'unknown',
        rollbackAttempted: true,
        rollbackVerified: false,
        operatorActionRequired: true,
      },
    };
    setVoiceRouteModeMock.mockResolvedValue(critical);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).not.toBe(502);
    expect(res.status).toBe(503);
    expect(body.error).toBe(critical.error);
    expect(body.operatorActionRequired).toBe(true);
    expect(body.outcome).toBe('critical_degraded');
  });

  it('never leaks secrets in any failure response', async () => {
    setVoiceRouteModeMock.mockResolvedValue({
      ok: false,
      error: 'x',
      outcome: 'critical_degraded',
      critical: {
        tenantId: 't1',
        voiceLineId: 'vl-1',
        did: '17678182219',
        requestedMode: 'cell',
        beforeMode: 'app',
        observedAfterMode: 'unknown',
        rollbackAttempted: true,
        rollbackVerified: false,
        operatorActionRequired: true,
      },
    } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220' }));
    const raw = JSON.stringify(await res.json()).toLowerCase();

    expect(raw).not.toContain('password');
    expect(raw).not.toContain('secret');
  });

  it('S6: approval_required outcome returns 202, not the legacy { error } shape', async () => {
    setVoiceRouteModeMock.mockResolvedValue({
      ok: false,
      outcome: 'approval_required',
      error: 'This routing change requires approval',
      approvalRequestId: 'appr-1',
      approvalExpiresAt: '2026-07-19T12:15:00.000Z',
    } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toEqual({
      approval_required: true,
      approval_request_id: 'appr-1',
      expires_at: '2026-07-19T12:15:00.000Z',
    });
  });

  it('S6: forwards approval_token from the request body into setVoiceRouteMode', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: true, mode: 'cell', forwardToCellNumber: '17678182220', outcome: 'success' } satisfies VoiceRouteMutationResult);
    await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220', approval_token: 'tok-123' }));

    expect(setVoiceRouteModeMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'operator' }),
      expect.objectContaining({ approvalToken: 'tok-123' }),
    );
  });
});
