import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { prismaMock, surfaceHandoffMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    conversation: {
      findUnique: vi.fn(),
      update:     vi.fn(),
    },
    chatwootBinding: {
      findMany: vi.fn(),
    },
  },
  surfaceHandoffMock: vi.fn(),
  auditMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/chatwoot-handoff', () => ({ surfaceHandoff: surfaceHandoffMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));

import { POST } from './route';

const TOKEN = 'test-customer-tools-token';

function req(body: unknown, token: string | null = TOKEN): NextRequest {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== null) headers.authorization = `Bearer ${token}`;
  return new NextRequest('http://localhost/api/customer/escalate', {
    method:  'POST',
    headers,
    body:    JSON.stringify(body),
  });
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                       'conv-1',
    tenant_id:                'tenant-1',
    chatwoot_conversation_id: 42,
    customer_phone:           '+18095551234',
    human_handling:           false,
    ...overrides,
  };
}

function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id:         'binding-1',
    tenant_id:  'tenant-1',
    base_url:   'https://inbox.epic.dm',
    account_id: '5',
    mode:       'a2',
    updated_at: new Date('2026-01-01'),
    tenant:     { status: 'active' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ISOLA_CUSTOMER_TOOLS_TOKEN = TOKEN;
  process.env.CHATWOOT_AGENTBOT_TOKEN = 'bot-token';
  prismaMock.chatwootBinding.findMany.mockResolvedValue([bindingRow()]);
  prismaMock.conversation.findUnique.mockResolvedValue(conversationRow());
  prismaMock.conversation.update.mockResolvedValue({});
});

describe('POST /api/customer/escalate — auth', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await POST(req({ conversation_id: 'conv-1' }, null));
    expect(res.status).toBe(401);
    const bodyJson = await res.json();
    expect(bodyJson.correlation_id).toBeTruthy();
  });

  it('returns 401 with a wrong bearer token', async () => {
    const res = await POST(req({ conversation_id: 'conv-1' }, 'wrong-token'));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) when ISOLA_CUSTOMER_TOOLS_TOKEN is unset', async () => {
    delete process.env.ISOLA_CUSTOMER_TOOLS_TOKEN;
    const res = await POST(req({ conversation_id: 'conv-1' }, TOKEN));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/customer/escalate — input validation', () => {
  it('returns 400 when conversation_id is missing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(prismaMock.conversation.findUnique).not.toHaveBeenCalled();
  });
});

describe('POST /api/customer/escalate — ownership resolution (server-side only)', () => {
  it('returns 404 for an unknown conversation_id', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(null);
    const res = await POST(req({ conversation_id: 'does-not-exist' }));
    expect(res.status).toBe(404);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('ignores client-supplied tenant_id / account_id / inbox_id and resolves entirely from conversation_id', async () => {
    const res = await POST(
      req({
        conversation_id: 'conv-1',
        tenant_id:  'attacker-tenant',
        account_id: '999',
        inbox_id:   '999',
      }),
    );
    expect(res.status).toBe(200);
    // The binding lookup must be keyed on the conversation's OWN tenant_id,
    // never on anything the client sent.
    expect(prismaMock.chatwootBinding.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: 'tenant-1', mode: 'a2' } }),
    );
    expect(surfaceHandoffMock).toHaveBeenCalledWith(
      'https://inbox.epic.dm', '5', 42, 'bot-token', expect.any(String),
    );
  });

  it('returns 409 when the conversation has no chatwoot_conversation_id', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(conversationRow({ chatwoot_conversation_id: null }));
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the tenant has no a2 ChatwootBinding', async () => {
    prismaMock.chatwootBinding.findMany.mockResolvedValue([]);
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 500 when CHATWOOT_AGENTBOT_TOKEN is not configured', async () => {
    delete process.env.CHATWOOT_AGENTBOT_TOKEN;
    const res = await POST(req({ conversation_id: 'conv-1' }));
    expect(res.status).toBe(500);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customer/escalate — successful escalation', () => {
  it('sets human_handling=true, surfaces into Chatwoot, audits, and returns status=escalated', async () => {
    const res = await POST(req({ conversation_id: 'conv-1', summary: 'Wants to cancel service.' }));
    const bodyJson = await res.json();

    expect(res.status).toBe(200);
    expect(bodyJson).toEqual(
      expect.objectContaining({ ok: true, status: 'escalated', conversation_id: 'conv-1' }),
    );
    expect(bodyJson.correlation_id).toBeTruthy();

    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data:  { human_handling: true },
    });

    expect(surfaceHandoffMock).toHaveBeenCalledTimes(1);
    const note = surfaceHandoffMock.mock.calls[0][4];
    expect(note).toContain('Wants to cancel service.');

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'escalate_to_human.invoked',
        entityId: 'conv-1',
        meta:     expect.objectContaining({ already_escalated: false, has_summary: true }),
      }),
    );
  });

  it('uses a generic note when no summary is provided', async () => {
    await POST(req({ conversation_id: 'conv-1' }));
    const note = surfaceHandoffMock.mock.calls[0][4];
    expect(note).toBe('🙋 Customer requested a human — escalate_to_human invoked.');
  });
});

describe('POST /api/customer/escalate — idempotency (repeat calls)', () => {
  it('a repeat call on an already-escalated conversation still succeeds, still calls surfaceHandoff (which single-fires itself), and reports already_escalated', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(conversationRow({ human_handling: true }));

    const res = await POST(req({ conversation_id: 'conv-1' }));
    const bodyJson = await res.json();

    expect(res.status).toBe(200);
    expect(bodyJson.status).toBe('already_escalated');
    // human_handling update is still issued (idempotent no-op at the DB layer)
    expect(prismaMock.conversation.update).toHaveBeenCalledWith({
      where: { id: 'conv-1' },
      data:  { human_handling: true },
    });
    expect(surfaceHandoffMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ already_escalated: true }) }),
    );
  });
});
