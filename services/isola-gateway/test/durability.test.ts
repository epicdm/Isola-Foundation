/**
 * The durable-delivery properties.
 *
 * These are the eight behaviours the owner required, proved at the unit level
 * against a ledger double that models the SQL semantics exactly. The deployed
 * proofs against the real Postgres are separate and are recorded in Port; these
 * exist so a regression fails in CI rather than in a customer conversation.
 *
 * The recurring trick is `ledger.survivesRestart()`: a NEW gateway process
 * sharing the SAME durable rows, which is precisely what a container
 * replacement is. The Chatwoot double is shared across the restart too, because
 * Chatwoot does not restart when the gateway does — that is what makes
 * "no second reply" a meaningful assertion rather than an artefact of a fresh
 * stub.
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity, deliveryRef, payloadDigest } from "../src/deliveryref.js";
import { ChatwootApiError } from "../src/errors.js";
import { createSweeper } from "../src/recovery.js";
import {
  ACCOUNT_ID,
  attachmentOnlyPayload,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  INBOX_ID,
  makeBinding,
  messageCreatedPayload,
  MESSAGE_ID,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const IDENTITY = {
  tenantId: TENANT_ID,
  bindingId: bindingIdentity(makeBinding()),
  chatwootAccountId: ACCOUNT_ID,
  chatwootInboxId: INBOX_ID,
  eventId: "delivery:d-1",
};

/**
 * A conversation record shaped exactly like the deployed one: `messages` holds
 * the SINGLE newest message (the partial builds it from
 * `conversation.messages.last`, so it can be an activity line) and
 * `last_non_activity_message` holds the newest real message. Those two fields
 * are all an AgentBot token can see — the messages index is not bot-accessible.
 */
function conversationRecord(
  overrides: { status?: string; assignee?: unknown; content?: string } = {},
): Record<string, unknown> {
  const inbound = {
    id: MESSAGE_ID,
    content: overrides.content ?? "what are your opening hours?",
    content_type: "text",
    message_type: 0,
    private: false,
    created_at: 1_786_459_000,
    sender: { type: "contact", id: 55 },
    attachments: [],
    content_attributes: {},
  };
  return {
    id: CONVERSATION_DISPLAY_ID,
    status: overrides.status ?? "pending",
    meta: { assignee: overrides.assignee ?? null },
    custom_attributes: {},
    messages: [inbound],
    last_non_activity_message: inbound,
  };
}

describe("1. two simultaneous copies of one event", () => {
  it("produce exactly one model run and exactly one reply", async () => {
    const runtime = StubAgentRuntime.answering("Nine to five, Monday to Friday.");
    const server = await startServer({ runtime });
    try {
      const signed = signRequest({ deliveryId: "d-concurrent" });
      // Genuinely concurrent: both requests are in flight before either
      // finishes, so only the ledger's atomic claim can separate them.
      const [a, b] = await Promise.all([
        postWebhook(server.url, signed),
        postWebhook(server.url, signed),
      ]);
      await server.gateway.drain();

      const outcomes = [a.json["outcome"], b.json["outcome"]].sort();
      expect(outcomes).toEqual(["accepted", "duplicate_suppressed"]);
      expect(runtime.requests).toHaveLength(1);
      expect(server.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("2. a duplicate after a gateway restart", () => {
  it("produces no second reply", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    const signed = signRequest({ deliveryId: "d-restart" });

    const first = await startServer({
      ledger,
      chatwoot,
      runtime: StubAgentRuntime.answering("The answer."),
    });
    await postWebhook(first.url, signed);
    await first.gateway.drain();
    await first.close();
    expect(chatwoot.customerMessages).toHaveLength(1);

    // The container is replaced. New process, same ledger, same Chatwoot.
    const runtime = StubAgentRuntime.answering("The answer.");
    const second = await startServer({
      ledger: ledger.survivesRestart(),
      chatwoot,
      runtime,
    });
    try {
      const replay = await postWebhook(second.url, signed);
      await second.gateway.drain();

      expect(replay.json["outcome"]).toBe("duplicate_suppressed");
      expect(runtime.requests).toHaveLength(0);
      // THE property. In-memory de-duplication produced two here.
      expect(chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await second.close();
    }
  });
});

describe("3. a restart after durable enqueue but before processing", () => {
  it("eventually produces exactly one reply, via the recovery sweeper", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    chatwoot.conversationRecord = conversationRecord();
    const runtime = StubAgentRuntime.answering("Nine to five.");
    const logger = new CapturingLogger();
    const config = envConfig();

    // The delivery was acknowledged and the container then died: the row
    // exists, nothing was sent, and Chatwoot will never re-offer it.
    await ledger.reserve({
      identity: IDENTITY,
      digest: "digest-1",
      correlationId: "corr-1",
      conversationId: CONVERSATION_DISPLAY_ID,
      messageId: MESSAGE_ID,
      mode: "answer",
      leaseMs: 60_000,
    });
    expect(chatwoot.customerMessages).toHaveLength(0);

    ledger.expireAllLeases();

    const sweeper = createSweeper({
      config,
      ledger,
      bindingStore: { list: () => [makeBinding()] },
      chatwoot,
      runtime,
      logger: logger.logger,
      now: () => Date.now(),
    });

    expect(await sweeper.sweep()).toBe(1);
    expect(runtime.requests).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);

    // And sweeping again does not answer a second time.
    expect(await sweeper.sweep()).toBe(0);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });

  it("does NOT answer when a human took the conversation over during the outage", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    // Recovery re-reads the CURRENT conversation, not a stale copy.
    chatwoot.conversationRecord = conversationRecord({
      status: "open",
      assignee: { id: 12 },
    });
    const runtime = StubAgentRuntime.answering("should never be sent");
    const logger = new CapturingLogger();

    await ledger.reserve({
      identity: IDENTITY,
      digest: "digest-1",
      correlationId: "corr-1",
      conversationId: CONVERSATION_DISPLAY_ID,
      messageId: MESSAGE_ID,
      mode: "answer",
      leaseMs: 60_000,
    });
    ledger.expireAllLeases();

    const sweeper = createSweeper({
      config: envConfig(),
      ledger,
      bindingStore: { list: () => [makeBinding()] },
      chatwoot,
      runtime,
      logger: logger.logger,
      now: () => Date.now(),
    });
    await sweeper.sweep();

    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
    // `status_not_pending` is evaluated before `human_assigned` — the existing,
    // deliberate predicate order. Either is a correct refusal; what matters is
    // that the resumed delivery was suppressed rather than answered.
    expect(logger.withOutcome("suppressed_on_resume")[0]?.["suppressionReason"]).toBe(
      "status_not_pending",
    );
  });

  it("does NOT answer when the conversation is merely assigned to a human", async () => {
    // The other half of the takeover case: still `pending`, but owned.
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    chatwoot.conversationRecord = conversationRecord({
      status: "pending",
      assignee: { id: 12 },
    });
    const runtime = StubAgentRuntime.answering("should never be sent");
    const logger = new CapturingLogger();

    await ledger.reserve({
      identity: IDENTITY,
      digest: "digest-1",
      correlationId: "corr-1",
      conversationId: CONVERSATION_DISPLAY_ID,
      messageId: MESSAGE_ID,
      mode: "answer",
      leaseMs: 60_000,
    });
    ledger.expireAllLeases();

    await createSweeper({
      config: envConfig(),
      ledger,
      bindingStore: { list: () => [makeBinding()] },
      chatwoot,
      runtime,
      logger: logger.logger,
      now: () => Date.now(),
    }).sweep();

    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(logger.withOutcome("suppressed_on_resume")[0]?.["suppressionReason"]).toBe(
      "human_assigned",
    );
  });
});

describe("4. a failure after Chatwoot commits but before the ledger completes", () => {
  it("reconciles and does not send a second message", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    // Chatwoot commits the message and THEN the response is lost. This is the
    // ambiguity that cannot be distinguished from a real failure at the client.
    chatwoot.commitDespiteFailure = true;
    chatwoot.postMessageFailure = new ChatwootApiError("connection reset", null);

    const server = await startServer({
      ledger,
      chatwoot,
      runtime: StubAgentRuntime.answering("Nine to five."),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: "d-lost-response" }));
      await server.gateway.drain();

      // Exactly one public message physically posted, and the pipeline
      // recognised it rather than treating the throw as "not delivered".
      expect(chatwoot.customerMessages).toHaveLength(1);
      const reconciles = chatwoot.calls.filter((c) => c.kind === "reconcile");
      expect(reconciles.length).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("fails CLOSED and sends nothing when reconciliation cannot prove absence", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.postMessageFailure = new ChatwootApiError("call timed out", null);
    chatwoot.reconcileInconclusive = true;
    const logger = new CapturingLogger();

    const server = await startServer({
      chatwoot,
      logger: logger.logger,
      runtime: StubAgentRuntime.answering("Nine to five."),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: "d-unresolved" }));
      await server.gateway.drain();

      // One attempt, never a second. Nothing is re-sent on an unproven state.
      expect(chatwoot.customerMessages).toHaveLength(1);
      const alerts = logger.lines.filter((l) => l["alert"] === true);
      expect(alerts.map((a) => a["alertCode"])).toContain("delivery_state_unresolved");
      expect(logger.withOutcome("reply_unresolved")[0]?.["needsRetry"]).toBe(true);
    } finally {
      await server.close();
    }
  });
});

describe("5. ledger unavailability before acknowledgment", () => {
  it("returns a retryable failure, never a false success", async () => {
    const ledger = new FakeLedger();
    ledger.unavailable = true;
    const chatwoot = new StubChatwootApi();
    const runtime = StubAgentRuntime.answering("never reached");
    const logger = new CapturingLogger();

    const server = await startServer({ ledger, chatwoot, runtime, logger: logger.logger });
    try {
      const res = await postWebhook(server.url, signRequest({ deliveryId: "d-no-ledger" }));

      // 500 specifically: Chatwoot v4.16.1 retries an agent-bot webhook on 429
      // and 500 ONLY, so any other status would lose the delivery silently.
      expect(res.status).toBe(500);
      expect(res.json["outcome"]).toBe("ledger_unavailable");
      expect(res.json["ok"]).toBe(false);

      await server.gateway.drain();
      // Nothing was said to anybody.
      expect(chatwoot.calls).toHaveLength(0);
      expect(runtime.requests).toHaveLength(0);

      const alerts = logger.lines.filter((l) => l["alert"] === true);
      expect(alerts.map((a) => a["alertCode"])).toContain("ledger_unavailable_on_ack");
    } finally {
      await server.close();
    }
  });
});

describe("6. the same event id with a different payload digest", () => {
  it("is denied as a conflict and processed by nobody", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    const runtime = StubAgentRuntime.answering("The answer.");
    const logger = new CapturingLogger();

    const server = await startServer({ ledger, chatwoot, runtime, logger: logger.logger });
    try {
      const first = await postWebhook(
        server.url,
        signRequest({ body: messageCreatedPayload(), deliveryId: "d-conflict" }),
      );
      expect(first.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      // Same delivery id, DIFFERENT body — and correctly signed, so this is
      // not a signature failure. Only the digest check can catch it.
      const second = await postWebhook(
        server.url,
        signRequest({
          body: messageCreatedPayload({ content: "a completely different question" }),
          deliveryId: "d-conflict",
        }),
      );
      await server.gateway.drain();

      expect(second.status).toBe(409);
      expect(second.json["outcome"]).toBe("ledger_conflict");
      expect(runtime.requests).toHaveLength(1);
      expect(chatwoot.customerMessages).toHaveLength(1);

      const alert = logger.lines.find((l) => l["alertCode"] === "delivery_digest_conflict");
      expect(alert).toBeDefined();
      // Digests are logged; neither body is.
      expect(JSON.stringify(logger.lines)).not.toContain("a completely different question");
    } finally {
      await server.close();
    }
  });
});

describe("7. attachment and empty-message handoffs across a restart", () => {
  it("do not duplicate the private note, the assignment or the acknowledgement", async () => {
    const ledger = new FakeLedger();
    const chatwoot = new StubChatwootApi();
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: JSON.stringify([makeBinding({ escalationTeamId: 5 })]),
    });
    const signed = signRequest({
      body: attachmentOnlyPayload(["image"]),
      deliveryId: "d-handoff-restart",
    });

    const first = await startServer({ ledger, chatwoot, config });
    await postWebhook(first.url, signed);
    await first.gateway.drain();
    await first.close();

    const notesAfterFirst = chatwoot.privateNotes.length;
    const acksAfterFirst = chatwoot.customerMessages.length;
    const assignmentsAfterFirst = chatwoot.assignments.length;
    expect(notesAfterFirst).toBe(1);
    expect(acksAfterFirst).toBe(1);
    expect(assignmentsAfterFirst).toBe(1);

    const second = await startServer({
      ledger: ledger.survivesRestart(),
      chatwoot,
      config,
    });
    try {
      await postWebhook(second.url, signed);
      await second.gateway.drain();

      expect(chatwoot.privateNotes).toHaveLength(notesAfterFirst);
      expect(chatwoot.customerMessages).toHaveLength(acksAfterFirst);
      expect(chatwoot.assignments).toHaveLength(assignmentsAfterFirst);
    } finally {
      await second.close();
    }
  });
});

describe("8. the deterministic delivery reference", () => {
  it("is stamped in content_attributes and never in the customer-visible text", async () => {
    const server = await startServer({
      runtime: StubAgentRuntime.answering("Nine to five, Monday to Friday."),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: "d-ref" }));
      await server.gateway.drain();

      const reply = server.chatwoot.customerMessages[0];
      expect(reply?.deliveryRef).toBeTruthy();
      expect(reply?.deliveryRef).toMatch(/^isola-[0-9a-f]{32}$/);
      // The reference must never leak into what the customer reads.
      expect(reply?.content).toBe("Nine to five, Monday to Friday.");
      expect(reply?.content).not.toContain(reply?.deliveryRef as string);
    } finally {
      await server.close();
    }
  });

  it("is deterministic per (identity, action) and differs across actions", () => {
    expect(deliveryRef(IDENTITY, "reply")).toBe(deliveryRef(IDENTITY, "reply"));
    expect(deliveryRef(IDENTITY, "reply")).not.toBe(deliveryRef(IDENTITY, "failure_note"));
    // A different tenant on identical routing gets a different reference, so
    // one tenant can never reconcile against another's message.
    expect(deliveryRef({ ...IDENTITY, tenantId: "other" }, "reply")).not.toBe(
      deliveryRef(IDENTITY, "reply"),
    );
  });

  it("is a pure digest: nothing about the tenant or the event is readable in it", () => {
    const ref = deliveryRef(IDENTITY, "reply");
    // The whole value after the prefix is hex, so no identifier, no tenant
    // name, no event id and no secret can be recovered by reading it.
    expect(ref).toMatch(/^isola-[0-9a-f]{32}$/);
    expect(ref).not.toContain(TENANT_ID);
    expect(ref).not.toContain(IDENTITY.eventId);
    expect(ref.length).toBe(38);
  });
});

describe("the payload digest", () => {
  it("is a sha256 of the raw bytes, so a one-byte change is a different digest", () => {
    const a = payloadDigest(Buffer.from('{"a":1}', "utf8"));
    const b = payloadDigest(Buffer.from('{"a":2}', "utf8"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(payloadDigest(Buffer.from('{"a":1}', "utf8"))).toBe(a);
  });
});
