/**
 * Route-level tests for POST /api/admin/approvals/revenue-followup —
 * correction 6 of dec-pr80-odoo-scope-idempotency-and-read-contract-2026-08-06.
 *
 * The underlying approve/revoke DOMAIN logic (strict scope matching, expiry,
 * revocation-wins) is already proven in
 * lib/governed/revenue-followup-approval.test.ts. These tests are about the
 * ROUTE's OWN responsibilities: authentication, role, required fields, and
 * that a caller's asserted tenant/opportunity/tool is actually checked against
 * the row before anything changes — so the two underlying functions are
 * mocked directly rather than re-exercised through a real AuditLog fake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';

const { getSessionFromCookieMock, approveMock, revokeMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  approveMock: vi.fn(),
  revokeMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/governed/revenue-followup-approval', () => ({
  approveRevenueFollowup: approveMock,
  revokeRevenueFollowupApproval: revokeMock,
}));

import { POST } from './route';

function adminSession(overrides: Partial<SessionCtx> = {}): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-eric' } as User & { tenant: Tenant },
    effectiveTenantId: 'tenant-epic',
    effectiveTenant: {} as Tenant,
    isAdmin: true,
    isOwner: false,
    identityId: 'identity-1',
    ...overrides,
  };
}

function postRequest(body: unknown, cookie = 'sid=abc'): NextRequest {
  return new NextRequest('http://localhost/api/admin/approvals/revenue-followup', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authentication and role', () => {
  it('denies an unauthenticated request', async () => {
    getSessionFromCookieMock.mockResolvedValue(null);
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-1', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(403);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('denies a non-admin session (wrong role/permission)', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession({ isAdmin: false }));
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-1', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(403);
    expect(approveMock).not.toHaveBeenCalled();
  });
});

describe('required fields', () => {
  it('requires tenantId and leadId', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-1' }));
    expect(res.status).toBe(400);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('requires pendingApprovalId for approve', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    const res = await POST(postRequest({ op: 'approve', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(400);
    expect(approveMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown op', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    const res = await POST(postRequest({ op: 'delete', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(400);
  });
});

describe('approve — scope assertions reach the underlying function', () => {
  it('passes expectedTool/expectedTenantId/expectedObjectId through, matching the route\'s own scope', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    approveMock.mockResolvedValue({ ok: true, auditId: 'al-approved-1' });

    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-pending-1', tenantId: 'tenant-epic', leadId: '1642' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, auditId: 'al-approved-1' });

    expect(approveMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pendingApprovalId: 'al-pending-1',
        approverActorId: 'user-eric',
        expectedTool: 'revenue.followup.set',
        expectedTenantId: 'tenant-epic',
        expectedObjectId: '1642',
      }),
    );
  });

  it('wrong tenant/opportunity/tool (an unrelated row) surfaces as a 403 wrong_scope, never a silent grant', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    approveMock.mockResolvedValue({ ok: false, code: 'wrong_scope', detail: 'this row does not belong to the expected tenant' });

    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-unrelated', tenantId: 'tenant-someone-else', leadId: '1642' }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('wrong_scope');
  });

  it('an expired pending row surfaces as 404 expired', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    approveMock.mockResolvedValue({ ok: false, code: 'expired', detail: 'expired' });
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-1', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(404);
  });

  it('a not_found pending id surfaces as 404', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    approveMock.mockResolvedValue({ ok: false, code: 'not_found', detail: 'no matching pending approval request' });
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-does-not-exist', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(404);
  });

  it('the success response body carries ONLY ok/auditId — no credential, no stored meta, no other row field', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    approveMock.mockResolvedValue({ ok: true, auditId: 'al-approved-2' });
    const res = await POST(postRequest({ op: 'approve', pendingApprovalId: 'al-1', tenantId: 't', leadId: '1642' }));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(['auditId', 'ok']);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/token|secret|api[_-]?key/i);
  });
});

describe('revoke — scope assertions', () => {
  it('passes expectedTool/expectedTenantId/expectedObjectId through', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    revokeMock.mockResolvedValue({ ok: true, auditId: 'al-revoked-1' });

    const res = await POST(
      postRequest({ op: 'revoke', approvedAuditId: 'al-approved-1', tenantId: 'tenant-epic', leadId: '1642', reason: 'changed mind' }),
    );
    expect(res.status).toBe(200);
    expect(revokeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        approvedAuditId: 'al-approved-1',
        revokedByActorId: 'user-eric',
        reason: 'changed mind',
        expectedTool: 'revenue.followup.set',
        expectedTenantId: 'tenant-epic',
        expectedObjectId: '1642',
      }),
    );
  });

  it('an unrelated approved row (different tool/tenant/opportunity) is refused, not revoked', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    revokeMock.mockResolvedValue({ ok: false, code: 'wrong_scope', detail: 'this row is a voice.route.set record, not revenue.followup.set' });
    const res = await POST(postRequest({ op: 'revoke', approvedAuditId: 'al-unrelated', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(403);
  });

  it('requires approvedAuditId', async () => {
    getSessionFromCookieMock.mockResolvedValue(adminSession());
    const res = await POST(postRequest({ op: 'revoke', tenantId: 't', leadId: '1642' }));
    expect(res.status).toBe(400);
    expect(revokeMock).not.toHaveBeenCalled();
  });
});
