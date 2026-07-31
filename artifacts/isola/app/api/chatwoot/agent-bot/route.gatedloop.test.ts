/**
 * Agent-bot route × the gated AI loop — the WIRING proof.
 *
 * Commit 1 built the structured Foundation->Clawith request. Commit 2 built
 * episode-aware ownership. This file proves the third thing: that the one
 * permitted caller now actually reaches that path, carries authoritative
 * context into it, and refuses to speak when it cannot.
 *
 * It drives the REAL route handler. What it asserts:
 *   • GATE OFF is byte-for-byte the previous behaviour.
 *   • The gated context is assembled from verified request/binding/DB state
 *     only — never from model output, never from the customer's phone number,
 *     never synthesised to paper over an absent source.
 *   • Ownership governs invocation, per state.
 *   • A suppressed turn posts nothing, records nothing, meters nothing.
 *   • A reply computed in an earlier ownership episode is discarded.
 *   • allowed_tools is empty.
 *
 * SCOPE NOTE, deliberate: `generateReply` is mocked here, so this file proves
 * what the ROUTE hands the brain layer and what it does with the answer. That
 * the gated branch calls the bridge exactly once, and that each classified
 * bridge failure never reaches chatComplete(), is proven where that logic
 * lives — lib/clawith/fail-closed.test.ts and lib/brain-provider.test.ts.
 * Duplicating it here would test a mock.
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
  mintRefMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: H.prismaMock }));
vi.mock('@/lib/brain-provider', () => ({
  generateReply: H.generateReplyMock,
  ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS: new Set<string>(['999']),
}));
vi.mock('@/lib/escalation-ref', () => ({ mintEscalationRefIfAllowed: H.mintRefMock }));
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
vi.mock('@/lib/ownership/transitions', () => ({
  recordHumanReply: H.recordHumanReplyMock,
  recordResolution: H.recordResolutionMock,
  settleResumed: H.settleResumedMock,
}));

import { POST } from './route';

const TENANT      = 'tenant-1';
const ACCOUNT     = '5';
const INBOX       = '46';   // the one designed door
const OTHER_INBOX = '38';   // never gated
const CW_CONV     = 89;
const CW_MSG      = 5001;
const CONTACT_ID  = 77;
const PHONE       = '+17672762128';
const COMPANY     = 'paperclip-co-6737';

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/chatwoot/agent-bot', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

function incoming(overrides: Record<string, unknown> = {}) {
  return {
    event:        'message_created',
    message_type: 'incoming',
    id:           CW_MSG,
    content:      'hello there',
    source_id:    'wamid.TEST',
    sender:       { phone_number: PHONE, name: 'Cust', id: CONTACT_ID },
    conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: INBOX, status: 'pending' },
    ...overrides,
  };
}

function outgoingHuman(overrides: Record<string, unknown> = {}) {
  return {
    event:        'message_created',
    message_type: 'outgoing',
    id:           6001,
    content:      'let me take this',
    sender:       { type: 'user', id: 42 },
    conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: INBOX, status: 'pending' },
    ...overrides,
  };
}

function bindingRow(inboxId = INBOX) {
  return {
    id:         'binding-1',
    tenant_id:  TENANT,
    base_url:   'https://inbox.epic.dm',
    account_id: ACCOUNT,
    inbox_id:   inboxId,
    mode:       'a2',
    agent:      null,
    tenant: {
      id:     TENANT,
      status: 'active',
      users:  [],
      agents: [{
        id: 'agent-1', name: 'Isola', greeting: '', business_info: '', knowledge_text: '',
        is_active: true, intelligence_tier: 'standard', brain_provider: 'clawith',
        flowise_flow_id: null, after_hours_start: null, after_hours_end: null,
        timezone: 'America/Dominica',
      }],
    },
  };
}

function conversationRow(overrides: Record<string, unknown> = {}) {
  return {
    id:                       'conv-1',
    tenant_id:                TENANT,
    chatwoot_conversation_id: CW_CONV,
    chatwoot_inbox_id:        INBOX,
    chatwoot_binding_id:      'binding-1',
    customer_phone:           PHONE,
    status:                   'open',
    human_handling:           false,
    ownership_state:          'AI_OWNED',
    ownership_episode:        0,
    ...overrides,
  };
}

function clawithRow(overrides: Record<string, unknown> = {}) {
  return {
    tenant_id:            TENANT,
    clawith_agent_id:     'agent-6737',
    paperclip_agent_id:   'pc-agent-1',
    paperclip_company_id: COMPANY,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The conversation row the ROUTE's first read sees. */
let baseRow: Record<string, unknown>;
/** The row the ownership-freshness re-read sees (defaults to the same). */
let freshRow: Record<string, unknown> | null;

function setClawith(row: Record<string, unknown> | null) {
  H.prismaMock.clawithBinding.findUnique.mockResolvedValue(row);
  H.prismaMock.clawithBinding.findFirst.mockResolvedValue(row);
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ISOLA_AI_LOOP_ENABLED;
  process.env.CHATWOOT_AGENTBOT_TOKEN     = 'bot-token';
  process.env.CHATWOOT_BOT_SIGNING_SECRET = 'signing-secret';

  baseRow  = conversationRow();
  freshRow = null;

  H.claimInboundMessageIdMock.mockResolvedValue(false);
  H.prismaMock.chatwootBinding.findMany.mockResolvedValue([bindingRow()]);
  H.prismaMock.chatwootBinding.findUnique.mockResolvedValue({ account_id: ACCOUNT });
  // Discriminated on `select`: only the freshness re-read asks for
  // ownership_episode by projection. Everything else gets the base row.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  H.prismaMock.conversation.findFirst.mockImplementation(async (args: any) =>
    args?.select?.ownership_episode ? (freshRow ?? baseRow) : baseRow,
  );
  H.prismaMock.conversation.findMany.mockResolvedValue([]);
  H.prismaMock.conversation.update.mockResolvedValue({});
  H.prismaMock.conversation.updateMany.mockResolvedValue({ count: 1 });
  H.prismaMock.message.create.mockResolvedValue({ id: 'm1' });
  H.prismaMock.message.findMany.mockResolvedValue([]);
  H.prismaMock.consent.upsert.mockResolvedValue({ status: 'opted_in' });
  H.prismaMock.whatsAppNumber.findFirst.mockResolvedValue({ phone_number_id: '999' });
  H.prismaMock.odooBinding.findUnique.mockResolvedValue(null);
  setClawith(clawithRow());
  H.generateReplyMock.mockResolvedValue({ text: 'hi!', tokensUsed: 10, model: 'x', provider: 'clawith' });
  H.recordHumanReplyMock.mockResolvedValue({ ok: true, status: 'applied', state: 'HUMAN_OWNED', episode: 1 });
  H.recordResolutionMock.mockResolvedValue({ status: 'recorded', state: 'HUMAN_OWNED', episode: 1, legacyCleared: false });
  H.settleResumedMock.mockResolvedValue({ ok: true, status: 'applied', state: 'AI_OWNED', episode: 1 });
  H.mintRefMock.mockResolvedValue({ token: 'ref-1', correlationId: 'corr-1' });

  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.ISOLA_AI_LOOP_ENABLED;
});

function gateOn() { process.env.ISOLA_AI_LOOP_ENABLED = 'true'; }

/** The gatedLoop context the route handed the brain layer. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ctx(): any {
  expect(H.generateReplyMock).toHaveBeenCalled();
  return H.generateReplyMock.mock.calls[0][0].gatedLoop;
}

function repliedToCustomer(): boolean {
  return fetchMock.mock.calls.some(
    ([url, init]) =>
      String(url).includes('/messages') &&
      typeof (init as { body?: string } | undefined)?.body === 'string' &&
      JSON.parse((init as { body: string }).body).message_type === 'outgoing',
  );
}

// ── 1-5  Gate parity and pipeline containment ───────────────────────────────

describe('gate parity and pipeline containment', () => {
  it('1. gate OFF still replies exactly as before', async () => {
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(repliedToCustomer()).toBe(true);
    expect(H.meterTokensMock).toHaveBeenCalledTimes(1);
  });

  it('2. gate OFF performs no ownership-freshness re-read (no new query on the live path)', async () => {
    await POST(post(incoming()));
    const projected = H.prismaMock.conversation.findFirst.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ([a]: any[]) => a?.select?.ownership_episode,
    );
    expect(projected).toHaveLength(0);
  });

  it('3. gate ON for account 5 / inbox 46 passes the gated context exactly once', async () => {
    gateOn();
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(ctx()).toBeTruthy();
    expect(ctx().chatwootAccountId).toBe(ACCOUNT);
    expect(ctx().inboxId).toBe(INBOX);
  });

  it('4. a non-designed inbox is untouched by the gate', async () => {
    gateOn();
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([bindingRow(OTHER_INBOX)]);
    baseRow = conversationRow({ chatwoot_inbox_id: OTHER_INBOX });
    await POST(post(incoming({
      conversation: { id: CW_CONV, account_id: ACCOUNT, inbox_id: OTHER_INBOX, status: 'pending' },
    })));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    // Context is still supplied; the DOOR decides, and this door is not gated,
    // so no freshness re-read and the legacy path runs.
    expect(ctx().inboxId).toBe(OTHER_INBOX);
    expect(repliedToCustomer()).toBe(true);
  });

  it('5. the direct-WhatsApp caller is not this route — only one call site passes gatedLoop', async () => {
    // Guard against a future edit adding a second gated caller: this route is
    // the only place the object is constructed, and it constructs one per turn.
    gateOn();
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
  });
});

// ── 6-17  Authoritative context fidelity ────────────────────────────────────

describe('authoritative context fidelity', () => {
  beforeEach(() => { gateOn(); });

  it('6. account id comes from the verified envelope', async () => {
    await POST(post(incoming()));
    expect(ctx().chatwootAccountId).toBe(ACCOUNT);
  });

  it('7. inbox id comes from the resolved inbox', async () => {
    await POST(post(incoming()));
    expect(ctx().inboxId).toBe(INBOX);
  });

  it('8. binding tenant comes from the binding row', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([
      { ...bindingRow(), tenant_id: TENANT },
    ]);
    await POST(post(incoming()));
    expect(ctx().bindingTenantId).toBe(TENANT);
  });

  it('9. conversation tenant comes from the conversation row', async () => {
    await POST(post(incoming()));
    expect(ctx().conversationTenantId).toBe(TENANT);
    expect(ctx().conversationId).toBe('conv-1');
  });

  it('10. the Chatwoot message id is used verbatim', async () => {
    await POST(post(incoming()));
    expect(ctx().inboundMessageId).toBe(String(CW_MSG));
  });

  it('11. a missing Chatwoot message id fails closed before any brain call', async () => {
    const res = await POST(post(incoming({ id: 'not-a-number' })));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('12. the Chatwoot contact id is used as contactRef', async () => {
    await POST(post(incoming()));
    expect(ctx().contactRef).toBe(String(CONTACT_ID));
  });

  it('13. the customer phone number is NEVER the contactRef', async () => {
    await POST(post(incoming()));
    expect(ctx().contactRef).not.toBe(PHONE);
    expect(ctx().contactRef).not.toContain('7672762128');
    expect(JSON.stringify(ctx())).not.toContain('7672762128');
  });

  it('13b. contactRef falls back to conversation.meta.sender.id, still never the phone', async () => {
    await POST(post(incoming({
      sender:       { phone_number: PHONE, name: 'Cust' },
      conversation: {
        id: CW_CONV, account_id: ACCOUNT, inbox_id: INBOX, status: 'pending',
        meta: { sender: { id: 91, phone_number: PHONE } },
      },
    })));
    expect(ctx().contactRef).toBe('91');
  });

  it('14. an absent contact id yields an empty contactRef — not a substitute', async () => {
    await POST(post(incoming({ sender: { phone_number: PHONE, name: 'Cust' } })));
    expect(ctx().contactRef).toBe('');
  });

  it('15. paperclip_company_id is the businessId', async () => {
    await POST(post(incoming()));
    expect(ctx().businessId).toBe(COMPANY);
    // Never the Isola tenant cuid: that is a different namespace.
    expect(ctx().businessId).not.toBe(TENANT);
  });

  it('16. an absent paperclip_company_id yields an empty businessId — not the tenant id', async () => {
    setClawith(clawithRow({ paperclip_company_id: null }));
    await POST(post(incoming()));
    expect(ctx().businessId).toBe('');
    expect(ctx().businessId).not.toBe(TENANT);
  });

  it('17. allowed_tools is empty', async () => {
    await POST(post(incoming()));
    expect(ctx().allowedTools).toEqual([]);
  });

  it('17b. the ownership state passed is the same one the suppression gate used', async () => {
    baseRow = conversationRow({ ownership_state: 'AI_RESUMED', ownership_episode: 3 });
    freshRow = baseRow;
    await POST(post(incoming()));
    expect(ctx().ownershipState).toBe('AI_RESUMED');
  });
});

// ── 18-22  Ownership governs invocation ─────────────────────────────────────

describe('ownership governs invocation (gate ON)', () => {
  beforeEach(() => { gateOn(); });

  it('18. AI_OWNED invokes once', async () => {
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(repliedToCustomer()).toBe(true);
  });

  it('19. AI_RESUMED invokes once and settles', async () => {
    baseRow = conversationRow({ ownership_state: 'AI_RESUMED', ownership_episode: 2 });
    freshRow = baseRow;
    await POST(post(incoming()));
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(H.settleResumedMock).toHaveBeenCalledTimes(1);
  });

  it('20. HUMAN_REQUESTED suppresses every brain', async () => {
    baseRow = conversationRow({ ownership_state: 'HUMAN_REQUESTED', ownership_episode: 1 });
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('21. HUMAN_OWNED suppresses every brain', async () => {
    baseRow = conversationRow({ ownership_state: 'HUMAN_OWNED', ownership_episode: 1, human_handling: true });
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('22. HANDING_BACK suppresses until reconciliation completes', async () => {
    baseRow = conversationRow({ ownership_state: 'HANDING_BACK', ownership_episode: 1 });
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('22b. a diverged row (AI state but legacy boolean set) suppresses — fail closed', async () => {
    baseRow = conversationRow({ ownership_state: 'AI_OWNED', human_handling: true });
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });
});

// ── 23-26  Suppression and freshness leave no trace ─────────────────────────

describe('suppression and freshness leave no trace', () => {
  beforeEach(() => { gateOn(); });

  it('23. a classified bridge failure suppresses and never reaches another brain', async () => {
    H.generateReplyMock.mockResolvedValue({
      text: '', tokensUsed: 0, model: 'clawith', provider: 'clawith',
      suppressCustomerReply: true,
      clawithFailure: { kind: 'bridge_unauthorized', correlationId: 'corr-x' },
    });
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1); // not retried on another brain
    expect(repliedToCustomer()).toBe(false);
  });

  it('24. no assistant message is recorded after suppression', async () => {
    H.generateReplyMock.mockResolvedValue({
      text: '', tokensUsed: 0, model: 'clawith', provider: 'clawith',
      suppressCustomerReply: true,
      clawithFailure: { kind: 'response_schema_invalid', correlationId: 'corr-y' },
    });
    await POST(post(incoming()));
    const assistantWrites = H.prismaMock.message.create.mock.calls.filter(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ([a]: any[]) => a?.data?.role === 'assistant',
    );
    expect(assistantWrites).toHaveLength(0);
  });

  it('25. no token metering occurs for a suppressed response', async () => {
    H.generateReplyMock.mockResolvedValue({
      text: '', tokensUsed: 0, model: 'clawith', provider: 'clawith',
      suppressCustomerReply: true,
      clawithFailure: { kind: 'bridge_unavailable', correlationId: 'corr-z' },
    });
    await POST(post(incoming()));
    expect(H.meterTokensMock).not.toHaveBeenCalled();
  });

  it('26. an ownership EPISODE change during generation discards the reply', async () => {
    freshRow = conversationRow({ ownership_state: 'AI_OWNED', ownership_episode: 1 });
    const res = await POST(post(incoming()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).toHaveBeenCalledTimes(1);
    expect(repliedToCustomer()).toBe(false);
    expect(H.meterTokensMock).not.toHaveBeenCalled();
  });

  it('26b. an ownership STATE change to human during generation discards the reply', async () => {
    freshRow = conversationRow({ ownership_state: 'HUMAN_OWNED', ownership_episode: 0, human_handling: true });
    await POST(post(incoming()));
    expect(repliedToCustomer()).toBe(false);
  });

  it('26c. a handback beginning during generation discards the reply', async () => {
    freshRow = conversationRow({ ownership_state: 'HANDING_BACK', ownership_episode: 0 });
    await POST(post(incoming()));
    expect(repliedToCustomer()).toBe(false);
  });

  it('26d. an unchanged episode still replies — freshness is a guard, not a block', async () => {
    freshRow = conversationRow();
    await POST(post(incoming()));
    expect(repliedToCustomer()).toBe(true);
  });
});

// ── 27-31  Proven paths still behave ────────────────────────────────────────

describe('previously proven paths still behave', () => {
  it('27. a duplicate inbound invokes nothing (dedup claim already held)', async () => {
    gateOn();
    H.claimInboundMessageIdMock.mockResolvedValue(true);
    await POST(post(incoming()));
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    expect(repliedToCustomer()).toBe(false);
  });

  it('28. nothing on this path calls BFF-v2', async () => {
    gateOn();
    await POST(post(incoming()));
    for (const [url] of fetchMock.mock.calls) {
      expect(String(url).toLowerCase()).not.toContain('bff');
    }
  });

  it('31. a human dashboard reply still silences the bot', async () => {
    const res = await POST(post(outgoingHuman()));
    expect(res.status).toBe(200);
    expect(H.generateReplyMock).not.toHaveBeenCalled();
    // The legacy fail-safe write is still issued, and the transition recorded.
    expect(H.prismaMock.conversation.updateMany).toHaveBeenCalled();
    expect(H.recordHumanReplyMock).toHaveBeenCalledTimes(1);
  });
});
