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

const { callClawithWithFallback } = await import('./fallback');

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const PRIMARY_AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const OTHER_AGENT = '9a1c9e2e-6b1a-4b9a-8b1a-2f3c4d5e6f70';

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

// A pairing naming a different agent as an "approved fallback" — the exact
// shape the old CLAWITH_APPROVED_FALLBACK_AGENTS env var used to accept.
// It must now be inert: nothing in fallback.ts reads it any more.
const envThatUsedToConfigureFallback = {
  CLAWITH_APPROVED_FALLBACK_AGENTS: `${PRIMARY_AGENT}:${OTHER_AGENT}`,
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.clearAllMocks();
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

describe('callClawithWithFallback — forwards the Foundation tenantId to the client for circuit-key scoping', () => {
  it('passes input.tenantId through as clientOptions.tenantId, distinct from request.tenant_id on the wire', async () => {
    callClawithStructuredMock.mockResolvedValue(okResult());
    const fetchImpl = vi.fn();
    await callClawithWithFallback({
      request: request(),
      tenantId: TENANT,
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });

    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
    const [calledReq, calledOptions] = callClawithStructuredMock.mock.calls[0] as unknown as [
      ReturnType<typeof request>,
      { tenantId?: string; fetchImpl?: unknown },
    ];
    expect(calledReq.tenant_id).toBe(TENANT);
    expect(calledOptions.tenantId).toBe(TENANT);
    // The caller's other clientOptions (e.g. fetchImpl) still reach the client.
    expect(calledOptions.fetchImpl).toBe(fetchImpl);
  });
});

describe('callClawithWithFallback — automatic fallback to a different Clawith agent is disabled', () => {
  it('rethrows a payment_required failure immediately — no second agent is ever attempted', async () => {
    const primaryFailure = new ClawithFailure('payment_required', 'Insufficient Balance', 402);
    callClawithStructuredMock.mockRejectedValue(primaryFailure);

    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: {} as NodeJS.ProcessEnv }),
    ).rejects.toBe(primaryFailure);
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });

  it('stays disabled even when a legacy fallback-pairing env var names an approved agent', async () => {
    const primaryFailure = new ClawithFailure('payment_required', 'Insufficient Balance', 402);
    callClawithStructuredMock.mockRejectedValue(primaryFailure);

    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envThatUsedToConfigureFallback }),
    ).rejects.toBe(primaryFailure);

    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
    // Never even resolves a candidate agent — the env var is not read at all.
    expect(prismaMock.clawithBinding.findFirst).not.toHaveBeenCalled();
    const [[calledReq]] = callClawithStructuredMock.mock.calls as unknown as [[ReturnType<typeof request>]];
    expect(calledReq.designated_agent_id).toBe(PRIMARY_AGENT);
  });

  it('rethrows every failure kind unchanged, including provider_error_leaked — never masked by a retry', async () => {
    const primaryFailure = new ClawithFailure('provider_error_leaked', 'model_call_failed', null);
    callClawithStructuredMock.mockRejectedValue(primaryFailure);

    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envThatUsedToConfigureFallback }),
    ).rejects.toBe(primaryFailure);
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });

  it('wraps a non-ClawithFailure thrown error into a classified failure without attempting a second agent', async () => {
    callClawithStructuredMock.mockRejectedValue(new Error('socket hang up'));

    await expect(
      callClawithWithFallback({ request: request(), tenantId: TENANT, env: envThatUsedToConfigureFallback }),
    ).rejects.toMatchObject({ kind: 'network_error' });
    expect(callClawithStructuredMock).toHaveBeenCalledTimes(1);
  });
});

describe('callClawithWithFallback — same logical agent identity is preserved', () => {
  it('never sends a request with any designated_agent_id other than the one the caller supplied', async () => {
    callClawithStructuredMock.mockResolvedValue(okResult());
    await callClawithWithFallback({ request: request(PRIMARY_AGENT), tenantId: TENANT, env: envThatUsedToConfigureFallback });

    for (const [calledReq] of callClawithStructuredMock.mock.calls as unknown as [ReturnType<typeof request>][]) {
      expect(calledReq.designated_agent_id).toBe(PRIMARY_AGENT);
      expect(calledReq.designated_agent_id).not.toBe(OTHER_AGENT);
    }
  });
});
