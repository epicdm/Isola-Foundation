/**
 * THE FLAT `inbox_id` PAYLOAD — the shape Chatwoot actually sends for
 * conversation events, and the reason explicit handback never arrived.
 *
 * Chatwoot does not send one envelope shape. It sends the `webhook_data` of
 * whichever MODEL the event is about, and the two nest differently. Read from
 * the RUNNING Chatwoot source on host03, not inferred from documentation:
 *
 *   Message#webhook_data                      -> account:{}, inbox:{}, conversation:{}
 *   Conversations::EventDataPresenter#webhook_data
 *     (conversation_status_changed sends
 *      `conversation.webhook_data.merge(event:, changed_attributes:)`)
 *                                             -> account:{}, FLAT inbox_id,
 *                                                FLAT status, top-level meta,
 *                                                top-level id = display_id
 *
 * The parser read `inbox.id` only. A conversation event therefore resolved to
 * `inboxId: null`, and `decideDelivery` refuses that as `unparseable_body`
 * BEFORE any secret is selected — the measured `422 unroutable_event` recorded
 * in `docs/isola/REPRO-EXPLICIT-HANDBACK-UNREACHABLE-2026-08-24.md`. The
 * handback signal was never rejected on its merits; it never got as far as
 * being read.
 *
 * The primary fixture below is that exact real staging shape. The nested shape
 * is kept as a compatibility fixture, because a fix that repairs conversation
 * events by breaking message events is not a fix.
 */
import { describe, expect, it } from "vitest";

import { parseRouting, parseWebhookPayload, isManualHandbackSignal } from "../src/webhook.js";

import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  INBOX_ID,
  MESSAGE_ID,
  CapturingLogger,
  messageCreatedPayload,
  placeholder,
  postWebhook,
  signRequest,
  startServer,
} from "./harness.js";

const buf = (value: unknown): Buffer => Buffer.from(JSON.stringify(value), "utf8");

/**
 * THE PRIMARY FIXTURE: the real `conversation_status_changed` body, keyed
 * exactly as `Conversations::EventDataPresenter#webhook_data` builds it.
 *
 * Note what is NOT here, because their absence is the whole defect: no `inbox`
 * node, and no `conversation` node.
 */
function realStatusChangedPayload(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    event: "conversation_status_changed",
    id: CONVERSATION_DISPLAY_ID, // conversation display_id, NOT a message id
    inbox_id: INBOX_ID, // FLAT
    status: "pending", // FLAT
    account: { id: ACCOUNT_ID, name: "EPIC" }, // still nested, per the presenter
    meta: {
      sender: { id: 5, name: "Repro Contact" },
      assignee: null,
      assignee_type: "User",
      team: null,
      hmac_verified: false,
    },
    additional_attributes: {},
    custom_attributes: {},
    can_reply: true,
    channel: "Channel::Api",
    labels: [],
    messages: [],
    unread_count: 1,
    priority: null,
    snoozed_until: null,
    changed_attributes: [{ status: ["open", "pending"] }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// parseRouting — the pre-signature step that produced the 422
// ---------------------------------------------------------------------------

describe("parseRouting — the real flat payload becomes routable", () => {
  it("resolves account and inbox from the REAL conversation_status_changed body", () => {
    const routing = parseRouting(buf(realStatusChangedPayload()));
    expect(routing).toEqual({
      accountId: ACCOUNT_ID,
      inboxId: INBOX_ID,
      ambiguous: false,
    });
  });

  /**
   * THE REGRESSION, pinned. Before the fix this returned `inboxId: null`, which
   * decideDelivery refuses as `unparseable_body`. Asserting the value alone
   * would pass on a parser that returned the right number for the wrong reason,
   * so the point being made is explicit: it is non-null.
   */
  it("no longer yields a null inboxId for a body with no `inbox` node", () => {
    const body = realStatusChangedPayload();
    expect(body["inbox"], "fixture must have NO nested inbox node").toBeUndefined();
    expect(parseRouting(buf(body)).inboxId).not.toBeNull();
  });

  it("COMPATIBILITY — the legacy nested shape still routes", () => {
    const routing = parseRouting(buf(messageCreatedPayload()));
    expect(routing).toEqual({
      accountId: ACCOUNT_ID,
      inboxId: INBOX_ID,
      ambiguous: false,
    });
  });

  it("accepts flat and nested agreeing with each other", () => {
    const routing = parseRouting(
      buf(realStatusChangedPayload({ inbox: { id: INBOX_ID }, account_id: ACCOUNT_ID })),
    );
    expect(routing.inboxId).toBe(INBOX_ID);
    expect(routing.accountId).toBe(ACCOUNT_ID);
    expect(routing.ambiguous).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conflicting-ID controls — refuse, never guess
// ---------------------------------------------------------------------------

describe("parseRouting — conflicting identifiers are refused as ambiguous", () => {
  it("refuses when flat inbox_id and nested inbox.id disagree", () => {
    const routing = parseRouting(
      buf(realStatusChangedPayload({ inbox_id: INBOX_ID, inbox: { id: INBOX_ID + 1 } })),
    );
    expect(routing.ambiguous).toBe(true);
    // Refusing means yielding NOTHING to route by. Returning either value would
    // pick a tenant by coin-flip.
    expect(routing.inboxId).toBeNull();
    expect(routing.accountId).toBeNull();
  });

  it("refuses when flat account_id and nested account.id disagree", () => {
    const routing = parseRouting(
      buf(realStatusChangedPayload({ account_id: ACCOUNT_ID + 5 })),
    );
    expect(routing.ambiguous).toBe(true);
    expect(routing.accountId).toBeNull();
  });

  /**
   * THE CONTROL THAT KEEPS THE ABOVE HONEST.
   *
   * Top-level `id` is the MESSAGE pk in a message payload and the CONVERSATION
   * display_id in a conversation payload. They differ on essentially every real
   * message Chatwoot sends. A naive "compare both forms" implementation would
   * read that difference as a conflict and refuse ALL normal traffic — a fix
   * that repairs handback by breaking the entire product.
   */
  it("does NOT treat message id vs conversation.id as a conflict", () => {
    const body = messageCreatedPayload();
    expect(body["id"], "message pk").toBe(MESSAGE_ID);
    expect(
      (body["conversation"] as Record<string, unknown>)["id"],
      "conversation display_id — legitimately different",
    ).toBe(CONVERSATION_DISPLAY_ID);
    expect(MESSAGE_ID).not.toBe(CONVERSATION_DISPLAY_ID);

    const routing = parseRouting(buf(body));
    expect(routing.ambiguous, "these two are DIFFERENT fields, not a conflict").toBe(false);
    expect(routing.inboxId).toBe(INBOX_ID);
  });
});

// ---------------------------------------------------------------------------
// Missing and malformed controls
// ---------------------------------------------------------------------------

describe("parseRouting — missing and malformed bodies", () => {
  it("a body with neither form yields nulls, and is NOT reported ambiguous", () => {
    const routing = parseRouting(buf({ event: "contact_updated", id: 1 }));
    expect(routing).toEqual({ accountId: null, inboxId: null, ambiguous: false });
  });

  it.each([
    ["not json at all", Buffer.from("<html>nope</html>", "utf8")],
    ["a JSON array", buf([1, 2, 3])],
    ["a JSON string", buf("hello")],
    ["a JSON number", buf(42)],
    ["null", buf(null)],
    ["empty", Buffer.alloc(0)],
  ])("%s yields nulls without throwing", (_label, raw) => {
    expect(() => parseRouting(raw)).not.toThrow();
    const routing = parseRouting(raw);
    expect(routing.accountId).toBeNull();
    expect(routing.inboxId).toBeNull();
  });

  it.each([
    ["a string that is not a number", "not-a-number"],
    ["a float", 7.5],
    ["a boolean", true],
    ["an object", { id: 7 }],
    ["an array", [7]],
    ["null", null],
  ])("a malformed flat inbox_id (%s) does not become an inbox id", (_label, value) => {
    const routing = parseRouting(buf(realStatusChangedPayload({ inbox_id: value })));
    expect(routing.inboxId).toBeNull();
  });

  /** Chatwoot has shipped numeric ids as strings. That must still route. */
  it("a numeric STRING inbox_id is accepted", () => {
    const routing = parseRouting(buf(realStatusChangedPayload({ inbox_id: String(INBOX_ID) })));
    expect(routing.inboxId).toBe(INBOX_ID);
  });
});

// ---------------------------------------------------------------------------
// parseWebhookPayload — the conversation identity fields
// ---------------------------------------------------------------------------

describe("parseWebhookPayload — the real conversation shape", () => {
  it("reads conversation id, status and assignee from the FLAT body", () => {
    const payload = parseWebhookPayload(buf(realStatusChangedPayload()));
    expect(payload).not.toBeNull();
    expect(payload?.accountId).toBe(ACCOUNT_ID);
    expect(payload?.inboxId).toBe(INBOX_ID);
    expect(payload?.conversationDisplayId).toBe(CONVERSATION_DISPLAY_ID);
    expect(payload?.conversationStatus).toBe("pending");
    expect(payload?.assignee).toBeNull();
  });

  /**
   * A conversation event carries no message. Reading top-level `id` as a
   * message id would file a conversation display_id as a message id — and
   * idempotency is keyed on message identity.
   */
  it("does NOT report a messageId for a conversation event", () => {
    const payload = parseWebhookPayload(buf(realStatusChangedPayload()));
    expect(payload?.messageId).toBeNull();
    expect(payload?.conversationDisplayId).toBe(CONVERSATION_DISPLAY_ID);
  });

  it("COMPATIBILITY — the nested shape still reports both ids correctly", () => {
    const payload = parseWebhookPayload(buf(messageCreatedPayload()));
    expect(payload?.messageId).toBe(MESSAGE_ID);
    expect(payload?.conversationDisplayId).toBe(CONVERSATION_DISPLAY_ID);
    expect(payload?.conversationStatus).toBe("pending");
  });

  it("reads a top-level assignee object when a human holds the conversation", () => {
    const payload = parseWebhookPayload(
      buf(
        realStatusChangedPayload({
          meta: { assignee: { id: 7, name: "Operator" }, sender: {}, team: null },
        }),
      ),
    );
    expect(payload?.assignee).toEqual({ id: 7, name: "Operator" });
  });

  it("refuses a body whose flat and nested status disagree", () => {
    const payload = parseWebhookPayload(
      buf({
        ...realStatusChangedPayload(),
        status: "pending",
        conversation: { id: CONVERSATION_DISPLAY_ID, status: "resolved" },
      }),
    );
    expect(payload, "same field, two values -> refuse").toBeNull();
  });

  it("refuses an ambiguous inbox even after signature verification", () => {
    const payload = parseWebhookPayload(
      buf(realStatusChangedPayload({ inbox: { id: INBOX_ID + 1 } })),
    );
    expect(payload).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The end this all serves: the handback signal is now recognisable
// ---------------------------------------------------------------------------

describe("the real payload now reaches isManualHandbackSignal", () => {
  it("the REAL body is recognised as the manual handback gesture", () => {
    const payload = parseWebhookPayload(buf(realStatusChangedPayload()));
    expect(payload).not.toBeNull();
    expect(isManualHandbackSignal(payload!)).toBe(true);
  });

  /** The gesture is `pending` specifically. Other status changes are not it. */
  it.each(["open", "resolved", "snoozed"])(
    "a real body reporting %s is NOT the handback gesture",
    (status) => {
      const payload = parseWebhookPayload(buf(realStatusChangedPayload({ status })));
      expect(payload).not.toBeNull();
      expect(isManualHandbackSignal(payload!)).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// HTTP layer — signature validation is preserved, end to end
// ---------------------------------------------------------------------------

describe("POST /v1/chatwoot/agent-bot — the real flat payload over HTTP", () => {
  it("a SIGNED real status-changed body routes as manual_handback_signal, not 422", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: realStatusChangedPayload() }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("manual_handback_signal");
      expect(res.json["outcome"]).not.toBe("unroutable_event");
    } finally {
      await server.close();
    }
  });

  it("SIGNATURE VALIDATION IS PRESERVED — a wrong-secret real body is still 401", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({
          body: realStatusChangedPayload(),
          secret: placeholder("wrong-secret"),
        }),
      );
      expect(res.status).toBe(401);
      expect(res.json["outcome"]).toBe("unauthorized");
    } finally {
      await server.close();
    }
  });

  it("INBOX VALIDATION IS PRESERVED — an unbound flat inbox_id is refused", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: realStatusChangedPayload({ inbox_id: 4242 }) }),
      );
      expect(res.status).not.toBe(200);
    } finally {
      await server.close();
    }
  });

  it("a contradictory body is refused as ambiguous, distinctly from unroutable", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({
          body: realStatusChangedPayload({ inbox: { id: INBOX_ID + 1 } }),
        }),
      );
      expect(res.status).toBe(422);
      await server.gateway.drain();
      const line = capture.lines.find(
        (l) => l["rejectionReason"] === "ambiguous_identifiers",
      );
      expect(
        line,
        "a contradictory body must be logged as ambiguous, not filed under the routine no-identifier case",
      ).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  /** CONTROL: the routine no-identifier event still logs as its own reason. */
  it("CONTROL — an identifier-less event still logs unparseable_body, not ambiguous", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: { event: "contact_updated", id: 1 } }),
      );
      expect(res.status).toBe(422);
      await server.gateway.drain();
      const line = capture.lines.find((l) => l["rejectionReason"] === "unparseable_body");
      expect(line, "the two 422 causes must remain distinguishable").toBeTruthy();
    } finally {
      await server.close();
    }
  });
});
