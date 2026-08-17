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
    expect(classifyTurn(base)).toEqual({ role: "customer", content: "hello" });
  });

  it("records a BUSINESS reply — including a human agent's", () => {
    // The gateway suppresses these from triggering a reply but still sees them.
    // A bot resuming after handback must know what the human already said.
    expect(classifyTurn({ ...base, messageType: "outgoing", content: "I'll check that" })).toEqual(
      { role: "business", content: "I'll check that" },
    );
  });

  it("trims, and drops a whitespace-only message", () => {
    expect(classifyTurn({ ...base, content: "  hi  " })).toEqual({
      role: "customer",
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
