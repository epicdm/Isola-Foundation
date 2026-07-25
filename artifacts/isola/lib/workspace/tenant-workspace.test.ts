import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, isAgentToolsEnabledMock, getCurrentUsageMock, getUsageHistoryMock } = vi.hoisted(() => ({
  prismaMock: {
    agent: { findMany: vi.fn(), findFirst: vi.fn() },
    whatsAppNumber: { findMany: vi.fn() },
    tenant: { findUnique: vi.fn() },
    chatwootBinding: { findMany: vi.fn(), findFirst: vi.fn() },
    clawithBinding: { findMany: vi.fn() },
    conversation: { count: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    escalationRef: { count: vi.fn(), findFirst: vi.fn() },
    message: { count: vi.fn() },
    auditLog: { findMany: vi.fn() },
  },
  isAgentToolsEnabledMock: vi.fn(),
  getCurrentUsageMock: vi.fn(),
  getUsageHistoryMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/engines', () => ({ isAgentToolsEnabled: isAgentToolsEnabledMock }));
vi.mock('@/lib/meter', () => ({ getCurrentUsage: getCurrentUsageMock, getUsageHistory: getUsageHistoryMock }));

import {
  getAiTeam,
  getAgentDetail,
  getAgentTools,
  getHandoffState,
  getActivitySummary,
  getConversationOverview,
  formatNumber,
} from './tenant-workspace';
import type { SessionCtx } from '@/lib/session';

const TENANT = 'tenant-epic';
const OTHER_TENANT = 'tenant-someone-else';

function ctx(overrides: Record<string, unknown> = {}): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'u1', tenant_id: TENANT, agent_took_over: false, tenant: {} },
    effectiveTenantId: TENANT,
    effectiveTenant: { id: TENANT, business_name: 'EPIC Communications Inc', status: 'active' },
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
    ...overrides,
  } as unknown as SessionCtx;
}

function agentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'agent-ema',
    tenant_id: TENANT,
    name: 'EMA',
    greeting: 'Hi, how can I help?',
    business_info: 'EPIC Communications sells managed WhatsApp front desks.',
    knowledge_text: 'Opening hours are 9-5.',
    intelligence_tier: 'standard',
    after_hours_start: null,
    after_hours_end: null,
    away_message: '',
    timezone: 'America/Dominica',
    is_active: true,
    brain_provider: 'clawith',
    flowise_flow_id: null,
    created_at: new Date('2026-07-18T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.whatsAppNumber.findMany.mockResolvedValue([]);
  prismaMock.tenant.findUnique.mockResolvedValue({ magnus_did_number: null, business_name: 'EPIC', status: 'active' });
  prismaMock.chatwootBinding.findMany.mockResolvedValue([]);
  prismaMock.clawithBinding.findMany.mockResolvedValue([]);
  prismaMock.conversation.count.mockResolvedValue(0);
  prismaMock.conversation.findFirst.mockResolvedValue(null);
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.escalationRef.count.mockResolvedValue(0);
  prismaMock.escalationRef.findFirst.mockResolvedValue(null);
  prismaMock.message.count.mockResolvedValue(0);
  prismaMock.auditLog.findMany.mockResolvedValue([]);
  getCurrentUsageMock.mockResolvedValue(null);
  getUsageHistoryMock.mockResolvedValue([]);
  isAgentToolsEnabledMock.mockReturnValue(false);
});

/* ------------------------------------------------------------- isolation */

describe('tenant isolation', () => {
  it('scopes the AI team query to the effective tenant only', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    await getAiTeam(ctx());
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: TENANT } })
    );
  });

  it('honours the admin act-as override rather than the raw user tenant', async () => {
    prismaMock.agent.findMany.mockResolvedValue([]);
    await getAiTeam(ctx({ effectiveTenantId: OTHER_TENANT, isAdmin: true }));
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: OTHER_TENANT } })
    );
  });

  it('returns null for an agent id belonging to another tenant (404, not 403)', async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null); // scoped query finds nothing
    const result = await getAgentDetail(ctx(), 'agent-owned-by-someone-else');
    expect(result).toBeNull();
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith({
      where: { id: 'agent-owned-by-someone-else', tenant_id: TENANT },
    });
  });

  it('never resolves a Chatwoot binding by tenant alone via findFirst', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    await getAiTeam(ctx());
    expect(prismaMock.chatwootBinding.findFirst).not.toHaveBeenCalled();
  });

  it('scopes every activity query to the effective tenant', async () => {
    await getActivitySummary(ctx());
    for (const call of prismaMock.conversation.count.mock.calls) {
      expect(call[0].where.tenant_id).toBe(TENANT);
    }
    expect(prismaMock.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: TENANT } })
    );
    expect(prismaMock.message.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ conversation: { tenant_id: TENANT } }) })
    );
  });
});

/* ------------------------------------------------------------ no secrets */

describe('secret redaction', () => {
  it('never selects Chatwoot binding tokens', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    await getAiTeam(ctx());
    const call = prismaMock.chatwootBinding.findMany.mock.calls[0][0];
    expect(Object.keys(call.select)).not.toContain('token');
  });

  it('never selects WhatsApp access tokens', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    await getAiTeam(ctx());
    const call = prismaMock.whatsAppNumber.findMany.mock.calls[0][0];
    expect(Object.keys(call.select)).not.toContain('access_token');
  });
});

/* ------------------------------------------------- honest provenance states */

describe('honest provenance', () => {
  it('reports an empty team as `empty` with an explanation, never as live', async () => {
    prismaMock.agent.findMany.mockResolvedValue([]);
    const panel = await getAiTeam(ctx());
    expect(panel.provenance.availability).toBe('empty');
    expect(panel.provenance.note).toBeTruthy();
    expect(panel.data).toEqual([]);
  });

  it('marks real team data as live with the Foundation source', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    prismaMock.conversation.findFirst.mockResolvedValue({ last_message_at: new Date('2026-07-25T06:00:00Z') });
    const panel = await getAiTeam(ctx());
    expect(panel.provenance.availability).toBe('live');
    expect(panel.provenance.source).toBe('isola.foundation');
    expect(panel.provenance.dataAsOf).toBe('2026-07-25T06:00:00.000Z');
    expect(panel.data[0].name).toBe('EMA');
  });

  it('never claims per-agent tool configuration that does not exist', async () => {
    const panel = getAgentTools();
    expect(panel.provenance.availability).toBe('not_configured');
    expect(panel.provenance.note).toMatch(/per-assistant|switched off/i);
  });

  it('explains the disabled-tools case differently from the enabled case', () => {
    isAgentToolsEnabledMock.mockReturnValue(false);
    const off = getAgentTools();
    isAgentToolsEnabledMock.mockReturnValue(true);
    const on = getAgentTools();
    expect(off.provenance.note).not.toBe(on.provenance.note);
    expect(off.provenance.availability).toBe('not_configured');
    expect(on.provenance.availability).toBe('not_configured');
  });

  it('reports no conversations as `empty` from the mirror source', async () => {
    const panel = await getConversationOverview(ctx());
    expect(panel.provenance.availability).toBe('empty');
    expect(panel.provenance.source).toBe('isola.mirror');
  });
});

/* --------------------------------------------------------- handoff state */

describe('handoff state', () => {
  it('reads human handling, owner takeover and recent escalations', async () => {
    prismaMock.conversation.count.mockResolvedValue(2);
    prismaMock.escalationRef.count.mockResolvedValue(5);
    prismaMock.escalationRef.findFirst.mockResolvedValue({ created_at: new Date('2026-07-25T05:00:00Z') });

    const panel = await getHandoffState(ctx({ user: { agent_took_over: true } }));
    expect(panel.data.humanHandlingCount).toBe(2);
    expect(panel.data.ownerTakeoverActive).toBe(true);
    expect(panel.data.escalationsLast7Days).toBe(5);
    expect(panel.data.mostRecentEscalationAt).toBe('2026-07-25T05:00:00.000Z');
    expect(prismaMock.conversation.count).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, human_handling: true },
    });
  });
});

/* ---------------------------------------------------- per-agent volumes */

describe('conversation attribution', () => {
  it('does not attribute workspace-wide volumes to an individual agent when several exist', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow(), agentRow({ id: 'agent-2', name: 'Zara' })]);
    prismaMock.conversation.count.mockResolvedValue(91);
    const panel = await getAiTeam(ctx());
    // Conversations carry no agent foreign key — inventing a split would be false data.
    expect(panel.data.every((m) => m.conversationCount === 0)).toBe(true);
  });

  it('attributes volumes when the workspace has exactly one assistant', async () => {
    prismaMock.agent.findMany.mockResolvedValue([agentRow()]);
    prismaMock.conversation.count.mockResolvedValue(91);
    const panel = await getAiTeam(ctx());
    expect(panel.data[0].conversationCount).toBe(91);
  });
});

/* -------------------------------------------------------------- display */

describe('formatNumber', () => {
  it('formats a North American number for display', () => {
    expect(formatNumber('17678183742')).toBe('+1 767-818-3742');
  });
  it('passes through an already formatted number', () => {
    expect(formatNumber('+441234567890')).toBe('+441234567890');
  });
  it('returns null for missing input rather than inventing a placeholder', () => {
    expect(formatNumber(null)).toBeNull();
    expect(formatNumber(undefined)).toBeNull();
  });
});
