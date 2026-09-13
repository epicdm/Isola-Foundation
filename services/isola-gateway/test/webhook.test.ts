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
  it("extracts the account and inbox ids without trusting anything else", () => {
    expect(parseRouting(Buffer.from(JSON.stringify(messageCreatedPayload())))).toEqual({
      accountId: 1,
      inboxId: 7,
    });
  });

  it("returns nulls for anything it cannot read", () => {
    expect(parseRouting(Buffer.from("garbage"))).toEqual({ accountId: null, inboxId: null });
    expect(parseRouting(Buffer.from("{}"))).toEqual({ accountId: null, inboxId: null });
    expect(parseRouting(Buffer.from('{"account":{"id":"x"},"inbox":{"id":7}}'))).toEqual({
      accountId: null,
      inboxId: 7,
    });
  });
});

/**
 * conversation_updated / conversation_status_changed / conversation_opened /
 * conversation_resolved — the ROOT-shaped events, distinct from
 * message_created's nested shape.
 *
 * GitHub Codex review of PR #135, pass 2 (P1, confirmed against Chatwoot
 * source — Conversations::EventDataPresenter#webhook_data, delivered
 * verbatim by Webhooks::Trigger with no re-wrapping): these four events put
 * `id`/`inbox_id`/`status`/`meta` at the TOP LEVEL, with `inbox_id` a bare
 * number and NO nested `inbox` object and NO nested `conversation` object
 * at all. Before this fix, running one of these through parseRouting
 * produced `inboxId: null` — meaning candidateSecrets found nothing and
 * EVERY such delivery was 401-rejected before evaluateSuppression ever ran.
 * That was a pre-existing gap (nothing needed these event types to route
 * correctly before def-handback-sweeper-is-blind-to-manually-assigned-
 * conversations-2026-09-13's reconcileObservedAssignment became the first
 * thing that does).
 */
function conversationUpdatedFixture(
  overrides: { event?: string; id?: unknown; inbox_id?: unknown; status?: unknown; assignee?: unknown } = {},
): Record<string, unknown> {
  return {
    event: overrides.event ?? "conversation_updated",
    id: "id" in overrides ? overrides.id : CONVERSATION_DISPLAY_ID,
    inbox_id: "inbox_id" in overrides ? overrides.inbox_id : 7,
    status: "status" in overrides ? overrides.status : "open",
    meta: { assignee: "assignee" in overrides ? overrides.assignee : { id: 99 } },
    account: { id: 1, name: "EPIC" },
    custom_attributes: {},
  };
}

describe("the root-shaped conversation events — parseRouting", () => {
  it("reads inbox_id as a bare number, not a nested { id } object", () => {
    expect(parseRouting(Buffer.from(JSON.stringify(conversationUpdatedFixture())))).toEqual({
      accountId: 1,
      inboxId: 7,
    });
  });

  it("still returns null for a truly missing inbox_id, never guessing", () => {
    expect(
      parseRouting(Buffer.from(JSON.stringify(conversationUpdatedFixture({ inbox_id: undefined })))),
    ).toEqual({ accountId: 1, inboxId: null });
  });

  for (const event of [
    "conversation_status_changed",
    "conversation_opened",
    "conversation_resolved",
  ] as const) {
    it(`routes ${event} the same way as conversation_updated`, () => {
      expect(
        parseRouting(Buffer.from(JSON.stringify(conversationUpdatedFixture({ event })))),
      ).toEqual({ accountId: 1, inboxId: 7 });
    });
  }

  it("a message_created payload is NOT parsed with the root shape — inbox stays nested", () => {
    // Negative control: the branch must key on `event`, not accidentally
    // apply to every payload.
    expect(parseRouting(Buffer.from(JSON.stringify(messageCreatedPayload())))).toEqual({
      accountId: 1,
      inboxId: 7,
    });
  });
});

describe("the root-shaped conversation events — parseWebhookPayload", () => {
  function rootPayloadFrom(overrides: Parameters<typeof conversationUpdatedFixture>[0] = {}) {
    const parsed = parseWebhookPayload(
      Buffer.from(JSON.stringify(conversationUpdatedFixture(overrides)), "utf8"),
    );
    if (parsed === null) throw new Error("fixture did not parse");
    return parsed;
  }

  it("reads conversationDisplayId, inboxId, status and assignee from the ROOT", () => {
    const payload = rootPayloadFrom();
    expect(payload.event).toBe("conversation_updated");
    expect(payload.conversationDisplayId).toBe(CONVERSATION_DISPLAY_ID);
    expect(payload.inboxId).toBe(7);
    expect(payload.accountId).toBe(1);
    expect(payload.conversationStatus).toBe("open");
    expect(payload.assignee).toEqual({ id: 99 });
  });

  it("still correctly reports not_message_created for the reply decision — this fix never changes that", () => {
    expect(evaluateSuppression(rootPayloadFrom()).action).toBe("suppress");
    expect((evaluateSuppression(rootPayloadFrom()) as { reason: string }).reason).toBe(
      "not_message_created",
    );
  });

  it("message-specific fields are absent, never guessed, for this shape", () => {
    const payload = rootPayloadFrom();
    expect(payload.messageId).toBeNull();
    expect(payload.content).toBeNull();
    expect(payload.messageType).toBe("unknown");
    expect(payload.attachmentTypes).toEqual([]);
    expect(payload.senderType).toBeNull();
    expect(payload.senderPhone).toBeNull();
  });

  it("a missing root `id` yields conversationDisplayId: null, never a guess", () => {
    expect(rootPayloadFrom({ id: undefined }).conversationDisplayId).toBeNull();
  });

  it("hasAssignee reads correctly from this shape's assignee value", () => {
    expect(hasAssignee(rootPayloadFrom().assignee)).toBe(true);
    expect(hasAssignee(rootPayloadFrom({ assignee: null }).assignee)).toBe(false);
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
