import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const { prismaMock, sessionMock, auditMock, executeHandbackMock } = vi.hoisted(() => ({
  prismaMock: { conversation: { findFirst: vi.fn() } },
  sessionMock: vi.fn(),
  auditMock: vi.fn(),
  executeHandbackMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/session', () => ({ getSessionFromCookie: sessionMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));
vi.mock('@/lib/ownership/handback', () => ({ executeHandback: executeHandbackMock }));

import { POST } from './route';

const TENANT = 'tenant-1';
const CONV = 'conv-1';

function req(body: unknown, cookie = 'session=abc'): NextRequest {
  return new NextRequest('http://localhost/api/conversations/conv-1/handback', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
const params = Promise.resolve({ id: CONV });

function session(overrides: Record<string, unknown> = {}) {
  return {
    user: { id: 'user-1' },
    effectiveTenantId: TENANT,
    isOwner: true,
    isAdmin: false,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue(session());
  prismaMock.conversation.findFirst.mockResolvedValue({ id: CONV, tenant_id: TENANT });
  executeHandbackMock.mockResolvedValue({
    ok: true, status: 'resumed', state: 'AI_RESUMED', episode: 2, detail: null, resumedNow: true,
  });
});

describe('POST /api/conversations/[id]/handback — auth', () => {
  it('401 with no session', async () => {
    sessionMock.mockResolvedValue(null);
    const res = await POST(req({ episode: 1, operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(401);
    expect(executeHandbackMock).not.toHaveBeenCalled();
  });

  it('404 when the conversation does not belong to the session tenant', async () => {
    prismaMock.conversation.findFirst.mockResolvedValue(null);
    const res = await POST(req({ episode: 1, operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(404);
    expect(executeHandbackMock).not.toHaveBeenCalled();
    // The lookup is tenant-scoped: cross-tenant handback is structurally
    // impossible here, not a check that could be forgotten.
    expect(prismaMock.conversation.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CONV, tenant_id: TENANT } }),
    );
  });

  it('maps a non-owner, non-admin session to an UNAUTHORIZED actor kind', async () => {
    sessionMock.mockResolvedValue(session({ isOwner: false, isAdmin: false }));
    await POST(req({ episode: 1, operation_id: 'hb-1' }), { params });
    expect(executeHandbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ kind: 'staff' }) }),
    );
  });

  it('maps an admin session to the admin actor kind', async () => {
    sessionMock.mockResolvedValue(session({ isOwner: false, isAdmin: true }));
    await POST(req({ episode: 1, operation_id: 'hb-1' }), { params });
    expect(executeHandbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ actor: expect.objectContaining({ kind: 'admin', ref: 'user:user-1' }) }),
    );
  });

  it('403 when the orchestrator refuses the actor', async () => {
    executeHandbackMock.mockResolvedValue({
      ok: false, status: 'not_authorized', state: 'HUMAN_OWNED', episode: 1,
      detail: 'actor_kind_not_authorized', resumedNow: false,
    });
    const res = await POST(req({ episode: 1, operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(403);
    expect((await res.json()).ok).toBe(false);
  });
});

describe('POST /api/conversations/[id]/handback — request validation', () => {
  it('400 without an episode', async () => {
    const res = await POST(req({ operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(400);
  });

  it('400 without an operation_id — an unclaimed handback cannot be idempotent', async () => {
    const res = await POST(req({ episode: 1 }), { params });
    expect(res.status).toBe(400);
  });

  it('400 on a non-integer episode', async () => {
    expect((await POST(req({ episode: '1', operation_id: 'x' }), { params })).status).toBe(400);
    expect((await POST(req({ episode: 1.5, operation_id: 'x' }), { params })).status).toBe(400);
  });
});

describe('POST /api/conversations/[id]/handback — outcomes', () => {
  it('200 and reports the resumed state', async () => {
    const res = await POST(req({ episode: 2, operation_id: 'hb-1', reason: 'sorted it' }), { params });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, status: 'resumed', ownership_state: 'AI_RESUMED', episode: 2 });
    expect(body.correlation_id).toBeTruthy();
    expect(executeHandbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT, conversationId: CONV, episode: 2, operationId: 'hb-1', reason: 'sorted it' }),
    );
  });

  it('409 on a stale episode — a late handback is refused, not applied', async () => {
    executeHandbackMock.mockResolvedValue({
      ok: false, status: 'stale_episode', state: 'HUMAN_OWNED', episode: 3,
      detail: 'episode_no_longer_current', resumedNow: false,
    });
    const res = await POST(req({ episode: 1, operation_id: 'hb-old' }), { params });
    expect(res.status).toBe(409);
    expect((await res.json()).ownership_state).toBe('HUMAN_OWNED');
  });

  it('409 when reconciliation failed, reporting the human state it stayed in', async () => {
    executeHandbackMock.mockResolvedValue({
      ok: false, status: 'reconciliation_failed', state: 'HUMAN_OWNED', episode: 2,
      detail: 'odoo_unreachable', resumedNow: false,
    });
    const res = await POST(req({ episode: 2, operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, status: 'reconciliation_failed', ownership_state: 'HUMAN_OWNED' });
  });

  it('200 and resumedNow=false on a replay', async () => {
    executeHandbackMock.mockResolvedValue({
      ok: true, status: 'already_applied', state: 'AI_RESUMED', episode: 2, detail: null, resumedNow: false,
    });
    const res = await POST(req({ episode: 2, operation_id: 'hb-1' }), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('already_applied');
  });

  it('audits every outcome with the actor, episode and resulting state', async () => {
    await POST(req({ episode: 2, operation_id: 'hb-1' }), { params });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'user:user-1',
        action: 'conversation.handback.resumed',
        entityId: CONV,
        meta: expect.objectContaining({ episode: 2, operation_id: 'hb-1', resulting_state: 'AI_RESUMED', resumed_now: true }),
      }),
    );
  });

  it('never returns a credential or the reconciliation internals', async () => {
    const res = await POST(req({ episode: 2, operation_id: 'hb-1' }), { params });
    const text = JSON.stringify(await res.json());
    expect(text).not.toMatch(/token|secret|api_access|password/i);
  });
});
