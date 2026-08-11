/**
 * Money and token arithmetic. Pure — no I/O, no clock, no state.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Paperclip's cost-event schema takes `costCents` as an INTEGER. A single
 * DeepSeek run costs a small fraction of one cent, so naive rounding sends 0
 * forever and the ledger never moves — which is exactly the blind-budget defect
 * this work fixes. Rounding every run *up* would be worse: it inflates spend by
 * up to a full cent per run, and at 53 runs per wakeup that is a fabricated
 * 53 cents.
 *
 * So cost is accumulated in a sub-cent unit and an integer-cent cost event is
 * emitted only once at least one whole cent has accrued; the remainder is
 * carried forward and is never dropped.
 *
 * THE UNIT
 * --------
 * Everything internal is in **microcents** (1 cent = 1_000_000 microcents,
 * i.e. one microcent is USD 1e-8). All arithmetic stays in safe integers:
 *
 *   price P is quoted in cents per 1,000,000 tokens
 *   cost_cents      = tokens * P / 1e6
 *   cost_microcents = cost_cents * 1e6 = tokens * P
 *
 * so a token simply costs `P` microcents and the largest intermediate value for
 * a 10M-token request at USD 100/Mtok is ~1e14 — far inside Number.MAX_SAFE_INTEGER.
 *
 * NEVER FABRICATE COST
 * --------------------
 * A rate card carries its provenance. `actual` means the numbers came from the
 * provider's own usage response priced at the provider's real rates.
 * `synthetic` means a clearly-labelled, versioned fake profile was applied so a
 * zero-cost provider (Ollama and friends) can still exercise the threshold
 * paths — it is never presented as real expenditure. `unpriced` means usage was
 * observed but no rate is known, so the event carries the usage and costCents 0.
 */

export const MICROCENTS_PER_CENT = 1_000_000;

/** Provenance of a priced amount. Never widened, never inferred. */
export type CostKind = "actual" | "synthetic" | "unpriced";

/** Versioned pricing profile identifiers. These land in `billingCode`. */
export const PROFILE_PROVIDER_RATES = "provider-rates@v1";
export const PROFILE_SYNTHETIC = "synthetic-pricing@v1";
export const PROFILE_UNPRICED = "unpriced@v1";

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export const ZERO_USAGE: TokenUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
});

export interface RateCard {
  /** Cents per 1,000,000 tokens. `null` means "no rate is known". */
  readonly inputPerMtokCents: number | null;
  readonly cachedInputPerMtokCents: number | null;
  readonly outputPerMtokCents: number | null;
  readonly kind: CostKind;
  /** Versioned profile id, surfaced in the cost event's `billingCode`. */
  readonly profile: string;
}

export const UNPRICED_RATE_CARD: RateCard = Object.freeze({
  inputPerMtokCents: null,
  cachedInputPerMtokCents: null,
  outputPerMtokCents: null,
  kind: "unpriced",
  profile: PROFILE_UNPRICED,
});

/**
 * Built-in list prices, in cents per 1,000,000 tokens.
 *
 * These are the provider's published rates and are the documented defaults for
 * the models this runtime actually calls. A model that is not in this table and
 * has no env override is treated as UNPRICED — the runtime records the usage
 * with costCents 0 rather than guessing a price.
 */
export const BUILTIN_RATE_CARDS: Readonly<
  Record<string, { input: number; cachedInput: number; output: number }>
> = Object.freeze({
  "deepseek-chat": { input: 27, cachedInput: 7, output: 110 },
  "deepseek-reasoner": { input: 55, cachedInput: 14, output: 219 },
});

/**
 * The synthetic profile. Deliberately round, deliberately not any real
 * provider's price, and only ever applied when explicitly switched on. Every
 * event it produces is stamped `synthetic-pricing@v1`.
 */
export const SYNTHETIC_RATES: Readonly<{
  input: number;
  cachedInput: number;
  output: number;
}> = Object.freeze({ input: 10, cachedInput: 1, output: 10 });

export interface RateOverrides {
  inputPerMtokCents: number | null;
  cachedInputPerMtokCents: number | null;
  outputPerMtokCents: number | null;
}

/**
 * Resolve the rate card for a model.
 *
 * Order: explicit env overrides win; then the built-in provider list price;
 * then, only if synthetic pricing is switched on, the clearly-labelled
 * synthetic profile; otherwise unpriced.
 */
export function resolveRateCard(args: {
  model: string;
  overrides: RateOverrides;
  syntheticEnabled: boolean;
}): RateCard {
  const { overrides } = args;
  const hasOverride =
    overrides.inputPerMtokCents !== null || overrides.outputPerMtokCents !== null;

  const builtin = BUILTIN_RATE_CARDS[args.model.trim().toLowerCase()];

  if (hasOverride || builtin !== undefined) {
    const input = overrides.inputPerMtokCents ?? builtin?.input ?? null;
    const output = overrides.outputPerMtokCents ?? builtin?.output ?? null;
    const cached =
      overrides.cachedInputPerMtokCents ?? builtin?.cachedInput ?? input;
    return Object.freeze({
      inputPerMtokCents: input,
      cachedInputPerMtokCents: cached,
      outputPerMtokCents: output,
      kind: "actual" as const,
      profile: PROFILE_PROVIDER_RATES,
    });
  }

  if (args.syntheticEnabled) {
    return Object.freeze({
      inputPerMtokCents: SYNTHETIC_RATES.input,
      cachedInputPerMtokCents: SYNTHETIC_RATES.cachedInput,
      outputPerMtokCents: SYNTHETIC_RATES.output,
      kind: "synthetic" as const,
      profile: PROFILE_SYNTHETIC,
    });
  }

  return UNPRICED_RATE_CARD;
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/** Normalise anything the provider reported into a safe, non-negative usage. */
export function normaliseUsage(usage: Partial<TokenUsage> | null | undefined): TokenUsage {
  if (usage === null || usage === undefined) return { ...ZERO_USAGE };
  return {
    inputTokens: nonNegativeInt(usage.inputTokens ?? 0),
    cachedInputTokens: nonNegativeInt(usage.cachedInputTokens ?? 0),
    outputTokens: nonNegativeInt(usage.outputTokens ?? 0),
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export function usageIsEmpty(usage: TokenUsage): boolean {
  return (
    usage.inputTokens === 0 &&
    usage.cachedInputTokens === 0 &&
    usage.outputTokens === 0
  );
}

/** A token costs exactly `perMtokCents` microcents. See the unit note above. */
export function microcentsForTokens(
  tokens: number,
  perMtokCents: number | null,
): number {
  if (perMtokCents === null || !Number.isFinite(perMtokCents)) return 0;
  if (tokens <= 0 || perMtokCents <= 0) return 0;
  return Math.round(tokens * perMtokCents);
}

export interface PricedUsage {
  microcents: number;
  kind: CostKind;
  profile: string;
}

/**
 * Price a usage record. Cached input tokens are billed at the cached rate; they
 * are assumed to be a *subset marker* reported alongside the input count in the
 * OpenAI-compatible shape, so `inputTokens` is billed net of them when the
 * caller has already separated the two.
 */
export function priceUsage(usage: TokenUsage, card: RateCard): PricedUsage {
  if (card.kind === "unpriced") {
    return { microcents: 0, kind: "unpriced", profile: card.profile };
  }
  const microcents =
    microcentsForTokens(usage.inputTokens, card.inputPerMtokCents) +
    microcentsForTokens(usage.cachedInputTokens, card.cachedInputPerMtokCents) +
    microcentsForTokens(usage.outputTokens, card.outputPerMtokCents);
  return { microcents, kind: card.kind, profile: card.profile };
}

// ---------------------------------------------------------------------------
// The sub-cent accumulator
// ---------------------------------------------------------------------------

export interface Accumulator {
  /** Sub-cent cost carried forward. Always >= 0 and always < 1 cent after a flush. */
  microcents: number;
  /** Usage accrued since the last emitted event, so no usage is ever lost. */
  usage: TokenUsage;
  /** How many runs have contributed since the last emitted event. */
  runs: number;
}

export function emptyAccumulator(): Accumulator {
  return { microcents: 0, usage: { ...ZERO_USAGE }, runs: 0 };
}

export function accrue(
  acc: Accumulator,
  delta: { microcents: number; usage: TokenUsage },
): Accumulator {
  return {
    microcents: acc.microcents + Math.max(0, Math.round(delta.microcents)),
    usage: addUsage(acc.usage, delta.usage),
    runs: acc.runs + 1,
  };
}

export interface FlushResult {
  /** True when at least one whole cent has accrued. */
  emit: boolean;
  /** Integer cents to bill. 0 when `emit` is false. */
  costCents: number;
  /** Usage to attach to the emitted event. Zeroed when `emit` is false. */
  usage: TokenUsage;
  /** Runs represented by the emitted event. */
  runs: number;
  /** What stays behind. The remainder is never dropped. */
  carry: Accumulator;
}

/**
 * Emit whole cents, carry the remainder.
 *
 * Invariant, asserted in the tests: over any sequence of accruals the sum of
 * emitted `costCents` equals `floor(total accrued microcents / 1e6)`, and the
 * carry equals the leftover. Nothing is rounded up, nothing is discarded.
 */
export function flush(acc: Accumulator): FlushResult {
  const costCents = Math.floor(acc.microcents / MICROCENTS_PER_CENT);
  if (costCents < 1) {
    return {
      emit: false,
      costCents: 0,
      usage: { ...ZERO_USAGE },
      runs: 0,
      carry: acc,
    };
  }
  return {
    emit: true,
    costCents,
    usage: { ...acc.usage },
    runs: acc.runs,
    carry: {
      microcents: acc.microcents - costCents * MICROCENTS_PER_CENT,
      usage: { ...ZERO_USAGE },
      runs: 0,
    },
  };
}

/**
 * An unpriced or synthetic-disabled run still has to reach the ledger, because
 * Paperclip is the canonical record of what the employee did. This produces the
 * usage-only event: real tokens, zero money, explicitly marked unpriced.
 */
export function isUnpricedProfile(profile: string): boolean {
  return profile === PROFILE_UNPRICED;
}

export function isSyntheticProfile(profile: string): boolean {
  return profile === PROFILE_SYNTHETIC;
}

/** Convert microcents to whole cents, rounding DOWN. Used for budget headroom. */
export function microcentsToCentsFloor(microcents: number): number {
  return Math.floor(Math.max(0, microcents) / MICROCENTS_PER_CENT);
}

export function centsToMicrocents(cents: number): number {
  return Math.round(cents * MICROCENTS_PER_CENT);
}
