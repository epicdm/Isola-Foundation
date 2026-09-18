import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSessionMock, requireWorkspaceAccessMock, askCcoMock, auditMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
  askCcoMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }));
vi.mock('@/lib/workspace/cco-invoke', () => ({ askCco: askCcoMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));

import { POST } from './route';

const TENANT = 'tenant-1';
const SESSION = { effectiveTenantId: TENANT, user: { id: 'user-1' } };

const OWNER_GUARD = {
  ok: true,
  authz: { level: 'owner', basis: 'membership', membershipRole: 'owner', canViewAudit: true, canViewConfiguration: true },
};
const MANAGER_DENIED_GUARD = {
  ok: false,
  status: 403,
  error: 'This view is available to workspace owners.',
  authz: { level: 'manager', basis: 'membership', membershipRole: 'admin', canViewAudit: false, canViewConfiguration: false },
};

const REPLIED_RESULT = {
  state: 'replied' as const,
  reason: null,
  briefing: { tenantId: TENANT, generatedAt: '2026-09-18T00:00:00.000Z', odooConnected: true, sections: [] },
  text: 'Here is your briefing.',
  sources: ['https://epic.odoo.com/odoo/account.move/1'],
  correlationId: 'corr-1',
};

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/workspace/cco/ask', { method: 'POST', body: JSON.stringify(body) }) as unknown as import('next/server').NextRequest,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(SESSION);
  requireWorkspaceAccessMock.mockResolvedValue(OWNER_GUARD);
  askCcoMock.mockResolvedValue(REPLIED_RESULT);
});

describe('POST /api/workspace/cco/ask — permission boundary', () => {
  it('401 when unauthenticated, and the CCO is never asked', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await post({ message: 'hi', threadId: 't1', turnId: 'u1' });
    expect(res.status).toBe(401);
    expect(askCcoMock).not.toHaveBeenCalled();
  });

  it('403 for a manager-level (non-owner) session, requiring the STRICTER owner minimum', async () => {
    requireWorkspaceAccessMock.mockResolvedValue(MANAGER_DENIED_GUARD);
    const res = await post({ message: 'hi', threadId: 't1', turnId: 'u1' });
    expect(res.status).toBe(403);
    expect(askCcoMock).not.toHaveBeenCalled();
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(SESSION, 'owner');
  });
});

describe('POST /api/workspace/cco/ask — request shape', () => {
  it('400 when message is missing', async () => {
    const res = await post({ threadId: 't1', turnId: 'u1' });
    expect(res.status).toBe(400);
    expect(askCcoMock).not.toHaveBeenCalled();
  });

  it('400 when threadId is missing', async () => {
    const res = await post({ message: 'hi', turnId: 'u1' });
    expect(res.status).toBe(400);
  });

  it('400 when turnId is missing', async () => {
    const res = await post({ message: 'hi', threadId: 't1' });
    expect(res.status).toBe(400);
  });

  it('400 on invalid JSON', async () => {
    const req = new Request('http://localhost/api/workspace/cco/ask', { method: 'POST', body: 'not json' }) as unknown as import('next/server').NextRequest;
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/workspace/cco/ask — the honest path', () => {
  it('asks the CCO scoped to the SESSION tenant (never a caller-supplied one), and returns text + sources + correlationId', async () => {
    const res = await post({ message: 'How are receivables?', threadId: 'thread-1', turnId: 'turn-1' });
    const bodyOut = await res.json();

    expect(askCcoMock).toHaveBeenCalledWith({
      tenantId: TENANT,
      message: 'How are receivables?',
      threadId: 'thread-1',
      turnId: 'turn-1',
    });
    expect(bodyOut).toEqual({
      state: 'replied',
      text: 'Here is your briefing.',
      sources: ['https://epic.odoo.com/odoo/account.move/1'],
      correlationId: 'corr-1',
    });
  });

  it('audits every ask with the tenant, actor, correlation id and outcome state', async () => {
    await post({ message: 'How are receivables?', threadId: 'thread-1', turnId: 'turn-1' });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'user-1',
        action: 'agent.cco_briefing.ask',
        requestId: 'corr-1',
        meta: expect.objectContaining({ state: 'replied' }),
      }),
    );
  });

  it('a caller-supplied tenantId in the body is IGNORED -- only the session tenant is ever used', async () => {
    await post({ message: 'x', threadId: 't1', turnId: 'u1', tenantId: 'someone-elses-tenant' });
    expect(askCcoMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT }));
  });

  it('a blocked result (wrong/missing agent binding) is passed through and audited, not converted to a generic error', async () => {
    askCcoMock.mockResolvedValue({
      state: 'blocked',
      reason: 'not_provisioned',
      briefing: null,
      text: null,
      sources: [],
      correlationId: null,
    });
    const res = await post({ message: 'x', threadId: 't1', turnId: 'u1' });
    const bodyOut = await res.json();
    expect(bodyOut.state).toBe('blocked');
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ meta: expect.objectContaining({ state: 'blocked', reason: 'not_provisioned' }) }));
  });
});
