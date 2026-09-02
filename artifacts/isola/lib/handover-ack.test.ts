import { describe, it, expect, vi } from 'vitest';
import {
  maybeAcknowledgeHandover,
  HANDOVER_ACK_TEXT,
  type HandoverAckInput,
} from './handover-ack';
import { guardReply, SALES_TENANT_IDS } from './claim-guard';
import { detectEscalationClaim } from './escalation-claim';

const CONV = 'conv-1';

/** A fake store implementing the conditional claim, so exactly-once is tested
 *  against real semantics rather than a mock that always says yes. */
function store(initialAcked: number | null = null) {
  let acked = initialAcked;
  const posts: string[] = [];
  return {
    posts,
    get acked() { return acked; },
    deps: {
      claimEpisode: vi.fn(async (_id: string, episode: number) => {
        if (acked === null || acked < episode) { acked = episode; return 1; }
        return 0;
      }),
      postMessage: vi.fn(async (text: string) => { posts.push(text); return true; }),
    },
  };
}

function handedOver(over: Partial<HandoverAckInput> = {}): HandoverAckInput {
  return {
    conversationId:         CONV,
    ownershipState:         'HUMAN_OWNED',
    ownershipEpisode:       1,
    ownershipAuthoritative: true,
    isPrivate:              false,
    isIncoming:             true,
    senderType:             'contact',
    ...over,
  };
}

describe('handover acknowledgement — K matrix', () => {
  it('K1 — handed over, one inbound: exactly one acknowledgement', async () => {
    const s = store();
    const outcome = await maybeAcknowledgeHandover(handedOver(), s.deps);
    expect(outcome).toBe('sent');
    expect(s.posts).toEqual([HANDOVER_ACK_TEXT]);
  });

  it('K2 — handed over, five inbound: still exactly ONE', async () => {
    const s = store();
    const outcomes = [];
    for (let i = 0; i < 5; i++) outcomes.push(await maybeAcknowledgeHandover(handedOver(), s.deps));
    expect(outcomes).toEqual(['sent', 'already_acked', 'already_acked', 'already_acked', 'already_acked']);
    expect(s.posts).toHaveLength(1);
  });

  it('K3 — handback then re-escalate: a second acknowledgement, one per episode', async () => {
    const s = store();
    await maybeAcknowledgeHandover(handedOver({ ownershipEpisode: 1 }), s.deps);
    // Episode 2 = a new span of human involvement, a new period of waiting.
    const second = await maybeAcknowledgeHandover(handedOver({ ownershipEpisode: 2 }), s.deps);
    expect(second).toBe('sent');
    expect(s.posts).toHaveLength(2);
  });

  it('K4 — two inbound in the same instant: exactly one wins the claim', async () => {
    const s = store();
    const [a, b] = await Promise.all([
      maybeAcknowledgeHandover(handedOver(), s.deps),
      maybeAcknowledgeHandover(handedOver(), s.deps),
    ]);
    expect([a, b].filter((o) => o === 'sent')).toHaveLength(1);
    expect(s.posts).toHaveLength(1);
  });

  it('K5 — HUMAN_REQUESTED (the state a FAILED surface leaves): zero', async () => {
    const s = store();
    const outcome = await maybeAcknowledgeHandover(
      handedOver({ ownershipState: 'HUMAN_REQUESTED' }), s.deps);
    expect(outcome).toBe('not_handed_over');
    expect(s.posts).toHaveLength(0);
    expect(s.deps.claimEpisode).not.toHaveBeenCalled();
  });

  it('K6 — HANDING_BACK (mid-reconciliation, nobody speaks): zero', async () => {
    const s = store();
    expect(await maybeAcknowledgeHandover(
      handedOver({ ownershipState: 'HANDING_BACK' }), s.deps)).toBe('not_handed_over');
    expect(s.posts).toHaveLength(0);
  });

  it('K7 — AI_OWNED and AI_RESUMED: zero, the normal AI path is untouched', async () => {
    const s = store();
    for (const state of ['AI_OWNED', 'AI_RESUMED']) {
      expect(await maybeAcknowledgeHandover(handedOver({ ownershipState: state }), s.deps))
        .toBe('not_handed_over');
    }
    expect(s.posts).toHaveLength(0);
  });

  it('K8 — a private note inbound: zero', async () => {
    const s = store();
    expect(await maybeAcknowledgeHandover(handedOver({ isPrivate: true }), s.deps))
      .toBe('not_customer_message');
    expect(s.posts).toHaveLength(0);
  });

  it('K8b — our own agent_bot message: zero, never acknowledge ourselves', async () => {
    const s = store();
    expect(await maybeAcknowledgeHandover(handedOver({ senderType: 'agent_bot' }), s.deps))
      .toBe('not_customer_message');
    expect(s.posts).toHaveLength(0);
  });

  it('K9 — the string is pinned byte for byte', () => {
    expect(HANDOVER_ACK_TEXT).toBe(
      'Thanks — your message has been added to the conversation and a member of our team has it.',
    );
    // The em dash and the ASCII apostrophe are part of the contract.
    expect(HANDOVER_ACK_TEXT).toContain('—');
    // It must not imply a response time.
    for (const forbidden of ['shortly', 'soon', 'right away', 'as soon as', 'within', 'minutes', 'hours']) {
      expect(HANDOVER_ACK_TEXT.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('K10 — the string passes the claim-guard for a sales tenant', () => {
    const salesTenant = [...SALES_TENANT_IDS][0];
    const guarded = guardReply(HANDOVER_ACK_TEXT, salesTenant);
    expect(guarded.blocked).toBe(false);
    expect(guarded.text).toBe(HANDOVER_ACK_TEXT);
  });

  it('K11 — the string does NOT trip detectEscalationClaim (else: escalation loop)', () => {
    // This is the sharp one. The backstop forces needsHandoff=true on any reply
    // that CLAIMS a handoff occurred — and it fires in production (8 times).
    // Our acknowledgement says a team member has the conversation, which is
    // exactly the shape it looks for. If it tripped, every acknowledgement
    // would force another handoff on a conversation already handed over.
    expect(detectEscalationClaim(HANDOVER_ACK_TEXT).claims).toBe(false);
  });

  it('legacy door: says nothing — a boolean has no episode to key "once" on', async () => {
    const s = store();
    expect(await maybeAcknowledgeHandover(
      handedOver({ ownershipAuthoritative: false }), s.deps)).toBe('not_authoritative');
    expect(s.posts).toHaveLength(0);
  });

  it('a failed post keeps the claim and does NOT retry — silence beats a duplicate', async () => {
    const s = store();
    s.deps.postMessage.mockImplementationOnce(async () => false);
    expect(await maybeAcknowledgeHandover(handedOver(), s.deps)).toBe('post_failed');
    // The episode stays claimed, so the next inbound message does not re-post.
    expect(await maybeAcknowledgeHandover(handedOver(), s.deps)).toBe('already_acked');
  });
});
