/**
 * The sub-cent accumulator is the single most important piece of correctness in
 * the metering work: Paperclip's `costCents` is an integer, a DeepSeek run costs
 * a small fraction of a cent, and both naive strategies are wrong — rounding
 * down sends 0 forever, rounding up invents money. So these tests assert the
 * exact invariant rather than a sample: over any sequence of accruals, the sum
 * of emitted whole cents plus the carried remainder equals the total accrued,
 * exactly.
 */
import { describe, expect, it } from "vitest";

import {
  BUILTIN_RATE_CARDS,
  MICROCENTS_PER_CENT,
  PROFILE_PROVIDER_RATES,
  PROFILE_SYNTHETIC,
  PROFILE_UNPRICED,
  accrue,
  addUsage,
  emptyAccumulator,
  flush,
  microcentsForTokens,
  normaliseUsage,
  priceUsage,
  resolveRateCard,
  usageIsEmpty,
  type Accumulator,
  type TokenUsage,
} from "../src/money.js";

const NO_OVERRIDES = {
  inputPerMtokCents: null,
  cachedInputPerMtokCents: null,
  outputPerMtokCents: null,
};

const usage = (input: number, output: number, cached = 0): TokenUsage => ({
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
});

describe("rate card resolution", () => {
  it("uses the built-in provider list price for a known model", () => {
    const card = resolveRateCard({
      model: "deepseek-chat",
      overrides: NO_OVERRIDES,
      syntheticEnabled: false,
    });
    expect(card.kind).toBe("actual");
    expect(card.profile).toBe(PROFILE_PROVIDER_RATES);
    expect(card.inputPerMtokCents).toBe(BUILTIN_RATE_CARDS["deepseek-chat"]!.input);
    expect(card.outputPerMtokCents).toBe(BUILTIN_RATE_CARDS["deepseek-chat"]!.output);
    expect(card.cachedInputPerMtokCents).toBe(BUILTIN_RATE_CARDS["deepseek-chat"]!.cachedInput);
  });

  it("env overrides beat the built-in card", () => {
    const card = resolveRateCard({
      model: "deepseek-chat",
      overrides: {
        inputPerMtokCents: 5,
        cachedInputPerMtokCents: null,
        outputPerMtokCents: 9,
      },
      syntheticEnabled: false,
    });
    expect(card.inputPerMtokCents).toBe(5);
    expect(card.outputPerMtokCents).toBe(9);
    // No cached override: the built-in cached rate is still the better answer.
    expect(card.cachedInputPerMtokCents).toBe(7);
    expect(card.kind).toBe("actual");
  });

  it("an unknown model with no rates is UNPRICED — never guessed", () => {
    const card = resolveRateCard({
      model: "some-local-model",
      overrides: NO_OVERRIDES,
      syntheticEnabled: false,
    });
    expect(card.kind).toBe("unpriced");
    expect(card.profile).toBe(PROFILE_UNPRICED);
    expect(card.inputPerMtokCents).toBeNull();
    expect(card.outputPerMtokCents).toBeNull();
  });

  it("synthetic pricing is opt-in, versioned and clearly labelled", () => {
    const card = resolveRateCard({
      model: "some-local-model",
      overrides: NO_OVERRIDES,
      syntheticEnabled: true,
    });
    expect(card.kind).toBe("synthetic");
    expect(card.profile).toBe(PROFILE_SYNTHETIC);
    expect(card.profile).toContain("@v");
    // Synthetic must never masquerade as the provider's real rate card.
    expect(card.profile).not.toBe(PROFILE_PROVIDER_RATES);
  });

  it("synthetic pricing never overrides a model that has a real rate", () => {
    const card = resolveRateCard({
      model: "deepseek-chat",
      overrides: NO_OVERRIDES,
      syntheticEnabled: true,
    });
    expect(card.kind).toBe("actual");
    expect(card.profile).toBe(PROFILE_PROVIDER_RATES);
  });
});

describe("pricing arithmetic", () => {
  it("one token costs exactly its per-Mtok rate in microcents", () => {
    // 1,000,000 tokens at 27 cents/Mtok is 27 cents is 27,000,000 microcents.
    expect(microcentsForTokens(1_000_000, 27)).toBe(27 * MICROCENTS_PER_CENT);
    expect(microcentsForTokens(1000, 27)).toBe(27_000);
    expect(microcentsForTokens(0, 27)).toBe(0);
    expect(microcentsForTokens(1000, null)).toBe(0);
    expect(microcentsForTokens(-5, 27)).toBe(0);
  });

  it("prices a deepseek-chat run at the documented list price", () => {
    const card = resolveRateCard({
      model: "deepseek-chat",
      overrides: NO_OVERRIDES,
      syntheticEnabled: false,
    });
    // 1000 fresh input + 500 cached input + 300 output
    const priced = priceUsage(usage(1000, 300, 500), card);
    // 1000*27 + 500*7 + 300*110 = 27000 + 3500 + 33000 = 63500 microcents
    expect(priced.microcents).toBe(63_500);
    expect(priced.microcents / MICROCENTS_PER_CENT).toBeCloseTo(0.0635, 6);
    expect(priced.kind).toBe("actual");
  });

  it("an unpriced card produces zero money but keeps the usage intact", () => {
    const card = resolveRateCard({
      model: "ollama-local",
      overrides: NO_OVERRIDES,
      syntheticEnabled: false,
    });
    const u = usage(4000, 900);
    const priced = priceUsage(u, card);
    expect(priced.microcents).toBe(0);
    expect(priced.kind).toBe("unpriced");
    // The usage object is untouched — it still has to reach the ledger.
    expect(u).toEqual({ inputTokens: 4000, cachedInputTokens: 0, outputTokens: 900 });
  });

  it("normalises junk usage without inventing tokens", () => {
    expect(normaliseUsage(null)).toEqual(usage(0, 0));
    expect(normaliseUsage({ inputTokens: -3, outputTokens: 2.7 })).toEqual({
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 2,
    });
    expect(usageIsEmpty(usage(0, 0))).toBe(true);
    expect(usageIsEmpty(usage(0, 1))).toBe(false);
    expect(addUsage(usage(1, 2, 3), usage(10, 20, 30))).toEqual(usage(11, 22, 33));
  });
});

describe("the sub-cent accumulator", () => {
  it("emits nothing until a whole cent has accrued", () => {
    let acc = emptyAccumulator();
    acc = accrue(acc, { microcents: 500_000, usage: usage(10, 5) }); // 0.5 cents
    const first = flush(acc);
    expect(first.emit).toBe(false);
    expect(first.costCents).toBe(0);
    // Nothing was rounded up, and nothing was thrown away.
    expect(first.carry.microcents).toBe(500_000);
    expect(first.carry.usage).toEqual(usage(10, 5));
  });

  it("emits exactly one cent and carries the remainder", () => {
    let acc = emptyAccumulator();
    acc = accrue(acc, { microcents: 1_400_000, usage: usage(100, 50) }); // 1.4 cents
    const result = flush(acc);
    expect(result.emit).toBe(true);
    expect(result.costCents).toBe(1);
    expect(result.usage).toEqual(usage(100, 50));
    expect(result.carry.microcents).toBe(400_000);
    // The usage went out with the event, so the carry starts clean.
    expect(result.carry.usage).toEqual(usage(0, 0));
    expect(result.carry.runs).toBe(0);
  });

  it("many sub-cent runs sum to the correct whole-cent total with carry", () => {
    // 100 runs of exactly 0.037 cents = 3.7 cents.
    const perRun = 37_000;
    let acc = emptyAccumulator();
    let emittedCents = 0;
    let events = 0;
    for (let i = 0; i < 100; i += 1) {
      acc = accrue(acc, { microcents: perRun, usage: usage(3, 1) });
      const result = flush(acc);
      acc = result.carry;
      if (result.emit) {
        emittedCents += result.costCents;
        events += 1;
      }
    }
    expect(emittedCents).toBe(3);
    expect(acc.microcents).toBe(700_000);
    expect(events).toBe(3);
    // The invariant: nothing invented, nothing lost.
    expect(emittedCents * MICROCENTS_PER_CENT + acc.microcents).toBe(100 * perRun);
  });

  it("a realistic 53-run wakeup produces a non-zero, exactly-correct charge", () => {
    // The defect: 53 runs reported spentMonthlyCents 0. Priced properly at the
    // deepseek-chat list price they are worth a real, small number of cents.
    const card = resolveRateCard({
      model: "deepseek-chat",
      overrides: NO_OVERRIDES,
      syntheticEnabled: false,
    });
    const runUsage = usage(2400, 700); // 2400*27 + 700*110 = 64800 + 77000
    const perRun = priceUsage(runUsage, card).microcents;
    expect(perRun).toBe(141_800);

    let acc = emptyAccumulator();
    let emittedCents = 0;
    let totalTokensBilled = 0;
    for (let i = 0; i < 53; i += 1) {
      acc = accrue(acc, { microcents: perRun, usage: runUsage });
      const result = flush(acc);
      acc = result.carry;
      if (result.emit) {
        emittedCents += result.costCents;
        totalTokensBilled += result.usage.inputTokens + result.usage.outputTokens;
      }
    }
    const total = 53 * perRun; // 7,515,400 microcents = 7.5154 cents
    expect(total).toBe(7_515_400);
    expect(emittedCents).toBe(7);
    expect(acc.microcents).toBe(515_400);
    expect(emittedCents * MICROCENTS_PER_CENT + acc.microcents).toBe(total);
    // Emphatically not zero — that was the defect.
    expect(emittedCents).toBeGreaterThan(0);
    // Every billed token reached an event; only the trailing sub-cent run's
    // usage is still waiting in the carry.
    expect(totalTokensBilled).toBe(
      53 * (runUsage.inputTokens + runUsage.outputTokens) -
        (acc.usage.inputTokens + acc.usage.outputTokens),
    );
  });

  it("the invariant holds over a long pseudo-random sequence", () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 20260811;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };

    let acc: Accumulator = emptyAccumulator();
    let total = 0;
    let emittedCents = 0;
    for (let i = 0; i < 5000; i += 1) {
      const microcents = next() % 250_000; // always sub-cent
      total += microcents;
      acc = accrue(acc, { microcents, usage: usage(1, 1) });
      const result = flush(acc);
      acc = result.carry;
      emittedCents += result.costCents;
    }
    expect(emittedCents).toBe(Math.floor(total / MICROCENTS_PER_CENT));
    expect(acc.microcents).toBe(total % MICROCENTS_PER_CENT);
    expect(emittedCents * MICROCENTS_PER_CENT + acc.microcents).toBe(total);
    // A carry is by construction always strictly under one cent.
    expect(acc.microcents).toBeLessThan(MICROCENTS_PER_CENT);
  });

  it("a single large run emits several cents at once, exactly", () => {
    let acc = emptyAccumulator();
    acc = accrue(acc, { microcents: 12_750_000, usage: usage(500_000, 100_000) });
    const result = flush(acc);
    expect(result.costCents).toBe(12);
    expect(result.carry.microcents).toBe(750_000);
  });

  it("never rounds a run up", () => {
    let acc = emptyAccumulator();
    for (let i = 0; i < 9; i += 1) {
      acc = accrue(acc, { microcents: 999_999, usage: usage(1, 1) });
    }
    // 9 x 0.999999 cents = 8.999991 cents. Rounding each run up would say 9.
    const result = flush(acc);
    expect(result.costCents).toBe(8);
    expect(result.carry.microcents).toBe(999_991);
  });
});
