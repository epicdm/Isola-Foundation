/**
 * HANDBACK — the caller the ownership state machine never had.
 *
 * `beginHandback`, `completeHandback` and `settleResumed` were written, tested
 * and correct, and NOTHING IN THE CODEBASE EVER CALLED THEM. Escalation moved
 * a conversation to HUMAN_REQUESTED/HUMAN_OWNED and there was no edge back, so
 * the first escalation silenced the AI for that customer permanently — with no
 * automatic resume and no manual one either. That was a regression against the
 * previous bff-v2 implementation, which was worse engineered (an in-memory Map,
 * lost on restart) and functionally more complete (10-minute idle resume, and
 * an instant clear when a label was removed).
 *
 * This module adds the caller. It does NOT add a second state machine: every
 * transition below is an existing exported function, called in its documented
 * order.
 *
 * SUPERSEDED 2026-10-02 (pivot packet ISOLA-PIVOT-20261002-01): the ratified
 * contract is EXPLICIT-ONLY handback. The idle trigger below is now OFF BY
 * DEFAULT and exists only as an explicit opt-in (`idleHandbackEnabled` /
 * GATEWAY_HANDBACK_IDLE_ENABLED). The historical description that follows is
 * kept because the opt-in path still behaves exactly as described.
 *
 * TWO TRIGGERS, ONE PATH:
 *   1. MANUAL — a human presses "Mark as pending" in Chatwoot. Already in the
 *      UI, already the exact inverse of the takeover gesture, and already what
 *      the gateway's own `status_not_pending` guard keys on. Nothing new for a
 *      human to learn.
 *   2. IDLE (OPT-IN ONLY) — no message in the conversation for `handbackIdleMs`.
 *
 * IDLE MEANS IDLE, NOT ELAPSED. The clock runs from the LAST MESSAGE in the
 * conversation, not from the moment of takeover. A human who is actively
 * replying keeps resetting it and is never interrupted mid-conversation; an
 * elapsed-since-takeover timer would cut across a live human exchange, which is
 * strictly worse than the defect being fixed.
 *
 * KNOWN AND ACCEPTED CONSEQUENCE — DO NOT "FIX" THIS WITH A SECOND MECHANISM:
 * a human says "let me check and get back to you", goes away for twenty
 * minutes, the customer writes "any update?", and the AI answers — because the
 * conversation was idle. The previous system behaved identically and the owner
 * lived with it. We are restoring parity, not seeking an optimum. If it ever
 * matters, the answer is that the human snoozes the conversation or keeps
 * owning it, NOT that we add another timer.
 */

import type { ChatwootApi, ChatwootTarget } from "./chatwoot.js";
import type { Logger } from "./log.js";
import type { SqlClient, SqlExecutor } from "./ledger.js";
import { readLastBusinessTurnMs } from "./turns.js";
import {
  abortHandback,
  beginHandback,
  completeHandback,
  readConversationOwnership,
  settleResumed,
} from "./ownership-store.js";
import type { ConversationRef } from "./ownership.js";

/** States a handback may begin from. Anything else has nothing to hand back. */
/**
 * States the sweeper may act on.
 *
 * `HANDING_BACK` IS INCLUDED DELIBERATELY. It suppresses the AI just as the
 * human-held states do, so a process that dies between `beginHandback` and
 * `completeHandback` would otherwise leave a row nothing ever selects again:
 * AI silenced, no human told, no retry. Review 2026-08-17. `performHandback`
 * is idempotent across a resumed row — `beginHandback` returns `duplicate` for
 * the same operation id, which is `ok`.
 */
const HANDBACK_ELIGIBLE_STATES = ["HUMAN_REQUESTED", "HUMAN_OWNED", "HANDING_BACK"] as const;

export interface HandbackDeps {
  exec: SqlExecutor;
  chatwoot: ChatwootApi;
  logger: Logger;
  now?: () => number;
}

export interface HandbackRequest {
  conversation: ConversationRef;
  episode: number;
  target: ChatwootTarget;
  /** `manual_mark_pending` or `idle_timeout`. Recorded on every transition. */
  reason: string;
  actorRef: string;
  correlationId?: string | null;
}

export type HandbackResult =
  | { ok: true; settled: boolean }
  | { ok: false; stage: "begin" | "complete" | "chatwoot"; detail: string };

/**
 * Run the full return edge: HANDING_BACK -> AI_RESUMED -> AI_OWNED, then set
 * Chatwoot back to `pending` so both guards agree.
 *
 * ORDER MATTERS. The ownership transitions come FIRST and Chatwoot second: if
 * the Chatwoot call fails after the store has resumed, the AI is authorised but
 * the conversation is not pending, so `status_not_pending` still suppresses it
 * and the worst case is that the handback did not take. The reverse order would
 * set the conversation pending while the store still said HUMAN_OWNED — a
 * conversation nobody answers, which is the failure we are removing.
 */
export async function performHandback(
  deps: HandbackDeps,
  req: HandbackRequest,
): Promise<HandbackResult> {
  const operationId =
    `handback:${req.conversation.tenantId}:${req.conversation.chatwootAccountId}:` +
    `${req.conversation.chatwootConversationId}:${req.episode}:${req.reason}`;
  const base = {
    event: "handback",
    tenantId: req.conversation.tenantId,
    chatwootAccountId: req.conversation.chatwootAccountId,
    chatwootConversationId: req.conversation.chatwootConversationId,
    episode: req.episode,
    reason: req.reason,
    correlationId: req.correlationId ?? null,
  };

  const begun = await beginHandback(deps.exec, {
    conversation: req.conversation,
    operationId,
    episode: req.episode,
    actorRef: req.actorRef,
    reason: req.reason,
    correlationId: req.correlationId ?? null,
  });
  if (!begun.ok) {
    deps.logger.warn({ ...base, outcome: "handback_begin_refused", detail: begun.status });
    return { ok: false, stage: "begin", detail: begun.status };
  }

  const completed = await completeHandback(deps.exec, {
    conversation: req.conversation,
    operationId,
    episode: req.episode,
    actorRef: req.actorRef,
    correlationId: req.correlationId ?? null,
  });
  if (!completed.ok) {
    deps.logger.error({
      ...base,
      alert: true,
      alertCode: "handback_stuck_in_handing_back",
      outcome: "handback_complete_refused",
      detail:
        "ownership is HANDING_BACK and did not reach AI_RESUMED; neither side will answer until this is retried",
    });
    return { ok: false, stage: "complete", detail: completed.status };
  }

  // AI_RESUMED -> AI_OWNED. Best-effort: the AI already has authority at
  // AI_RESUMED, so a failure here costs tidiness, not capability.
  let settled = false;
  try {
    const s = await settleResumed(deps.exec, {
      conversation: req.conversation,
      operationId: `${operationId}:settle`,
      episode: req.episode,
    });
    settled = s.ok;
  } catch (err) {
    deps.logger.warn({
      ...base,
      outcome: "handback_settle_failed",
      detail: err instanceof Error ? err.message : "unknown",
    });
  }

  try {
    await deps.chatwoot.pendConversation(req.target);
  } catch (err) {
    // THE OWNERSHIP STORE ALREADY SAYS AI_OWNED, BUT CHATWOOT STILL SAYS OPEN,
    // so `status_not_pending` keeps suppressing the AI while the row is no
    // longer in a human state — nothing would ever select it again and the
    // conversation would be owned by nobody. Abort back to HUMAN_OWNED so the
    // sweeper retries on its next pass. Review 2026-08-17.
    deps.logger.error({
      ...base,
      alert: true,
      alertCode: "handback_chatwoot_pend_failed",
      outcome: "handback_chatwoot_pend_failed",
      detail: err instanceof Error ? err.message : "unknown",
    });
    try {
      await abortHandback(deps.exec, {
        conversation: req.conversation,
        operationId: `${operationId}:abort`,
        episode: req.episode,
        actorRef: req.actorRef,
        reason: "chatwoot_pend_failed_reverting_to_human",
        correlationId: req.correlationId ?? null,
      });
    } catch (abortErr) {
      deps.logger.error({
        ...base,
        alert: true,
        alertCode: "handback_abort_failed",
        outcome: "handback_abort_failed",
        detail:
          "ownership says the AI resumed but Chatwoot was never set pending, and the abort failed; this conversation is answered by nobody until retried",
      });
    }
    return { ok: false, stage: "chatwoot", detail: "pendConversation failed" };
  }

  deps.logger.info({ ...base, outcome: "handed_back", settled });
  return { ok: true, settled };
}

// ---------------------------------------------------------------------------
// THE MANUAL TRIGGER, ON THE WEBHOOK PATH
// ---------------------------------------------------------------------------
//
// server.ts's own boot comment has said, since before this function existed,
// that "the manual trigger ('Mark as pending' in Chatwoot) is handled on the
// webhook path; this is the one that needs a clock" — describing exactly this
// function, which did not exist yet. The sweeper's `recordReadable` fallback
// was the only manual detection there ever was, and it depends on re-reading
// the conversation via `conversations#show`, which 500s for an AgentBot token
// once a team is assigned — precisely the case escalation creates. So the
// comment was aspirational, not a description of working code: for every
// escalation with a team configured (the normal, intended path),
// `recordReadable` was false on every sweep and the manual trigger could never
// fire. See `def-explicit-handback-unreachable-after-team-assignment-2026-08-24`.
//
// THE FIX IS THE EVENT, NOT THE FETCH. Chatwoot's own `conversation_status_changed`
// webhook reports the status directly, so nothing here needs to ask
// `conversations#show` anything. It reaches this function only after the SAME
// signature verification every other delivery goes through — no new trust
// boundary, no admin token, no manual database change. It is, deliberately,
// Chatwoot's real "mark as pending" action and nothing else: the ratified
// instruction is that explicit handback must work through the conversation
// lifecycle a human agent already uses, not a parallel mechanism.

export interface ManualHandbackWebhookArgs {
  conversation: ConversationRef;
  target: ChatwootTarget;
  correlationId?: string | null;
}

export type ManualHandbackWebhookOutcome =
  | { outcome: "handed_back"; episode: number; settled: boolean }
  /** The AI already owned this conversation; the signal was a true no-op. */
  | { outcome: "no_handback_needed"; state: string }
  | { outcome: "handback_failed"; stage: string; detail: string };

/**
 * Act on a signed `conversation_status_changed` -> `pending` webhook.
 *
 * Reads the CURRENT episode before deciding whether to call `performHandback`
 * at all — under NO lock, because the decision made here is only "is there
 * anything eligible to hand back", never the transition itself. The actual
 * safety property is `performHandback`'s own `expectedEpisode` check, taken
 * under `applyOwnershipTransition`'s row lock; a stale read here can only
 * cause a call that gets correctly refused, never one that succeeds
 * incorrectly.
 *
 * IDEMPOTENT ACROSS RETRIES FOR FREE. `performHandback`'s operation id is
 * deterministic — `handback:{tenant}:{account}:{conversation}:{episode}:{reason}`
 * — so a redelivered webhook (Chatwoot's own retry, or two concurrent
 * deliveries) computes the SAME id and `applyOwnershipTransition`'s unique
 * claim resolves the race; the loser reports `duplicate`, which
 * `performHandback` reports as `ok: true`. No separate delivery ledger
 * reservation is needed for this path, unlike the reply path — the ownership
 * store's own claim already is the exactly-once guarantee.
 */
export async function handleManualHandbackWebhook(
  deps: HandbackDeps,
  args: ManualHandbackWebhookArgs,
): Promise<ManualHandbackWebhookOutcome> {
  const view = await readConversationOwnership(deps.exec, args.conversation);

  const eligible = (HANDBACK_ELIGIBLE_STATES as readonly string[]).includes(view.state);
  if (!eligible) {
    deps.logger.info({
      event: "handback",
      outcome: "webhook_no_handback_needed",
      accountId: args.conversation.chatwootAccountId,
      conversationId: args.conversation.chatwootConversationId,
      ownershipState: view.state,
      detail:
        "a status-changed webhook reported pending, but the AI already owns this " +
        "conversation; nothing to hand back",
    });
    return { outcome: "no_handback_needed", state: view.state };
  }

  const result = await performHandback(deps, {
    conversation: args.conversation,
    episode: view.episode,
    target: args.target,
    reason: "manual_mark_pending",
    // Distinct actorRef from the sweeper's own manual path
    // ("chatwoot:mark_as_pending"), so the audit trail can tell which
    // detection mechanism actually fired — useful while both exist, and a
    // clean signal if the sweeper's fallback is ever retired outright.
    actorRef: "chatwoot:mark_as_pending:webhook",
    correlationId: args.correlationId ?? null,
  });

  if (!result.ok) {
    return { outcome: "handback_failed", stage: result.stage, detail: result.detail };
  }
  return { outcome: "handed_back", episode: view.episode, settled: result.settled };
}

/** A conversation the sweeper may act on, read from the ownership store. */
export interface IdleCandidate {
  conversation: ConversationRef;
  episode: number;
  accountId: number;
  conversationId: number;
  inboxId: number | null;
  /** When the human took/was asked for the conversation. The idle floor when no
   *  business turn has been recorded — so a conversation escalated before the
   *  turn store existed still has a clock, instead of being ineligible forever. */
  ownershipChangedAtMs: number | null;
}

/**
 * Conversations a human holds. `ownership_changed_at` is the floor for how long
 * the hold has existed; the ACTUAL idleness test is done per-candidate against
 * Chatwoot's own `last_activity_at`, because the gateway never sees a human's
 * outgoing messages (they are suppressed as `message_type_not_incoming`) and so
 * cannot know from its own records when a human last spoke.
 */
export async function selectHumanHeldConversations(
  exec: SqlExecutor,
  limit: number,
): Promise<IdleCandidate[]> {
  const rows = await exec.query(
    `SELECT tenant_id, conversation_key, ownership_episode,
            chatwoot_account_id, chatwoot_conversation_id, chatwoot_inbox_id,
            ownership_changed_at
       FROM conversation_ownership
      WHERE ownership_state = ANY($1::text[])
      ORDER BY ownership_changed_at ASC NULLS FIRST
      LIMIT $2`,
    [[...HANDBACK_ELIGIBLE_STATES], limit],
  );
  return (rows.rows ?? []).map((r: Record<string, unknown>) => ({
    conversation: {
      tenantId: String(r["tenant_id"]),
      chatwootAccountId: Number(r["chatwoot_account_id"]),
      chatwootConversationId: Number(r["chatwoot_conversation_id"]),
      chatwootInboxId: r["chatwoot_inbox_id"] === null ? null : Number(r["chatwoot_inbox_id"]),
    },
    episode: Number(r["ownership_episode"] ?? 0),
    accountId: Number(r["chatwoot_account_id"]),
    conversationId: Number(r["chatwoot_conversation_id"]),
    inboxId: r["chatwoot_inbox_id"] === null ? null : Number(r["chatwoot_inbox_id"]),
    ownershipChangedAtMs: toEpochMs(r["ownership_changed_at"]),
  }));
}

/**
 * Chatwoot reports `last_activity_at` in SECONDS. Returning null rather than 0
 * on a shape we do not recognise is deliberate: 0 would read as "idle since
 * 1970" and hand every conversation back on the first sweep.
 */
export function readConversationStatus(record: unknown): string | null {
  if (typeof record !== "object" || record === null) return null;
  const payload = (record as Record<string, unknown>)["payload"] ?? record;
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>)["status"];
  return typeof raw === "string" ? raw : null;
}

/** Postgres may hand back a Date or a string depending on the driver. */
export function toEpochMs(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

export function readLastActivityMs(record: unknown): number | null {
  if (typeof record !== "object" || record === null) return null;
  const payload = (record as Record<string, unknown>)["payload"] ?? record;
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>)["last_activity_at"];
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return raw * 1000;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Everything the sweeper needs to turn an ownership row into a Chatwoot call. */
export interface HandbackSweeperDeps extends HandbackDeps {
  /**
   * OPT-IN idle handback. DEFAULT OFF (absent = false).
   *
   * The ratified contract is EXPLICIT-ONLY handback: a human who holds a
   * conversation gives it back by an explicit, verified Chatwoot transition
   * ("Mark as pending"), never by going quiet. Idleness is not consent — a human
   * at lunch has not handed the customer back
   * (def-idle-timeout-handback-contradicts-ratified-explicit-contract-2026-08-20).
   * With this off the sweeper still detects the explicit gesture (status already
   * `pending` while the store says a human holds it) and hands back on THAT; it
   * simply never reads a clock to decide.
   *
   * Kept as an explicit opt-in (GATEWAY_HANDBACK_IDLE_ENABLED) only because a
   * deployment may depend on the old behaviour; turning it on contradicts the
   * ratified contract and should carry its own recorded decision.
   */
  idleHandbackEnabled?: boolean;
  idleMs: number;
  intervalMs: number;
  batch: number;
  /** Resolve the per-binding Chatwoot credentials for a conversation. Returns
   *  null when no binding matches — a row whose binding was removed must be
   *  skipped, never handed back with someone else's token. */
  resolveTarget(candidate: IdleCandidate): ChatwootTarget | null;
  /** The gateway's own turn store, used as the idle clock. Optional so an
   *  installation without it still sweeps on the Chatwoot clock. */
  turnStore?: SqlClient;
}

export interface HandbackSweeper {
  sweep(): Promise<number>;
  start(): void;
  stop(): void;
}

/**
 * The IDLE trigger. Runs alongside the ledger recovery sweeper and follows the
 * same shape: a re-entrancy guard, `unref()` so it never holds the process open,
 * and a bounded batch.
 *
 * It reads idleness from CHATWOOT, not from the ownership store, because the
 * gateway never sees a human's outgoing messages and therefore cannot know from
 * its own records when a human last spoke. A conversation whose activity cannot
 * be read is LEFT ALONE — silence from Chatwoot is not evidence of idleness.
 */
export function createHandbackSweeper(deps: HandbackSweeperDeps): HandbackSweeper {
  const now = deps.now ?? (() => Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function sweep(): Promise<number> {
    if (running) return 0;
    running = true;
    let handedBack = 0;
    try {
      const candidates = await selectHumanHeldConversations(deps.exec, deps.batch);
      for (const candidate of candidates) {
        // EVERY SKIP BELOW IS LOGGED. The previous version `continue`d silently
        // on four different paths, and the result was a sweeper that ran once a
        // minute for nine hours, stranded a real customer, and reported nothing
        // but "started". An unobservable loop is indistinguishable from a
        // working one — that is the defect, not just the strand.
        const skip = (reason: string, extra: Record<string, unknown> = {}): void => {
          deps.logger.info({
            event: "handback",
            outcome: "sweep_skipped",
            accountId: candidate.accountId,
            conversationId: candidate.conversationId,
            reason,
            ...extra,
          });
        };

        const target = deps.resolveTarget(candidate);
        if (target === null) {
          skip("no_binding");
          continue;
        }

        // Chatwoot is consulted for the MANUAL trigger only, and its failure is
        // no longer fatal. `conversations#show` returns 500 for an AgentBot
        // token once a team is assigned, and escalation is what assigns the
        // team — so this endpoint breaks precisely when the sweeper needs it.
        let record: unknown = null;
        let recordReadable = true;
        try {
          record = await deps.chatwoot.getConversationRecord(target);
        } catch {
          recordReadable = false;
        }

        // TRIGGER 1 — MANUAL. A human pressed "Mark as pending" in Chatwoot.
        // Chatwoot's status is already `pending` while the ownership store
        // still says a human holds it, so the two disagree and the AI stays
        // silent. An explicit gesture is not subject to the idle clock.
        const manual = recordReadable && readConversationStatus(record) === "pending";

        // IDLE HANDBACK IS OFF UNLESS EXPLICITLY OPTED IN. Not an explicit
        // gesture and not opted in: leave the conversation with the human, and
        // SAY SO — a skip nobody can see is indistinguishable from a dead loop.
        // No clock is read: the turn store and the Chatwoot activity are not
        // consulted to decide something this loop is no longer allowed to decide.
        if (!manual && deps.idleHandbackEnabled !== true) {
          skip("idle_handback_disabled", { recordReadable });
          continue;
        }

        // TRIGGER 2 — IDLE, on OUR clock (opt-in only; see above). Measured from the last thing the
        // BUSINESS said, so a customer chasing for an answer no longer pushes
        // their own handback away. Falls back to Chatwoot's activity, then to
        // when the human took the conversation — a conversation escalated
        // before the turn store existed still has a floor rather than being
        // ineligible for ever.
        let idleSinceMs: number | null = null;
        let clock = "none";
        if (deps.turnStore !== undefined) {
          try {
            idleSinceMs = await readLastBusinessTurnMs(
              deps.turnStore,
              candidate.accountId,
              candidate.conversationId,
            );
            if (idleSinceMs !== null) clock = "turn_store";
          } catch {
            idleSinceMs = null;
          }
        }
        if (idleSinceMs === null && recordReadable) {
          idleSinceMs = readLastActivityMs(record);
          if (idleSinceMs !== null) clock = "chatwoot";
        }
        if (idleSinceMs === null) {
          idleSinceMs = candidate.ownershipChangedAtMs;
          if (idleSinceMs !== null) clock = "ownership_changed_at";
        }
        // FLOOR AT TAKEOVER. Review 2026-08-17: a business turn from a PREVIOUS
        // episode is not evidence about this one. A human who takes a
        // conversation over now, and has not replied yet, would otherwise be
        // measured against yesterday's reply and have it snatched back on the
        // very first sweep — the opposite of taking over.
        if (
          idleSinceMs !== null &&
          candidate.ownershipChangedAtMs !== null &&
          idleSinceMs < candidate.ownershipChangedAtMs
        ) {
          idleSinceMs = candidate.ownershipChangedAtMs;
          clock = `${clock}+floored`;
        }

        const idleForMs = idleSinceMs === null ? null : now() - idleSinceMs;
        const idle = idleForMs !== null && idleForMs >= deps.idleMs;

        if (!manual && !idle) {
          skip(idleSinceMs === null ? "no_clock" : "not_idle_yet", {
            clock,
            idleForMs,
            recordReadable,
          });
          continue;
        }

        const result = await performHandback(deps, {
          conversation: candidate.conversation,
          episode: candidate.episode,
          target,
          reason: manual ? "manual_mark_pending" : "idle_timeout",
          actorRef: manual ? "chatwoot:mark_as_pending" : "gateway:handback-sweeper",
        });
        if (result.ok) handedBack += 1;
      }
    } catch (err) {
      deps.logger.error({
        event: "handback",
        outcome: "handback_sweep_failed",
        detail: err instanceof Error ? err.message : "unknown",
      });
    } finally {
      running = false;
    }
    return handedBack;
  }

  return {
    sweep,
    start(): void {
      if (timer !== null) return;
      timer = setInterval(() => {
        void sweep();
      }, deps.intervalMs);
      if (typeof timer.unref === "function") timer.unref();
    },
    stop(): void {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
