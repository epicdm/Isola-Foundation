import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';

const { getSessionFromCookieMock, canMock, auditMock, prismaMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  canMock: vi.fn(),
  auditMock: vi.fn(),
  prismaMock: {
    approvalRequest: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/permissions', () => ({ can: canMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { GET, POST } from './route';

function session(overrides: Partial<SessionCtx> = {}): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-1' } as User & { tenant: Tenant },
    effectiveTenantId: 'tenant-1',
    effectiveTenant: {} as Tenant,
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
    ...overrides,
  };
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/approvals/appr-1', { headers: { cookie: 'sid=abc' } });
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/approvals/appr-1', {
    method: 'POST',
    headers: { cookie: 'sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function params(id = 'appr-1') {
  return { params: Promise.resolve({ id }) };
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'appr-1',
    tenant_id: 'tenant-1',
    token: 'secret-token',
    action: 'voice.route.set',
    target_entity: 'voice_line',
    target_id: 'vl-1',
    payload: { did: '17678182219', mode: 'app', forwardNumber: null },
    status: 'pending',
    requested_by: 'user-1',
    decided_by: null,
    decided_at: null,
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000),
    created_at: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(session());
  canMock.mockResolvedValue(true);
});

describe('GET /api/approvals/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    getSessionFromCookieMock.mockResolvedValue(null);
    const res = await GET(getRequest(), params());
    expect(res.status).toBe(401);
  });

  it('returns the row without leaking the token or tenant_id', async () => {
    // Mirrors the route's own `select` (no `token` field) — a real Prisma
    // call with that select could never return one.
    const { token: _token, ...selected } = pendingRow();
    prismaMock.approvalRequest.findUnique.mockResolvedValue(selected);
    const res = await GET(getRequest(), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('pending');
    expect(body.token).toBeUndefined();
    expect(body.tenant_id).toBeUndefined();
  });

  it('returns 404 for a cross-tenant id', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow({ tenant_id: 'tenant-OTHER' }));
    const res = await GET(getRequest(), params());
    expect(res.status).toBe(404);
  });

  it('returns 404 when no row exists', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(null);
    const res = await GET(getRequest(), params());
    expect(res.status).toBe(404);
  });
});

describe('POST /api/approvals/[id]', () => {
  it('returns 401 when unauthenticated', async () => {
    getSessionFromCookieMock.mockResolvedValue(null);
    const res = await POST(postRequest({ decision: 'approve' }), params());
    expect(res.status).toBe(401);
  });

  it('a staff Membership (can() denies) is forbidden from deciding', async () => {
    canMock.mockResolvedValue(false);
    const res = await POST(postRequest({ decision: 'approve' }), params());
    expect(res.status).toBe(403);
  });

  it('rejects a missing/invalid decision', async () => {
    const res = await POST(postRequest({ decision: 'maybe' }), params());
    expect(res.status).toBe(400);
  });

  it('returns 404 for a cross-tenant id', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow({ tenant_id: 'tenant-OTHER' }));
    const res = await POST(postRequest({ decision: 'approve' }), params());
    expect(res.status).toBe(404);
  });

  it('returns 409 when the row is already decided', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow({ status: 'approved' }));
    const res = await POST(postRequest({ decision: 'approve' }), params());
    expect(res.status).toBe(409);
  });

  it('flips an expired pending row to expired and returns 410', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow({ expires_at: new Date(Date.now() - 1000) }));
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(postRequest({ decision: 'approve' }), params());

    expect(res.status).toBe(410);
    expect(prismaMock.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'appr-1', status: 'pending' },
      data: { status: 'expired' },
    });
  });

  it('deny flips status to denied and audits', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow());
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(postRequest({ decision: 'deny' }), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'denied' });
    expect(prismaMock.approvalRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'appr-1', status: 'pending' },
      data: { status: 'denied', decided_by: 'user-1', decided_at: expect.any(Date) },
    });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'voice.route.denied' }));
  });

  it('approve flips status to approved, returns the token, and audits self_approved=true when approver === requester', async () => {
    prismaMock.approvalRequest.findUnique
      .mockResolvedValueOnce(pendingRow({ requested_by: 'user-1' }))
      .mockResolvedValueOnce({ token: 'secret-token' });
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    const res = await POST(postRequest({ decision: 'approve' }), params());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ status: 'approved', token: 'secret-token' });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'voice.route.approved', meta: expect.objectContaining({ self_approved: true }) }),
    );
  });

  it('approve by a different tenant owner (not the requester) audits self_approved=false', async () => {
    prismaMock.approvalRequest.findUnique
      .mockResolvedValueOnce(pendingRow({ requested_by: 'user-OTHER' }))
      .mockResolvedValueOnce({ token: 'secret-token' });
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 1 });
    await POST(postRequest({ decision: 'approve' }), params());

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'voice.route.approved', meta: expect.objectContaining({ self_approved: false }) }),
    );
  });

  it('a lost race on the decide claim (already decided between read and update) returns 409', async () => {
    prismaMock.approvalRequest.findUnique.mockResolvedValue(pendingRow());
    prismaMock.approvalRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await POST(postRequest({ decision: 'approve' }), params());
    expect(res.status).toBe(409);
  });
});
