/**
 * Conversation memory the gateway accumulates itself.
 *
 * These prove the DECISION logic — what counts as a turn, and how the window is
 * bounded. The storage guarantees (the idempotency constraint) belong to
 * Postgres and are not asserted against a fake.
 */
import { describe, expect, it } from "vitest";

import { classifyTurn, TURN_MAX, TURN_MAX_CHARS } from "../src/turns.js";

const base = {
  event: "message_created",
  messageType: "incoming",
  private: false as boolean | null,
  content: "hello",
  messageId: 1,
};

describe("classifyTurn — what is a turn", () => {
  it("records a customer message", () => {
    expect(classifyTurn(base)).toEqual({ role: "customer", author: "customer", content: "hello" });
  });

  it("records a BUSINESS reply — including a human agent's", () => {
    // The gateway suppresses these from triggering a reply but still sees them.
    // A bot resuming after handback must know what the human already said.
    // No senderType on this fixture, so the author is honestly UNKNOWN rather
    // than assumed to be the AI. Attribution is asserted in its own block below.
    expect(classifyTurn({ ...base, messageType: "outgoing", content: "I'll check that" })).toEqual(
      { role: "business", author: "unknown", content: "I'll check that" },
    );
  });

  it("trims, and drops a whitespace-only message", () => {
    expect(classifyTurn({ ...base, content: "  hi  " })).toEqual({
      role: "customer",
      author: "customer",
      content: "hi",
    });
    expect(classifyTurn({ ...base, content: "   " })).toBeNull();
    expect(classifyTurn({ ...base, content: null })).toBeNull();
  });
});

describe("PRIVATE NOTES NEVER BECOME TURNS — fail closed", () => {
  /**
   * THE ONE THAT MATTERS. The handoff note is staff-only. If it entered the
   * turn store it would reach the model and sit one paraphrase from the
   * customer. The previous history attempt used `=== true`, which let every
   * malformed shape through; only an explicit `false` is public.
   */
  it("drops an explicitly private note", () => {
    expect(classifyTurn({ ...base, private: true, messageType: "outgoing" })).toBeNull();
  });

  it("drops a note whose private flag is missing or malformed", () => {
    for (const bad of [null, undefined, "true", "false", 0, 1, {}] as unknown[]) {
      expect(
        classifyTurn({ ...base, private: bad as boolean | null, messageType: "outgoing" }),
        JSON.stringify(bad),
      ).toBeNull();
    }
  });
});

describe("only real message events become turns", () => {
  it("ignores non-message events", () => {
    for (const event of [
      "conversation_status_changed",
      "conversation_created",
      "conversation_updated",
      "message_updated",
      null,
    ]) {
      expect(classifyTurn({ ...base, event }), String(event)).toBeNull();
    }
  });

  it("ignores activity lines and unknown message types", () => {
    for (const messageType of ["activity", "template", null, "system"]) {
      expect(classifyTurn({ ...base, messageType }), String(messageType)).toBeNull();
    }
  });

  it("refuses a message with no id — the idempotency key would be missing", () => {
    expect(classifyTurn({ ...base, messageId: null })).toBeNull();
  });
});

describe("the window is stated, not discovered", () => {
  it("is 20 turns and 8000 characters", () => {
    expect(TURN_MAX).toBe(20);
    expect(TURN_MAX_CHARS).toBe(8000);
  });
});

describe("WHO SPOKE — the AI and a human agent are not the same voice", () => {
  /**
   * `role` deliberately collapses both into `business` for the model. That
   * collapse produced a wrong report on 2026-08-17: a `business` turn was cited
   * as proof the AI had replied, and it was an EPIC staff member answering from
   * his phone. The AI had replied nothing at all.
   */
  it("credits the AI only when Chatwoot says the sender was the bot", () => {
    expect(classifyTurn({ ...base, messageType: "outgoing", senderType: "agent_bot" })).toEqual({
      role: "business",
      author: "ai",
      content: "hello",
    });
  });

  it("credits a human when a person sent it", () => {
    expect(classifyTurn({ ...base, messageType: "outgoing", senderType: "user" })).toEqual({
      role: "business",
      author: "human",
      content: "hello",
    });
  });

  it("says UNKNOWN rather than guessing the AI when there is no sender type", () => {
    // Over-crediting the AI is the exact error this field exists to prevent, so
    // an absent sender must never resolve to "ai".
    for (const missing of [null, undefined, ""]) {
      const t = classifyTurn({
        ...base,
        messageType: "outgoing",
        senderType: missing as string | null,
      });
      expect(t, String(missing)).toEqual({
        role: "business",
        author: "unknown",
        content: "hello",
      });
    }
  });

  it("a customer is always the customer, whatever the sender type claims", () => {
    expect(
      classifyTurn({ ...base, messageType: "incoming", senderType: "agent_bot" })?.author,
    ).toBe("customer");
  });
});
