import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CLAWITH_SCHEMA_VERSION, type ClawithToolDefinition } from './contract';
import { ClawithFailure } from './errors';
import { buildClawithRequest } from './request';

const { prismaMock, callClawithStructuredMock } = vi.hoisted(() => ({
  prismaMock: { clawithBinding: { findFirst: vi.fn() } },
  callClawithStructuredMock: vi.fn(),
}));

vi.mock('../prisma', () => ({ prisma: prismaMock }));
vi.mock('./client', () => ({ callClawithStructured: callClawithStructuredMock }));

const {
  callClawithWithFallback,
  resolveApprovedFallback,
  CLAWITH_APPROVED_FALLBACK_AGENTS_ENV,
} = await import('./fallback');

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const PRIMARY_AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const FALLBACK_AGENT = '9a1c9e2e-6b1a-4b9a-8b1a-2f3c4d5e6f70';
const UNAPPROVED_AGENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const TOOL: ClawithToolDefinition = {
  name: 'crm.contact.lookup',
  description: 'Look up a contact',
  arguments: ['phone'],
  mutating: false,
};

function request(designatedAgentId = PRIMARY_AGENT) {
  return buildClawithRequest({
    tenantId: TENANT,
    bindingTenantId: TENANT,
    conversationTenantId: TENANT,
    businessId: 'epic-communications-inc',
    chatwootAccountId: '5',
    inboxId: '46',
    conversationId: 'conv-1',
    inboundMessageId: 'msg-1',
    contactRef: 'contact:1',
    customerMessage: 'hello',
    history: [],
    designatedAgentId,
    allowedTools: [TOOL],
    ownershipState: 'AI_OWNED',
    correlationId: 'corr-1',
  });
}

function okResult(agentId = PRIMARY_AGENT) {
  return {
    response: {
      schema_version: CLAWITH_SCHEMA_VERSION,
      agent_id: agentId,
      session_id: 'sess-1',
      correlation_id: 'corr-1',
      customer_reply: 'hi there',
      intent: null,
      confidence: 0.9,
      qualification_state: 'unknown' as const,
      knowledge_references: [],
      tool_requests: [],
      escalation: {
        requested: false,
        reason_code: null,
        explanation: null,
        urgency: null,
        required_team: null,
        customer_handoff_message: null,
      },
      missing_information: [],
      follow_up_required: false,
      usage: null,
    },
    attempts: 1,
    latencyMs: 5,
  };
}

const envWithFallback = {
  [CLAWITH_APPROVED_FALLBACK_AGENTS_ENV]: `${PRIMARY_AGENT}:${FALLBACK_AGENT}`,
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveApprovedFallback — tenant-verified, not just config-trusted', () => {
  it('returns null when no fallback pairing is configured at all', async () => {
    const result = await resolveApprovedFallback({
      tenantId: TENANT,
      primaryClawithAgentId: PRIMARY_AGENT,
      env: {} as NodeJS.ProcessEnv,
    });
    expect(result).toBeNull();
    expect(prismaMock.clawithBinding.findFirst).not.toHaveBeenCalled();
  });

  it('refuses the pairing when no ClawithBinding row exists for THIS tenant — cross-tenant fallback refused', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    const result = await resolveApprovedFallback({
      tenantId: TENANT,
      primaryClawithAgentId: PRIMARY_AGENT,
      env: envWithFallback,
    });
    expect(result).toBeNull();
    expect(prismaMock.clawithBinding.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: TENANT, clawith_agent_id: FALLBACK_AGENT } }),
    );
  });

  it('approves the pairing once a real ClawithBinding row for this tenant confirms it', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue({ clawith_agent_id: FALLBACK_AGENT });
    const result = await resolveApprovedFallback({
      tenantId: TENANT,
      primaryClawithAgentId: PRIMARY_AGENT,
      env: envWithFallback,
    });
    expect(result).toBe(FALLBACK_AGENT);
  });

  it('ignores a malformed or self-referential pairing entry', async () => {
    const result = await resolveApprovedFallback({
      tenantId: TENANT,
      primaryClawithAgentId: PRIMARY_AGENT,
      env: { [CLAWITH_APPROVED_FALLBACK_AGENTS_ENV]: `${PRIMARY_AGENT}:${PRIMARY_AGENT}` } as unknown as NodeJS.ProcessEnv,
    });
    expect(result).toBeNull();
  });
});

describe('callClawithWithFallback — normal success is unchanged', () => {
  it('returns the primary result untouched when the primary call succeeds', async () => {
    callClawithStructuredMock.mockResolvedValue(okResult());
    const result = await callClawithWithFallback({ request: request(), tenantId: TENANT, env: {} as NodeJS.ProcessEnv });
    expect(result.usedFallback).toBe(false);
    expect(result.primaryFailure).toBeNull();
    expect(result.response.customer_reply).toBe('hi there');
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });
});

describe('callClawithWithFallback — configuration failures never attempt a fallback', () => {
  it('rethrows a secret_missing failure without ever attempting fallback', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue({ clawith_agent_id: FALLBACK_AGENT });
    callClawithStructuredMock.mockRejectedValue(new ClawithFailure('secret_missing', null));
    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envWithFallback }),
    ).rejects.toMatchObject({ kind: 'secret_missing' });
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });
});

describe('callClawithWithFallback — no approved fallback configured', () => {
  it('immediately rethrows the primary failure — requirement 13, no waiting on a fallback that does not exist', async () => {
    callClawithStructuredMock.mockRejectedValue(new ClawithFailure('payment_required', 'Insufficient Balance', 402));
    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: {} as NodeJS.ProcessEnv }),
    ).rejects.toMatchObject({ kind: 'payment_required' });
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });

  it('immediately rethrows when the configured pairing does not resolve for this tenant', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    callClawithStructuredMock.mockRejectedValue(new ClawithFailure('payment_required', null, 402));
    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envWithFallback }),
    ).rejects.toMatchObject({ kind: 'payment_required' });
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });
});

describe('callClawithWithFallback — an approved fallback is attempted exactly once', () => {
  it('retries against the approved fallback agent and succeeds, preserving every other request field', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue({ clawith_agent_id: FALLBACK_AGENT });
    const primaryFailure = new ClawithFailure('payment_required', 'Insufficient Balance', 402);
    callClawithStructuredMock.mockRejectedValueOnce(primaryFailure).mockResolvedValueOnce(okResult(FALLBACK_AGENT));

    const result = await callClawithWithFallback({ request: request(), tenantId: TENANT, env: envWithFallback });

    expect(result.usedFallback).toBe(true);
    expect(result.primaryFailure).toBe(primaryFailure);
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(2);

    const [firstReq] = callClawithStructuredMock.mock.calls[0] as unknown as [ReturnType<typeof request>];
    const [secondReq] = callClawithStructuredMock.mock.calls[1] as unknown as [ReturnType<typeof request>];

    expect(firstReq.designated_agent_id).toBe(PRIMARY_AGENT);
    expect(secondReq.designated_agent_id).toBe(FALLBACK_AGENT);

    // Everything else about the turn's identity is untouched — same object
    // with only designated_agent_id swapped.
    const { designated_agent_id: _a, ...firstRest } = firstReq;
    const { designated_agent_id: _b, ...secondRest } = secondReq;
    expect(secondRest).toEqual(firstRest);
    expect(secondReq.tenant_id).toBe(firstReq.tenant_id);
    expect(secondReq.correlation_id).toBe(firstReq.correlation_id);
    expect(secondReq.allowed_tools).toEqual(firstReq.allowed_tools);
  });

  it('attempts the fallback at most once — a second fallback failure is not retried again', async () => {
    prismaMock.clawithBinding.findFirst.mockResolvedValue({ clawith_agent_id: FALLBACK_AGENT });
    const primaryFailure = new ClawithFailure('payment_required', null, 402);
    const fallbackFailure = new ClawithFailure('provider_unavailable', 'down', 503);
    callClawithStructuredMock.mockRejectedValueOnce(primaryFailure).mockRejectedValueOnce(fallbackFailure);

    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envWithFallback }),
    ).rejects.toMatchObject({ kind: 'provider_unavailable' });
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(2);
  });
});

describe('callClawithWithFallback — never a cross-tenant or unapproved agent/credential', () => {
  it('never calls callClawithStructured with an agent id that was not tenant-verified', async () => {
    // env names a pairing, but the tenant-scoped lookup finds nothing —
    // simulating a misconfigured env var naming another tenant's agent.
    prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    callClawithStructuredMock.mockRejectedValue(new ClawithFailure('payment_required', null, 402));

    await expect(
      callClawithWithFallback({
        request: request(),
        tenantId: TENANT,
        env: { [CLAWITH_APPROVED_FALLBACK_AGENTS_ENV]: `${PRIMARY_AGENT}:${UNAPPROVED_AGENT}` } as unknown as NodeJS.ProcessEnv,
      }),
    ).rejects.toMatchObject({ kind: 'payment_required' });

    for (const [calledReq] of callClawithStructuredMock.mock.calls as unknown as [ReturnType<typeof request>][]) {
      expect(calledReq.designated_agent_id).not.toBe(UNAPPROVED_AGENT);
    }
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });
});
