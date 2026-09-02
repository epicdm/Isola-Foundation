/**
 * The durable conversation-ownership engine.
 *
 * Every change of response authority in Foundation goes through exactly one
 * of the functions below. They are the ONLY places that write
 * `Conversation.ownership_state` or the `human_handling` projection.
 *
 * ── Exactly-once ─────────────────────────────────────────────────────────
 *
 * Each call carries an `operationId`. The claim is the UNIQUE index
 * `(tenant_id, conversation_id, operation_id)` on
 * `ConversationOwnershipTransition` — the same substrate shape already
 * proven by `StaffWorkAction.@@unique([tenant_id, idempotency_key])`, not a
 * new invention. A replayed webhook, a retried MCP tool call and a
 * double-clicked dashboard button all present the same operation id and
 * therefore produce ONE transition; the second attempt returns
 * `status: 'duplicate'` with the conversation's current state and changes
 * nothing.
 *
 * Call sites MUST run their side effects (Chatwoot assignment, private note,
 * handoff message) only when `status === 'applied'`. That is what turns
 * "one transition" into "one note".
 *
 * Identity is tenant + conversation + episode, as required: the tenant and
 * conversation are in the unique key, and the episode is checked explicitly
 * via `expectedEpisode` wherever a late-arriving message could otherwise be
 * applied to the wrong episode of human involvement.
 *
 * ── Episodes ─────────────────────────────────────────────────────────────
 *
 * An episode is one span of human involvement. It increments when a
 * conversation LEAVES AI authority (escalation, or a human simply replying),
 * and never otherwise. A handback names the episode it is ending; if that
 * conversation has since been escalated again, the episode no longer matches
 * and the handback is refused as `stale_episode` rather than resuming an AI
 * into a live human conversation.
 *
 * ── Atomicity ────────────────────────────────────────────────────────────
 *
 * Claim and state change happen in one interactive transaction. A crash
 * between them would otherwise leave a claimed operation whose state change
 * never landed — and because the claim is idempotent, the retry would be
 * swallowed as a duplicate and the conversation would sit in the old state
 * forever.
 */

import { prisma } from '@/lib/prisma';
import {
  DEFAULT_OWNERSHIP_STATE,
  canTransition,
  isOwnershipState,
  projectHumanHandling,
  type OwnershipState,
} from './state';

// ── Result vocabulary ────────────────────────────────────────────────────────

export type TransitionStatus =
  /** The transition was claimed and applied by THIS call. Side effects belong here. */
  | 'applied'
  /** This exact operation was already claimed. Nothing changed. Not an error. */
  | 'duplicate'
  /** The caller named an episode that is no longer current. Refused. */
  | 'stale_episode'
  /** The conversation is not in a state from which this transition is legal. */
  | 'illegal_transition'
  /** No such conversation for this tenant. */
  | 'unknown_conversation';

export interface TransitionOutcome {
  /** True for `applied` and `duplicate` — i.e. the intent holds. False means refused. */
  ok: boolean;
  status: TransitionStatus;
  /** The conversation's state AFTER this call (unchanged when not applied). */
  state: OwnershipState;
  episode: number;
  operationId: string;
  transitionId: string | null;
}

/** Kinds are free-form strings in the ledger, enumerated here so the audit
 *  surface is inspectable and a typo cannot invent a new kind silently. */
export type OwnershipOperationKind =
  | 'escalate'
  | 'human_assigned'
  | 'human_reply'
  | 'handback_begin'
  | 'handback_complete'
  | 'handback_failed'
  | 'resolution_observed'
  | 'resumed_settled';

interface ApplyInput {
  tenantId: string;
  conversationId: string;
  operationId: string;
  operationKind: OwnershipOperationKind;
  toState: OwnershipState;
  reason: string;
  /** States this transition may legally start from. A current state outside
   *  this set is refused — even when `canTransition` would allow it — so each
   *  caller's own precondition is explicit rather than implied by the graph. */
  allowedFrom: readonly OwnershipState[];
  actorRef?: string | null;
  correlationId?: string | null;
  /** When set, the conversation's current episode must equal this exactly. */
  expectedEpisode?: number | null;
  /** True for transitions that OPEN a new span of human involvement. */
  startsNewEpisode?: boolean;
  /** Recorded on the conversation for provenance. */
  escalationOperationId?: string | null;
  handbackOperationId?: string | null;
}

type TxClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

const CONVERSATION_SELECT = {
  id: true,
  tenant_id: true,
  ownership_state: true,
  ownership_episode: true,
  human_handling: true,
} as const;

/** Fail-closed read used for transition preconditions: an unrecognised state
 *  is treated as HUMAN_OWNED so an unknown row cannot be transitioned into an
 *  AI state by a caller that expected AI_OWNED. */
function currentState(raw: unknown): OwnershipState {
  return isOwnershipState(raw) ? raw : 'HUMAN_OWNED';
}

function refused(status: TransitionStatus, state: OwnershipState, episode: number, operationId: string): TransitionOutcome {
  return { ok: false, status, state, episode, operationId, transitionId: null };
}

async function applyTransition(input: ApplyInput): Promise<TransitionOutcome> {
  const {
    tenantId, conversationId, operationId, operationKind, toState, reason,
    allowedFrom, actorRef = null, correlationId = null,
    expectedEpisode = null, startsNewEpisode = false,
    escalationOperationId = null, handbackOperationId = null,
  } = input;

  return prisma.$transaction(async (tx: TxClient) => {
    const conv = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_SELECT,
    });
    if (!conv || conv.tenant_id !== tenantId) {
      return refused('unknown_conversation', 'HUMAN_OWNED', 0, operationId);
    }

    const from = currentState(conv.ownership_state);
    const episode = typeof conv.ownership_episode === 'number' ? conv.ownership_episode : 0;

    // Idempotency FIRST — a replay must not be judged against preconditions
    // that its own original application has already changed. Without this, a
    // retried escalation would see HUMAN_REQUESTED, fail `allowedFrom`, and
    // report `illegal_transition` for an operation that in fact succeeded.
    const existing = await tx.conversationOwnershipTransition.findUnique({
      where: {
        tenant_id_conversation_id_operation_id: {
          tenant_id: tenantId,
          conversation_id: conversationId,
          operation_id: operationId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { ok: true, status: 'duplicate' as const, state: from, episode, operationId, transitionId: existing.id };
    }

    if (expectedEpisode !== null && expectedEpisode !== episode) {
      return refused('stale_episode', from, episode, operationId);
    }
    if (!allowedFrom.includes(from) || !canTransition(from, toState)) {
      return refused('illegal_transition', from, episode, operationId);
    }

    const nextEpisode = startsNewEpisode ? episode + 1 : episode;
    const now = new Date();

    let created: { id: string };
    try {
      created = await tx.conversationOwnershipTransition.create({
        data: {
          tenant_id: tenantId,
          conversation_id: conversationId,
          episode: nextEpisode,
          from_state: from,
          to_state: toState,
          reason,
          operation_id: operationId,
          operation_kind: operationKind,
          actor_ref: actorRef,
          correlation_id: correlationId,
        },
        select: { id: true },
      });
    } catch (err: unknown) {
      // Concurrent claim — the other writer won and applied the same intent.
      if ((err as { code?: string } | null)?.code === 'P2002') {
        return { ok: true, status: 'duplicate' as const, state: from, episode, operationId, transitionId: null };
      }
      throw err;
    }

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        ownership_state: toState,
        ownership_episode: nextEpisode,
        ownership_changed_at: now,
        ownership_reason: reason,
        ownership_actor_ref: actorRef,
        ownership_correlation_id: correlationId,
        ...(escalationOperationId !== null ? { ownership_escalation_operation_id: escalationOperationId } : {}),
        ...(handbackOperationId !== null ? { ownership_handback_operation_id: handbackOperationId } : {}),
        // Compatibility projection — derived, never consulted for authority
        // on a door where the ownership model is authoritative.
        human_handling: projectHumanHandling(toState),
      },
    });

    return { ok: true, status: 'applied' as const, state: toState, episode: nextEpisode, operationId, transitionId: created.id };
  });
}

// ── Public transitions ───────────────────────────────────────────────────────

export interface EscalationInput {
  tenantId: string;
  conversationId: string;
  /** The escalation operation's identity. For the governed
   *  `escalate_to_human` endpoint this is the scoped ref's own correlation
   *  id, which is stable for the life of the ref — so a replayed tool call
   *  presents the SAME id and claims once. */
  operationId: string;
  reason: string;
  actorRef?: string | null;
  correlationId?: string | null;
}

/**
 * Accepted escalation → `HUMAN_REQUESTED`, opening a new episode.
 *
 * Automated replies are suppressed from the moment this returns `applied`
 * (or `duplicate` — the suppression is already in force), BEFORE the caller
 * performs the Chatwoot assignment and context publication. Suppress first,
 * publish second: the reverse order leaves a window in which the bot can
 * answer a conversation that has already been handed to a person.
 */
export async function requestHumanOwnership(input: EscalationInput): Promise<TransitionOutcome> {
  return applyTransition({
    ...input,
    operationKind: 'escalate',
    toState: 'HUMAN_REQUESTED',
    allowedFrom: ['AI_OWNED', 'AI_RESUMED'],
    startsNewEpisode: true,
    escalationOperationId: input.operationId,
  });
}

/**
 * Assignment and context publication completed → `HUMAN_OWNED`.
 * Replies stay suppressed; the difference from `HUMAN_REQUESTED` is that a
 * person can now actually see the conversation and its context.
 */
export async function confirmHumanOwnership(input: {
  tenantId: string;
  conversationId: string;
  operationId: string;
  episode: number;
  reason: string;
  actorRef?: string | null;
  correlationId?: string | null;
}): Promise<TransitionOutcome> {
  return applyTransition({
    ...input,
    operationKind: 'human_assigned',
    toState: 'HUMAN_OWNED',
    allowedFrom: ['HUMAN_REQUESTED'],
    expectedEpisode: input.episode,
  });
}

/**
 * A human agent replied in the Chatwoot dashboard → `HUMAN_OWNED`.
 *
 * This is the path that has been proven in production for months and it is
 * preserved exactly: the human's reply silences the bot. What changes is
 * only that the silence is now a recorded state with an episode, instead of
 * a boolean that any later resolution could clear.
 *
 * From an AI state this opens a new episode (the human took over without a
 * prior escalation). From `HUMAN_REQUESTED` it confirms the existing one.
 */
export async function recordHumanReply(input: {
  tenantId: string;
  conversationId: string;
  /** Chatwoot's own message id — one physical human reply, one transition. */
  operationId: string;
  currentState: OwnershipState;
  currentEpisode: number;
  reason?: string;
  actorRef?: string | null;
}): Promise<TransitionOutcome> {
  // Already human-owned, or mid-handback (where a human message is part of
  // the reconciliation rather than a new takeover). There is nothing to
  // transition and the bot is already silent — returning `duplicate` says
  // exactly that, rather than reporting an illegal transition for an event
  // whose intent already holds.
  if (input.currentState === 'HUMAN_OWNED' || input.currentState === 'HANDING_BACK') {
    return {
      ok: true,
      status: 'duplicate',
      state: input.currentState,
      episode: input.currentEpisode,
      operationId: input.operationId,
      transitionId: null,
    };
  }
  const fromAi = input.currentState === 'AI_OWNED' || input.currentState === 'AI_RESUMED';
  return applyTransition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: input.operationId,
    operationKind: 'human_reply',
    toState: 'HUMAN_OWNED',
    reason: input.reason ?? 'human_agent_replied_in_chatwoot',
    allowedFrom: fromAi ? ['AI_OWNED', 'AI_RESUMED'] : ['HUMAN_REQUESTED'],
    startsNewEpisode: fromAi,
    actorRef: input.actorRef ?? null,
  });
}

/** Explicit, authorized handback begins → `HANDING_BACK`. Nobody speaks. */
export async function beginHandback(input: {
  tenantId: string;
  conversationId: string;
  operationId: string;
  episode: number;
  actorRef: string;
  reason?: string;
  correlationId?: string | null;
}): Promise<TransitionOutcome> {
  return applyTransition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: input.operationId,
    operationKind: 'handback_begin',
    toState: 'HANDING_BACK',
    reason: input.reason ?? 'explicit_authorized_handback_requested',
    allowedFrom: ['HUMAN_OWNED', 'HUMAN_REQUESTED'],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
    handbackOperationId: input.operationId,
  });
}

/** Reconciliation succeeded → `AI_RESUMED`. The ONLY edge back to AI authority. */
export async function completeHandback(input: {
  tenantId: string;
  conversationId: string;
  operationId: string;
  episode: number;
  actorRef: string;
  correlationId?: string | null;
}): Promise<TransitionOutcome> {
  return applyTransition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: `${input.operationId}:complete`,
    operationKind: 'handback_complete',
    toState: 'AI_RESUMED',
    reason: 'handback_reconciled',
    allowedFrom: ['HANDING_BACK'],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
    handbackOperationId: input.operationId,
  });
}

/** Reconciliation failed → back to `HUMAN_OWNED`. The AI does not resume. */
export async function abortHandback(input: {
  tenantId: string;
  conversationId: string;
  operationId: string;
  episode: number;
  actorRef: string;
  reason: string;
  correlationId?: string | null;
}): Promise<TransitionOutcome> {
  return applyTransition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: `${input.operationId}:failed`,
    operationKind: 'handback_failed',
    toState: 'HUMAN_OWNED',
    reason: input.reason,
    allowedFrom: ['HANDING_BACK'],
    expectedEpisode: input.episode,
    actorRef: input.actorRef,
    correlationId: input.correlationId ?? null,
  });
}

/**
 * The resumed turn has been consumed → `AI_RESUMED` settles to `AI_OWNED`.
 * Both states permit an invocation, so this changes no authority; it makes
 * "the next customer message invoked Clawith once after handback" an
 * observable fact rather than an assumption.
 */
export async function settleResumed(input: {
  tenantId: string;
  conversationId: string;
  operationId: string;
  episode: number;
}): Promise<TransitionOutcome> {
  return applyTransition({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: input.operationId,
    operationKind: 'resumed_settled',
    toState: 'AI_OWNED',
    reason: 'resumed_turn_consumed',
    allowedFrom: ['AI_RESUMED'],
    expectedEpisode: input.episode,
  });
}

// ── Resolution ───────────────────────────────────────────────────────────────

export type ResolutionStatus = 'recorded' | 'duplicate' | 'unknown_conversation';

export interface ResolutionOutcome {
  status: ResolutionStatus;
  state: OwnershipState;
  episode: number;
  /** True when the legacy compatibility clear was applied (non-authoritative door). */
  legacyCleared: boolean;
}

/**
 * `conversation_resolved` / `conversation_status_changed → resolved`.
 *
 * THIS IS THE CENTRAL BEHAVIOURAL CHANGE OF COMMIT 2.
 *
 * Before: resolution set `human_handling = false`, which handed response
 * authority straight back to the AI. Closing a ticket in the Chatwoot UI —
 * something agents do for housekeeping, and something Chatwoot itself does
 * on automation rules — silently re-armed an automated brain with no
 * reconciliation, no human outcome in context, and no record that it had
 * happened.
 *
 * After, on a door where ownership is AUTHORITATIVE: resolution marks the
 * conversation resolved and writes a ledger row. Ownership does not move.
 * Only an explicit authorized handback can return authority to the AI.
 *
 * On a NON-authoritative (legacy) door the historical clear is preserved
 * exactly — and applied to BOTH stores, so the state and its projection
 * cannot drift. That is what keeps gate-OFF production behaviour identical.
 */
export async function recordResolution(input: {
  tenantId: string;
  conversationId: string;
  /** Stable per (conversation, episode) so webhook retries collapse. */
  operationId: string;
  authoritative: boolean;
  reason?: string;
}): Promise<ResolutionOutcome> {
  const { tenantId, conversationId, operationId, authoritative } = input;

  return prisma.$transaction(async (tx: TxClient) => {
    const conv = await tx.conversation.findUnique({
      where: { id: conversationId },
      select: CONVERSATION_SELECT,
    });
    if (!conv || conv.tenant_id !== tenantId) {
      return { status: 'unknown_conversation' as const, state: 'HUMAN_OWNED' as OwnershipState, episode: 0, legacyCleared: false };
    }

    const from = currentState(conv.ownership_state);
    const episode = typeof conv.ownership_episode === 'number' ? conv.ownership_episode : 0;

    const existing = await tx.conversationOwnershipTransition.findUnique({
      where: {
        tenant_id_conversation_id_operation_id: {
          tenant_id: tenantId, conversation_id: conversationId, operation_id: operationId,
        },
      },
      select: { id: true },
    });
    if (existing) {
      return { status: 'duplicate' as const, state: from, episode, legacyCleared: false };
    }

    // On a legacy door the historical semantics stand: resolution clears the
    // human hold. Applied to the state as well as the boolean, so the two
    // never disagree.
    const legacyClear = !authoritative && from !== 'AI_OWNED' && from !== 'AI_RESUMED';
    const toState: OwnershipState = legacyClear ? DEFAULT_OWNERSHIP_STATE : from;
    const reason = input.reason
      ?? (authoritative
        ? 'chatwoot_resolution_observed_ownership_unchanged'
        : legacyClear
          ? 'legacy_resolution_clear_non_authoritative_door'
          : 'chatwoot_resolution_observed');

    try {
      await tx.conversationOwnershipTransition.create({
        data: {
          tenant_id: tenantId,
          conversation_id: conversationId,
          episode,
          from_state: from,
          to_state: toState,
          reason,
          operation_id: operationId,
          operation_kind: 'resolution_observed',
          actor_ref: 'chatwoot:conversation_resolved',
          correlation_id: null,
        },
        select: { id: true },
      });
    } catch (err: unknown) {
      if ((err as { code?: string } | null)?.code === 'P2002') {
        return { status: 'duplicate' as const, state: from, episode, legacyCleared: false };
      }
      throw err;
    }

    await tx.conversation.update({
      where: { id: conversationId },
      data: {
        status: 'resolved',
        ...(legacyClear
          ? {
              ownership_state: toState,
              ownership_changed_at: new Date(),
              ownership_reason: reason,
              human_handling: false,
            }
          : {}),
      },
    });

    return { status: 'recorded' as const, state: toState, episode, legacyCleared: legacyClear };
  });
}
