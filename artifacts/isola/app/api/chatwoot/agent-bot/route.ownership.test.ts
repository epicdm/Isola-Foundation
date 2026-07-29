/**
 * Agent-bot route × conversation ownership.
 *
 * This is the file that proves Commit 2 changed what it meant to change and
 * nothing else. It drives the REAL route handler — not a re-implementation of
 * its rules — with the gate off (the production configuration) and with the
 * gate on for the one designed door, and asserts the difference.
 *
 * The properties under test:
 *   • GATE OFF preserves live behaviour exactly: the legacy boolean is still
 *     the reply gate, and Chatwoot resolution still clears it.
 *   • GATE ON makes the ownership state the authority: HUMAN_REQUESTED,
 *     HUMAN_OWNED and HANDING_BACK each suppress, and resolution resumes
 *     nothing.
 *   • The proven paths — cross-path dedup, Chatwoot message-id dedup, and the
 *     human dashboard reply silencing the bot — still behave as before.
 *   • Nothing on this path calls BFF-v2.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';

const H = vi.hoisted(() => ({
  prismaMock: {
    chatwootBinding: { findMany: vi.fn(), findUnique: vi.fn() },
    conversation: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    message: { create: vi.fn(), findMany: vi.fn() },
    consent: { upsert: vi.fn() },
    whatsAppNumber: { findFirst: vi.fn() },
    clawithBinding: { findUnique: vi.fn(), findFirst: vi.fn() },
    odooBinding: { findUnique: vi.fn() },
  },
  generateReplyMock: vi.fn(),
  meterTokensMock: vi.fn(),
  claimInboundMessageIdMock: vi.fn(),
  toggleConvStatusMock: vi.fn(),
  surfaceHandoffMock: vi.fn(),
  stampLeadContextMock: vi.fn(),
  recordHumanReplyMock: vi.fn(),
  recordResolutionMock: vi.fn(),
  settleResumedMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: H.prismaMock }));
vi.mock('@/lib/brain-provider', () => ({ generateReply: H.generateReplyMock }));
vi.mock('@/lib/meter', () => ({ meterTokens: H.meterTokensMock }));
vi.mock('@/lib/inbound-dedup', () => ({ claimInboundMessageId: H.claimInboundMessageIdMock }));
vi.mock('@/lib/chatwoot-handoff', () => ({
  toggleConvStatus: H.toggleConvStatusMock,
  surfaceHandoff: H.surfaceHandoffMock,
}));
vi.mock('@/lib/chatwoot-lead-context', () => ({ stampLeadContext: H.stampLeadContextMock }));
vi.mock('@/lib/claim-guard', () => ({ SALES_TENANT_IDS: new Set<string>() }));
vi.mock('@/lib/chatwoot-binding-resolution', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveActiveBinding: (bindings: any[]) => bindings[0] ?? null,
}));
vi.mock('@/lib/chatwoot-webhook-signature', () => ({
  readSignatureHeaders: () => ({ signature: 'sig', timestamp: '1' }),
  verifyChatwootSignature: () => ({ ok: true }),
}));
vi.mock('@/lib/escalation-card', () => ({ buildEscalationCard: () => 'card' }));
vi.mock('@/lib/escalation-intent', () => ({ detectEscalationIntent: () => ({ escalate: false, category: null }) }));
// Transitions are spied, not faked: this file is about the ROUTE's decisions.
// The engine's own guarantees are proven in lib/ownership/transitions.test.ts.
vi.mock('@/lib/ownership/transitions', () => ({
  recordHumanReply: H.recordHumanReplyMock,
  recordResolution: H.recordResolutionMock,
  settleResumed: H.settleResumedMock,
}));

import { POST } from './route';

const TENANT = 'tenant-1';
const ACCOUNT = '5';
const INBOX = '46';          // the one designed door
const OTHER_INBOX = '38';    // never gated
const CW_CONV = 89;

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chatwoot/agent-bot', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    message_type: 'incoming',
    id: 5001,
    content: 'hello there',
    source_id: 'wamid.TEST',
    sender: { phone_number: '+17672762128', name: 'Cust', id: 77 },
    conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: INBOX, status: 'pending' },
    ...overrides,
  };
}

function outgoingHuman(overrides: Record<string, unknown> = {}) {
  return {
    event: 'message_created',
    message_type: 'outgoing',
    id: 6001,
    content: 'let me take this',
    sender: { type: 'user', id: 42 },
    conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: INBOX, status: 'pending' },
    ...overrides,
  };
}

function bindingRow(inboxId = INBOX) {
  return {
    id: 'binding-1',
    tenant_id: TENANT,
    base_url: 'https://inbox.epic.dm',
    account_id: ACCOUNT,
    inbox_id: inboxId,
    mode: 'a2',
    agent: null,
    tenant: {
      id: TENANT,
      status: 'active',
      users: [],
      agents: [{
        id: 'agent-1',
        name: 'Isola',
        greeting: '',
        business_info: '',
        knowledge_text: '',
        is_active: true,
        intelligence_tier: 'standard',
        brain_provider: 'native',
        flowise_flow_id: null,
        after_hours_start: null,
        after_hours_end: null,
        timezone: 'America/Dominica',
      }],
    },
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    tenant_id: TENANT,
    chatwoot_conversation_id: CW_CONV,
    chatwoot_inbox_id: INBOX,
    chatwoot_binding_id: 'binding-1',
    customer_phone: '+17672762128',
    status: 'open',
    human_handling: false,
    ownership_state: 'AI_OWNED',
    ownership_episode: 0,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ISOLA_AI_LOOP_ENABLED;
  process.env.CHATWOOT_AGENTBOT_TOKEN = 'bot-token';
  process.env.CHATWOOT_BOT_SIGNING_SECRET = 'signing-secret';

  H.claimInboundMessageIdMock.mockResolvedValue(false);
  H.prismaMock.chatwootBinding.findMany.mockResolvedValue([bindingRow()]);
  H.prismaMock.chatwootBinding.findUnique.mockResolvedValue({ account_id: ACCOUNT });
  H.prismaMock.conversation.findFirst.mockResolvedValue(conversationRow());
  H.prismaMock.conversation.findMany.mockResolvedValue([]);
  H.prismaMock.conversation.update.mockResolvedValue({});
  H.prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
  H.prismaMock.message.create.mockResolvedValue({ id: 'm1' });
  H.prismaMock.message.findMany.mockResolvedValue([]);
  H.prismaMock.consent.upsert.mockResolvedValue({ status: 'opted_in' });
  H.prismaMock.whatsAppNumber.findFirst.mockResolvedValue({ phone_number_id: '999' });
  H.generateReplyMock.mockResolvedValue({ text: 'hi!', tokensUsed: 10, model: 'x', provider: 'native' });
  H.recordHumanReplyMock.mockResolvedValue({ ok: true, status: 'applied', state: 'HUMAN_OWNED', episode: 1 });
  H.recordResolutionMock.mockResolvedValue({ status: 'recorded', state: 'HUMAN_OWNED', episode: 1, legacyCleared: false });
  H.settleResumedMock.mockResolvedValue({ ok: true, status: 'applied', state: 'AI_OWNED', episode: 1 });

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ISOLA_AI_LOOP_ENABLED;
});

/** Did the route post a customer-facing message to Chatwoot? */
function repliedToCustomer(): boolean {
  return fetchMock.mock.calls.some(
    ([url, init]) =>
      String(url).includes('/messages') &&
      typeof (init as { body?: string } | undefined)?.body === 'string' &&
      JSON.parse((init as { body: string }).body).message_type === 'outgoing',
  );
}

// ── GATE OFF: live behaviour must be unchanged ──────────────────────────────

describe('gate OFF — existing live behaviour is preserved', () => {
  it('replies when the legacy boolean is false', async () => {
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(repliedToCustomer()).toBe(true);
  });

  it('stays silent when the legacy boolean is true — the pre-Commit-2 gate', async () => {
    H.prismaMock.conversation.findFirst.mockResolvedValue(conversationRow({ human_handling: true }));
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('IGNORES the ownership state while the gate is off — no new suppression', async () => {
    // A human ownership state must NOT silence the bot on a legacy door: that
    // would be a live routing change, which §8 forbids while the gate is off.
    H.prismaMock.conversation.findFirst.mockResolvedValue(
      conversationRow({ human_handling: false, ownership_state: 'HUMAN_OWNED', ownership_episode: 4 }),
    );
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
  });

  it('resolution still clears the hold on a legacy door', async () => {
    H.prismaMock.conversation.findMany.mockResolvedValue([{
      id: 'conv-1', tenant_id: TENANT, chatwoot_inbox_id: OTHER_INBOX,
      chatwoot_binding_id: 'binding-1', ownership_episode: 1,
    }]);
    await POST(post({
      event: 'conversation_resolved', id: CW_CONV, status: 'resolved',
      meta: { sender: { phone_number: '+17672762128' } },
    }));
    expect(H.recordResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ authoritative: false, conversationId: 'conv-1' }),
    );
  });
});

// ── GATE ON, designed door: ownership is authoritative ──────────────────────

describe('gate ON (account 5 / inbox 46) — ownership state is authoritative', () => {
  beforeEach(() => { process.env.ISOLA_AI_LOOP_ENABLED = 'true'; });

  it('AI_OWNED permits exactly one invocation', async () => {
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
  });

  it.each(['HUMAN_REQUESTED', 'HUMAN_OWNED', 'HANDING_BACK'])(
    '%s suppresses the AI even with the legacy boolean false',
    async (state) => {
      H.prismaMock.conversation.findFirst.mockResolvedValue(
        conversationRow({ ownership_state: state, ownership_episode: 2, human_handling: false }),
      );
      await POST(post(incoming()));
      expect(H.generateReplyMock).not.toHaveBeenCalled();
      expect(repliedToCustomer()).toBe(false);
    },
  );

  it('an unreadable ownership state fails closed', async () => {
    H.prismaMock.conversation.findFirst.mockResolvedValue(
      conversationRow({ ownership_state: 'SOMETHING_NEW', human_handling: false }),
    );
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
  });

  it('AI_RESUMED permits the next customer message to invoke the brain ONCE, then settles', async () => {
    H.prismaMock.conversation.findFirst.mockResolvedValue(
      conversationRow({ ownership_state: 'AI_RESUMED', ownership_episode: 2, human_handling: false }),
    );
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(H.settleResumedMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', episode: 2 }),
    );
  });

  it('does not settle a conversation that was already AI_OWNED', async () => {
    await POST(post(incoming()));
    expect(H.settleResumedMock).not.toHaveBeenCalled();
  });

  it('CONVERSATION RESOLUTION DOES NOT RESUME AI', async () => {
    H.prismaMock.conversation.findMany.mockResolvedValue([{
      id: 'conv-1', tenant_id: TENANT, chatwoot_inbox_id: INBOX,
      chatwoot_binding_id: 'binding-1', ownership_episode: 1,
    }]);
    await POST(post({
      event: 'conversation_resolved', id: CW_CONV, status: 'resolved',
      meta: { sender: { phone_number: '+17672762128' } },
    }));
    // Resolution is recorded as an observation on an authoritative door…
    expect(H.recordResolutionMock).toHaveBeenCalledWith(
      expect.objectContaining({ authoritative: true, operationId: `resolution:${CW_CONV}:1` }),
    );
    // …and the legacy blanket clear is gone from this path entirely.
    expect(H.prismaMock.conversation.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ human_handling: false }) }),
    );
  });

  it('a conversation whose door cannot be resolved is treated as legacy, not authoritative', async () => {
    H.prismaMock.conversation.findMany.mockResolvedValue([{
      id: 'conv-1', tenant_id: TENANT, chatwoot_inbox_id: INBOX,
      chatwoot_binding_id: null, ownership_episode: 1,
    }]);
    await POST(post({
      event: 'conversation_resolved', id: CW_CONV, status: 'resolved',
      meta: { sender: { phone_number: '+17672762128' } },
    }));
    expect(H.recordResolutionMock).toHaveBeenCalledWith(expect.objectContaining({ authoritative: false }));
  });
});

// ── Proven paths that must not regress ──────────────────────────────────────

describe('existing AgentBot behaviour is intact', () => {
  it('cross-path dedup still drops a message already claimed by the WA path', async () => {
    H.claimInboundMessageIdMock.mockResolvedValue(true);
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(H.prismaMock.message.create).not.toHaveBeenCalled();
  });

  it('Chatwoot message-id dedup (P2002) still short-circuits without replying', async () => {
    const p2002 = Object.assign(new Error('unique'), { code: 'P2002' });
    H.prismaMock.message.create.mockRejectedValueOnce(p2002);
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).not.toHaveBeenCalled();
  });

  it('an unknown inbox is still a no-op (isolation guarantee)', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([]);
    const res = await POST(post(incoming({ conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: '999', status: 'pending' } })));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).not.toHaveBeenCalled();
  });

  it('THE HUMAN DASHBOARD REPLY PATH IS UNCHANGED — the boolean is still set unconditionally', async () => {
    const res = await POST(post(outgoingHuman()));
    expect(res.status).toBe(200);
    // The legacy-regime fail-safe write is still issued, exactly as before.
    expect(H.prismaMock.conversation.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, chatwoot_conversation_id: CW_CONV },
      data: { human_handling: true },
    });
    // …and the same fact is now recorded durably as an episode.
    expect(H.recordHumanReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', operationId: 'human_reply:6001', currentState: 'AI_OWNED' }),
    );
    expect(H.generateReplyMock).not.toHaveBeenCalled();
  });

  it("the bot's own outgoing replies never count as a human takeover", async () => {
    await POST(post(outgoingHuman({ sender: { type: 'agent_bot', id: 4 } })));
    expect(H.prismaMock.conversation.updateMany).not.toHaveBeenCalled();
    expect(H.recordHumanReplyMock).not.toHaveBeenCalled();
  });

  it('an outgoing human reply for an unknown local conversation records nothing', async () => {
    H.prismaMock.conversation.updateMany.mockResolvedValue({ count: 0 });
    await POST(post(outgoingHuman()));
    expect(H.recordHumanReplyMock).not.toHaveBeenCalled();
  });
});

describe('no BFF-v2 dependency', () => {
  it('every outbound call on the reply path targets Chatwoot only', async () => {
    await POST(post(incoming()));
    expect(fetchMock).toHaveBeenCalled();
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url)).toContain('https://inbox.epic.dm');
      expect(String(url)).not.toMatch(/bff|9043|runtime\.epic\.dm/i);
    }
  });
});
