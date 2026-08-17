/**
 * The agent's promise, read back.
 *
 * The anchor case is REAL: it is the sentence the live agent sent to the owner
 * on 2026-08-17, after which nothing escalated and nobody was told.
 */
import { describe, expect, it } from "vitest";

import { detectHumanPromise, normaliseForMatch } from "../src/promise.js";

describe("detectHumanPromise — the live sentence that escaped", () => {
  it("catches the exact reply from the 2026-08-17 transcript", () => {
    const live =
      "Good question — I don't have pricing details here, but I'd be happy to " +
      "have a colleague confirm current prices for you. Could you share your " +
      "name and a callback number so they can reach out?";
    const v = detectHumanPromise(live);
    expect(v.promised).toBe(true);
    expect(v.matched).toContain("have a colleague");
  });

  it("catches the other phrasings the same agent used", () => {
    for (const reply of [
      "Want me to connect you with someone? I'd just need your name.",
      "I can connect you to a colleague who handles that.",
      "I can have someone confirm that for you.",
      "A team member will confirm current pricing.",
      "A colleague will reach out shortly.",
      "I'm passing this to our support team now.",
    ]) {
      expect(detectHumanPromise(reply).promised, reply).toBe(true);
    }
  });
});

describe("the rejected phrases stay rejected — a false positive costs the customer their AI", () => {
  it("does not fire on ordinary answers that merely mention colleagues or follow-up", () => {
    for (const reply of [
      "I'll follow up on that.",
      "Let me get back to you on the details.",
      "A colleague handles installations, and they are included on our internet plans.",
      "Our team members are available Monday to Friday, 8am to 4pm.",
      "I can confirm that for you: installation is included.",
      // The ISP false positives review found — ordinary sales copy for THIS
      // business. Bare "connect you" used to match these and silence the AI.
      "This router can connect you to Wi-Fi anywhere in the house.",
      "That plan can connect you to the internet on the same day.",
    ]) {
      expect(detectHumanPromise(reply).promised, reply).toBe(false);
    }
  });

  it("does not fire on a plain greeting or an ordinary answer", () => {
    expect(detectHumanPromise("Hi there! How can I help you today?").promised).toBe(false);
    expect(
      detectHumanPromise(
        "We offer internet plans for homes and businesses, plus the Isola Smart Business Line.",
      ).promised,
    ).toBe(false);
  });
});

describe("matching survives real formatting", () => {
  it("is case-insensitive and survives a line wrap mid-phrase", () => {
    expect(detectHumanPromise("I'll HAVE A\n  COLLEAGUE confirm that.").promised).toBe(true);
  });

  it("survives smart quotes and em dashes", () => {
    expect(
      detectHumanPromise("Happy to connect you with someone — what’s your number?").promised,
    ).toBe(true);
  });

  it("normalises whitespace, quotes and dashes", () => {
    expect(normaliseForMatch("  A  — B’s  ")).toBe("a b's");
  });

  it("returns false, never throws, for null or empty text", () => {
    expect(detectHumanPromise(null).promised).toBe(false);
    expect(detectHumanPromise("").promised).toBe(false);
    expect(detectHumanPromise("   ").promised).toBe(false);
  });
});
