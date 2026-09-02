/**
 * Payload parsing and the suppression predicate — pure, no HTTP.
 *
 * Chatwoot's own `agent_bot_listener.rb` checks neither status nor assignee, so
 * every branch below is load-bearing: without it the bot talks over a human.
 */
import { describe, expect, it } from "vitest";

import {
  evaluateSuppression,
  hasAssignee,
  parseRouting,
  parseWebhookPayload,
  readMessageType,
} from "../src/webhook.js";
import { CONVERSATION_DISPLAY_ID, messageCreatedPayload, MESSAGE_ID } from "./harness.js";

function payloadFrom(overrides: Parameters<typeof messageCreatedPayload>[0] = {}) {
  const parsed = parseWebhookPayload(
    Buffer.from(JSON.stringify(messageCreatedPayload(overrides)), "utf8"),
  );
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
}

describe("parseWebhookPayload", () => {
  it("reads every field the gateway depends on", () => {
    const payload = payloadFrom();
    expect(payload.event).toBe("message_created");
    expect(payload.messageId).toBe(MESSAGE_ID);
    expect(payload.messageType).toBe("incoming");
    expect(payload.private).toBe(false);
    expect(payload.senderType).toBe("contact");
    expect(payload.accountId).toBe(1);
    expect(payload.inboxId).toBe(7);
    expect(payload.conversationStatus).toBe("pending");
    expect(payload.assignee).toBeNull();
    expect(payload.customAttributes).toEqual({});
  });

  it("treats conversation.id as the display_id — the value the API path expects", () => {
    // Chatwoot's webhook sends the display_id here, NOT the database pk. Using
    // the pk would 404 on every reply.
    expect(payloadFrom().conversationDisplayId).toBe(CONVERSATION_DISPLAY_ID);
  });

  it("returns null for a body that is not a JSON object", () => {
    expect(parseWebhookPayload(Buffer.from("[]"))).toBeNull();
    expect(parseWebhookPayload(Buffer.from("not json"))).toBeNull();
    expect(parseWebhookPayload(Buffer.from(""))).toBeNull();
  });

  it("accepts message_type as a string or as the enum ordinal", () => {
    expect(readMessageType("incoming")).toBe("incoming");
    expect(readMessageType("OUTGOING")).toBe("outgoing");
    expect(readMessageType(0)).toBe("incoming");
    expect(readMessageType(1)).toBe("outgoing");
    expect(readMessageType(2)).toBe("activity");
    expect(readMessageType(3)).toBe("template");
    expect(readMessageType(99)).toBe("unknown");
    expect(readMessageType(null)).toBe("unknown");
  });

  it("records a non-boolean `private` as null rather than guessing false", () => {
    expect(payloadFrom({ private: undefined }).private).toBeNull();
    expect(payloadFrom({ private: "false" }).private).toBeNull();
  });
});

describe("parseRouting", () => {
  // `ambiguous` was added when the parser learned Chatwoot's flat `inbox_id`
  // shape. It is asserted here rather than loosened away with objectContaining:
  // for these bodies the correct answer really is "not ambiguous", and saying so
  // is what stops a future change from quietly reporting every body as
  // contradictory while these tests still pass.
  it("extracts the account and inbox ids without trusting anything else", () => {
    expect(parseRouting(Buffer.from(JSON.stringify(messageCreatedPayload())))).toEqual({
      accountId: 1,
      inboxId: 7,
      ambiguous: false,
    });
  });

  it("returns nulls for anything it cannot read", () => {
    expect(parseRouting(Buffer.from("garbage"))).toEqual({
      accountId: null,
      inboxId: null,
      ambiguous: false,
    });
    expect(parseRouting(Buffer.from("{}"))).toEqual({
      accountId: null,
      inboxId: null,
      ambiguous: false,
    });
    // A malformed account id and a readable inbox id: the unreadable half is
    // null, the readable half survives, and nothing about that is ambiguous —
    // ambiguity means two PRESENT values disagreeing, not one absent value.
    expect(parseRouting(Buffer.from('{"account":{"id":"x"},"inbox":{"id":7}}'))).toEqual({
      accountId: null,
      inboxId: 7,
      ambiguous: false,
    });
  });
});

describe("hasAssignee", () => {
  it("is false for null, undefined and an empty object", () => {
    expect(hasAssignee(null)).toBe(false);
    expect(hasAssignee(undefined)).toBe(false);
    expect(hasAssignee({})).toBe(false);
  });
  it("is true only for an object carrying an id", () => {
    expect(hasAssignee({ id: 4, name: "Eric" })).toBe(true);
  });
});

describe("the suppression predicate", () => {
  it("replies when all five conditions hold", () => {
    expect(evaluateSuppression(payloadFrom())).toEqual({ action: "reply" });
  });

  it("suppresses an event that is not message_created", () => {
    expect(evaluateSuppression(payloadFrom({ event: "conversation_created" }))).toEqual({
      action: "suppress",
      reason: "not_message_created",
    });
  });

  it("suppresses an outgoing message", () => {
    expect(evaluateSuppression(payloadFrom({ message_type: "outgoing" }))).toEqual({
      action: "suppress",
      reason: "message_type_not_incoming",
    });
  });

  it("suppresses an activity message", () => {
    expect(evaluateSuppression(payloadFrom({ message_type: "activity" }))).toEqual({
      action: "suppress",
      reason: "message_type_not_incoming",
    });
  });

  it("suppresses a private note", () => {
    expect(evaluateSuppression(payloadFrom({ private: true }))).toEqual({
      action: "suppress",
      reason: "private_note",
    });
  });

  it("suppresses a payload with no boolean `private` rather than guessing public", () => {
    expect(evaluateSuppression(payloadFrom({ private: undefined }))).toEqual({
      action: "suppress",
      reason: "private_flag_absent",
    });
  });

  it("suppresses a message the bot itself sent", () => {
    expect(
      evaluateSuppression(payloadFrom({ sender: { type: "agent_bot", id: 3 } })),
    ).toEqual({ action: "suppress", reason: "sender_is_agent_bot" });
  });

  it("suppresses a conversation whose status is not pending", () => {
    for (const status of ["open", "resolved", "snoozed"]) {
      expect(
        evaluateSuppression(
          payloadFrom({
            conversation: {
              id: CONVERSATION_DISPLAY_ID,
              status,
              meta: { assignee: null },
              custom_attributes: {},
            },
          }),
        ),
      ).toEqual({ action: "suppress", reason: "status_not_pending" });
    }
  });

  it("suppresses a conversation a human has been assigned to", () => {
    // The case Chatwoot does NOT filter for us: delivery provably continues
    // after a human takes the conversation over.
    expect(
      evaluateSuppression(
        payloadFrom({
          conversation: {
            id: CONVERSATION_DISPLAY_ID,
            status: "pending",
            meta: { assignee: { id: 12, name: "Eric" } },
            custom_attributes: {},
          },
        }),
      ),
    ).toEqual({ action: "suppress", reason: "human_assigned" });
  });

  it("suppresses a message with no conversation id", () => {
    expect(
      evaluateSuppression(
        payloadFrom({ conversation: { status: "pending", meta: { assignee: null } } }),
      ),
    ).toEqual({ action: "suppress", reason: "no_conversation_id" });
  });

  it("hands off — rather than suppressing — a message with no usable text", () => {
    // This is the behaviour change. It used to be `empty_content`: acknowledged,
    // nothing sent, nobody summoned.
    for (const content of [null, "   ", ""]) {
      const verdict = evaluateSuppression(payloadFrom({ content }));
      expect(verdict.action).toBe("handoff");
    }
  });

  it("still evaluates status and assignee BEFORE the no-text branch", () => {
    // This ordering is what suppresses the AI after a handoff has opened and
    // assigned the conversation: a second attachment is suppressed, not handed
    // off a second time. No second mechanism exists, and none is needed.
    expect(
      evaluateSuppression(
        payloadFrom({
          content: null,
          attachments: [{ file_type: "image" }],
          conversation: {
            id: CONVERSATION_DISPLAY_ID,
            status: "open",
            meta: { assignee: { id: 12 } },
            custom_attributes: {},
          },
        }),
      ),
    ).toEqual({ action: "suppress", reason: "status_not_pending" });
  });
});
