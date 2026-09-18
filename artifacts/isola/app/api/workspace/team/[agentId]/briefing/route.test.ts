import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getSessionMock, requireWorkspaceAccessMock, resolveEligibilityMock, getBusinessBriefingMock, auditMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
  resolveEligibilityMock: vi.fn(),
  getBusinessBriefingMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }));
vi.mock('@/lib/workspace/staff-agent-chat', () => ({
  resolveStaffChatEligibility: resolveEligibilityMock,
}));
vi.mock('@/lib/workspace/business-briefing', () => ({ getBusinessBriefing: getBusinessBriefingMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));

import { GET } from './route';

const TENANT = 'tenant-1';
const AGENT_ID = 'agent-1';
const SESSION = { effectiveTenantId: TENANT, user: { id: 'user-1' } };

const OWNER_GUARD = {
  ok: true,
  authz: { level: 'owner', basis: 'membership', membershipRole: 'owner', canViewAudit: true, canViewConfiguration: true },
};
// requireWorkspaceAccess(session, 'owner') itself produces this shape for a
// manager-level (Membership.role 'admin') caller — see authz.ts's own
// levelSatisfies. Not a fixture invention: it is the real 403 the tightened
// gate returns.
const MANAGER_DENIED_GUARD = {
  ok: false,
  status: 403,
  error: 'This view is available to workspace owners.',
  authz: { level: 'manager', basis: 'membership', membershipRole: 'admin', canViewAudit: false, canViewConfiguration: false },
};
const STAFF_DENIED_GUARD = {
  ok: false,
  status: 403,
  error: 'This view is available to workspace owners.',
  authz: { level: 'denied', basis: 'insufficient-role', membershipRole: 'staff', canViewAudit: false, canViewConfiguration: false },
};
const ELIGIBLE_AGENT = { agentId: AGENT_ID, tenantId: TENANT, name: 'CCO', clawithAgentId: 'clawith-1', clawithTenantId: 'ct-1', paperclipCompanyId: 'company-1', chatwootBindingModes: [] };

function params(agentId = AGENT_ID) {
  return { params: Promise.resolve({ agentId }) };
}

function get(agentId = AGENT_ID) {
  return GET(new Request(`http://localhost/api/workspace/team/${agentId}/briefing`) as unknown as import('next/server').NextRequest, params(agentId));
}

const BRIEFING = {
  tenantId: TENANT,
  generatedAt: '2026-09-18T00:00:00.000Z',
  odooConnected: true,
  sections: [{ id: 'overdue_receivables', title: 'Overdue receivables', state: 'ok', rows: [] }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(SESSION);
  requireWorkspaceAccessMock.mockResolvedValue(OWNER_GUARD);
  resolveEligibilityMock.mockResolvedValue({ eligible: true, agent: ELIGIBLE_AGENT });
  getBusinessBriefingMock.mockResolvedValue(BRIEFING);
});

describe('GET .../briefing — permission boundary', () => {
  it('401 when unauthenticated, and no briefing is fetched', async () => {
    getSessionMock.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(401);
    expect(getBusinessBriefingMock).not.toHaveBeenCalled();
  });

  it('403 for a staff-level session, and no briefing is fetched', async () => {
    requireWorkspaceAccessMock.mockResolvedValue(STAFF_DENIED_GUARD);
    const res = await get();
    expect(res.status).toBe(403);
    expect(getBusinessBriefingMock).not.toHaveBeenCalled();
  });

  it('REQUESTER AUTHORITY: 403 for a manager-level (admin) session — company filtering is not requester authorization, and this view now requires genuine tenant-owner authority', async () => {
    requireWorkspaceAccessMock.mockResolvedValue(MANAGER_DENIED_GUARD);
    const res = await get();
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('This view is available to workspace owners.');
    expect(getBusinessBriefingMock).not.toHaveBeenCalled();
    // The guard call itself proves the STRICTER minimum was actually requested,
    // not just that some guard happened to return ok:true elsewhere.
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(SESSION, 'owner');
  });

  it('404 when the agent does not belong to this tenant — never 403, stays indistinguishable from absent', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: false, reason: 'agent_not_found' });
    const res = await get();
    expect(res.status).toBe(404);
    expect(getBusinessBriefingMock).not.toHaveBeenCalled();
  });

  it('a PUBLIC or unclassified agent is blocked, never used to fetch a briefing', async () => {
    resolveEligibilityMock.mockResolvedValue({ eligible: false, reason: 'not_internal_classified' });
    const res = await get();
    const body = await res.json();
    expect(body).toEqual({ state: 'blocked', reason: 'not_internal_classified', briefing: null });
    expect(getBusinessBriefingMock).not.toHaveBeenCalled();
  });
});

describe('GET .../briefing — success path', () => {
  it('fetches the briefing scoped to the SESSION tenant (never a caller-supplied one) and audits the read', async () => {
    const res = await get();
    const body = await res.json();

    expect(getBusinessBriefingMock).toHaveBeenCalledWith(TENANT);
    expect(body).toEqual({ state: 'ok', briefing: BRIEFING });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        actorId: 'user-1',
        action: 'agent.business_briefing.read',
        entityId: AGENT_ID,
        meta: { odooConnected: true, sections: [{ id: 'overdue_receivables', state: 'ok' }] },
      }),
    );
  });
});
