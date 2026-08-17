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

  // NOTE: "Want me to connect you with someone?" was in this list and asserted
  // to escalate. It was moved to the offer group below on 2026-08-17, because
  // production proved that behaviour wrong: escalating on an offer silences the
  // AI exactly when the customer is answering it. See the 6737 block.
  it("catches the other phrasings the same agent used", () => {
    for (const reply of [
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

describe("AN OFFER IS NOT A HANDOVER — measured on 6737, 2026-08-17", () => {
  /**
   * THE VERBATIM REGRESSION. This exact reply escalated, and the customer's
   * answer to the AI's own question was then suppressed as status_not_pending.
   * Twice.
   */
  const LIVE_REPLY =
    "Hi Eric! We offer residential and commercial internet, landline services, " +
    "data backup, and IT consultancy. We also have the Isola Smart Business Line " +
    "for businesses.\n\nFor pricing on any of these, a colleague will need to " +
    "confirm the current rates. Would you like me to pass that along for you?";

  it("does NOT escalate on the reply that broke the live conversation", () => {
    expect(detectHumanPromise(LIVE_REPLY).promised).toBe(false);
  });

  it("still escalates when the AI actually commits", () => {
    expect(detectHumanPromise("I'll pass this to a colleague now.").promised).toBe(true);
    expect(detectHumanPromise("A colleague will call you back today.").promised).toBe(true);
  });

  it("treats each sentence on its own — an offer elsewhere does not excuse a commitment", () => {
    // Committing sentence + a separate unrelated offer: must still escalate.
    const both = "I'm passing this to a colleague. Would you like anything else?";
    expect(detectHumanPromise(both).promised).toBe(true);
  });

  it("does not escalate on any of the ordinary ways of asking permission", () => {
    for (const q of [
      "Shall I have a colleague call you?",
      "Do you want me to pass this to a colleague?",
      "If you like, a team member can confirm the rates.",
      "Let me know if you want me to pass this to a colleague.",
      "Want me to have someone check that for you?",
    ]) {
      expect(detectHumanPromise(q).promised, q).toBe(false);
    }
  });

  it("is not vacuous — the same sentences escalate once the offer wording is removed", () => {
    // Positive control: strip the question and the identical phrase fires.
    expect(detectHumanPromise("A team member can confirm the rates.").promised).toBe(true);
    expect(detectHumanPromise("I'll have someone check that for you.").promised).toBe(true);
  });
});

describe("the offer that used to escalate", () => {
  it("waits for consent instead of hanging up", () => {
    // Previously asserted to escalate. The customer's "yes please" would then
    // have been suppressed as status_not_pending — the live 6737 failure.
    expect(
      detectHumanPromise("Want me to connect you with someone? I'd just need your name.").promised,
    ).toBe(false);
  });

  it("escalates on the NEXT turn, once the AI commits", () => {
    expect(detectHumanPromise("Great — I'll connect you with a colleague now.").promised).toBe(
      true,
    );
  });
});
