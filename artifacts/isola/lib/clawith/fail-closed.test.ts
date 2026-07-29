/**
 * Proof 15 and the §6 guarantee: on the gated inbox-46 path, no Clawith
 * failure may produce a reply from an unrelated native brain.
 */
import { describe, expect, it, vi } from 'vitest';
import { CLAWITH_SCHEMA_VERSION, type ClawithToolDefinition } from './contract';
import { ClawithFailure, isConfigurationFailure, isRetryable, classifyHttpStatus, classifyThrown } from './errors';
import { SAFE_UNAVAILABILITY_REPLY, invokeClawithGated, outcomeForFailure } from './invoke';

const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const ENV = { CLAWITH_SHARED_SECRET: 'test-secret' } as unknown as NodeJS.ProcessEnv;

const TOOL: ClawithToolDefinition = {
  name: 'crm.contact.lookup',
  description: 'Look up a contact',
  arguments: ['phone'],
  mutating: false,
};

function input(overrides: Record<string, unknown> = {}, fetchImpl?: unknown) {
  return {
    tenantId: TENANT,
    bindingTenantId: TENANT,
    conversationTenantId: TENANT,
    businessId: 'epic-communications-inc',
    chatwootAccountId: '5',
    inboxId: '46',
    conversationId: 'conv-1',
    inboundMessageId: 'msg-1',
    contactRef: 'contact:1',
    customerMessage: 'do you install fibre?',
    history: [],
    designatedAgentId: AGENT,
    allowedTools: [TOOL],
    ownershipState: 'AI_OWNED' as const,
    correlationId: 'corr-1',
    clientOptions: {
      env: ENV,
      sleep: async () => {},
      fetchImpl: (fetchImpl ?? (async () => okResponse())) as typeof fetch,
    },
    ...overrides,
  };
}

function okResponse(overrides: Record<string, unknown> = {}, status = 200): Response {
  const body = {
    schema_version: CLAWITH_SCHEMA_VERSION,
    agent_id: AGENT,
    session_id: 'sess-1',
    correlation_id: 'corr-1',
    customer_reply: 'Yes, we do.',
    confidence: 0.9,
    qualification_state: 'unknown',
    tool_requests: [],
    escalation: { requested: false },
    ...overrides,
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const FAILURE_KINDS = [
  'secret_missing',
  'agent_missing',
  'request_invalid',
  'timeout',
  'auth_rejected',
  'http_error',
  'network_error',
  'invalid_response',
  'correlation_mismatch',
  'agent_mismatch',
  'tenant_mismatch',
  'unsupported_tool',
  'contradictory_response',
] as const;

describe('proof 15: a gated inbox-46 failure never falls back to native', () => {
  it.each(FAILURE_KINDS)('%s resolves to an approved outcome, never a native reply', (kind) => {
    const outcome = outcomeForFailure(new ClawithFailure(kind, 'detail'), {
      correlationId: 'corr-1',
      conversationId: 'conv-1',
      inboundMessageId: 'msg-1',
    });
    expect(['safe_unavailable', 'suppressed']).toContain(outcome.kind);
    if (outcome.kind === 'safe_unavailable') {
      expect(outcome.text).toBe(SAFE_UNAVAILABILITY_REPLY);
      expect(outcome.needsHandoff).toBe(true);
    } else {
      expect(outcome.text).toBeNull();
    }
    expect(outcome).not.toHaveProperty('provider', 'native');
    expect((outcome as { failure: { kind: string } }).failure.kind).toBe(kind);
  });

  it('a Clawith timeout produces the safe line plus exactly one escalation', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    const outcome = await invokeClawithGated(input({}, fetchImpl));
    expect(outcome.kind).toBe('safe_unavailable');
    expect(outcome.text).toBe(SAFE_UNAVAILABILITY_REPLY);
    expect(outcome.needsHandoff).toBe(true);
  });

  it('a 401 authentication failure produces the safe line, NOT a native answer', async () => {
    const fetchImpl = vi.fn(async () => okResponse({}, 401));
    const outcome = await invokeClawithGated(input({}, fetchImpl));
    expect(outcome.kind).toBe('safe_unavailable');
    expect(outcome.text).toBe(SAFE_UNAVAILABILITY_REPLY);
    expect((outcome as { failure: { kind: string; status: number | null } }).failure).toMatchObject({
      kind: 'auth_rejected',
      status: 401,
    });
  });

  it('invalid structured output produces the safe line, NOT a native answer', async () => {
    const fetchImpl = vi.fn(async () => okResponse({ confidence: 'very' }));
    const outcome = await invokeClawithGated(input({}, fetchImpl));
    expect(outcome.kind).toBe('safe_unavailable');
    expect((outcome as { failure: { kind: string } }).failure.kind).toBe('invalid_response');
  });

  it('a missing configured agent is recorded and SUPPRESSED — no fabricated customer claim', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const outcome = await invokeClawithGated(input({ designatedAgentId: '' }, fetchImpl));
    expect(outcome.kind).toBe('suppressed');
    expect(outcome.text).toBeNull();
    expect(outcome.needsHandoff).toBe(false);
    expect((outcome as { failure: { kind: string } }).failure.kind).toBe('agent_missing');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('a cross-tenant conversation is suppressed before any request is sent', async () => {
    const fetchImpl = vi.fn(async () => okResponse());
    const outcome = await invokeClawithGated(input({ conversationTenantId: 'other-tenant' }, fetchImpl));
    expect(outcome.kind).toBe('suppressed');
    expect((outcome as { failure: { kind: string } }).failure.kind).toBe('request_invalid');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('the safe line makes no claim that a human has already replied', () => {
    expect(SAFE_UNAVAILABILITY_REPLY).not.toMatch(/has (already )?(replied|responded|been assigned)/i);
    expect(SAFE_UNAVAILABILITY_REPLY).not.toMatch(/within \d+/i);
  });
});

describe('the happy path still works', () => {
  it('returns the Clawith reply verbatim', async () => {
    const outcome = await invokeClawithGated(input());
    expect(outcome.kind).toBe('reply');
    expect(outcome.text).toBe('Yes, we do.');
    expect(outcome.needsHandoff).toBe(false);
  });

  it('treats a Clawith-requested escalation as a handoff, not a chat message', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        customer_reply: null,
        escalation: {
          requested: true,
          reason_code: 'explicit_human_request',
          explanation: 'customer asked for a person',
          urgency: 'normal',
          customer_handoff_message: 'Let me get a colleague for you.',
        },
      }),
    );
    const outcome = await invokeClawithGated(input({}, fetchImpl));
    expect(outcome.kind).toBe('escalate');
    expect(outcome.needsHandoff).toBe(true);
    expect(outcome.text).toBe('Let me get a colleague for you.');
  });

  it('suppresses a tool-only turn rather than improvising a reply', async () => {
    const fetchImpl = vi.fn(async () =>
      okResponse({
        customer_reply: null,
        tool_requests: [{ tool_name: 'crm.contact.lookup', operation_id_hint: 'op-1', arguments: {}, reason: 'id' }],
      }),
    );
    const outcome = await invokeClawithGated(input({}, fetchImpl));
    expect(outcome.kind).toBe('suppressed');
    expect(outcome.text).toBeNull();
  });
});

describe('failure taxonomy', () => {
  it('retries only transient transport kinds', () => {
    expect(isRetryable('timeout')).toBe(true);
    expect(isRetryable('network_error')).toBe(true);
    expect(isRetryable('http_error')).toBe(true);
    for (const kind of ['auth_rejected', 'invalid_response', 'secret_missing', 'unsupported_tool'] as const) {
      expect(isRetryable(kind), kind).toBe(false);
    }
  });

  it('separates configuration defects from runtime faults', () => {
    for (const kind of ['secret_missing', 'agent_missing', 'request_invalid', 'tenant_mismatch'] as const) {
      expect(isConfigurationFailure(kind), kind).toBe(true);
    }
    for (const kind of ['timeout', 'auth_rejected', 'invalid_response'] as const) {
      expect(isConfigurationFailure(kind), kind).toBe(false);
    }
  });

  it('classifies statuses and thrown errors', () => {
    expect(classifyHttpStatus(401)).toBe('auth_rejected');
    expect(classifyHttpStatus(403)).toBe('auth_rejected');
    expect(classifyHttpStatus(500)).toBe('http_error');
    expect(classifyHttpStatus(404)).toBe('http_error');
    const timeout = new Error('t');
    timeout.name = 'TimeoutError';
    expect(classifyThrown(timeout)).toBe('timeout');
    expect(classifyThrown(new Error('socket hang up'))).toBe('network_error');
  });
});
