import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@/lib/prisma', async () => {
  const { fakePrisma } = await import('./fake-prisma');
  return { prisma: fakePrisma.client };
});

import { fakePrisma as fake } from './fake-prisma';
import {
  HANDBACK_SUMMARY_PREFIX,
  MAX_OUTCOME_SUMMARY_CHARS,
  defaultHandbackReconciler,
  executeHandback,
  sanitizeOutcomeSummary,
  type HandbackReconciler,
} from './handback';
import { authorizeHandback, AUTHORIZED_HANDBACK_ACTOR_KINDS, type HandbackActor } from './authorize';
import { requestHumanOwnership } from './transitions';

const TENANT = 'tenant-1';
const CONV = 'conv-1';
const OWNER: HandbackActor = { kind: 'owner', ref: 'user:owner-1', tenantId: TENANT };

function seedConversation(overrides: Record<string, unknown> = {}) {
  fake.store.conversations.set(CONV, {
    id: CONV,
    tenant_id: TENANT,
    status: 'open',
    ownership_state: 'HUMAN_OWNED',
    ownership_episode: 1,
    human_handling: true,
    ...overrides,
  });
}

function seedHistory() {
  fake.store.messages.push(
    { id: 'm1', conversation_id: CONV, role: 'user', content: 'my internet is down', created_at: new Date(2026, 6, 29, 10, 0, 0) },
    { id: 'm2', conversation_id: CONV, role: 'assistant', content: 'A technician is booked for Thursday 9am.', created_at: new Date(2026, 6, 29, 10, 5, 0) },
  );
}

const conv = () => fake.store.conversations.get(CONV)!;
const ledger = () => fake.store.transitions;

/** A reconciler whose steps can be made to fail one at a time. */
function reconciler(fail?: 'messages' | 'odoo' | 'summary' | 'session' | 'throw'): HandbackReconciler {
  return {
    reconcileHumanMessages: async () =>
      fail === 'messages'
        ? { ok: false, detail: 'no_local_history_for_episode', appended: 0 }
        : { ok: true, detail: 'ok', appended: 0 },
    reconcileOdoo: async () => {
      if (fail === 'throw') throw new Error('odoo exploded');
      return fail === 'odoo'
        ? { ok: false, detail: 'odoo_unreachable', status: 'skipped_no_binding' as const }
        : { ok: true, detail: 'ok', status: 'noted' as const };
    },
    summarizeOutcome: async () =>
      fail === 'summary'
        ? { ok: false, detail: 'nothing_to_summarize', summary: null }
        : { ok: true, detail: 'ok', summary: `${HANDBACK_SUMMARY_PREFIX} technician booked Thursday 9am` },
    prepareClawithSession: async () =>
      fail === 'session' ? { ok: false, detail: 'session_prepare_failed' } : { ok: true, detail: 'ok' },
  };
}

beforeEach(() => {
  fake.store.reset();
  seedConversation();
  seedHistory();
});

// ── Authorization ───────────────────────────────────────────────────────────

describe('authorizeHandback', () => {
  it('authorizes only owner, admin and internal_operator', () => {
    expect([...AUTHORIZED_HANDBACK_ACTOR_KINDS].sort()).toEqual(['admin', 'internal_operator', 'owner']);
  });

  it('REFUSES a Chatwoot resolution as an actor — resolution is not an authorization', () => {
    const r = authorizeHandback({ kind: 'chatwoot_resolution', ref: 'chatwoot:resolved', tenantId: TENANT }, TENANT);
    expect(r).toEqual({ ok: false, refusal: 'actor_kind_not_authorized' });
  });

  it('refuses the brain asking to take itself back', () => {
    const r = authorizeHandback({ kind: 'clawith_agent', ref: 'clawith:agent-1', tenantId: TENANT }, TENANT);
    expect(r.ok).toBe(false);
  });

  it('refuses staff, a missing actor, a cross-tenant actor and a blank ref', () => {
    expect(authorizeHandback({ kind: 'staff', ref: 'user:s', tenantId: TENANT }, TENANT).ok).toBe(false);
    expect(authorizeHandback(null, TENANT)).toEqual({ ok: false, refusal: 'no_actor' });
    expect(authorizeHandback({ ...OWNER, tenantId: 'tenant-other' }, TENANT)).toEqual({ ok: false, refusal: 'tenant_mismatch' });
    expect(authorizeHandback({ ...OWNER, ref: '  ' }, TENANT)).toEqual({ ok: false, refusal: 'actor_ref_missing' });
  });
});

// ── Sanitization ────────────────────────────────────────────────────────────

describe('sanitizeOutcomeSummary', () => {
  it('redacts secret-shaped runs before they can enter a prompt', () => {
    const dirty = 'token Bearer abcdefghijklmnop1234 and key ' + 'a'.repeat(40) + ' and sk_live_abcdefghijklmno';
    const clean = sanitizeOutcomeSummary(dirty);
    expect(clean).not.toContain('abcdefghijklmnop1234');
    expect(clean).not.toContain('a'.repeat(40));
    expect(clean).not.toContain('sk_live_abcdefghijklmno');
    expect(clean).toContain('[redacted]');
  });

  it('collapses whitespace and bounds the length', () => {
    expect(sanitizeOutcomeSummary('  a\n\n  b  ')).toBe('a b');
    expect(sanitizeOutcomeSummary('x'.repeat(MAX_OUTCOME_SUMMARY_CHARS + 500)).length).toBe(MAX_OUTCOME_SUMMARY_CHARS);
  });
});

// ── Orchestration ───────────────────────────────────────────────────────────

describe('executeHandback', () => {
  it('UNAUTHORIZED HANDBACK IS REJECTED and touches nothing', async () => {
    const r = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1',
      actor: { kind: 'chatwoot_resolution', ref: 'chatwoot:resolved', tenantId: TENANT },
      reconciler: reconciler(),
    });
    expect(r).toMatchObject({ ok: false, status: 'not_authorized', resumedNow: false });
    expect(conv().ownership_state).toBe('HUMAN_OWNED');
    expect(ledger()).toHaveLength(0);
  });

  it('EXPLICIT AUTHORIZED HANDBACK BEGINS THE TRANSITION and resumes once', async () => {
    const r = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1',
      actor: OWNER, reconciler: reconciler(),
    });
    expect(r).toMatchObject({ ok: true, status: 'resumed', state: 'AI_RESUMED', resumedNow: true });
    expect(conv().ownership_state).toBe('AI_RESUMED');
    expect(conv().human_handling).toBe(false);

    const kinds = ledger().map((t) => t.operation_kind);
    expect(kinds).toEqual(['handback_begin', 'handback_complete']);
    expect(ledger().every((t) => t.actor_ref === 'user:owner-1')).toBe(true);
  });

  it('THE HUMAN OUTCOME ENTERS CONTEXT as an ordinary history turn', async () => {
    await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1',
      actor: OWNER, reconciler: reconciler(),
    });
    const appended = fake.store.messages.filter((m) => m.content.startsWith(HANDBACK_SUMMARY_PREFIX));
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toContain('technician booked Thursday 9am');
    // No side channel: it is in the same table the next request's bounded
    // history is built from.
    expect(appended[0].conversation_id).toBe(CONV);
  });

  it('NO AUTOMATIC RESPONSE IS SENT SOLELY ON HANDBACK', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1',
      actor: OWNER, reconciler: reconciler(),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    // The only message written is the internal context note, never a customer
    // reply composed by Foundation.
    const customerFacing = fake.store.messages.filter(
      (m) => m.role === 'assistant' && !m.content.startsWith(HANDBACK_SUMMARY_PREFIX) && m.id.startsWith('msg-'),
    );
    expect(customerFacing).toHaveLength(0);
    vi.unstubAllGlobals();
  });

  it.each(['messages', 'odoo', 'summary', 'session', 'throw'] as const)(
    'FAILED RECONCILIATION (%s) DOES NOT RESUME AI',
    async (step) => {
      const r = await executeHandback({
        tenantId: TENANT, conversationId: CONV, episode: 1, operationId: `hb-${step}`,
        actor: OWNER, reconciler: reconciler(step),
      });
      expect(r).toMatchObject({ ok: false, status: 'reconciliation_failed', state: 'HUMAN_OWNED', resumedNow: false });
      expect(conv().ownership_state).toBe('HUMAN_OWNED');
      expect(conv().human_handling).toBe(true);
      expect(ledger().map((t) => t.operation_kind)).toEqual(['handback_begin', 'handback_failed']);
      expect(fake.store.messages.filter((m) => m.content.startsWith(HANDBACK_SUMMARY_PREFIX))).toHaveLength(0);
    },
  );

  it('DUPLICATE HANDBACK APPLIES ONCE — the replay resumes nothing again', async () => {
    const first = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1', actor: OWNER, reconciler: reconciler(),
    });
    const second = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1', actor: OWNER, reconciler: reconciler(),
    });
    expect(first).toMatchObject({ status: 'resumed', resumedNow: true });
    expect(second).toMatchObject({ ok: true, status: 'already_applied', resumedNow: false });
    expect(ledger().filter((t) => t.operation_kind === 'handback_complete')).toHaveLength(1);
    expect(fake.store.messages.filter((m) => m.content.startsWith(HANDBACK_SUMMARY_PREFIX))).toHaveLength(1);
  });

  it('A STALE HANDBACK FAILS — an episode that has moved on is refused', async () => {
    seedConversation({ ownership_state: 'HUMAN_OWNED', ownership_episode: 3, human_handling: true });
    const r = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-old', actor: OWNER, reconciler: reconciler(),
    });
    expect(r).toMatchObject({ ok: false, status: 'stale_episode', resumedNow: false });
    expect(conv().ownership_state).toBe('HUMAN_OWNED');
    expect(ledger()).toHaveLength(0);
  });

  it('refuses a handback on a conversation the AI already owns', async () => {
    seedConversation({ ownership_state: 'AI_OWNED', ownership_episode: 0, human_handling: false });
    const r = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 0, operationId: 'hb-1', actor: OWNER, reconciler: reconciler(),
    });
    expect(r).toMatchObject({ ok: false, status: 'illegal_state' });
  });

  it('a re-escalation during HANDING_BACK cannot be overtaken by the stale handback', async () => {
    // The conversation escalates again while a handback is in flight; the
    // in-flight handback names episode 1 and must not resume episode 2.
    seedConversation({ ownership_state: 'AI_OWNED', ownership_episode: 1, human_handling: false });
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'esc-2', reason: 'r' });
    const r = await executeHandback({
      tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-inflight', actor: OWNER, reconciler: reconciler(),
    });
    expect(r.status).toBe('stale_episode');
    expect(conv().ownership_state).toBe('HUMAN_REQUESTED');
  });
});

// ── Default reconciler ──────────────────────────────────────────────────────

describe('defaultHandbackReconciler', () => {
  const ctx = { tenantId: TENANT, conversationId: CONV, episode: 1, operationId: 'hb-1', actorRef: 'user:owner-1' };

  it('refuses to summarise a conversation with no local history', async () => {
    fake.store.messages.length = 0;
    expect(await defaultHandbackReconciler.reconcileHumanMessages(ctx)).toMatchObject({ ok: false });
    expect(await defaultHandbackReconciler.summarizeOutcome(ctx)).toMatchObject({ ok: false, summary: null });
  });

  it('reports honestly that there is no Odoo binding rather than claiming success', async () => {
    expect(await defaultHandbackReconciler.reconcileOdoo(ctx)).toMatchObject({ ok: true, status: 'skipped_no_binding' });
    fake.store.odooBindings.set(TENANT, { tenant_id: TENANT });
    expect(await defaultHandbackReconciler.reconcileOdoo(ctx)).toMatchObject({ ok: true, status: 'noted' });
  });

  it('builds a sanitized summary from the recent turns', async () => {
    const r = await defaultHandbackReconciler.summarizeOutcome(ctx);
    expect(r.ok).toBe(true);
    expect(r.summary).toContain(HANDBACK_SUMMARY_PREFIX);
    expect(r.summary).toContain('technician is booked for Thursday');
    expect((r.summary ?? '').length).toBeLessThanOrEqual(MAX_OUTCOME_SUMMARY_CHARS);
  });
});
