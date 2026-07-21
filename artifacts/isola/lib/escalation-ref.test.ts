import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    escalationRef: {
      create:      vi.fn(),
      findUnique:  vi.fn(),
    },
  },
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));

import { createEscalationRef, resolveEscalationRef } from './escalation-ref';

const MINT_PARAMS = {
  tenantId:          'tenant-1',
  conversationId:    'conv-1',
  clawithAgentId:    'clawith-agent-1',
  chatwootBindingId: 'binding-1',
  chatwootInboxId:   'inbox-1',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createEscalationRef', () => {
  it('mints a unique opaque token and correlation id, and persists the full scoped capability', async () => {
    prismaMock.escalationRef.create.mockResolvedValue({});
    const { token, correlationId } = await createEscalationRef(MINT_PARAMS);

    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
    expect(typeof correlationId).toBe('string');
    expect(correlationId).not.toBe(token);

    expect(prismaMock.escalationRef.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.escalationRef.create.mock.calls[0][0].data;
    expect(data.purpose).toBe('escalate_to_human');
    expect(data.tenant_id).toBe('tenant-1');
    expect(data.conversation_id).toBe('conv-1');
    expect(data.clawith_agent_id).toBe('clawith-agent-1');
    expect(data.chatwoot_binding_id).toBe('binding-1');
    expect(data.chatwoot_inbox_id).toBe('inbox-1');
    expect(data.correlation_id).toBe(correlationId);
    expect(data.token).toBe(token);
    expect(data.expires_at).toBeInstanceOf(Date);
    expect(data.expires_at.getTime()).toBeGreaterThan(Date.now());
  });

  it('mints a different token and correlation id on each call', async () => {
    prismaMock.escalationRef.create.mockResolvedValue({});
    const a = await createEscalationRef(MINT_PARAMS);
    const b = await createEscalationRef(MINT_PARAMS);
    expect(a.token).not.toBe(b.token);
    expect(a.correlationId).not.toBe(b.correlationId);
  });

  it('persists a null chatwoot_inbox_id when the conversation has no live inbox snapshot (legacy conversation)', async () => {
    prismaMock.escalationRef.create.mockResolvedValue({});
    await createEscalationRef({ ...MINT_PARAMS, chatwootInboxId: null });

    const data = prismaMock.escalationRef.create.mock.calls[0][0].data;
    expect(data.chatwoot_inbox_id).toBeNull();
  });
});

describe('resolveEscalationRef', () => {
  it('returns null for an unknown token', async () => {
    prismaMock.escalationRef.findUnique.mockResolvedValue(null);
    const result = await resolveEscalationRef('does-not-exist');
    expect(result).toBeNull();
  });

  it('returns null for an expired token', async () => {
    prismaMock.escalationRef.findUnique.mockResolvedValue({
      purpose:             'escalate_to_human',
      tenant_id:           'tenant-1',
      conversation_id:     'conv-1',
      clawith_agent_id:    'clawith-agent-1',
      chatwoot_binding_id: 'binding-1',
      chatwoot_inbox_id:   'inbox-1',
      correlation_id:      'corr-1',
      expires_at:          new Date(Date.now() - 1000),
    });
    const result = await resolveEscalationRef('expired-token');
    expect(result).toBeNull();
  });

  it('returns the full bound scope for a valid, unexpired token', async () => {
    prismaMock.escalationRef.findUnique.mockResolvedValue({
      purpose:             'escalate_to_human',
      tenant_id:           'tenant-1',
      conversation_id:     'conv-1',
      clawith_agent_id:    'clawith-agent-1',
      chatwoot_binding_id: 'binding-1',
      chatwoot_inbox_id:   'inbox-1',
      correlation_id:      'corr-1',
      expires_at:          new Date(Date.now() + 60_000),
    });
    const result = await resolveEscalationRef('valid-token');
    expect(result).toEqual({
      purpose:           'escalate_to_human',
      tenantId:          'tenant-1',
      conversationId:    'conv-1',
      clawithAgentId:    'clawith-agent-1',
      chatwootBindingId: 'binding-1',
      chatwootInboxId:   'inbox-1',
      correlationId:     'corr-1',
    });
  });
});
