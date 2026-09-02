import { describe, it, expect, beforeEach, vi } from 'vitest';

// The engine's guarantees are properties of a UNIQUE CONSTRAINT, so the store
// is faked rather than stubbed — see ./fake-prisma.ts.
vi.mock('@/lib/prisma', async () => {
  const { fakePrisma } = await import('./fake-prisma');
  return { prisma: fakePrisma.client };
});

import { fakePrisma as fake } from './fake-prisma';

import {
  abortHandback,
  beginHandback,
  completeHandback,
  confirmHumanOwnership,
  recordHumanReply,
  recordResolution,
  requestHumanOwnership,
  settleResumed,
} from './transitions';

const TENANT = 'tenant-1';
const CONV = 'conv-1';

function seed(overrides: Record<string, unknown> = {}) {
  fake.store.conversations.set(CONV, {
    id: CONV,
    tenant_id: TENANT,
    status: 'open',
    ownership_state: 'AI_OWNED',
    ownership_episode: 0,
    human_handling: false,
    chatwoot_conversation_id: 46,
    ...overrides,
  });
}

const conv = () => fake.store.conversations.get(CONV)!;
const ledger = () => fake.store.transitions;

beforeEach(() => {
  fake.store.reset();
  seed();
});

// ── Escalation ──────────────────────────────────────────────────────────────

describe('requestHumanOwnership', () => {
  it('moves AI_OWNED → HUMAN_REQUESTED, opens episode 1, and suppresses replies', async () => {
    const out = await requestHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1',
      reason: 'clawith_escalate_to_human', actorRef: 'clawith:escalate_to_human', correlationId: 'corr-1',
    });
    expect(out).toMatchObject({ ok: true, status: 'applied', state: 'HUMAN_REQUESTED', episode: 1 });
    expect(conv().ownership_state).toBe('HUMAN_REQUESTED');
    expect(conv().ownership_episode).toBe(1);
    // Projection follows the state — the legacy readers keep working.
    expect(conv().human_handling).toBe(true);
    expect(conv().ownership_escalation_operation_id).toBe('op-esc-1');
    expect(ledger()).toHaveLength(1);
  });

  it('DUPLICATE ESCALATION APPLIES ONCE — one transition, one ledger row', async () => {
    const first = await requestHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r',
    });
    const second = await requestHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r',
    });
    const third = await requestHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r',
    });

    expect(first.status).toBe('applied');
    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');
    // The property the call site depends on: only ONE call reports `applied`,
    // so only one performs the Chatwoot assignment / private note / handoff.
    expect([first, second, third].filter((r) => r.status === 'applied')).toHaveLength(1);
    expect(ledger()).toHaveLength(1);
    expect(conv().ownership_episode).toBe(1);
  });

  it('a genuinely NEW escalation after a handback opens a second episode', async () => {
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r' });
    await confirmHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1:assigned', episode: 1, reason: 'a' });
    await beginHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 1, actorRef: 'user:1' });
    await completeHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 1, actorRef: 'user:1' });

    const again = await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-2', reason: 'r' });
    expect(again).toMatchObject({ status: 'applied', state: 'HUMAN_REQUESTED', episode: 2 });
  });

  it('refuses a conversation belonging to another tenant', async () => {
    const out = await requestHumanOwnership({
      tenantId: 'tenant-OTHER', conversationId: CONV, operationId: 'op-x', reason: 'r',
    });
    expect(out).toMatchObject({ ok: false, status: 'unknown_conversation' });
    expect(conv().ownership_state).toBe('AI_OWNED');
  });

  it('reports illegal_transition rather than escalating an already-human conversation', async () => {
    seed({ ownership_state: 'HUMAN_OWNED', ownership_episode: 1, human_handling: true });
    const out = await requestHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-new', reason: 'r',
    });
    expect(out).toMatchObject({ ok: false, status: 'illegal_transition', state: 'HUMAN_OWNED' });
    expect(ledger()).toHaveLength(0);
  });
});

describe('confirmHumanOwnership', () => {
  it('HUMAN_REQUESTED → HUMAN_OWNED on the same episode', async () => {
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r' });
    const out = await confirmHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1:assigned', episode: 1, reason: 'assigned',
    });
    expect(out).toMatchObject({ status: 'applied', state: 'HUMAN_OWNED', episode: 1 });
    expect(conv().human_handling).toBe(true);
  });

  it('DUPLICATE ASSIGNMENT APPLIES ONCE', async () => {
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r' });
    const a = await confirmHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'assign-1', episode: 1, reason: 'x' });
    const b = await confirmHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'assign-1', episode: 1, reason: 'x' });
    expect(a.status).toBe('applied');
    expect(b.status).toBe('duplicate');
    expect(ledger().filter((t) => t.operation_kind === 'human_assigned')).toHaveLength(1);
  });

  it('refuses when the episode has moved on', async () => {
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r' });
    const out = await confirmHumanOwnership({
      tenantId: TENANT, conversationId: CONV, operationId: 'assign-stale', episode: 0, reason: 'x',
    });
    expect(out).toMatchObject({ ok: false, status: 'stale_episode' });
  });
});

// ── Human reply ─────────────────────────────────────────────────────────────

describe('recordHumanReply', () => {
  it('takes over from AI_OWNED and opens an episode', async () => {
    const out = await recordHumanReply({
      tenantId: TENANT, conversationId: CONV, operationId: 'human_reply:900',
      currentState: 'AI_OWNED', currentEpisode: 0, actorRef: 'chatwoot_user:7',
    });
    expect(out).toMatchObject({ status: 'applied', state: 'HUMAN_OWNED', episode: 1 });
    expect(conv().human_handling).toBe(true);
  });

  it('confirms an existing escalation without opening a second episode', async () => {
    await requestHumanOwnership({ tenantId: TENANT, conversationId: CONV, operationId: 'op-esc-1', reason: 'r' });
    const out = await recordHumanReply({
      tenantId: TENANT, conversationId: CONV, operationId: 'human_reply:901',
      currentState: 'HUMAN_REQUESTED', currentEpisode: 1,
    });
    expect(out).toMatchObject({ status: 'applied', state: 'HUMAN_OWNED', episode: 1 });
  });

  it('is a no-op when the conversation is already HUMAN_OWNED', async () => {
    seed({ ownership_state: 'HUMAN_OWNED', ownership_episode: 1, human_handling: true });
    const out = await recordHumanReply({
      tenantId: TENANT, conversationId: CONV, operationId: 'human_reply:902',
      currentState: 'HUMAN_OWNED', currentEpisode: 1,
    });
    expect(out).toMatchObject({ ok: true, status: 'duplicate', state: 'HUMAN_OWNED', episode: 1 });
    expect(ledger()).toHaveLength(0);
  });

  it('collapses a redelivered Chatwoot event to one transition', async () => {
    const a = await recordHumanReply({ tenantId: TENANT, conversationId: CONV, operationId: 'human_reply:903', currentState: 'AI_OWNED', currentEpisode: 0 });
    const b = await recordHumanReply({ tenantId: TENANT, conversationId: CONV, operationId: 'human_reply:903', currentState: 'HUMAN_OWNED', currentEpisode: 1 });
    expect(a.status).toBe('applied');
    expect(b.status).toBe('duplicate');
    expect(conv().ownership_episode).toBe(1);
  });
});

// ── Resolution ──────────────────────────────────────────────────────────────

describe('recordResolution', () => {
  it('AI CANNOT RESUME FROM CHATWOOT RESOLUTION ALONE on an authoritative door', async () => {
    seed({ ownership_state: 'HUMAN_OWNED', ownership_episode: 1, human_handling: true });
    const out = await recordResolution({
      tenantId: TENANT, conversationId: CONV, operationId: 'resolution:46:1', authoritative: true,
    });
    expect(out).toMatchObject({ status: 'recorded', state: 'HUMAN_OWNED', legacyCleared: false });
    expect(conv().ownership_state).toBe('HUMAN_OWNED');
    expect(conv().human_handling).toBe(true);   // NOT cleared
    expect(conv().status).toBe('resolved');     // the observation IS recorded
    expect(ledger()[0]).toMatchObject({ operation_kind: 'resolution_observed', from_state: 'HUMAN_OWNED', to_state: 'HUMAN_OWNED' });
  });

  it('also refuses to resume from HUMAN_REQUESTED and HANDING_BACK', async () => {
    for (const state of ['HUMAN_REQUESTED', 'HANDING_BACK']) {
      fake.store.reset();
      seed({ ownership_state: state, ownership_episode: 1, human_handling: true });
      await recordResolution({ tenantId: TENANT, conversationId: CONV, operationId: 'r', authoritative: true });
      expect(conv().ownership_state).toBe(state);
      expect(conv().human_handling).toBe(true);
    }
  });

  it('GATE OFF / legacy door — preserves the historical clear exactly, on both stores', async () => {
    seed({ ownership_state: 'HUMAN_OWNED', ownership_episode: 1, human_handling: true });
    const out = await recordResolution({
      tenantId: TENANT, conversationId: CONV, operationId: 'resolution:46:1', authoritative: false,
    });
    expect(out).toMatchObject({ status: 'recorded', state: 'AI_OWNED', legacyCleared: true });
    expect(conv().human_handling).toBe(false);       // exactly the pre-Commit-2 effect
    expect(conv().ownership_state).toBe('AI_OWNED'); // and the two stores agree
    expect(conv().status).toBe('resolved');
  });

  it('legacy door on an already-AI conversation clears nothing and still records', async () => {
    const out = await recordResolution({
      tenantId: TENANT, conversationId: CONV, operationId: 'resolution:46:0', authoritative: false,
    });
    expect(out).toMatchObject({ status: 'recorded', state: 'AI_OWNED', legacyCleared: false });
    expect(conv().status).toBe('resolved');
  });

  it('collapses a redelivered resolution event', async () => {
    const a = await recordResolution({ tenantId: TENANT, conversationId: CONV, operationId: 'resolution:46:0', authoritative: true });
    const b = await recordResolution({ tenantId: TENANT, conversationId: CONV, operationId: 'resolution:46:0', authoritative: true });
    expect(a.status).toBe('recorded');
    expect(b.status).toBe('duplicate');
    expect(ledger()).toHaveLength(1);
  });
});

// ── Handback transitions ────────────────────────────────────────────────────

describe('handback transitions', () => {
  beforeEach(() => {
    seed({ ownership_state: 'HUMAN_OWNED', ownership_episode: 2, human_handling: true });
  });

  it('begin → HANDING_BACK, which still suppresses replies', async () => {
    const out = await beginHandback({
      tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9',
    });
    expect(out).toMatchObject({ status: 'applied', state: 'HANDING_BACK', episode: 2 });
    expect(conv().human_handling).toBe(true);
    expect(conv().ownership_handback_operation_id).toBe('hb-1');
  });

  it('STALE HANDBACK FAILS — an older episode is refused', async () => {
    const out = await beginHandback({
      tenantId: TENANT, conversationId: CONV, operationId: 'hb-old', episode: 1, actorRef: 'user:9',
    });
    expect(out).toMatchObject({ ok: false, status: 'stale_episode', state: 'HUMAN_OWNED', episode: 2 });
    expect(conv().ownership_state).toBe('HUMAN_OWNED');
    expect(ledger()).toHaveLength(0);
  });

  it('complete → AI_RESUMED and clears the projection', async () => {
    await beginHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    const out = await completeHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    expect(out).toMatchObject({ status: 'applied', state: 'AI_RESUMED', episode: 2 });
    expect(conv().human_handling).toBe(false);
  });

  it('DUPLICATE HANDBACK APPLIES ONCE at both the begin and complete claims', async () => {
    const b1 = await beginHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    const b2 = await beginHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    expect(b1.status).toBe('applied');
    expect(b2.status).toBe('duplicate');

    const c1 = await completeHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    const c2 = await completeHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    expect(c1.status).toBe('applied');
    expect(c2.status).toBe('duplicate');
    expect(ledger().filter((t) => t.operation_kind === 'handback_complete')).toHaveLength(1);
  });

  it('abort → HUMAN_OWNED; the AI is not resumed', async () => {
    await beginHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2, actorRef: 'user:9' });
    const out = await abortHandback({
      tenantId: TENANT, conversationId: CONV, operationId: 'hb-1', episode: 2,
      actorRef: 'user:9', reason: 'handback_reconciliation_failed:odoo',
    });
    expect(out).toMatchObject({ status: 'applied', state: 'HUMAN_OWNED' });
    expect(conv().human_handling).toBe(true);
  });

  it('cannot complete a handback that never began', async () => {
    const out = await completeHandback({ tenantId: TENANT, conversationId: CONV, operationId: 'hb-ghost', episode: 2, actorRef: 'user:9' });
    expect(out).toMatchObject({ ok: false, status: 'illegal_transition', state: 'HUMAN_OWNED' });
  });
});

describe('settleResumed', () => {
  it('AI_RESUMED → AI_OWNED once the resumed turn is consumed', async () => {
    seed({ ownership_state: 'AI_RESUMED', ownership_episode: 2, human_handling: false });
    const out = await settleResumed({ tenantId: TENANT, conversationId: CONV, operationId: 'settle-1', episode: 2 });
    expect(out).toMatchObject({ status: 'applied', state: 'AI_OWNED' });
  });

  it('settles at most once for a redelivered message', async () => {
    seed({ ownership_state: 'AI_RESUMED', ownership_episode: 2, human_handling: false });
    const a = await settleResumed({ tenantId: TENANT, conversationId: CONV, operationId: 'settle-1', episode: 2 });
    const b = await settleResumed({ tenantId: TENANT, conversationId: CONV, operationId: 'settle-1', episode: 2 });
    expect(a.status).toBe('applied');
    expect(b.status).toBe('duplicate');
  });
});
