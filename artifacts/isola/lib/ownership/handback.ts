/**
 * Human → AI handback: the explicit, authorized, reconciled path back to AI
 * authority.
 *
 * Implements `dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29`.
 *
 * The sequence is fixed and every step is a gate on the next:
 *
 *   1. AUTHORIZE  — an allow-listed actor for this tenant (./authorize.ts).
 *   2. BEGIN      — `HANDING_BACK`, claimed exactly once, episode-checked.
 *                   Nobody speaks from here until the outcome is known.
 *   3. RECONCILE  — human messages, relevant Odoo changes, a sanitized
 *                   outcome summary, and the prepared Clawith session.
 *   4. RESUME     — `AI_RESUMED`, and ONLY if every reconciliation step
 *                   succeeded. A failure returns the conversation to
 *                   `HUMAN_OWNED`; it never leaves an AI in charge of a
 *                   conversation whose human outcome it cannot see.
 *
 * Nothing here sends a customer message. A handback is a change of
 * authority, not an utterance — the next customer message is what invokes
 * the brain. Sending "I'm back!" on handback would be Foundation speaking on
 * the agent's behalf, which is the exact class of fabrication the Commit 1
 * fail-closed rules exist to prevent.
 *
 * Reconciliation is expressed as an injectable `HandbackReconciler` so each
 * step is independently testable and so Commit 3 can extend the Odoo step
 * without touching the state machine. The default Odoo step deliberately
 * REPORTS that it has no bounded capability yet rather than pretending to
 * have reconciled — an honest `skipped` beats a fabricated success.
 */

import { prisma } from '@/lib/prisma';
import { authorizeHandback, type HandbackActor } from './authorize';
import {
  abortHandback,
  beginHandback,
  completeHandback,
  type TransitionOutcome,
} from './transitions';
import type { OwnershipState } from './state';

// ── Sanitization ─────────────────────────────────────────────────────────────

/** Longest outcome summary that may enter the brain's context. */
export const MAX_OUTCOME_SUMMARY_CHARS = 2_000;

const SECRET_SHAPED = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\b[A-Fa-f0-9]{32,}\b/g,
  // Body deliberately includes `_`: real provider keys are sk_live_…,
  // pk_test_…; a class without `_` stops at the first separator, never
  // reaches the {12,} floor, and lets the key through.
  /\b(?:sk|pk|rk)_[A-Za-z0-9_]{12,}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT-shaped
];

/**
 * What a human wrote during an episode is not automatically safe to hand to
 * a model: agents paste tokens, one-time codes and internal links into
 * private notes. Redact secret-shaped runs, collapse whitespace, bound the
 * length. Redaction is deliberately shape-based and generous — a false
 * positive costs a few characters of context; a false negative puts a live
 * credential in a prompt.
 */
export function sanitizeOutcomeSummary(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_SHAPED) text = text.replace(pattern, '[redacted]');
  return text.slice(0, MAX_OUTCOME_SUMMARY_CHARS);
}

// ── Reconciler ───────────────────────────────────────────────────────────────

export interface HandbackContext {
  tenantId: string;
  conversationId: string;
  episode: number;
  operationId: string;
  actorRef: string;
}

export interface StepResult {
  ok: boolean;
  /** Short machine-readable outcome, recorded on failure as the abort reason. */
  detail: string;
}

export interface HandbackReconciler {
  /** Ensure everything the human said during this episode is in local history. */
  reconcileHumanMessages(ctx: HandbackContext): Promise<StepResult & { appended: number }>;
  /** Reconcile relevant Odoo changes made while the human owned the conversation. */
  reconcileOdoo(ctx: HandbackContext): Promise<StepResult & { status: 'skipped_no_binding' | 'noted' }>;
  /** Compose the sanitized outcome summary that enters the brain's context. */
  summarizeOutcome(ctx: HandbackContext): Promise<StepResult & { summary: string | null }>;
  /** Prepare the Clawith session/context for the next customer turn. */
  prepareClawithSession(ctx: HandbackContext): Promise<StepResult>;
}

/** Marker that makes a handback summary identifiable in history and in tests. */
export const HANDBACK_SUMMARY_PREFIX = '[handback]';

export const defaultHandbackReconciler: HandbackReconciler = {
  async reconcileHumanMessages(ctx) {
    // Human dashboard replies are already mirrored into local Message rows by
    // the paths that observe them; this step verifies the episode has a
    // readable history rather than inventing one. A conversation with no
    // messages at all cannot be summarised honestly.
    const count = await prisma.message.count({ where: { conversation_id: ctx.conversationId } });
    if (count === 0) {
      return { ok: false, detail: 'no_local_history_for_episode', appended: 0 };
    }
    return { ok: true, detail: 'history_present', appended: 0 };
  },

  async reconcileOdoo(ctx) {
    const binding = await prisma.odooBinding.findUnique({
      where: { tenant_id: ctx.tenantId },
      select: { tenant_id: true },
    });
    if (!binding) {
      // No Odoo for this tenant — nothing to reconcile, and saying so is the
      // truthful outcome rather than a failure.
      return { ok: true, detail: 'no_odoo_binding', status: 'skipped_no_binding' };
    }
    // Foundation has no bounded, authorised Odoo read capability on this path
    // yet (that is Commit 3's `allowedTools` work). Recording the binding's
    // presence is the whole of what this step can honestly claim today.
    return { ok: true, detail: 'odoo_binding_present_no_bounded_capability_yet', status: 'noted' };
  },

  async summarizeOutcome(ctx) {
    const recent = await prisma.message.findMany({
      where: { conversation_id: ctx.conversationId },
      orderBy: { created_at: 'desc' },
      take: 10,
      select: { role: true, content: true },
    });
    if (recent.length === 0) return { ok: false, detail: 'nothing_to_summarize', summary: null };
    const body = recent
      .reverse()
      .map((m) => `${m.role === 'user' ? 'customer' : 'team'}: ${m.content}`)
      .join(' | ');
    return {
      ok: true,
      detail: 'summarized',
      summary: sanitizeOutcomeSummary(
        `${HANDBACK_SUMMARY_PREFIX} A member of the team handled this conversation. What was covered: ${body}`,
      ),
    };
  },

  async prepareClawithSession() {
    // The Clawith session key is the conversation id and the context is the
    // bounded local history, both of which the next turn rebuilds from the
    // database. There is no separate remote session to prime, and pretending
    // to prime one would be a fabricated step.
    return { ok: true, detail: 'session_key_is_conversation_id' };
  },
};

// ── Orchestration ────────────────────────────────────────────────────────────

export type HandbackStatus =
  | 'resumed'
  | 'already_applied'
  | 'not_authorized'
  | 'stale_episode'
  | 'illegal_state'
  | 'unknown_conversation'
  | 'reconciliation_failed';

export interface HandbackResult {
  ok: boolean;
  status: HandbackStatus;
  state: OwnershipState;
  episode: number;
  /** Populated on `reconciliation_failed` / refusals — never a secret value. */
  detail: string | null;
  /** True exactly once per handback operation: when THIS call resumed the AI. */
  resumedNow: boolean;
}

function fromTransition(status: HandbackStatus, t: TransitionOutcome, detail: string | null): HandbackResult {
  return { ok: false, status, state: t.state, episode: t.episode, detail, resumedNow: false };
}

/**
 * Run one handback. Idempotent on `operationId`: a replay short-circuits at
 * the BEGIN claim and returns `already_applied` without re-running
 * reconciliation and without resuming a second time.
 */
export async function executeHandback(input: {
  tenantId: string;
  conversationId: string;
  episode: number;
  operationId: string;
  actor: HandbackActor | null | undefined;
  reason?: string;
  correlationId?: string | null;
  reconciler?: HandbackReconciler;
}): Promise<HandbackResult> {
  const reconciler = input.reconciler ?? defaultHandbackReconciler;

  // 1. AUTHORIZE — before any state is touched.
  const authz = authorizeHandback(input.actor, input.tenantId);
  if (!authz.ok) {
    return { ok: false, status: 'not_authorized', state: 'HUMAN_OWNED', episode: input.episode, detail: authz.refusal, resumedNow: false };
  }
  const actorRef = authz.actorRef;

  // 2. BEGIN
  const begun = await beginHandback({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    operationId: input.operationId,
    episode: input.episode,
    actorRef,
    reason: input.reason ?? 'explicit_authorized_handback_requested',
    correlationId: input.correlationId ?? null,
  });
  if (begun.status === 'duplicate') {
    return { ok: true, status: 'already_applied', state: begun.state, episode: begun.episode, detail: null, resumedNow: false };
  }
  if (begun.status === 'stale_episode') return fromTransition('stale_episode', begun, 'episode_no_longer_current');
  if (begun.status === 'unknown_conversation') return fromTransition('unknown_conversation', begun, null);
  if (begun.status !== 'applied') return fromTransition('illegal_state', begun, begun.status);

  const ctx: HandbackContext = {
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    episode: begun.episode,
    operationId: input.operationId,
    actorRef,
  };

  // 3. RECONCILE — first failure stops the sequence.
  const failed = async (detail: string): Promise<HandbackResult> => {
    const aborted = await abortHandback({
      tenantId: ctx.tenantId,
      conversationId: ctx.conversationId,
      operationId: ctx.operationId,
      episode: ctx.episode,
      actorRef,
      reason: `handback_reconciliation_failed:${detail}`,
      correlationId: input.correlationId ?? null,
    });
    console.warn(
      `[ownership] handback reconciliation FAILED conv=${ctx.conversationId} ep=${ctx.episode} step=${detail} — ` +
        `AI not resumed, conversation returned to human ownership`,
    );
    return { ok: false, status: 'reconciliation_failed', state: aborted.state, episode: ctx.episode, detail, resumedNow: false };
  };

  try {
    const messages = await reconciler.reconcileHumanMessages(ctx);
    if (!messages.ok) return failed(messages.detail);

    const odoo = await reconciler.reconcileOdoo(ctx);
    if (!odoo.ok) return failed(odoo.detail);

    const outcome = await reconciler.summarizeOutcome(ctx);
    if (!outcome.ok || !outcome.summary) return failed(outcome.detail || 'summary_missing');

    // Everything that can fail must fail BEFORE the summary is written. The
    // summary is a durable history turn: appending it and then aborting would
    // leave an orphan note in the brain's context, and the retry would append
    // a second one. So the last fallible step runs here, and the append is the
    // final act before the resume.
    const prepared = await reconciler.prepareClawithSession(ctx);
    if (!prepared.ok) return failed(prepared.detail);

    // The human's outcome enters the brain's context as an ordinary history
    // turn, so the bounded history the next request builds already contains
    // it — no side channel, no second source of truth.
    await prisma.message.create({
      data: {
        conversation_id: ctx.conversationId,
        role: 'assistant',
        content: sanitizeOutcomeSummary(outcome.summary),
      },
    });
  } catch (err: unknown) {
    return failed(`reconciler_threw:${(err as Error | null)?.name ?? 'error'}`);
  }

  // 4. RESUME
  const completed = await completeHandback({
    tenantId: ctx.tenantId,
    conversationId: ctx.conversationId,
    operationId: ctx.operationId,
    episode: ctx.episode,
    actorRef,
    correlationId: input.correlationId ?? null,
  });
  if (completed.status === 'duplicate') {
    return { ok: true, status: 'already_applied', state: completed.state, episode: completed.episode, detail: null, resumedNow: false };
  }
  if (completed.status !== 'applied') return fromTransition('illegal_state', completed, completed.status);

  return { ok: true, status: 'resumed', state: completed.state, episode: completed.episode, detail: null, resumedNow: true };
}
