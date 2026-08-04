import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSessionMock, requireWorkspaceAccessMock, resolveEligibilityMock, performTurnMock, auditMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    requireWorkspaceAccessMock: vi.fn(),
    resolveEligibilityMock: vi.fn(),
    performTurnMock: vi.fn(),
    auditMock: vi.fn(),
  }));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }));
vi.mock('@/lib/workspace/staff-agent-chat', () => ({
  resolveStaffChatEligibility: resolveEligibilityMock,
  performStaffChatTurn: performTurnMock,
  buildStaffChatCorrelationId: (threadId: string, turnId: string) => `staffchat:${threadId}:${turnId}`,
}));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));

import { POST } from './route';

const TENANT = 'tenant-1';
const AGENT_ID = 'agent-1';

const SESSION = { effectiveTenantId: TENANT, user: { id: 'user-1' } };

const MANAGER_GUARD = {
  ok: true,
  authz: { level: 'manager', basis: 'membership', membershipRole: 'admin', canViewAudit: false, canViewConfiguration: false },
};
const STAFF_DENIED_GUARD = {
  ok: false,
  status: 403,
  error: 'You do not have access to this workspace.',
  authz: { level: 'denied', basis: 'insufficient-role', membershipRole: 'staff', canViewAudit: false, canViewConfiguration: false },
};

const ELIGIBLE_AGENT = {
  agentId: AGENT_ID,
  tenantId: TENANT,
  name: 'Isola',
  clawithAgentId: 'clawith-agent-1',
  paperclipCompanyId: 'company-1',
  chatwootBindingModes: ['lane2', 'a2'],
};

function params(agentId = AGENT_ID) {
  return { params: Promise.resolve({ agentId }) };
}

function post(body: unknown, agentId = AGENT_ID) {
  return POST(
    new Request(`http://localhost/api/workspace/team/${agentId}/chat`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }) as unknown as import('next/server').NextRequest,
    params(agentId),
  );
}

const VALID_BODY = { message: 'hello', threadId: 'thread-1', turnId: 'turn-1' };

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(SESSION);
  requireWorkspaceAccessMock.mockResolvedValue(MANAGER_GUARD);
});

describe('permission boundary', () => {
  it('401 when unauthenticated, and no eligibility check or turn is attempted', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(401);
    expect(resolveEligibilityMock).not.toHaveBeenCalled();
    expect(performTurnMock).not.toHaveBeenCalled();
  });

  it('403 for Membership.role=staff', async () => {
    requireWorkspaceAccessMock.mockResolvedValue(STAFF_DENIED_GUARD);
    const res = await post(VALID_BODY);
    expect(res.status).toBe(403);
    expect(resolveEligibilityMock).not.toHaveBeenCalled();
  });

  it('owner passes the guard (manager minimum is satisfied by owner)', async () => {
    requireWorkspaceAccessMock.mockResolvedValue({
      ok: true,
      authz: { level: 'owner', basis: 'membership', membershipRole: 'owner', canViewAudit: true, canViewConfiguration: true },
    });
    resolveEligibilityMock.mockResolvedValue({ eligible: true, agent: ELIGIBLE_AGENT });
    performTurnMock.mockResolvedValue({
      result: { state: 'replied', text: 'hi', correlationId: 'staffchat:thread-1:turn-1', failureKind: null, attempts: 1 },
      sentRequest: {},
    });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
  });

  it('404 for a cross-tenant / nonexistent agent — never 403, stays indistinguishable from absent', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: false, reason: 'agent_not_found' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(404);
    expect(performTurnMock).not.toHaveBeenCalled();
  });
});

describe('request validation', () => {
  it('400 when message is missing', async () => {
    const res = await post({ threadId: 't', turnId: 'x' });
    expect(res.status).toBe(400);
  });

  it('400 when threadId is missing', async () => {
    const res = await post({ message: 'hi', turnId: 'x' });
    expect(res.status).toBe(400);
  });

  it('400 when turnId is missing', async () => {
    const res = await post({ message: 'hi', threadId: 't' });
    expect(res.status).toBe(400);
  });

  it('400 on invalid JSON', async () => {
    const res = await post('{not json');
    expect(res.status).toBe(400);
  });
});

describe('eligibility failure (agent exists, but is not chat-eligible) renders the truthful blocked state', () => {
  it('returns state=blocked with no upstream call and no audit for a not_allowlisted agent', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: false, reason: 'not_allowlisted' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state).toBe('blocked');
    expect(data.allowedTools).toEqual([]);
    expect(performTurnMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('B4: returns state=blocked with no upstream call, but DOES audit, for a not_internal_classified refusal', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: false, reason: 'not_internal_classified' });
    const res = await post(VALID_BODY);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state).toBe('blocked');
    expect(data.reason).toBe('not_internal_classified');
    expect(performTurnMock).not.toHaveBeenCalled();

    expect(auditMock).toHaveBeenCalledTimes(1);
    const auditCall = auditMock.mock.calls[0][0];
    expect(auditCall.action).toBe('clawith.exposure.staff_denied');
    expect(auditCall.tenantId).toBe(TENANT);
    expect(auditCall.actorId).toBe('user-1');
    expect(auditCall.entityId).toBe(AGENT_ID);
    expect(auditCall.requestId).toBe('staffchat:thread-1:turn-1');
    expect(auditCall.meta).toEqual({ reason: 'not_internal_classified' });
  });
});

describe('one submit equals one upstream call and one audit', () => {
  it('an eligible turn calls performStaffChatTurn exactly once and audit exactly once, with matching request_id', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: true, agent: ELIGIBLE_AGENT });
    performTurnMock.mockResolvedValue({
      result: {
        state: 'replied',
        text: 'the answer',
        correlationId: 'staffchat:thread-1:turn-1',
        failureKind: null,
        attempts: 1,
      },
      sentRequest: { allowed_tools: [] },
    });

    const res = await post(VALID_BODY);
    const data = await res.json();

    expect(performTurnMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledTimes(1);

    const auditCall = auditMock.mock.calls[0][0];
    expect(auditCall.action).toBe('agent.staff_chat.turn');
    expect(auditCall.requestId).toBe('staffchat:thread-1:turn-1');
    expect(auditCall.tenantId).toBe(TENANT);
    expect(auditCall.actorId).toBe('user-1');

    expect(data.state).toBe('replied');
    expect(data.text).toBe('the answer');
    expect(data.correlationId).toBe('staffchat:thread-1:turn-1');
    expect(data.mode).toBe('LIVE_ASSISTED');
    expect(data.allowedTools).toEqual([]);
  });

  it('audit is still written for a safe-failure outcome (e.g. timeout), proving the AuditLog correlation proof holds on failure too', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: true, agent: ELIGIBLE_AGENT });
    performTurnMock.mockResolvedValue({
      result: { state: 'timeout', text: null, correlationId: 'staffchat:thread-1:turn-1', failureKind: 'timeout', attempts: null },
      sentRequest: { allowed_tools: [] },
    });

    const res = await post(VALID_BODY);
    const data = await res.json();

    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock.mock.calls[0][0].requestId).toBe('staffchat:thread-1:turn-1');
    expect(data.state).toBe('timeout');
    // No raw error/detail is ever placed on the response body.
    expect(JSON.stringify(data)).not.toContain('ClawithFailure');
  });
});

describe('the response body never leaks raw upstream detail', () => {
  it('never includes a provider/db error shape, only the closed state vocabulary', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: true, agent: ELIGIBLE_AGENT });
    performTurnMock.mockResolvedValue({
      result: { state: 'degraded', text: null, correlationId: 'staffchat:thread-1:turn-1', failureKind: 'invalid_response', attempts: 1 },
      sentRequest: { allowed_tools: [] },
    });
    const res = await post(VALID_BODY);
    const data = await res.json();
    expect(Object.keys(data).sort()).toEqual(['allowedTools', 'correlationId', 'mode', 'state', 'text']);
  });
});
