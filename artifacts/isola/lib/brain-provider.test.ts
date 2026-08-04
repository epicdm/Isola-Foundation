import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateReply, type BrainAgent, type ClawithBindingInput } from './brain-provider';

// Mock the external Clawith bridge (agents.epic.dm) via global.fetch, and the
// native Claude fallback via lib/ai — the regression suite must not depend
// on live Clawith (per dispatch instruction), so every "brain" response here
// is synthetic.
const { chatCompleteMock } = vi.hoisted(() => ({ chatCompleteMock: vi.fn() }));
const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));

vi.mock('./ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai')>();
  return { ...actual, chatComplete: chatCompleteMock };
});

vi.mock('./audit', () => ({ audit: auditMock }));
vi.mock('./prisma', () => ({ prisma: {} }));

const { guardReplyMock } = vi.hoisted(() => ({ guardReplyMock: vi.fn() }));
vi.mock('./claim-guard', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./claim-guard')>();
  return { ...actual, guardReply: guardReplyMock };
});

const SALES_TENANT = 'ema_sales_tenant';
const OTHER_TENANT = 'some-other-tenant';

/** This suite's fixture tenants/agent id are synthetic and not part of the
 *  real production B1 policy floor (lib/clawith/agent-exposure-policy.ts).
 *  The B2 exposure gate is exercised end to end in
 *  lib/brain-provider.exposure.test.ts against the real floor; here, an
 *  additive extra-policy env entry (mirrors this file's existing
 *  process.env.CLAWITH_SHARED_SECRET fixture pattern) authorizes exactly
 *  this suite's synthetic (tenant, agent) pairs as PUBLIC so every
 *  pre-existing claim-guard/escalation test below continues to exercise the
 *  Clawith bridge path unrelated to exposure semantics. */
function clawithBindingFor(tenantId: string): ClawithBindingInput {
  return {
    tenant_id: tenantId,
    clawith_agent_id: 'agent-123',
    paperclip_agent_id: 'pc-agent',
    paperclip_company_id: 'pc-co',
  };
}

function baseAgent(overrides: Partial<BrainAgent> = {}): BrainAgent {
  return {
    id: 'agent-row-1',
    intelligence_tier: 'standard',
    brain_provider: 'clawith',
    flowise_flow_id: null,
    is_active: true,
    ...overrides,
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

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.CLAWITH_SHARED_SECRET = 'test-secret';
  // B2 exposure gate fixture — authorizes this suite's synthetic tenant/agent
  // pairs as PUBLIC so the pre-existing claim-guard/escalation tests below
  // (which predate the exposure gate) keep exercising the Clawith bridge
  // path. See lib/brain-provider.exposure.test.ts for the gate's own coverage.
  process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
    { foundationTenantId: SALES_TENANT, clawithAgentId: 'agent-123', classification: 'PUBLIC', enabled: true },
    { foundationTenantId: OTHER_TENANT, clawithAgentId: 'agent-123', classification: 'PUBLIC', enabled: true },
  ]);
  chatCompleteMock.mockResolvedValue({ text: 'Native fallback reply', inputTokens: 10, outputTokens: 10 });
  global.fetch = vi.fn();
  // guardReply is mocked at the module level solely so the guard-error test
  // below can force a throw; every other test needs the REAL guard logic, so
  // delegate to it by default here.
  const actualClaimGuard = await vi.importActual<typeof import('./claim-guard')>('./claim-guard');
  guardReplyMock.mockImplementation(actualClaimGuard.guardReply);
});

const baseParams = {
  system: 'system prompt',
  messages: [{ role: 'user' as const, content: 'Can your AI answer my phone calls?' }],
  sessionId: 'conv-1',
  phoneNumberId: '1023804347491554',
  senderPhone: '+17671234567',
};

describe('generateReply — claim-guard integration (Clawith path, mocked bridge)', () => {
  it('a fabricated voice-AI claim from the (mocked) Clawith bridge is deflected for a sales tenant, and flags handoff', async () => {
    mockBridgeReply({ reply: 'Yes! Our AI answers your phone calls for you automatically.', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: SALES_TENANT,
      clawithBinding: clawithBindingFor(SALES_TENANT),
    });

    expect(result.text).not.toMatch(/answers your phone calls/i);
    expect(result.needsHandoff).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SALES_TENANT, action: 'claim_guard.blocked' }),
    );
  });

  it('an unratified/invented price from the (mocked) Clawith bridge is deflected for a sales tenant, and flags handoff', async () => {
    mockBridgeReply({ reply: 'That package is EC$425/mo, a great deal!', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: SALES_TENANT,
      clawithBinding: clawithBindingFor(SALES_TENANT),
    });

    expect(result.text).not.toMatch(/425/);
    expect(result.needsHandoff).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SALES_TENANT, action: 'claim_guard.blocked', meta: { rule: 'unratified_price' } }),
    );
  });

  it('a clean, ratified-price reply from the (mocked) bridge passes through unchanged for a sales tenant', async () => {
    mockBridgeReply({ reply: 'The WA-Receptionist is EC$250 setup plus EC$149/mo.', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: SALES_TENANT,
      clawithBinding: clawithBindingFor(SALES_TENANT),
    });

    expect(result.text).toBe('The WA-Receptionist is EC$250 setup plus EC$149/mo.');
    expect(result.needsHandoff).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('the same fabricated reply passes through unchanged for a non-sales tenant (proves scoping end to end)', async () => {
    mockBridgeReply({ reply: 'Yes! Our AI answers your phone calls for you automatically.', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    expect(result.text).toBe('Yes! Our AI answers your phone calls for you automatically.');
    expect(result.needsHandoff).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('an already-set needsHandoff from the brain is preserved alongside a guard pass', async () => {
    mockBridgeReply({ reply: 'The WA-Receptionist is EC$250 setup plus EC$149/mo.', needs_handoff: true });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: SALES_TENANT,
      clawithBinding: clawithBindingFor(SALES_TENANT),
    });

    expect(result.needsHandoff).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('generateReply — escalation-claim handoff backstop (defect-lite-concierge-stale-owner-active-silent-drop-2026-07-21)', () => {
  it('forces needsHandoff true when the (mocked) bridge reply itself claims escalation but returns needs_handoff: false — the exact conversation #100 repro', async () => {
    mockBridgeReply({
      reply:
        "Absolutely — I've already escalated your request to a human team member. They'll take it from here. " +
        "Thanks for reaching out, and someone from EPIC will be with you shortly!",
      needs_handoff: false,
    });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    expect(result.needsHandoff).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: OTHER_TENANT,
        action: 'escalation_claim.handoff_forced',
        meta: { rule: 'already_escalated' },
      }),
    );
  });

  it('does not double-fire (no extra audit call) when the brain already set needsHandoff: true on an escalation-claiming reply', async () => {
    mockBridgeReply({
      reply: "I've already escalated this to a human team member — they'll take it from here.",
      needs_handoff: true,
    });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    expect(result.needsHandoff).toBe(true);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('leaves a routine reply with no escalation claim untouched (needsHandoff stays false, no audit call)', async () => {
    mockBridgeReply({
      reply: 'Our team is available Monday to Friday, 9am–5pm.',
      needs_handoff: false,
    });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    expect(result.needsHandoff).toBe(false);
    expect(auditMock).not.toHaveBeenCalled();
  });
});

describe('generateReply — Clawith path forwards conversationRef to the Isola bridge', () => {
  it('sends the caller-supplied conversationRef as conversation_ref on the bridge request', async () => {
    mockBridgeReply({ reply: 'ok', needs_handoff: false });

    await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
      conversationRef: 'opaque-ref-123',
    });

    const [, init] = (global.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.conversation_ref).toBe('opaque-ref-123');
  });

  it('sends conversation_ref: null when no ref was minted for this turn', async () => {
    mockBridgeReply({ reply: 'ok', needs_handoff: false });

    await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    const [, init] = (global.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.conversation_ref).toBeNull();
  });

  it('forwards escalationCorrelationId as correlation_id on the bridge request', async () => {
    mockBridgeReply({ reply: 'ok', needs_handoff: false });

    await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
      conversationRef: 'opaque-ref-123',
      escalationCorrelationId: 'corr-abc',
    });

    const [, init] = (global.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.correlation_id).toBe('corr-abc');
  });

  it('never sends the raw Conversation id (sessionId) to the Isola bridge', async () => {
    mockBridgeReply({ reply: 'ok', needs_handoff: false });

    await generateReply({
      ...baseParams,
      sessionId: 'raw-conversation-db-id-should-not-leak',
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
      conversationRef: 'opaque-ref-123',
    });

    const [, init] = (global.fetch as any).mock.calls[0];
    const sentBody = JSON.parse(init.body);
    expect(sentBody.external_conversation_id).toBeUndefined();
    expect(JSON.stringify(sentBody)).not.toContain('raw-conversation-db-id-should-not-leak');
  });
});

describe('generateReply — claim-guard integration (native fallback path)', () => {
  it('a fabricated claim from the native fallback is deflected for a sales tenant', async () => {
    chatCompleteMock.mockResolvedValue({
      text: 'We guarantee higher sales for your business.',
      inputTokens: 5,
      outputTokens: 5,
    });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent({ brain_provider: 'native' }),
      tenantId: SALES_TENANT,
      clawithBinding: null,
    });

    expect(result.provider).toBe('native');
    expect(result.text).not.toMatch(/guarantee/i);
    expect(result.needsHandoff).toBe(true);
  });
});

describe('generateReply — claim-guard fail-closed on a guard error', () => {
  it('deflects (does not send the raw reply, does not throw) when guardReply itself throws for a sales tenant', async () => {
    guardReplyMock.mockImplementation(() => {
      throw new Error('synthetic guard failure');
    });
    mockBridgeReply({ reply: 'This text never gets a chance to be checked.', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: SALES_TENANT,
      clawithBinding: clawithBindingFor(SALES_TENANT),
    });

    expect(result.text).not.toBe('This text never gets a chance to be checked.');
    expect(result.needsHandoff).toBe(true);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: SALES_TENANT, action: 'claim_guard.error' }),
    );
  });

  it('passes the raw reply through for a non-sales tenant even when guardReply throws (error path stays scoped too)', async () => {
    guardReplyMock.mockImplementation(() => {
      throw new Error('synthetic guard failure');
    });
    mockBridgeReply({ reply: 'Unrelated tenant, unrelated reply text.', needs_handoff: false });

    const result = await generateReply({
      ...baseParams,
      agent: baseAgent(),
      tenantId: OTHER_TENANT,
      clawithBinding: clawithBindingFor(OTHER_TENANT),
    });

    expect(result.text).toBe('Unrelated tenant, unrelated reply text.');
  });
});
