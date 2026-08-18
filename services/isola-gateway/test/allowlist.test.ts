/**
 * THE STAFF GATE.
 *
 * This replaces a property that used to be structural: until 2026-08-17 an
 * INTERNAL binding could not be routed at all — `parseBindings` hardcoded
 * PUBLIC and `resolveBinding` refused anything else. That was the right default
 * while there was no way to say WHO may use an internal line.
 *
 * Opening it is a real weakening unless the replacement is as hard to get wrong,
 * so these tests hold the new property at the same strength: refusal is the
 * DEFAULT, and every path that could admit a sender has to earn it.
 */
import { describe, expect, it } from "vitest";

import { checkSender, normalisePhone } from "../src/allowlist.js";

const INTERNAL = (allowedSenders: string[]) =>
  ({ exposure: "INTERNAL" as const, allowedSenders });

describe("normalisePhone — formatting must never decide access", () => {
  it("treats every human spelling of one number as that number", () => {
    for (const spelling of [
      "+17678189043",
      "1 767 818 9043",
      "+1 (767) 818-9043",
      "1-767-818-9043",
      " +1.767.818.9043 ",
    ]) {
      expect(normalisePhone(spelling), spelling).toBe("17678189043");
    }
  });

  it("refuses anything too short to be a real number", () => {
    // Otherwise "9043" would be an identity, and the list would be trivial to
    // satisfy by accident.
    for (const junk of ["9043", "", "  ", "abc", null, undefined, "12345"]) {
      expect(normalisePhone(junk as string | null), String(junk)).toBeNull();
    }
  });
});

describe("PUBLIC lines are untouched", () => {
  it("lets everyone through, allowlist or not", () => {
    // 6737 and 3742 must keep answering strangers — that is their whole job.
    expect(checkSender({ exposure: "PUBLIC", allowedSenders: [] }, "+1 555 000 1111")).toEqual({
      allowed: true,
    });
    expect(checkSender({ exposure: "PUBLIC", allowedSenders: [] }, null)).toEqual({ allowed: true });
  });
});

describe("INTERNAL lines refuse by default", () => {
  it("admits a sender on the list, however either side is formatted", () => {
    expect(checkSender(INTERNAL(["+1 767 818-9043"]), "17678189043")).toEqual({ allowed: true });
    expect(checkSender(INTERNAL(["17678189043"]), "+1 (767) 818-9043")).toEqual({ allowed: true });
  });

  it("refuses a sender who is not on the list", () => {
    expect(checkSender(INTERNAL(["17678189043"]), "+1 555 000 1111")).toEqual({
      allowed: false,
      reason: "not_allowlisted",
    });
  });

  /**
   * THE ONE THAT MATTERS MOST. "No list configured" must never read as "not
   * configured yet, so allow" — that is how a staff line becomes a public one by
   * omission, at the exact moment someone half-finishes the config.
   */
  it("an EMPTY allowlist refuses EVERYONE", () => {
    for (const sender of ["17678189043", "+1 555 000 1111", null]) {
      expect(checkSender(INTERNAL([]), sender), String(sender)).toEqual({
        allowed: false,
        reason: "empty_allowlist",
      });
    }
  });

  it("refuses a sender it cannot identify", () => {
    // "We could not tell who this was" is not a reason to admit someone to an
    // internal agent.
    for (const bad of [null, "", "unknown", "9043"]) {
      expect(checkSender(INTERNAL(["17678189043"]), bad), String(bad)).toEqual({
        allowed: false,
        reason: "unidentified_sender",
      });
    }
  });

  it("does NOT match on a suffix — the obvious wrong implementation", () => {
    // A suffix rule would admit every number on earth ending in the staff
    // digits. Exact match on the full digit string, or nothing.
    expect(checkSender(INTERNAL(["17678189043"]), "9998189043").allowed).toBe(false);
    expect(checkSender(INTERNAL(["17678189043"]), "4417678189043").allowed).toBe(false);
  });

  it("ignores a malformed entry rather than letting it admit anyone", () => {
    expect(checkSender(INTERNAL(["", "junk", "17678189043"]), "17678189043").allowed).toBe(true);
    expect(checkSender(INTERNAL(["", "junk"]), "17678189043").allowed).toBe(false);
  });
});

describe("a refused sender is told NOTHING", () => {
  /**
   * Ruled 2026-08-17. There is no refusal message to assert, which is the point:
   * a reply would confirm to a stranger that the number is live and monitored,
   * and an INTERNAL line is never given to a customer.
   *
   * The behaviour is asserted where it happens — webhook-http.test.ts proves the
   * gateway makes NO outbound call on a refusal. This block exists so the
   * decision is visible from the module that decides it.
   */
  it("exports no refusal text at all", async () => {
    const mod = (await import("../src/allowlist.js")) as Record<string, unknown>;
    expect(mod["refusalText"], "silence is the behaviour, not a configurable message").toBeUndefined();
  });
});
