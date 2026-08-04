/**
 * End-to-end proof that generateReply() — the single chokepoint both live
 * customer paths (app/api/chatwoot/agent-bot/route.ts and the direct
 * WhatsApp webhook via lib/agent.ts) funnel through — actually enforces the
 * B2 exposure gate using the REAL production B1 classifications, not a
 * synthetic fixture. See lib/brain-provider.test.ts for the pre-existing
 * claim-guard suite (which uses its own synthetic, exposure-gate-exempted
 * fixture) and lib/clawith/customer-exposure-gate.test.ts for the gate's
 * own unit coverage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReply, type BrainAgent, type ClawithBindingInput } from './brain-provider';

const { chatCompleteMock } = vi.hoisted(() => ({ chatCompleteMock: vi.fn() }));
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));

vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>();
  return { ...actual, chatComplete: chatCompleteMock };
});
vi.mock('./audit', () => ({ audit: auditMock }));
vi.mock('./prisma', () => ({ prisma: {} }));

// Canonical topology from xp-foundation-agent-exposure-enforcement-2026-08-04.
const FOUNDATION_TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const EMA = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162'; // PUBLIC
const EPIC_FRONT_DESK = 'a71578a4-12cc-4e38-ad24-4b9fffd69309'; // PUBLIC
const ATLAS = '9baf6f00-f9e0-4bd4-9672-10865f438e2c'; // INTERNAL
const SCOUT = '695930c9-cfb0-4b52-b33e-f3826493b891'; // INTERNAL
const LEDGER_UNKNOWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // unclassified
const OTHER_TENANT = 'a-different-foundation-tenant';

function agent(overrides: Partial<BrainAgent> = {}): BrainAgent {
  return {
    id: 'agent-row-1',
    intelligence_tier: 'standard',
    brain_provider: 'clawith',
    flowise_flow_id: null,
    is_active: true,
    ...overrides,
  };
}

function binding(clawithAgentId: string, tenantId = FOUNDATION_TENANT): ClawithBindingInput {
  return {
    tenant_id: tenantId,
    clawith_agent_id: clawithAgentId,
    paperclip_agent_id: 'pc-agent',
    paperclip_company_id: 'pc-co',
  };
}

function mockBridgeReply(body: Record<string, unknown>, ok = true) {
  (global.fetch as any).mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CLAWITH_SHARED_SECRET = 'test-secret';
  delete process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON;
  delete process.env.ISOLA_LEGACY_CLAWITH_FALLBACK;
  chatCompleteMock.mockResolvedValue({ text: 'Native fallback reply', inputTokens: 1, outputTokens: 1 });
  global.fetch = vi.fn();
  mockBridgeReply({ reply: 'Hello from Clawith', needs_handoff: false });
});

const baseParams = {
  system: 'system prompt',
  messages: [{ role: 'user' as const, content: 'hi' }],
  sessionId: 'conv-1',
  phoneNumberId: '278390858690809',
  senderPhone: '+17671234567',
};

describe('generateReply — B2 PUBLIC positive (customer route may reach a PUBLIC agent)', () => {
  it('a customer route reaches EMA — bridge is called, reply is provider=clawith', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(EMA),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('clawith');
    expect(result.text).toBe('Hello from Clawith');
  });

  it('a customer route reaches EPIC Front Desk with the correct binding — bridge is called', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(EPIC_FRONT_DESK),
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(result.provider).toBe('clawith');
  });
});

describe('generateReply — B2 PUBLIC negative (fail closed, no substitution)', () => {
  it('a customer route cannot reach Atlas (INTERNAL) — bridge is never called, falls back to native', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(ATLAS),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
    expect(result.text).toBe('Native fallback reply');
  });

  it('a customer route cannot reach Scout (INTERNAL) — bridge is never called, falls back to native', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(SCOUT),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('a customer route cannot reach Ledger while unclassified — bridge is never called', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(LEDGER_UNKNOWN_ID),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('missing policy for the requested agent fails closed identically to Ledger', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding('never-classified-agent'),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('a disabled PUBLIC agent (via env override on a non-floor pair) fails closed', async () => {
    process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'disabled-agent', classification: 'PUBLIC', enabled: false },
    ]);
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: OTHER_TENANT,
      clawithBinding: binding('disabled-agent', OTHER_TENANT),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('a mismatched tenant on the ClawithBinding fails closed even for EMA (PUBLIC) — never trusts a cross-tenant binding', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(EMA, OTHER_TENANT), // binding says it belongs to a different tenant
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('an inactive Foundation agent fails closed regardless of classification', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent({ is_active: false }),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(EMA),
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
  });

  it('no fallback crosses into a different or INTERNAL agent — a denial for Atlas never silently tries EMA or any other agent', async () => {
    await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: binding(ATLAS),
    });
    // The only fetch that could have happened is the (never-taken) bridge
    // call — proven zero above. Nothing in this module can retarget a
    // denial at a different clawith_agent_id; there is no such parameter.
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('generateReply — B2 audits the no-binding-at-all case too (Codex P2 finding)', () => {
  it('a clawith-provider agent with no ClawithBinding resolved still writes a B4 audit entry, and never calls the bridge', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent(),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: null,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(result.provider).toBe('native');
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'clawith.exposure.customer_denied',
        tenantId: FOUNDATION_TENANT,
        meta: expect.objectContaining({ reason: 'no_clawith_binding' }),
      }),
    );
  });
});

describe('generateReply — B2 does not affect non-Clawith providers', () => {
  it('a native-provider agent is untouched by the exposure gate (no clawithBinding path is even evaluated)', async () => {
    const result = await generateReply({
      ...baseParams,
      agent: agent({ brain_provider: 'native' }),
      tenantId: FOUNDATION_TENANT,
      clawithBinding: null,
    });
    expect(result.provider).toBe('native');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
