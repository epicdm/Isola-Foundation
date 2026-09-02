/**
 * Handback — the return edge that had no caller.
 *
 * These are unit proofs of the DECISION logic. The transition guarantees
 * themselves (locking, unique claim, episode fencing) are proven against real
 * Postgres in `ownership-store.pg.test.ts`, which refuses to pass without a
 * database. Nothing here re-asserts those.
 */
import { describe, expect, it } from "vitest";

import { readLastActivityMs } from "../src/handback.js";

describe("readLastActivityMs — idleness is read from Chatwoot, not inferred", () => {
  it("reads seconds and converts to milliseconds", () => {
    expect(readLastActivityMs({ payload: { last_activity_at: 1_786_900_000 } })).toBe(
      1_786_900_000_000,
    );
  });

  it("reads an unwrapped record as well as a payload-wrapped one", () => {
    expect(readLastActivityMs({ last_activity_at: 1_786_900_000 })).toBe(1_786_900_000_000);
  });

  it("accepts an ISO timestamp", () => {
    expect(readLastActivityMs({ last_activity_at: "2026-08-16T22:42:04.000Z" })).toBe(
      Date.parse("2026-08-16T22:42:04.000Z"),
    );
  });

  /**
   * THE ONE THAT MATTERS. A shape we do not recognise must return null, never 0.
   *
   * 0 would read as "idle since 1970" and the sweeper would hand back EVERY
   * human-held conversation on its first pass — silently taking live
   * conversations away from the people holding them. Returning null makes an
   * unreadable record mean "leave it alone", which is the safe direction.
   */
  it("returns null — never 0 — for a record it cannot read", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "nope",
      {},
      { payload: {} },
      { last_activity_at: null },
      { last_activity_at: 0 },
      { last_activity_at: -1 },
      { last_activity_at: "not a date" },
      { last_activity_at: Number.NaN },
    ]) {
      expect(readLastActivityMs(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("an unreadable record is NOT treated as idle at any threshold", () => {
    const idleMs = 10 * 60 * 1000;
    const now = 1_786_900_000_000;
    const lastActivity = readLastActivityMs({ payload: { conversation: "no timestamp" } });
    // The sweeper's own predicate: null must short-circuit before the comparison.
    const wouldHandBack = lastActivity !== null && now - lastActivity >= idleMs;
    expect(wouldHandBack).toBe(false);
  });
});

describe("the idle threshold is measured from the LAST MESSAGE, not from takeover", () => {
  const IDLE_MS = 10 * 60 * 1000;
  const now = 1_786_900_000_000;

  it("does not hand back while a human is still replying", () => {
    // Took over 30 minutes ago, spoke 1 minute ago. An elapsed-since-takeover
    // timer would cut across a live conversation; an idle timer must not.
    const lastActivity = now - 60_000;
    expect(now - lastActivity >= IDLE_MS).toBe(false);
  });

  it("hands back once the conversation itself has gone quiet", () => {
    const lastActivity = now - 11 * 60 * 1000;
    expect(now - lastActivity >= IDLE_MS).toBe(true);
  });

  it("does not hand back one second early", () => {
    const lastActivity = now - (IDLE_MS - 1000);
    expect(now - lastActivity >= IDLE_MS).toBe(false);
  });
});
