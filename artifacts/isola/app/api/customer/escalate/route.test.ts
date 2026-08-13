import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const {
  prismaMock, surfaceHandoffMock, auditMock, resolveEscalationRefMock,
  requestHumanOwnershipMock, confirmHumanOwnershipMock,
} = vi.hoisted(() => ({
  prismaMock: {
    conversation: {
      findUnique: vi.fn(),
      update:     vi.fn(),
    },
    chatwootBinding: {
      findUnique: vi.fn(),
      findMany:   vi.fn(), // asserted NOT called — tenant-wide lookup is the bug this route must not repeat
    },
    clawithBinding: {
      findUnique: vi.fn(),
      findFirst:  vi.fn(),
    },
  },
  surfaceHandoffMock: vi.fn(),
  auditMock: vi.fn(),
  resolveEscalationRefMock: vi.fn(),
  requestHumanOwnershipMock: vi.fn(),
  confirmHumanOwnershipMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/chatwoot-handoff', () => ({ surfaceHandoff: surfaceHandoffMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));
vi.mock('@/lib/escalation-ref', () => ({ resolveEscalationRef: resolveEscalationRefMock }));
// Commit 2: the silence gate is an ownership TRANSITION, not a boolean write.
// The engine's own exactly-once guarantee is proven against a real unique
// constraint in lib/ownership/transitions.test.ts; here we assert what the
// ROUTE does with the claim result.
vi.mock('@/lib/ownership/transitions', () => ({
  requestHumanOwnership: requestHumanOwnershipMock,
  confirmHumanOwnership: confirmHumanOwnershipMock,
}));

import { POST } from './route';

const TOKEN = 'test-customer-tools-token';
const REF = 'opaque-escalation-ref';
const CLAWITH_AGENT_ID = 'clawith-agent-1';

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
    chatwoot_binding_id:      'binding-1',
    chatwoot_inbox_id:        'inbox-42',
    customer_phone:           '+18095551234',
    human_handling:           false,
    ...overrides,
  };
}

function bindingRow(overrides: Record<string, unknown> = {}) {
  return {
    id:         'binding-1',
    tenant_id:  'tenant-1',
    agent_id:   'foundation-agent-1',
    base_url:   'https://inbox.epic.dm',
    account_id: '5',
    inbox_id:   'inbox-42',
    mode:       'a2',
    updated_at: new Date('2026-01-01'),
    tenant:     { status: 'active' },
    ...overrides,
  };
}

/** Matches what lib/escalation-ref.ts's resolveEscalationRef() returns for a
 *  ref minted (per agent-bot/route.ts) for conversationRow()/bindingRow(). */
function resolvedRef(overrides: Record<string, unknown> = {}) {
  return {
    purpose:           'escalate_to_human',
    tenantId:          'tenant-1',
    conversationId:    'conv-1',
    clawithAgentId:    CLAWITH_AGENT_ID,
    chatwootBindingId: 'binding-1',
    chatwootInboxId:   'inbox-42',
    correlationId:     'corr-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ISOLA_CUSTOMER_TOOLS_TOKEN = TOKEN;
  process.env.CHATWOOT_AGENTBOT_TOKEN = 'bot-token';
  resolveEscalationRefMock.mockResolvedValue(resolvedRef());
  prismaMock.chatwootBinding.findUnique.mockResolvedValue(bindingRow());
  prismaMock.conversation.findUnique.mockResolvedValue(conversationRow());
  prismaMock.conversation.update.mockResolvedValue({});
  // surfaceHandoff now REPORTS what it achieved (it used to return void and
  // swallow its failures). Default: the surface landed.
  surfaceHandoffMock.mockResolvedValue({
    surfaced: true, alreadySurfaced: false,
    notePosted: true, labelApplied: true, statusOpened: true,
  });
  // Per-agent ClawithBinding lookup — the "current" clawith_agent_id for
  // bindingRow().agent_id. Tests that want the tenant-level fallback path
  // clear this and set findFirst instead.
  prismaMock.clawithBinding.findUnique.mockResolvedValue({ clawith_agent_id: CLAWITH_AGENT_ID });
  prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
  requestHumanOwnershipMock.mockResolvedValue({
    ok: true, status: 'applied', state: 'HUMAN_REQUESTED', episode: 1,
    operationId: 'corr-1', transitionId: 'tr-1',
  });
  confirmHumanOwnershipMock.mockResolvedValue({
    ok: true, status: 'applied', state: 'HUMAN_OWNED', episode: 1,
    operationId: 'corr-1:assigned', transitionId: 'tr-2',
  });
});

describe('POST /api/customer/escalate — auth', () => {
  it('returns 401 with no Authorization header', async () => {
    const res = await POST(req({ conversation_ref: REF }, null));
    expect(res.status).toBe(401);
    const bodyJson = await res.json();
    expect(bodyJson.correlation_id).toBeTruthy();
  });

  it('returns 401 with a wrong bearer token', async () => {
    const res = await POST(req({ conversation_ref: REF }, 'wrong-token'));
    expect(res.status).toBe(401);
  });

  it('fails closed (401) when ISOLA_CUSTOMER_TOOLS_TOKEN is unset', async () => {
    delete process.env.ISOLA_CUSTOMER_TOOLS_TOKEN;
    const res = await POST(req({ conversation_ref: REF }, TOKEN));
    expect(res.status).toBe(401);
  });
});

describe('POST /api/customer/escalate — input validation', () => {
  it('returns 400 when conversation_ref is missing', async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
    expect(resolveEscalationRefMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customer/escalate — ownership resolution (server-side only)', () => {
  it('returns 404 for an unknown or expired conversation_ref', async () => {
    resolveEscalationRefMock.mockResolvedValue(null);
    const res = await POST(req({ conversation_ref: 'stale-or-fake-ref' }));
    expect(res.status).toBe(404);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('unknown_or_expired_conversation_ref');
    expect(prismaMock.conversation.findUnique).not.toHaveBeenCalled();
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 400 malformed_conversation_ref when the resolved ref carries the wrong purpose', async () => {
    resolveEscalationRefMock.mockResolvedValue(resolvedRef({ purpose: 'get_my_account' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(400);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('malformed_conversation_ref');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('ignores a client-supplied conversation_id / tenant_id / account_id / inbox_id and resolves entirely from conversation_ref', async () => {
    const res = await POST(
      req({
        conversation_ref: REF,
        conversation_id: 'attacker-supplied-conv',
        tenant_id:  'attacker-tenant',
        account_id: '999',
        inbox_id:   '999',
      }),
    );
    expect(res.status).toBe(200);
    expect(resolveEscalationRefMock).toHaveBeenCalledWith(REF);
    // The Conversation lookup must be keyed on what the ref resolved to, never
    // on anything the client sent directly.
    expect(prismaMock.conversation.findUnique).toHaveBeenCalledWith({ where: { id: 'conv-1' } });
    // Binding resolution must be keyed on the conversation's OWN stored
    // snapshot (chatwoot_binding_id), never a fresh tenant-wide lookup.
    expect(prismaMock.chatwootBinding.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'binding-1' } }),
    );
    expect(prismaMock.chatwootBinding.findMany).not.toHaveBeenCalled();
    expect(surfaceHandoffMock).toHaveBeenCalledWith(
      'https://inbox.epic.dm', '5', 42, 'bot-token', expect.any(String),
    );
  });

  it('never queries ChatwootBinding by tenant_id — immune to multi-binding-per-tenant ambiguity (S4 per-agent routing)', async () => {
    // Simulate a tenant that owns a second, different a2 binding (a different
    // agent/inbox on the same tenant) — this must never even be consulted;
    // only the conversation's own snapshotted binding-1 is used.
    await POST(req({ conversation_ref: REF }));
    expect(prismaMock.chatwootBinding.findMany).not.toHaveBeenCalled();
    expect(prismaMock.chatwootBinding.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.chatwootBinding.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'binding-1' } }),
    );
  });

  it('returns 404 when the resolved conversation no longer exists', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(null);
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(404);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 when the conversation has no chatwoot_conversation_id', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(conversationRow({ chatwoot_conversation_id: null }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 403 ref_scope_mismatch when the ref names a different tenant than the resolved conversation (cross-tenant)', async () => {
    resolveEscalationRefMock.mockResolvedValue(resolvedRef({ tenantId: 'other-tenant' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('ref_scope_mismatch');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved for a legacy conversation with no stored chatwoot_binding_id, without ever querying ChatwootBinding', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(conversationRow({ chatwoot_binding_id: null }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('binding_unresolved');
    expect(prismaMock.chatwootBinding.findUnique).not.toHaveBeenCalled();
    expect(prismaMock.chatwootBinding.findMany).not.toHaveBeenCalled();
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved when the snapshotted binding no longer exists', async () => {
    prismaMock.chatwootBinding.findUnique.mockResolvedValue(null);
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('binding_unresolved');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved when the snapshotted binding is no longer mode=a2', async () => {
    prismaMock.chatwootBinding.findUnique.mockResolvedValue(bindingRow({ mode: 'mirror' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved when the snapshotted binding belongs to a different tenant (cross-tenant data-integrity guard)', async () => {
    prismaMock.chatwootBinding.findUnique.mockResolvedValue(bindingRow({ tenant_id: 'other-tenant' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved when the snapshotted binding\'s tenant is no longer active', async () => {
    prismaMock.chatwootBinding.findUnique.mockResolvedValue(bindingRow({ tenant: { status: 'suspended' } }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 409 binding_unresolved when the conversation\'s stored inbox no longer matches the binding\'s inbox (wrong-inbox mismatch)', async () => {
    prismaMock.conversation.findUnique.mockResolvedValue(conversationRow({ chatwoot_inbox_id: 'inbox-999' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 403 ref_scope_mismatch when the ref names a different ChatwootBinding than the conversation currently snapshots (cross-binding replay)', async () => {
    resolveEscalationRefMock.mockResolvedValue(resolvedRef({ chatwootBindingId: 'a-different-binding' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('ref_scope_mismatch');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 403 ref_scope_mismatch when the ref names a different Chatwoot inbox than the conversation currently snapshots (cross-inbox replay)', async () => {
    resolveEscalationRefMock.mockResolvedValue(resolvedRef({ chatwootInboxId: 'inbox-999' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('ref_scope_mismatch');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 403 ref_scope_mismatch when the ref names a different Clawith agent than the conversation currently resolves to (wrong-agent reference)', async () => {
    resolveEscalationRefMock.mockResolvedValue(resolvedRef({ clawithAgentId: 'some-other-agent' }));
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('ref_scope_mismatch');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('falls back to the tenant-level ClawithBinding (agent_id IS NULL) when the binding has no per-agent row, mirroring agent-bot/route.ts', async () => {
    prismaMock.chatwootBinding.findUnique.mockResolvedValue(bindingRow({ agent_id: null }));
    prismaMock.clawithBinding.findUnique.mockResolvedValue(null);
    prismaMock.clawithBinding.findFirst.mockResolvedValue({ clawith_agent_id: CLAWITH_AGENT_ID });

    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(200);
    expect(prismaMock.clawithBinding.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: 'tenant-1', agent_id: null },
    });
  });

  it('returns 403 ref_scope_mismatch when no current ClawithBinding can be resolved at all', async () => {
    prismaMock.clawithBinding.findUnique.mockResolvedValue(null);
    prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(403);
    const bodyJson = await res.json();
    expect(bodyJson.error).toBe('ref_scope_mismatch');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('returns 500 when CHATWOOT_AGENTBOT_TOKEN is not configured', async () => {
    delete process.env.CHATWOOT_AGENTBOT_TOKEN;
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(500);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });
});

describe('POST /api/customer/escalate — successful escalation', () => {
  it('claims the ownership transition, surfaces into Chatwoot, audits, and returns status=escalated with no ownership payload', async () => {
    const res = await POST(req({ conversation_ref: REF, summary: 'Wants to cancel service.' }));
    const bodyJson = await res.json();

    expect(res.status).toBe(200);
    expect(bodyJson).toEqual(
      expect.objectContaining({ ok: true, status: 'escalated' }),
    );
    expect(bodyJson.correlation_id).toBeTruthy();
    // Never returns the decoded ownership payload (conversation/tenant/binding/
    // inbox id) or the opaque ref itself to the customer-facing response.
    expect(bodyJson.conversation_id).toBeUndefined();
    expect(bodyJson.tenant_id).toBeUndefined();
    expect(JSON.stringify(bodyJson)).not.toContain(REF);

    // The silence gate is the ownership transition, claimed on the scoped
    // ref's own correlation id — the value that is stable across a replay.
    expect(requestHumanOwnershipMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId:       'tenant-1',
        conversationId: 'conv-1',
        operationId:    'corr-1',
        reason:         'clawith_escalate_to_human',
      }),
    );
    // The legacy boolean is no longer written directly by this route.
    expect(prismaMock.conversation.update).not.toHaveBeenCalled();

    expect(surfaceHandoffMock).toHaveBeenCalledTimes(1);
    const note = surfaceHandoffMock.mock.calls[0][4];
    expect(note).toContain('Wants to cancel service.');

    // Assignment + context publication recorded as HUMAN_OWNED.
    expect(confirmHumanOwnershipMock).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: 'corr-1:assigned', episode: 1 }),
    );

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action:   'escalate_to_human.invoked',
        entityId: 'conv-1',
        meta:     expect.objectContaining({
          already_escalated: false,
          has_summary:       true,
          ownership_state:   'HUMAN_REQUESTED',
          claim:             'applied',
        }),
      }),
    );
  });

  it('uses a generic note when no summary is provided', async () => {
    await POST(req({ conversation_ref: REF }));
    const note = surfaceHandoffMock.mock.calls[0][4];
    expect(note).toBe('🙋 Customer requested a human — escalate_to_human invoked.');
  });
});

describe('POST /api/customer/escalate — idempotency (repeat calls)', () => {
  it('DUPLICATE ESCALATION APPLIES ONCE — the replay surfaces nothing and reports already_escalated', async () => {
    // The engine reports `duplicate` for a replayed operation id. The route's
    // contract is that EVERY side effect is gated on the winning claim, so a
    // replay produces no assignment, no private note and no handoff message.
    requestHumanOwnershipMock.mockResolvedValue({
      ok: true, status: 'duplicate', state: 'HUMAN_REQUESTED', episode: 1,
      operationId: 'corr-1', transitionId: 'tr-1',
    });

    const res = await POST(req({ conversation_ref: REF }));
    const bodyJson = await res.json();

    expect(res.status).toBe(200);
    expect(bodyJson.status).toBe('already_escalated');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
    expect(confirmHumanOwnershipMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ already_escalated: true, claim: 'duplicate' }) }),
    );
  });

  it('two calls with the same ref produce ONE assignment and ONE private note', async () => {
    const first = await POST(req({ conversation_ref: REF }));
    const firstJson = await first.json();

    requestHumanOwnershipMock.mockResolvedValue({
      ok: true, status: 'duplicate', state: 'HUMAN_REQUESTED', episode: 1,
      operationId: 'corr-1', transitionId: 'tr-1',
    });
    const second = await POST(req({ conversation_ref: REF }));
    const secondJson = await second.json();

    expect(firstJson.status).toBe('escalated');
    expect(secondJson.status).toBe('already_escalated');
    // Exactly one of the two calls performed the Chatwoot side effects —
    // this is now a property of the claim, not of surfaceHandoff()'s own
    // best-effort label/note heuristics.
    expect(surfaceHandoffMock).toHaveBeenCalledTimes(1);
    expect(confirmHumanOwnershipMock).toHaveBeenCalledTimes(1);
  });

  it('an already-human conversation is reported as already_escalated without re-surfacing', async () => {
    requestHumanOwnershipMock.mockResolvedValue({
      ok: false, status: 'illegal_transition', state: 'HUMAN_OWNED', episode: 1,
      operationId: 'corr-1', transitionId: null,
    });
    const res = await POST(req({ conversation_ref: REF }));
    expect((await res.json()).status).toBe('already_escalated');
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });

  it('fails closed with 409 when the conversation cannot be resolved for ownership', async () => {
    requestHumanOwnershipMock.mockResolvedValue({
      ok: false, status: 'unknown_conversation', state: 'HUMAN_OWNED', episode: 0,
      operationId: 'corr-1', transitionId: null,
    });
    const res = await POST(req({ conversation_ref: REF }));
    expect(res.status).toBe(409);
    expect(surfaceHandoffMock).not.toHaveBeenCalled();
  });
});

/**
 * E3, REWRITTEN — route half.
 *
 * The original E3 assumed Foundation performs the Chatwoot assignment and can
 * therefore fail at it. It does not: Foundation issues no assignment call, and
 * the team assignment seen in production is Chatwoot automation rule #3. So E3
 * passed whether or not anything worked.
 *
 * The real failure mode is: NOTHING REACHES CHATWOOT AND FOUNDATION RECORDS
 * HUMAN_OWNED ANYWAY. That is what these assert.
 */
describe('E3 rewritten — ownership is not advanced when the handoff never surfaced', () => {
  function surfaceFailed() {
    surfaceHandoffMock.mockResolvedValue({
      surfaced: false, alreadySurfaced: false,
      notePosted: false, labelApplied: false, statusOpened: false,
    });
  }

  it('does NOT record HUMAN_OWNED when note, label and reopen all failed', async () => {
    surfaceFailed();
    await POST(req({ conversation_ref: REF }));

    expect(surfaceHandoffMock).toHaveBeenCalled();
    // The assertion the old E3 could never make.
    expect(confirmHumanOwnershipMock).not.toHaveBeenCalled();
  });

  it('records escalate_to_human.surface_failed with which parts failed', async () => {
    surfaceFailed();
    await POST(req({ conversation_ref: REF }));

    const failures = auditMock.mock.calls
      .map((c: any[]) => c[0])
      .filter((a: any) => a?.action === 'escalate_to_human.surface_failed');
    expect(failures).toHaveLength(1);
    expect(failures[0].meta).toMatchObject({
      note_posted: false, label_applied: false, status_opened: false,
    });
  });

  it('leaves ownership at HUMAN_REQUESTED — the AI stays silent, but nothing claims a person is on it', async () => {
    surfaceFailed();
    await POST(req({ conversation_ref: REF }));

    // requestHumanOwnership ran (HUMAN_REQUESTED); confirm did not.
    expect(requestHumanOwnershipMock).toHaveBeenCalled();
    expect(confirmHumanOwnershipMock).not.toHaveBeenCalled();
  });

  it('still records HUMAN_OWNED on the normal path, with a reason that does not claim an assignment', async () => {
    await POST(req({ conversation_ref: REF }));

    expect(confirmHumanOwnershipMock).toHaveBeenCalledTimes(1);
    const arg = confirmHumanOwnershipMock.mock.calls[0][0];
    expect(arg.reason).toBe('chatwoot_context_published');
    // Foundation never assigns; the reason must not say it did.
    expect(arg.reason).not.toContain('assignment');
  });

  it('records HUMAN_OWNED when a prior handoff was already surfaced', async () => {
    surfaceHandoffMock.mockResolvedValue({
      surfaced: true, alreadySurfaced: true,
      notePosted: false, labelApplied: false, statusOpened: false,
    });
    await POST(req({ conversation_ref: REF }));

    expect(confirmHumanOwnershipMock).toHaveBeenCalledTimes(1);
  });
});
