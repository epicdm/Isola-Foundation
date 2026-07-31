import { describe, expect, it, vi } from 'vitest';
import { CLAWITH_SCHEMA_VERSION, type ClawithToolDefinition } from './contract';
import { ClawithFailure } from './errors';
import { buildClawithRequest } from './request';
import { MAX_ATTEMPTS, callClawithStructured } from './client';

const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const ENV = { CLAWITH_SHARED_SECRET: 'test-secret' } as unknown as NodeJS.ProcessEnv;

const TOOL: ClawithToolDefinition = {
  name: 'crm.contact.lookup',
  description: 'Look up a contact',
  arguments: ['phone'],
  mutating: false,
};

const REQUEST = buildClawithRequest({
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
  designatedAgentId: AGENT,
  allowedTools: [TOOL],
  ownershipState: 'AI_OWNED',
  correlationId: 'corr-1',
});

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: CLAWITH_SCHEMA_VERSION,
    agent_id: AGENT,
    session_id: 'sess-1',
    correlation_id: 'corr-1',
    customer_reply: 'hi there',
    confidence: 0.9,
    qualification_state: 'unknown',
    tool_requests: [],
    escalation: { requested: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const noSleep = async () => {};

describe('callClawithStructured — transport', () => {
  it('sends the structured envelope, the secret header and the correlation header', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Isola-Secret']).toBe('test-secret');
    expect(headers['X-Isola-Correlation-Id']).toBe('corr-1');
    expect(headers['X-Isola-Schema-Version']).toBe(CLAWITH_SCHEMA_VERSION);
    expect(JSON.parse(init.body as string).tenant_id).toBe(TENANT);
  });

  it('proof 17: no BFF-v2 function or endpoint is invoked', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/api/isola/bridge/message');
    expect(url).not.toContain('bff.epic.dm');
    expect(url).not.toContain('/api/internal/agent/invoke');
    expect(JSON.stringify(init)).not.toContain('bff');
  });
});

describe('proof 13: timeout is classified', () => {
  it('classifies an aborted request as timeout, not as a generic failure', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('retries a timeout exactly once and no more', async () => {
    const fetchImpl = vi.fn(async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    });
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toBeInstanceOf(ClawithFailure);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('returns the second attempt when the first times out', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call === 1) {
        const err = new Error('timeout');
        err.name = 'TimeoutError';
        throw err;
      }
      return jsonResponse(okBody());
    });
    const result = await callClawithStructured(REQUEST, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      env: ENV,
      sleep: noSleep,
    });
    expect(result.attempts).toBe(2);
    expect(result.response.customer_reply).toBe('hi there');
  });
});

describe('proof 14: authentication failure is classified', () => {
  it('classifies 401 as auth_rejected — the exact live inbox-46 condition', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_isola_bridge_secret' }, 401));
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'auth_rejected', status: 401 });
  });

  it('classifies 403 as auth_rejected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'forbidden' }, 403));
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'auth_rejected' });
  });

  it('does NOT retry an auth rejection — a rotated secret fails identically twice', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'invalid_isola_bridge_secret' }, 401));
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toBeInstanceOf(ClawithFailure);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('never attempts a request at all when the secret is absent', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await expect(
      callClawithStructured(REQUEST, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        env: {} as NodeJS.ProcessEnv,
        sleep: noSleep,
      }),
    ).rejects.toMatchObject({ kind: 'secret_missing' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('other transport classifications', () => {
  it('classifies 5xx as http_error and retries once', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'boom' }, 503));
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'http_error', status: 503 });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it('classifies a non-JSON body as invalid_response and does not retry it', async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error('not json');
          },
          text: async () => '<html>502</html>',
        }) as unknown as Response,
    );
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'invalid_response' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a correlation mismatch from a 200 body', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody({ correlation_id: 'corr-OTHER' })));
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'correlation_mismatch' });
  });

  it('rejects a tool the request did not authorise', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        okBody({
          customer_reply: null,
          tool_requests: [{ tool_name: 'odoo.execute_kw', operation_id_hint: 'op-1', arguments: {}, reason: 'x' }],
        }),
      ),
    );
    await expect(
      callClawithStructured(REQUEST, { fetchImpl: fetchImpl as unknown as typeof fetch, env: ENV, sleep: noSleep }),
    ).rejects.toMatchObject({ kind: 'unsupported_tool' });
  });
});
