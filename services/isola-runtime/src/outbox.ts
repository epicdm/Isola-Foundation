/**
 * The durable, idempotent cost-event outbox.
 *
 * Paperclip is the canonical ledger, but Paperclip's `http` adapter throws this
 * service's response body away, so the only way spend reaches the ledger is a
 * separate POST. That POST can fail. If a failure silently dropped the event,
 * the employee would go on running against a budget nobody was counting — which
 * is precisely the defect being fixed.
 *
 * So a finalized cost event is first written to a durable outbox keyed by
 * `(companyId, agentId, runId)` and only then delivered. Entries go
 * pending -> delivered, or pending -> failed when Paperclip rejects them in a
 * way that retrying cannot fix. Undelivered spend is visible, bounded, and
 * gates further invocations (see `metering.ts`).
 *
 * DELIVERY IS LEASED, NOT LOCKED
 * ------------------------------
 * A network call is never made while holding a state transaction. Instead the
 * claiming transaction increments `attempts` and pushes `nextAttemptMs` forward
 * by the backoff, so a concurrent flush sees the entry as not-due and cannot
 * deliver it a second time.
 *
 * WHEN IT RUNS
 * ------------
 * Immediately after a cost event is enqueued; at the start of every subsequent
 * invocation (so a transient failure heals on the next run); on a low-frequency
 * background sweep; and on startup, which re-reads the store and re-delivers
 * anything still pending.
 */
import type { Logger } from "./log.js";
import { PaperclipApiError } from "./errors.js";
import type { PaperclipApi } from "./paperclip.js";
import type { OutboxEntry, RuntimeState, StateStore } from "./state.js";

export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BASE_BACKOFF_MS = 250;
export const DEFAULT_MAX_BACKOFF_MS = 30_000;
export const DEFAULT_DELIVERED_RETENTION_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_FLUSH_LIMIT = 10;

export function outboxKey(
  companyId: string,
  agentId: string,
  runId: string | null,
): string {
  return `${companyId}|${agentId}|${runId ?? "no-run"}`;
}

/** Exponential, capped. Deterministic — the tests assert the exact schedule. */
export function backoffMs(
  attempts: number,
  baseMs: number = DEFAULT_BASE_BACKOFF_MS,
  maxMs: number = DEFAULT_MAX_BACKOFF_MS,
): number {
  if (attempts <= 0) return 0;
  const raw = baseMs * 2 ** (attempts - 1);
  return Math.min(maxMs, Math.max(0, Math.round(raw)));
}

export interface PendingSpend {
  entries: number;
  /** Cents sitting in the outbox that Paperclip has not confirmed. */
  cents: number;
  /** Age of the oldest undelivered entry, in ms. 0 when there are none. */
  oldestAgeMs: number;
  /** Entries that will never be retried again. */
  failed: number;
}

/**
 * Everything that has not been confirmed delivered counts as undelivered spend
 * — including `failed`, because a permanently rejected event is lost money, not
 * resolved money.
 */
export function pendingSpend(state: RuntimeState, nowMs: number): PendingSpend {
  let entries = 0;
  let cents = 0;
  let failed = 0;
  let oldest = Number.POSITIVE_INFINITY;
  for (const entry of Object.values(state.outbox)) {
    if (entry.state === "delivered") continue;
    entries += 1;
    cents += Math.max(0, entry.event.costCents);
    if (entry.state === "failed") failed += 1;
    if (entry.createdAtMs < oldest) oldest = entry.createdAtMs;
  }
  return {
    entries,
    cents,
    failed,
    oldestAgeMs: Number.isFinite(oldest) ? Math.max(0, nowMs - oldest) : 0,
  };
}

/** Pending entries whose backoff has elapsed, oldest first. */
export function dueEntries(state: RuntimeState, nowMs: number, limit: number): OutboxEntry[] {
  return Object.values(state.outbox)
    .filter((e) => e.state === "pending" && e.nextAttemptMs <= nowMs)
    .sort((a, b) => a.createdAtMs - b.createdAtMs)
    .slice(0, Math.max(0, limit));
}

export function pruneDelivered(
  state: RuntimeState,
  nowMs: number,
  retentionMs: number,
): number {
  let removed = 0;
  for (const [key, entry] of Object.entries(state.outbox)) {
    if (
      entry.state === "delivered" &&
      entry.deliveredAtMs !== null &&
      nowMs - entry.deliveredAtMs > retentionMs
    ) {
      delete state.outbox[key];
      removed += 1;
    }
  }
  return removed;
}

export interface FlushOptions {
  store: StateStore;
  api: PaperclipApi | null;
  /** Resolves the employee agent key for the exposure that produced the event. */
  apiKeyFor: (exposure: string) => string | null;
  now: () => number;
  logger: Logger;
  limit?: number;
  maxAttempts?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  retentionMs?: number;
  /** Free-text category for the log line: "invoke", "startup", "sweep". */
  reason: string;
}

export interface FlushSummary {
  attempted: number;
  delivered: number;
  deferred: number;
  failed: number;
}

/**
 * Deliver due outbox entries. Never throws: a delivery failure is state, not an
 * exception, and it must not turn a successful model run into an error.
 */
export async function flushOutbox(options: FlushOptions): Promise<FlushSummary> {
  const summary: FlushSummary = { attempted: 0, delivered: 0, deferred: 0, failed: 0 };
  const {
    store,
    api,
    apiKeyFor,
    now,
    logger,
    limit = DEFAULT_FLUSH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    retentionMs = DEFAULT_DELIVERED_RETENTION_MS,
  } = options;

  if (api === null) return summary;

  // Claim under a transaction: bump attempts and push the next attempt out so a
  // concurrent flush cannot pick the same entry up.
  const claimed = await store.transact((draft) => {
    const nowMs = now();
    pruneDelivered(draft, nowMs, retentionMs);
    const due = dueEntries(draft, nowMs, limit);
    const taken: OutboxEntry[] = [];
    for (const entry of due) {
      const live = draft.outbox[entry.key];
      if (live === undefined) continue;
      live.attempts += 1;
      live.lastAttemptMs = nowMs;
      live.nextAttemptMs = nowMs + backoffMs(live.attempts, baseBackoffMs, maxBackoffMs);
      taken.push(structuredClone(live));
    }
    return taken;
  });

  for (const entry of claimed) {
    summary.attempted += 1;
    const apiKey = apiKeyFor(entry.exposure);
    if (apiKey === null) {
      await store.transact((draft) => {
        const live = draft.outbox[entry.key];
        if (live !== undefined) {
          live.state = "failed";
          live.lastError = "no agent api key configured for this exposure";
        }
      });
      summary.failed += 1;
      logger.error({
        event: "cost_event",
        outcome: "cost_delivery_failed",
        runId: entry.runId,
        agentId: entry.agentId,
        outboxKey: entry.key,
        detail: "no agent api key configured for this exposure",
      });
      continue;
    }

    let error: PaperclipApiError | null = null;
    try {
      await api.postCostEvent(entry.companyId, entry.event, {
        apiKey,
        runId: entry.runId,
      });
    } catch (err) {
      error =
        err instanceof PaperclipApiError
          ? err
          : new PaperclipApiError(
              `unexpected delivery fault (${err instanceof Error ? err.name : "unknown"})`,
              null,
              true,
            );
    }

    if (error === null) {
      await store.transact((draft) => {
        const live = draft.outbox[entry.key];
        if (live !== undefined) {
          live.state = "delivered";
          live.deliveredAtMs = now();
          live.lastError = null;
        }
      });
      summary.delivered += 1;
      logger.info({
        event: "cost_event",
        outcome: "cost_event_delivered",
        runId: entry.runId,
        agentId: entry.agentId,
        outboxKey: entry.key,
        costCents: entry.event.costCents,
        costKind: entry.costKind,
        billingCode: entry.event.billingCode,
        attempts: entry.attempts,
        reason: options.reason,
      });
      continue;
    }

    const giveUp = !error.retryable || entry.attempts >= maxAttempts;
    await store.transact((draft) => {
      const live = draft.outbox[entry.key];
      if (live === undefined) return;
      live.lastError = error.detail;
      if (giveUp) live.state = "failed";
    });
    if (giveUp) summary.failed += 1;
    else summary.deferred += 1;

    logger.error({
      event: "cost_event",
      outcome: giveUp ? "cost_delivery_failed" : "cost_delivery_deferred",
      runId: entry.runId,
      agentId: entry.agentId,
      outboxKey: entry.key,
      costCents: entry.event.costCents,
      attempts: entry.attempts,
      retryable: error.retryable,
      failureCategory: error.detail,
      reason: options.reason,
    });
  }

  return summary;
}

/**
 * Startup reconciliation. Re-reads whatever the store holds and re-delivers
 * everything still pending, ignoring the backoff clock — a restart is itself
 * evidence that the previous schedule is stale.
 */
export async function reconcileOutbox(
  options: Omit<FlushOptions, "reason" | "limit"> & { limit?: number },
): Promise<FlushSummary> {
  await options.store.transact((draft) => {
    const nowMs = options.now();
    for (const entry of Object.values(draft.outbox)) {
      if (entry.state === "pending") entry.nextAttemptMs = nowMs;
    }
    // A run that was in flight when the process died can never complete. Drop
    // the claim so the work is not blocked forever by a stale lease, but keep
    // completed records so a genuine replay is still suppressed.
    for (const [key, record] of Object.entries(draft.idempotency)) {
      if (record.state === "in_flight") delete draft.idempotency[key];
    }
    // Reservations belong to processes that no longer exist.
    draft.reservations = {};
  });

  const summary = await flushOutbox({
    ...options,
    limit: options.limit ?? 100,
    reason: "startup",
  });

  options.logger.info({
    event: "reconcile",
    outcome: "reconcile_complete",
    attempted: summary.attempted,
    delivered: summary.delivered,
    deferred: summary.deferred,
    failed: summary.failed,
  });

  return summary;
}
