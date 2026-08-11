/**
 * Budget arithmetic and threshold logic. Pure — no I/O, no clock beyond the
 * timestamp it is handed.
 *
 * Paperclip owns the canonical `spentMonthlyCents`. This runtime adds the three
 * things Paperclip cannot know yet:
 *
 *   - cost sitting in the outbox that Paperclip has not confirmed,
 *   - sub-cent cost accrued but not yet worth a whole-cent event,
 *   - reservations held by runs that are in flight right now.
 *
 * Counting all four is what makes concurrent runs unable to collectively
 * overspend: each run reserves its estimate *before* the provider is called, and
 * the reservation is part of the next run's arithmetic.
 */
import {
  MICROCENTS_PER_CENT,
  type RateCard,
  centsToMicrocents,
  microcentsForTokens,
} from "./money.js";
import type { AlertRecord } from "./state.js";

export const DEFAULT_ALERT_PCT = 80;

/** Rough tokenisation for a pre-flight estimate only. Never used for billing. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

export interface BudgetInputs {
  /** Paperclip's monthly budget. `null` or <= 0 means "no budget configured". */
  budgetCents: number | null;
  /** Paperclip's canonical spend for the period. */
  spentCents: number;
  /** Outbox entries Paperclip has not confirmed. */
  localUndeliveredCents: number;
  /** Sub-cent cost not yet worth an event. */
  localAccruedMicrocents: number;
  /** Reservations held by other in-flight runs. */
  reservedMicrocents: number;
  /** What this request wants to reserve. */
  requestMicrocents: number;
  alertPct: number;
}

export type BudgetVerdict =
  | { kind: "unlimited" }
  | {
      kind: "ok" | "alert" | "exhausted";
      usedPct: number;
      budgetCents: number;
      effectiveMicrocents: number;
      remainingMicrocents: number;
    };

export function evaluateBudget(inputs: BudgetInputs): BudgetVerdict {
  const budgetCents = inputs.budgetCents;
  if (budgetCents === null || !Number.isFinite(budgetCents) || budgetCents <= 0) {
    return { kind: "unlimited" };
  }

  const budgetMicrocents = centsToMicrocents(budgetCents);
  const effectiveMicrocents =
    centsToMicrocents(Math.max(0, inputs.spentCents)) +
    centsToMicrocents(Math.max(0, inputs.localUndeliveredCents)) +
    Math.max(0, inputs.localAccruedMicrocents) +
    Math.max(0, inputs.reservedMicrocents) +
    Math.max(0, inputs.requestMicrocents);

  const usedPct = (effectiveMicrocents / budgetMicrocents) * 100;
  const remainingMicrocents = budgetMicrocents - effectiveMicrocents;

  const base = { usedPct, budgetCents, effectiveMicrocents, remainingMicrocents };

  // At or over 100% the provider must not be called at all.
  if (effectiveMicrocents >= budgetMicrocents) {
    return { kind: "exhausted", ...base };
  }
  if (usedPct >= inputs.alertPct) {
    return { kind: "alert", ...base };
  }
  return { kind: "ok", ...base };
}

/** Monthly budget period key, in UTC. Budgets are `...Monthly...` in Paperclip. */
export function budgetPeriod(nowMs: number): string {
  const d = new Date(nowMs);
  const month = `${d.getUTCMonth() + 1}`.padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}

export function emptyAlertRecord(agentId: string, period: string, budgetCents: number | null): AlertRecord {
  return { agentId, period, budgetCents, alertedPct: 0, pausedInPeriod: false };
}

export interface ThresholdDecision {
  /** Emit the 80% alert now. */
  alert: boolean;
  /** Call the pause endpoint now. */
  pause: boolean;
  record: AlertRecord;
}

/**
 * Decide whether this crossing is new.
 *
 * The alert fires **once per crossing**, not once per run — 53 runs in one
 * wakeup must not produce 53 alerts. The memory resets when the budget period
 * rolls over, when the budget amount changes (a raised budget is a new regime),
 * or when usage falls back below the threshold.
 */
export function decideThreshold(args: {
  existing: AlertRecord | undefined;
  agentId: string;
  period: string;
  budgetCents: number | null;
  usedPct: number;
  alertPct: number;
  exhausted: boolean;
}): ThresholdDecision {
  const stale =
    args.existing === undefined ||
    args.existing.period !== args.period ||
    args.existing.budgetCents !== args.budgetCents;

  const record: AlertRecord = stale
    ? emptyAlertRecord(args.agentId, args.period, args.budgetCents)
    : { ...(args.existing as AlertRecord) };

  // Fell back below the threshold: arm the alert again.
  if (args.usedPct < args.alertPct && record.alertedPct > 0) {
    record.alertedPct = 0;
  }

  const alert = args.usedPct >= args.alertPct && record.alertedPct < args.alertPct;
  if (alert) record.alertedPct = args.alertPct;

  const pause = args.exhausted && !record.pausedInPeriod;
  if (pause) record.pausedInPeriod = true;

  return { alert, pause, record };
}

/**
 * Pre-flight cost estimate for the reservation.
 *
 * Deliberately crude and deliberately not recorded anywhere as cost: it exists
 * only to hold budget headroom while the provider is working. The real number
 * comes from the provider's usage response and replaces it at settlement.
 */
export function estimateRunMicrocents(args: {
  promptChars: number;
  expectedOutputTokens: number;
  card: RateCard;
}): number {
  if (args.card.kind === "unpriced") return 0;
  const inputTokens = Math.ceil(Math.max(0, args.promptChars) / CHARS_PER_TOKEN_ESTIMATE);
  return (
    microcentsForTokens(inputTokens, args.card.inputPerMtokCents) +
    microcentsForTokens(Math.max(0, args.expectedOutputTokens), args.card.outputPerMtokCents)
  );
}

/** Human-readable percentage for a log line or a comment. */
export function formatPct(usedPct: number): string {
  return `${Math.round(usedPct * 10) / 10}%`;
}

export function microcentsToCentsString(microcents: number): string {
  const cents = microcents / MICROCENTS_PER_CENT;
  return cents.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
