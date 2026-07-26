import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// Owner Dashboard page contract. Proves the golden-screen recomposition kept the
// data layer honest: every read is scoped to the session's effective tenant, the
// attention queue only ever names conditions with real backing data, and the
// customer-facing wording stays truthful (tokens, USD metering cost).

const { getSessionMock, prismaMock, getCurrentUsageMock, getUsageHistoryMock, redirectMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  prismaMock: {
    conversation: { count: vi.fn(), findMany: vi.fn() },
    whatsAppNumber: { findMany: vi.fn() },
    wallet: { findUnique: vi.fn() },
    agent: { findFirst: vi.fn() },
  },
  getCurrentUsageMock: vi.fn(),
  getUsageHistoryMock: vi.fn(),
  redirectMock: vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
}));

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/meter', () => ({ getCurrentUsage: getCurrentUsageMock, getUsageHistory: getUsageHistoryMock }));
vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('../app/(owner)/dashboard/TakeoverToggle', () => ({
  TakeoverToggle: ({ agentTookOver }: { agentTookOver: boolean }) => <span data-takeover={String(agentTookOver)}>TAKEOVER_TOGGLE</span>,
}));

import DashboardPage from '../app/(owner)/dashboard/page';

const TENANT = 'tenant-under-test';

function session(overrides: Record<string, unknown> = {}) {
  return {
    effectiveTenantId: TENANT,
    effectiveTenant: { business_name: 'Acme Ltd' },
    user: { agent_took_over: false },
    ...overrides,
  };
}

function emptyTenant() {
  prismaMock.conversation.count.mockResolvedValue(0);
  prismaMock.conversation.findMany.mockResolvedValue([]);
  prismaMock.whatsAppNumber.findMany.mockResolvedValue([]);
  prismaMock.wallet.findUnique.mockResolvedValue(null);
  prismaMock.agent.findFirst.mockResolvedValue(null);
  getCurrentUsageMock.mockResolvedValue(null);
  getUsageHistoryMock.mockResolvedValue([]);
}

function populatedTenant() {
  prismaMock.conversation.count.mockResolvedValue(3);
  prismaMock.conversation.findMany.mockResolvedValue([
    { id: 'c1', customer_name: 'Jane Roe', customer_phone: '+1555', last_message_at: new Date(), messages: [{ content: 'Hello there' }] },
  ]);
  prismaMock.whatsAppNumber.findMany.mockResolvedValue([{ id: 'w1', phone_number: '+15550001111', display_name: 'Front Desk' }]);
  prismaMock.wallet.findUnique.mockResolvedValue({ currency: 'USD', balance_cache: 42.5 });
  prismaMock.agent.findFirst.mockResolvedValue({ id: 'a1', name: 'Front Desk', is_active: true, intelligence_tier: 'standard' });
  getCurrentUsageMock.mockResolvedValue({ tokens_used: 12345, minutes_used: 8.25, minutes_cost: 1.5 });
  getUsageHistoryMock.mockResolvedValue([
    { period_start: new Date('2026-05-01'), tokens_used: 100, minutes_used: 1.0 },
    { period_start: new Date('2026-06-01'), tokens_used: 200, minutes_used: 2.0 },
  ]);
}

async function render() {
  return renderToStaticMarkup(await DashboardPage());
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionMock.mockResolvedValue(session());
});

describe('Dashboard — authorization boundary', () => {
  it('redirects an unauthenticated visitor and reads no tenant data', async () => {
    getSessionMock.mockResolvedValue(null);
    await expect(DashboardPage()).rejects.toThrow('NEXT_REDIRECT');
    expect(redirectMock).toHaveBeenCalledWith('/');
    expect(prismaMock.conversation.count).not.toHaveBeenCalled();
    expect(prismaMock.wallet.findUnique).not.toHaveBeenCalled();
  });
});

describe('Dashboard — tenant boundary', () => {
  it('scopes every read to the session effective tenant', async () => {
    populatedTenant();
    await render();
    expect(prismaMock.conversation.count).toHaveBeenCalledWith({ where: { tenant_id: TENANT, status: 'open' } });
    expect(prismaMock.whatsAppNumber.findMany).toHaveBeenCalledWith({ where: { tenant_id: TENANT } });
    expect(prismaMock.wallet.findUnique).toHaveBeenCalledWith({ where: { tenant_id: TENANT } });
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith({ where: { tenant_id: TENANT } });
    expect(prismaMock.conversation.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT });
    expect(getCurrentUsageMock).toHaveBeenCalledWith(TENANT);
    expect(getUsageHistoryMock).toHaveBeenCalledWith(TENANT, 6);
  });

  it('follows act-as impersonation to the effective tenant, not the user home tenant', async () => {
    populatedTenant();
    getSessionMock.mockResolvedValue(session({ effectiveTenantId: 'impersonated-tenant', effectiveTenant: { business_name: 'Other Co' } }));
    const html = await render();
    expect(prismaMock.conversation.count).toHaveBeenCalledWith({ where: { tenant_id: 'impersonated-tenant', status: 'open' } });
    expect(html).toContain('Other Co');
    expect(html).not.toContain('Acme Ltd');
  });
});

describe('Dashboard — metric cards', () => {
  it('links Open Conversations to the inbox and Wallet Balance to the wallet', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain('href="/inbox"');
    expect(html).toContain('href="/wallet"');
    expect(html).toContain('Open Conversations');
    expect(html).toContain('Wallet Balance');
  });

  it('labels AI consumption as tokens, not turns', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain('AI Usage (tokens)');
    expect(html).not.toMatch(/AI Turns/i);
    expect(html).toContain('12,345');
  });

  it('renders call cost as a USD metering cost', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain('Call Minutes (this month)');
    expect(html).toContain('$1.50');
    expect(html).toContain('billed');
  });

  it('renders an em-dash rather than a fabricated balance when no wallet exists', async () => {
    emptyTenant();
    const html = await render();
    expect(html).toContain('Wallet Balance');
    expect(html).toContain('—');
  });
});

describe('Dashboard — attention queue', () => {
  it('surfaces onboarding when no WhatsApp number is connected', async () => {
    emptyTenant();
    const html = await render();
    expect(html).toContain('Connect WhatsApp to get started');
    expect(html).toContain('href="/onboard"');
  });

  it('surfaces open conversations with a correctly pluralised count', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain('3 open conversations in your inbox');

    prismaMock.conversation.count.mockResolvedValue(1);
    const single = await render();
    expect(single).toContain('1 open conversation in your inbox');
  });

  it('invents no low-balance threshold — no unratified attention item appears', async () => {
    populatedTenant();
    prismaMock.conversation.count.mockResolvedValue(0);
    prismaMock.wallet.findUnique.mockResolvedValue({ currency: 'USD', balance_cache: 0.01 });
    const html = await render();
    expect(html).not.toMatch(/low balance|running low|top up now/i);
    expect(html).toContain('Nothing needs your attention right now');
  });

  it('uses neutral, truthful wording for open conversations (no urgency it cannot justify)', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain("Review and reply when you&#x27;re ready.");
    expect(html).not.toMatch(/urgent|overdue|immediately/i);
  });
});

describe('Dashboard — empty states', () => {
  it('renders honest empty states for numbers and conversations', async () => {
    emptyTenant();
    const html = await render();
    expect(html).toContain('No numbers connected yet');
    expect(html).toContain('No conversations yet');
    expect(html).toContain('No agent configured.');
  });

  it('renders real records instead of empty states once data exists', async () => {
    populatedTenant();
    const html = await render();
    expect(html).toContain('+15550001111');
    expect(html).toContain('Jane Roe');
    expect(html).not.toContain('No conversations yet');
  });
});

describe('Dashboard — takeover control', () => {
  it('renders the takeover toggle only when the tenant has an agent', async () => {
    populatedTenant();
    expect(await render()).toContain('TAKEOVER_TOGGLE');

    emptyTenant();
    expect(await render()).not.toContain('TAKEOVER_TOGGLE');
  });
});
