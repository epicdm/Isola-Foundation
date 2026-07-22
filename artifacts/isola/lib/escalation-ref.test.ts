import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, allowedPhoneNumberIds } = vi.hoisted(() => ({
  prismaMock: {
    escalationRef: {
      create:      vi.fn(),
      findUnique:  vi.fn(),
    },
  },
  // Mutable stand-in for brain-provider.ts's ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS —
  // that Set is computed once at module load from a hardcoded floor + env var,
  // so tests can't flip membership via process.env after import; mocking the
  // module and mutating this Set directly is the only way to control it per test.
  allowedPhoneNumberIds: new Set<string>(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./brain-provider', () => ({ ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS: allowedPhoneNumberIds }));

import { createEscalationRef, resolveEscalationRef, mintEscalationRefIfAllowed } from './escalation-ref';

const MINT_PARAMS = {
  tenantId:          'tenant-1',
  conversationId:    'conv-1',
  clawithAgentId:    'clawith-agent-1',
  chatwootBindingId: 'binding-1',
  chatwootInboxId:   'inbox-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  allowedPhoneNumberIds.clear();
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

describe('mintEscalationRefIfAllowed', () => {
  const PHONE_NUMBER_ID = '1023804347491554'; // EMA sales/onboarding number

  it('skips the mint and returns nulls without throwing when phoneNumberId is not on the allowlist', async () => {
    // allowedPhoneNumberIds is empty by default (see beforeEach) — matches
    // production today: migration 20260721020000_harden_escalation_ref is
    // not applied anywhere, so the allowlist must stay empty until it is.
    const result = await mintEscalationRefIfAllowed({ ...MINT_PARAMS, phoneNumberId: PHONE_NUMBER_ID });

    expect(result).toEqual({ token: null, correlationId: null });
    expect(prismaMock.escalationRef.create).not.toHaveBeenCalled();
  });

  it('mints normally, unchanged, when phoneNumberId is on the allowlist', async () => {
    allowedPhoneNumberIds.add(PHONE_NUMBER_ID);
    prismaMock.escalationRef.create.mockResolvedValue({});

    const result = await mintEscalationRefIfAllowed({ ...MINT_PARAMS, phoneNumberId: PHONE_NUMBER_ID });

    expect(typeof result.token).toBe('string');
    expect(result.token!.length).toBeGreaterThan(20);
    expect(typeof result.correlationId).toBe('string');

    expect(prismaMock.escalationRef.create).toHaveBeenCalledTimes(1);
    const data = prismaMock.escalationRef.create.mock.calls[0][0].data;
    expect(data.tenant_id).toBe('tenant-1');
    expect(data.conversation_id).toBe('conv-1');
    expect(data.clawith_agent_id).toBe('clawith-agent-1');
    expect(data.chatwoot_binding_id).toBe('binding-1');
    expect(data.chatwoot_inbox_id).toBe('inbox-1');
    expect(data.token).toBe(result.token);
    expect(data.correlation_id).toBe(result.correlationId);
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
