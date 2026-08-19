/**
 * Metering, reservations and budget enforcement.
 *
 * WHY THIS LIVES HERE AND NOT IN PAPERCLIP
 * ----------------------------------------
 * Paperclip's `http` adapter discards the adapter response, so cost and usage
 * never reach it on their own — after 53 runs the employee still reported
 * `spentMonthlyCents: 0` and neither the 80% alert nor the 100% hard stop could
 * ever fire. This runtime is the only component that sees the provider's usage
 * response, so metering has to originate here. Paperclip stays the canonical
 * ledger: every figure this service derives is pushed into it as a cost event,
 * and the budget it enforces against is read back from it.
 *
 * THE ORDER OF A RUN
 * ------------------
 *   1. claim the idempotency record  (a replay stops here and returns the
 *      original result — no second comment, no second charge, no second call)
 *   2. flush anything the outbox owes
 *   3. fail closed if undelivered spend is over the threshold      -> 503
 *   4. read the budget, reserve this run's estimate atomically
 *        - at/over 100%: reject before the provider is touched     -> 402
 *        - at/over 80%: emit the alert, once per crossing
 *   5. call the provider                       (app.ts does this)
 *   6. settle: release the reservation, accrue the real cost, emit a
 *      whole-cent event when one has accrued, deliver it
 */
import { createHash, randomUUID } from "node:crypto";

import {
  budgetPeriod,
  decideThreshold,
  estimateRunMicrocents,
  evaluateBudget,
  type BudgetVerdict,
} from "./budget.js";
import { PaperclipApiError } from "./errors.js";
import type { Logger } from "./log.js";
import {
  MICROCENTS_PER_CENT,
  accrue,
  emptyAccumulator,
  flush,
  normaliseUsage,
  priceUsage,
  resolveRateCard,
  usageIsEmpty,
  type CostKind,
  type RateCard,
  type RateOverrides,
  type TokenUsage,
} from "./money.js";
import {
  DEFAULT_BASE_BACKOFF_MS,
  DEFAULT_DELIVERED_RETENTION_MS,
  DEFAULT_FLUSH_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_MAX_BACKOFF_MS,
  flushOutbox,
  outboxKey,
  pendingSpend,
  reconcileOutbox,
  type FlushSummary,
} from "./outbox.js";
import type { PaperclipApi } from "./paperclip.js";
import type {
  CostEventPayload,
  IdempotencyRecord,
  OutboxEntry,
  RunResultRecord,
  RuntimeState,
  StateStore,
} from "./state.js";

/** Paperclip's `billingType` enum value used for real metered provider spend. */
export const BILLING_TYPE_METERED = "metered_api";
/**
 * Everything that is NOT real metered expenditure uses the schema's documented
 * default. Synthetic and unpriced events are identified by `billingCode`, which
 * is a free string, rather than by inventing an enum member that the deployed
 * Paperclip may reject.
 */
export const BILLING_TYPE_UNKNOWN = "unknown";

export interface MeteringOptions {
  companyIdDefault: string | null;
  provider: string;
  rateOverrides: RateOverrides;
  syntheticEnabled: boolean;
  alertPct: number;
  /**
   * The ceiling applied when Paperclip supplies none (null / 0 / non-finite).
   * Not a default in the usual sense: it is what stands between an agent with
   * no configured budget and an unbounded spend, so config refuses to boot
   * without it.
   */
  budgetFallbackCents: number;
  budgetRefreshMs: number;
  budgetEnforcement: boolean;
  pauseOnExhausted: boolean;
  maxUndeliveredCents: number;
  maxUndeliveredAgeMs: number;
  reservationTtlMs: number;
  idempotencyTtlMs: number;
  estimatedOutputTokens: number;
  outboxMaxAttempts: number;
  outboxBaseBackoffMs: number;
  outboxMaxBackoffMs: number;
  outboxRetentionMs: number;
  outboxFlushLimit: number;
}

export const DEFAULT_METERING_OPTIONS: MeteringOptions = Object.freeze({
  companyIdDefault: null,
  provider: "deepseek",
  // 0 REFUSES, it does not permit. evaluateBudget treats a zero ceiling as
  // exhausted, so anyone adopting these defaults without choosing a real number
  // gets a hard stop rather than an unbounded agent. The permissive version of
  // this constant is exactly the fall-through that made "no budget" mean "no
  // limit" until 2026-08-19.
  budgetFallbackCents: 0,
  rateOverrides: {
    inputPerMtokCents: null,
    cachedInputPerMtokCents: null,
    outputPerMtokCents: null,
  },
  syntheticEnabled: false,
  alertPct: 80,
  budgetRefreshMs: 15_000,
  budgetEnforcement: true,
  pauseOnExhausted: true,
  maxUndeliveredCents: 50,
  maxUndeliveredAgeMs: 60 * 60 * 1000,
  reservationTtlMs: 5 * 60 * 1000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
  estimatedOutputTokens: 1000,
  outboxMaxAttempts: DEFAULT_MAX_ATTEMPTS,
  outboxBaseBackoffMs: DEFAULT_BASE_BACKOFF_MS,
  outboxMaxBackoffMs: DEFAULT_MAX_BACKOFF_MS,
  outboxRetentionMs: DEFAULT_DELIVERED_RETENTION_MS,
  outboxFlushLimit: DEFAULT_FLUSH_LIMIT,
});

export interface MeteringDeps {
  store: StateStore;
  api: PaperclipApi | null;
  /** Employee agent API key per exposure class. Never a shared board key. */
  agentKeyFor: (exposure: string) => string | null;
  options: MeteringOptions;
  logger: Logger;
  now: () => number;
}

// ---------------------------------------------------------------------------
// Idempotency keys
// ---------------------------------------------------------------------------

/** Short, stable fingerprint of the run context. Not a secret, not reversible. */
export function contextFingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/**
 * Build the idempotency key.
 *
 * The run id is the primary key, exactly as the contract requires. When
 * Paperclip sends no run id the key falls back to the issue plus a fingerprint
 * of the context, which is what actually distinguishes "the adapter retried"
 * from "a genuinely new piece of work" — and is precisely the case that
 * produced 53 identical runs.
 */
export function buildIdempotencyKey(args: {
  companyId: string | null;
  agentId: string | null;
  runId: string | null;
  issueId: string | null;
  contextText: string;
}): string {
  const scope = `${args.companyId ?? "no-company"}|${args.agentId ?? "no-agent"}`;
  if (args.runId !== null && args.runId.length > 0) return `${scope}|run:${args.runId}`;
  const fp = contextFingerprint(args.contextText);
  if (args.issueId !== null && args.issueId.length > 0) {
    return `${scope}|issue:${args.issueId}|ctx:${fp}`;
  }
  return `${scope}|ctx:${fp}`;
}

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "replay"; record: IdempotencyRecord }
  | { kind: "in_flight"; record: IdempotencyRecord };

export interface UndeliveredGate {
  blocked: boolean;
  reason: string | null;
  pendingCents: number;
  pendingEntries: number;
  failedEntries: number;
  oldestAgeMs: number;
}

export interface PreflightArgs {
  companyId: string | null;
  agentId: string | null;
  exposure: string;
  /** OUR run id. Keys idempotency records and the cost outbox. Never null on a real run. */
  runId: string | null;
  /**
   * PAPERCLIP'S run id, and only set when Paperclip actually issued it.
   *
   * Deliberately a second field rather than a reuse of `runId`: this one becomes
   * the `x-paperclip-run-id` HEADER, which Paperclip writes into a foreign key
   * on a table only it populates. `runId` must stay real for our own keys, and
   * this must be null unless Paperclip issued it. Collapsing them would either
   * break our keys or break their foreign key.
   */
  paperclipRunId?: string | null;
  model: string;
  promptChars: number;
}

export type PreflightResult =
  | {
      kind: "proceed";
      reservationId: string | null;
      card: RateCard;
      verdict: BudgetVerdict;
      alert: boolean;
      usedPct: number | null;
      budgetKnown: boolean;
    }
  | {
      kind: "exhausted";
      card: RateCard;
      verdict: BudgetVerdict;
      usedPct: number;
      budgetCents: number;
      pause: boolean;
    };

export interface SettleArgs {
  reservationId: string | null;
  companyId: string | null;
  agentId: string | null;
  exposure: string;
  runId: string | null;
  issueId: string | null;
  model: string;
  usage: Partial<TokenUsage> | null;
  card: RateCard;
}

export type SettleResult =
  | { kind: "skipped"; reason: string; costKind: CostKind | null; accruedMicrocents: number; costEventKey: null }
  | {
      kind: "accrued";
      costKind: CostKind;
      accruedMicrocents: number;
      carriedMicrocents: number;
      costEventKey: null;
    }
  | {
      kind: "emitted";
      costKind: CostKind;
      accruedMicrocents: number;
      carriedMicrocents: number;
      costCents: number;
      aggregatedRuns: number;
      costEventKey: string;
    };

export class MeteringService {
  private readonly d: MeteringDeps;

  constructor(deps: MeteringDeps) {
    this.d = deps;
  }

  get options(): MeteringOptions {
    return this.d.options;
  }

  /** Startup reconciliation: re-deliver everything the store still owes. */
  async reconcile(): Promise<FlushSummary> {
    return reconcileOutbox({
      store: this.d.store,
      api: this.d.api,
      apiKeyFor: this.d.agentKeyFor,
      now: this.d.now,
      logger: this.d.logger,
      maxAttempts: this.d.options.outboxMaxAttempts,
      baseBackoffMs: this.d.options.outboxBaseBackoffMs,
      maxBackoffMs: this.d.options.outboxMaxBackoffMs,
      retentionMs: this.d.options.outboxRetentionMs,
    });
  }

  async flush(reason: string, limit?: number): Promise<FlushSummary> {
    return flushOutbox({
      store: this.d.store,
      api: this.d.api,
      apiKeyFor: this.d.agentKeyFor,
      now: this.d.now,
      logger: this.d.logger,
      limit: limit ?? this.d.options.outboxFlushLimit,
      maxAttempts: this.d.options.outboxMaxAttempts,
      baseBackoffMs: this.d.options.outboxBaseBackoffMs,
      maxBackoffMs: this.d.options.outboxMaxBackoffMs,
      retentionMs: this.d.options.outboxRetentionMs,
      reason,
    });
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  async claimOrReplay(args: {
    key: string;
    companyId: string | null;
    agentId: string | null;
    runId: string | null;
    issueId: string | null;
  }): Promise<ClaimResult> {
    return this.d.store.transact((draft) => {
      const nowMs = this.d.now();
      this.purgeIdempotency(draft, nowMs);
      const existing = draft.idempotency[args.key];
      if (existing !== undefined) {
        return existing.state === "complete"
          ? ({ kind: "replay", record: structuredClone(existing) } as ClaimResult)
          : ({ kind: "in_flight", record: structuredClone(existing) } as ClaimResult);
      }
      draft.idempotency[args.key] = {
        key: args.key,
        state: "in_flight",
        companyId: args.companyId,
        agentId: args.agentId,
        runId: args.runId,
        issueId: args.issueId,
        createdAtMs: nowMs,
        completedAtMs: null,
        result: null,
      };
      return { kind: "claimed" } as ClaimResult;
    });
  }

  /**
   * Drop the claim. Used for outcomes that must be retryable later — a budget
   * rejection or an undelivered-spend rejection is a "not now", not a result.
   */
  async release(key: string): Promise<void> {
    await this.d.store.transact((draft) => {
      delete draft.idempotency[key];
    });
  }

  async finalize(key: string, result: RunResultRecord): Promise<void> {
    await this.d.store.transact((draft) => {
      const record = draft.idempotency[key];
      if (record === undefined) return;
      record.state = "complete";
      record.completedAtMs = this.d.now();
      record.result = result;
    });
  }

  private purgeIdempotency(draft: RuntimeState, nowMs: number): void {
    const ttl = this.d.options.idempotencyTtlMs;
    for (const [key, record] of Object.entries(draft.idempotency)) {
      if (nowMs - record.createdAtMs > ttl) delete draft.idempotency[key];
    }
  }

  // -------------------------------------------------------------------------
  // Fail closed on undelivered spend
  // -------------------------------------------------------------------------

  async undeliveredGate(): Promise<UndeliveredGate> {
    const state = await this.d.store.read();
    const nowMs = this.d.now();
    const pending = pendingSpend(state, nowMs);

    let reason: string | null = null;
    if (pending.cents > this.d.options.maxUndeliveredCents) {
      reason = `undelivered cost events total ${pending.cents} cents, over the ${this.d.options.maxUndeliveredCents} cent limit`;
    } else if (
      pending.entries > 0 &&
      pending.oldestAgeMs > this.d.options.maxUndeliveredAgeMs
    ) {
      reason = `the oldest undelivered cost event is ${Math.round(pending.oldestAgeMs / 1000)}s old, over the ${Math.round(this.d.options.maxUndeliveredAgeMs / 1000)}s limit`;
    }

    return {
      blocked: reason !== null,
      reason,
      pendingCents: pending.cents,
      pendingEntries: pending.entries,
      failedEntries: pending.failed,
      oldestAgeMs: pending.oldestAgeMs,
    };
  }

  // -------------------------------------------------------------------------
  // Budget
  // -------------------------------------------------------------------------

  rateCardFor(model: string): RateCard {
    return resolveRateCard({
      model,
      overrides: this.d.options.rateOverrides,
      syntheticEnabled: this.d.options.syntheticEnabled,
    });
  }

  /** Read the agent's budget, preferring a fresh Paperclip figure over a cached one. */
  private async budgetSnapshot(
    agentId: string,
    exposure: string,
    runId: string | null,
  ): Promise<{ budgetCents: number | null; spentCents: number; known: boolean }> {
    const state = await this.d.store.read();
    const cached = state.budgets[agentId];
    const nowMs = this.d.now();
    if (cached !== undefined && nowMs - cached.fetchedAtMs < this.d.options.budgetRefreshMs) {
      return {
        budgetCents: cached.budgetMonthlyCents,
        spentCents: cached.spentMonthlyCents,
        known: true,
      };
    }

    const apiKey = this.d.agentKeyFor(exposure);
    if (this.d.api === null || apiKey === null) {
      return cached !== undefined
        ? {
            budgetCents: cached.budgetMonthlyCents,
            spentCents: cached.spentMonthlyCents,
            known: true,
          }
        : { budgetCents: null, spentCents: 0, known: false };
    }

    try {
      const fresh = await this.d.api.getAgentBudget(agentId, { apiKey, runId });
      await this.d.store.transact((draft) => {
        draft.budgets[agentId] = {
          agentId,
          budgetMonthlyCents: fresh.budgetMonthlyCents,
          spentMonthlyCents: fresh.spentMonthlyCents,
          fetchedAtMs: this.d.now(),
        };
      });
      return {
        budgetCents: fresh.budgetMonthlyCents,
        spentCents: fresh.spentMonthlyCents,
        known: true,
      };
    } catch (err) {
      const detail =
        err instanceof PaperclipApiError ? err.detail : "budget read failed";
      this.d.logger.warn({
        event: "budget",
        outcome: "budget_read_failed",
        agentId,
        runId,
        failureCategory: detail,
        usingStaleSnapshot: cached !== undefined,
      });
      return cached !== undefined
        ? {
            budgetCents: cached.budgetMonthlyCents,
            spentCents: cached.spentMonthlyCents,
            known: true,
          }
        : { budgetCents: null, spentCents: 0, known: false };
    }
  }

  /**
   * Reserve headroom and decide whether the provider may be called.
   *
   * The read of the ledger, the sum of live reservations and the creation of
   * this run's reservation all happen inside one serialized transaction, so two
   * concurrent runs can never both see the same headroom.
   */
  async preflight(args: PreflightArgs): Promise<PreflightResult> {
    const card = this.rateCardFor(args.model);
    const estimate = estimateRunMicrocents({
      promptChars: args.promptChars,
      expectedOutputTokens: this.d.options.estimatedOutputTokens,
      card,
    });

    if (args.agentId === null || !this.d.options.budgetEnforcement) {
      return {
        kind: "proceed",
        reservationId: null,
        card,
        verdict: { kind: "unlimited" },
        alert: false,
        usedPct: null,
        budgetKnown: false,
      };
    }

    // PAPERCLIP-SCOPED, deliberately NOT args.runId. `runId` keys our
    // idempotency records and the cost outbox; nulling it there would collapse
    // distinct runs onto one key. This value only ever becomes the
    // `x-paperclip-run-id` HEADER, which Paperclip writes into a foreign key, so
    // it must be null unless Paperclip issued it.
    const snapshot = await this.budgetSnapshot(
      args.agentId,
      args.exposure,
      args.paperclipRunId ?? null,
    );
    const agentId = args.agentId;
    const companyId = args.companyId ?? this.d.options.companyIdDefault ?? "";

    return this.d.store.transact((draft) => {
      const nowMs = this.d.now();
      this.purgeReservations(draft, nowMs);

      let reservedMicrocents = 0;
      for (const reservation of Object.values(draft.reservations)) {
        if (reservation.agentId === agentId) reservedMicrocents += reservation.microcents;
      }

      let localUndeliveredCents = 0;
      for (const entry of Object.values(draft.outbox)) {
        if (entry.state === "delivered") continue;
        if (entry.agentId !== agentId) continue;
        localUndeliveredCents += Math.max(0, entry.event.costCents);
      }

      let localAccruedMicrocents = 0;
      for (const [key, acc] of Object.entries(draft.accumulators)) {
        if (key.includes(`|${agentId}|`)) localAccruedMicrocents += acc.microcents;
      }

      const verdict = evaluateBudget({
        budgetCents: snapshot.budgetCents,
        spentCents: snapshot.spentCents,
        localUndeliveredCents,
        localAccruedMicrocents,
        reservedMicrocents,
        requestMicrocents: estimate,
        alertPct: this.d.options.alertPct,
        // Applied when Paperclip supplies no ceiling. See budget.ts: absent and
        // zero both used to mean "unlimited", so a new agent was unguarded by
        // fall-through rather than by decision.
        fallbackCents: this.d.options.budgetFallbackCents,
      });

      if (verdict.kind === "unlimited") {
        const id = this.createReservation(draft, {
          agentId,
          companyId,
          microcents: estimate,
          nowMs,
        });
        return {
          kind: "proceed",
          reservationId: id,
          card,
          verdict,
          alert: false,
          usedPct: null,
          budgetKnown: snapshot.known,
        } satisfies PreflightResult;
      }

      const period = budgetPeriod(nowMs);
      const decision = decideThreshold({
        existing: draft.alerts[agentId],
        agentId,
        period,
        budgetCents: verdict.budgetCents,
        usedPct: verdict.usedPct,
        alertPct: this.d.options.alertPct,
        exhausted: verdict.kind === "exhausted",
      });
      draft.alerts[agentId] = decision.record;

      if (verdict.kind === "exhausted") {
        // No reservation: the provider will not be called at all.
        return {
          kind: "exhausted",
          card,
          verdict,
          usedPct: verdict.usedPct,
          budgetCents: verdict.budgetCents,
          pause: decision.pause && this.d.options.pauseOnExhausted,
        } satisfies PreflightResult;
      }

      const id = this.createReservation(draft, {
        agentId,
        companyId,
        microcents: estimate,
        nowMs,
      });
      return {
        kind: "proceed",
        reservationId: id,
        card,
        verdict,
        alert: decision.alert,
        usedPct: verdict.usedPct,
        budgetKnown: snapshot.known,
      } satisfies PreflightResult;
    });
  }

  private createReservation(
    draft: RuntimeState,
    args: { agentId: string; companyId: string; microcents: number; nowMs: number },
  ): string {
    const id = randomUUID();
    draft.reservations[id] = {
      id,
      companyId: args.companyId,
      agentId: args.agentId,
      microcents: Math.max(0, Math.round(args.microcents)),
      createdAtMs: args.nowMs,
      expiresAtMs: args.nowMs + this.d.options.reservationTtlMs,
    };
    return id;
  }

  private purgeReservations(draft: RuntimeState, nowMs: number): void {
    for (const [id, reservation] of Object.entries(draft.reservations)) {
      if (reservation.expiresAtMs <= nowMs) delete draft.reservations[id];
    }
  }

  /** Release a reservation without settling any cost (the run never happened). */
  async releaseReservation(reservationId: string | null): Promise<void> {
    if (reservationId === null) return;
    await this.d.store.transact((draft) => {
      delete draft.reservations[reservationId];
    });
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /**
   * Release the reservation, accrue the real cost, and emit a whole-cent event
   * if one has accrued. Never throws — losing a run over a metering fault would
   * be a worse failure than the one being fixed.
   */
  async settle(args: SettleArgs): Promise<SettleResult> {
    const usage = normaliseUsage(args.usage);
    const companyId = args.companyId ?? this.d.options.companyIdDefault;
    const agentId = args.agentId;

    const outcome = await this.d.store.transact((draft): SettleResult => {
      if (args.reservationId !== null) delete draft.reservations[args.reservationId];

      if (companyId === null || companyId.length === 0) {
        return {
          kind: "skipped",
          reason: "no_company_context",
          costKind: null,
          accruedMicrocents: 0,
          costEventKey: null,
        };
      }
      if (agentId === null || agentId.length === 0) {
        return {
          kind: "skipped",
          reason: "no_agent_context",
          costKind: null,
          accruedMicrocents: 0,
          costEventKey: null,
        };
      }
      if (usageIsEmpty(usage)) {
        // The provider reported nothing. Inventing a number here would be
        // exactly the fabrication this design forbids.
        return {
          kind: "skipped",
          reason: "usage_unavailable",
          costKind: null,
          accruedMicrocents: 0,
          costEventKey: null,
        };
      }

      const priced = priceUsage(usage, args.card);
      const nowMs = this.d.now();

      // Unpriced: there is no money to accumulate, but the usage still has to
      // reach the ledger, so the event goes out immediately at costCents 0.
      if (args.card.kind === "unpriced") {
        const key = this.enqueue(draft, {
          companyId,
          agentId,
          runId: args.runId,
          issueId: args.issueId,
          exposure: args.exposure,
          model: args.model,
          usage,
          costCents: 0,
          card: args.card,
          nowMs,
        });
        return {
          kind: "emitted",
          costKind: "unpriced",
          accruedMicrocents: 0,
          carriedMicrocents: 0,
          costCents: 0,
          aggregatedRuns: 1,
          costEventKey: key,
        };
      }

      // Priced (real or clearly-labelled synthetic). Provenance is kept in its
      // own accumulator so synthetic cost is never blended into actual spend.
      const accKey = `${companyId}|${agentId}|${args.card.kind}`;
      const before = draft.accumulators[accKey] ?? emptyAccumulator();
      const after = accrue(before, { microcents: priced.microcents, usage });
      const result = flush(after);

      if (!result.emit) {
        draft.accumulators[accKey] = result.carry;
        return {
          kind: "accrued",
          costKind: args.card.kind,
          accruedMicrocents: priced.microcents,
          carriedMicrocents: result.carry.microcents,
          costEventKey: null,
        };
      }

      draft.accumulators[accKey] = result.carry;
      const key = this.enqueue(draft, {
        companyId,
        agentId,
        runId: args.runId,
        issueId: args.issueId,
        exposure: args.exposure,
        model: args.model,
        usage: result.usage,
        costCents: result.costCents,
        card: args.card,
        nowMs,
      });
      return {
        kind: "emitted",
        costKind: args.card.kind,
        accruedMicrocents: priced.microcents,
        carriedMicrocents: result.carry.microcents,
        costCents: result.costCents,
        aggregatedRuns: result.runs,
        costEventKey: key,
      };
    });

    if (outcome.kind === "skipped") {
      this.d.logger.warn({
        event: "cost_event",
        outcome: `cost_${outcome.reason}`,
        runId: args.runId,
        agentId: args.agentId,
        issueId: args.issueId,
        detail: "no cost event was emitted for this run",
      });
      return outcome;
    }

    if (outcome.kind === "accrued") {
      this.d.logger.info({
        event: "cost_event",
        outcome: "cost_event_accrued_subcent",
        runId: args.runId,
        agentId: args.agentId,
        costKind: outcome.costKind,
        accruedMicrocents: outcome.accruedMicrocents,
        carriedMicrocents: outcome.carriedMicrocents,
        detail: "under one cent; carried forward, no event emitted",
      });
      return outcome;
    }

    this.d.logger.info({
      event: "cost_event",
      outcome: "cost_event_enqueued",
      runId: args.runId,
      agentId: args.agentId,
      costKind: outcome.costKind,
      costCents: outcome.costCents,
      aggregatedRuns: outcome.aggregatedRuns,
      carriedMicrocents: outcome.carriedMicrocents,
      outboxKey: outcome.costEventKey,
    });

    // Deliver right away; a failure leaves it pending for the next flush.
    await this.flush("settle");
    return outcome;
  }

  /** Build the Paperclip cost-event body and park it in the outbox. */
  private enqueue(
    draft: RuntimeState,
    args: {
      companyId: string;
      agentId: string;
      runId: string | null;
      issueId: string | null;
      exposure: string;
      model: string;
      usage: TokenUsage;
      costCents: number;
      card: RateCard;
      nowMs: number;
    },
  ): string {
    const key = outboxKey(args.companyId, args.agentId, args.runId);
    const synthetic = args.card.kind === "synthetic";
    const event: CostEventPayload = {
      agentId: args.agentId,
      ...(args.issueId !== null && args.issueId.length > 0 ? { issueId: args.issueId } : {}),
      // heartbeatRunId is DELIBERATELY NOT SENT. See below.
      //
      // `args.runId` is the GATEWAY'S delivery id — a UUID this runtime minted.
      // `cost_events.heartbeat_run_id` is a FOREIGN KEY into Paperclip's
      // `heartbeat_runs`, a table Paperclip populates when PAPERCLIP runs an
      // agent. This runtime is an external executor: it calls the model itself
      // and only reports the cost afterwards, so it never holds a
      // Paperclip-issued run id and there is no endpoint to obtain one —
      // Paperclip exposes no heartbeat/run creation route (checked 2026-08-17).
      //
      // Sending our own id was a FALSE CLAIM, and the FK correctly refused it:
      //   insert into "cost_events" ... violates foreign key constraint
      //   "cost_events_heartbeat_run_id_heartbeat_runs_id_fk"
      //
      // This is CLAUDE.md law 10 exactly — "with a run id Paperclip never
      // issued it gets 500" — and the consequence was not a lost metric. The
      // event stuck in the outbox, and once the oldest undelivered event passed
      // the age limit the runtime FAILED CLOSED and refused to invoke the model
      // at all. On 2026-08-17 a SINGLE UNDELIVERED CENT took the customer-facing
      // front desk offline: 6737 answered nothing, because a 1c cost event from
      // 12:23 could not be written.
      //
      // What is lost by omitting it: Paperclip counts distinct runs with
      // `count(distinct heartbeat_run_id)`, which ignores NULL, so run-COUNT
      // metrics undercount. Cost totals are unaffected. That is strictly better
      // than the event never landing at all.
      //
      // The run is still traceable: the `x-paperclip-run-id` header still
      // carries it (Paperclip's auth reads it and does not FK it), the outbox
      // key is `companyId|agentId|runId`, and `issueId` below is a real
      // Paperclip id. Restore this field ONLY with an id Paperclip issued.
      billingCode: args.card.profile,
      provider: this.d.options.provider,
      // A synthetic figure is never billed to the real provider.
      biller: synthetic ? `${this.d.options.provider}-synthetic` : this.d.options.provider,
      billingType: args.card.kind === "actual" ? BILLING_TYPE_METERED : BILLING_TYPE_UNKNOWN,
      model: args.model,
      inputTokens: args.usage.inputTokens,
      cachedInputTokens: args.usage.cachedInputTokens,
      outputTokens: args.usage.outputTokens,
      costCents: Math.max(0, Math.round(args.costCents)),
      occurredAt: new Date(args.nowMs).toISOString(),
    };

    const entry: OutboxEntry = {
      key,
      companyId: args.companyId,
      agentId: args.agentId,
      runId: args.runId,
      exposure: args.exposure,
      event,
      costKind: args.card.kind,
      state: "pending",
      attempts: 0,
      createdAtMs: args.nowMs,
      lastAttemptMs: null,
      nextAttemptMs: args.nowMs,
      lastError: null,
      deliveredAtMs: null,
    };

    // Keyed insert: a replayed run can never create a second entry.
    if (draft.outbox[key] === undefined) draft.outbox[key] = entry;
    return key;
  }

  /** Pause the employee. Called only after a 100% rejection. */
  async pauseAgent(agentId: string, exposure: string, runId: string | null): Promise<boolean> {
    const apiKey = this.d.agentKeyFor(exposure);
    if (this.d.api === null || apiKey === null) return false;
    try {
      await this.d.api.pauseAgent(agentId, { apiKey, runId });
      this.d.logger.warn({
        event: "budget",
        outcome: "agent_paused",
        agentId,
        runId,
        detail: "monthly budget exhausted; employee paused through the Paperclip API",
      });
      return true;
    } catch (err) {
      this.d.logger.error({
        event: "budget",
        outcome: "agent_pause_failed",
        agentId,
        runId,
        failureCategory: err instanceof PaperclipApiError ? err.detail : "pause call failed",
      });
      return false;
    }
  }
}

/** Convenience for logs: microcents rendered as a decimal cent figure. */
export function microcentsAsCents(microcents: number): number {
  return Math.round((microcents / MICROCENTS_PER_CENT) * 10_000) / 10_000;
}
