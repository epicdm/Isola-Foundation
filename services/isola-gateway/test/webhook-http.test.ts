/**
 * The webhook endpoint end to end, over a real socket, with stubbed upstreams.
 *
 * The dominant constraint under test here is Chatwoot's 5-second webhook
 * open/read timeout: the ACK must come back well inside it even when the
 * runtime is slow.
 */
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ID,
  attachmentOnlyPayload,
  BOT_SECRET,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  bindingsJson,
  StubChatwootApi,
  envConfig,
  makeBinding,
  messageCreatedPayload,
  placeholder,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
} from "./harness.js";

describe("POST /v1/chatwoot/agent-bot — authentication", () => {
  it("accepts a correctly signed delivery", async () => {
    const server = await startServer();
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      expect(res.correlationHeader).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  const rejected: Array<[string, () => ReturnType<typeof signRequest>, string]> = [
    [
      "a signature made with the wrong secret",
      () => signRequest({ secret: placeholder("wrong-secret") }),
      "signature_mismatch",
    ],
    [
      "a missing signature header",
      () => signRequest({ signatureHeader: null }),
      "signature_header_missing",
    ],
    [
      "a malformed signature header",
      () => signRequest({ signatureHeader: "garbage" }),
      "signature_header_malformed",
    ],
    [
      "a missing timestamp header",
      () => signRequest({ timestampHeader: null }),
      "timestamp_header_missing",
    ],
    [
      "a stale timestamp in the past",
      () => signRequest({ timestamp: Math.floor(Date.now() / 1000) - 600 }),
      "timestamp_too_old",
    ],
    [
      "a timestamp in the future",
      () => signRequest({ timestamp: Math.floor(Date.now() / 1000) + 600 }),
      "timestamp_in_future",
    ],
  ];

  /**
   * An unroutable body is NOT an authentication failure and must not answer as
   * though it were.
   *
   * Chatwoot routinely sends events that carry no inbox — entity events that
   * are not about an inbox at all. Answering 401 to those made a normal,
   * expected event indistinguishable in the logs from a genuine signature
   * failure, which poisons the one alarm worth trusting. It is decided before
   * any secret is consulted, so 422 leaks nothing: the caller already knows the
   * shape of the body it sent.
   */
  it("answers 422, not 401, for a body with no routable account/inbox", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(server.url, signRequest({ rawBody: "not json at all" }));
      expect(res.status).toBe(422);
      expect(res.json["outcome"]).toBe("unroutable_event");
      // Still no oracle: the response says nothing about secrets or inboxes.
      expect(res.text).not.toContain("signature");
      expect(res.text).not.toContain("secret");
      // The server-side log still records exactly what happened.
      expect(
        capture.lines.some((l) => l["rejectionReason"] === "unparseable_body"),
      ).toBe(true);
    } finally {
      await server.close();
    }
  });

  for (const [label, build, expectedReason] of rejected) {
    it(`rejects ${label} with 401 and never says why`, async () => {
      const capture = new CapturingLogger();
      const server = await startServer({ logger: capture.logger });
      try {
        const res = await postWebhook(server.url, build());
        expect(res.status).toBe(401);
        expect(res.json["outcome"]).toBe("unauthorized");
        // The response must not leak which half failed.
        expect(res.text).not.toContain(expectedReason);
        // The server-side log must say exactly which half failed.
        const line = capture.lines.find((l) => l["event"] === "webhook");
        expect(line?.["rejectionReason"]).toBe(expectedReason);
        expect(server.chatwoot.calls).toEqual([]);
      } finally {
        await server.close();
      }
    });
  }

  it("rejects a delivery for an inbox with no binding at all", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({
          body: messageCreatedPayload({ inbox: { id: 999 } }),
        }),
      );
      expect(res.status).toBe(401);
      const line = capture.lines.find((l) => l["event"] === "webhook");
      expect(line?.["rejectionReason"]).toBe("no_binding_secret");
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("re-serialised JSON does not verify, even though it parses identically", async () => {
    const server = await startServer();
    try {
      const rawBody = JSON.stringify(messageCreatedPayload()).replace(/,"/g, ',  "');
      const signed = signRequest({ rawBody });
      // Same signature, semantically identical body, different bytes.
      const reparsed = JSON.stringify(JSON.parse(rawBody));
      expect(JSON.parse(reparsed)).toEqual(JSON.parse(rawBody));

      const good = await postWebhook(server.url, signed);
      expect(good.status).toBe(200);

      const bad = await postWebhook(server.url, {
        raw: reparsed,
        headers: { ...signed.headers, "x-chatwoot-delivery": "a-different-delivery-id" },
      });
      expect(bad.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("POST /v1/chatwoot/agent-bot — idempotency", () => {
  it("a repeated delivery id returns 200 and sends nothing", async () => {
    const server = await startServer();
    try {
      const signed = signRequest({ deliveryId: "delivery-abc" });
      const first = await postWebhook(server.url, signed);
      expect(first.json["outcome"]).toBe("accepted");
      await server.gateway.drain();
      const sentAfterFirst = server.chatwoot.calls.length;
      expect(sentAfterFirst).toBeGreaterThan(0);

      const second = await postWebhook(server.url, signed);
      expect(second.status).toBe(200);
      expect(second.json["outcome"]).toBe("duplicate_suppressed");
      await server.gateway.drain();
      expect(server.chatwoot.calls.length).toBe(sentAfterFirst);
      expect((server.runtime as StubAgentRuntime).requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("falls back to (account, conversation, message, event) with no delivery header", async () => {
    const server = await startServer();
    try {
      const first = await postWebhook(server.url, signRequest({ deliveryId: null }));
      expect(first.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      const second = await postWebhook(server.url, signRequest({ deliveryId: null }));
      expect(second.json["outcome"]).toBe("duplicate_suppressed");
      await server.gateway.drain();
      expect((server.runtime as StubAgentRuntime).requests).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("POST /v1/chatwoot/agent-bot — binding refusal", () => {
  it("refuses a retired binding: 200, nothing sent", async () => {
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ status: "retired" })]),
    });
    const server = await startServer({ config });
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("binding_retired");
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
      expect((server.runtime as StubAgentRuntime).requests).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("an INTERNAL binding REFUSES a sender who is not on its allowlist", async () => {
    // THE END-TO-END SHAPE OF THE STAFF GATE. The brain is never invoked, no
    // content is recorded, and the stranger gets exactly one static line.
    const { StaticBindingStore } = await import("../src/bindings.js");
    const internal = {
      ...makeBinding(),
      exposure: "INTERNAL" as const,
      allowedSenders: ["+1 767 555-0101"],
    };
    const server = await startServer({
      bindingStore: new StaticBindingStore([internal]),
    });
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("rejected_sender");
      await server.gateway.drain();
      // THE BRAIN IS NEVER REACHED. This is the assertion that matters: a
      // stranger must not cost a token or wake an agent holding internal
      // context.
      expect((server.runtime as StubAgentRuntime).requests).toEqual([]);
      // Exactly one outbound call: the static refusal.
      expect(server.chatwoot.calls).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("refuses a duplicate binding", async () => {
    const { StaticBindingStore } = await import("../src/bindings.js");
    const server = await startServer({
      bindingStore: new StaticBindingStore([
        makeBinding(),
        makeBinding({ tenantId: "tenant-other" }),
      ]),
    });
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("binding_duplicate");
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("POST /v1/chatwoot/agent-bot — suppression", () => {
  const cases: Array<[string, Parameters<typeof messageCreatedPayload>[0], string]> = [
    [
      "a human is assigned",
      {
        conversation: {
          id: CONVERSATION_DISPLAY_ID,
          status: "pending",
          meta: { assignee: { id: 12 } },
          custom_attributes: {},
        },
      },
      "human_assigned",
    ],
    [
      "the conversation is already open",
      {
        conversation: {
          id: CONVERSATION_DISPLAY_ID,
          status: "open",
          meta: { assignee: null },
          custom_attributes: {},
        },
      },
      "status_not_pending",
    ],
    ["the message is outgoing", { message_type: "outgoing" }, "message_type_not_incoming"],
    ["the message is a private note", { private: true }, "private_note"],
    ["the sender is the bot itself", { sender: { type: "agent_bot" } }, "sender_is_agent_bot"],
    ["the event is not message_created", { event: "message_updated" }, "not_message_created"],
  ];

  for (const [label, overrides, reason] of cases) {
    it(`sends nothing when ${label}`, async () => {
      const server = await startServer();
      try {
        const res = await postWebhook(
          server.url,
          signRequest({ body: messageCreatedPayload(overrides) }),
        );
        expect(res.status).toBe(200);
        expect(res.json["outcome"]).toBe("suppressed");
        expect(res.json["suppressionReason"]).toBe(reason);
        await server.gateway.drain();
        expect(server.chatwoot.calls).toEqual([]);
        expect((server.runtime as StubAgentRuntime).requests).toEqual([]);
      } finally {
        await server.close();
      }
    });
  }
});

describe("POST /v1/chatwoot/agent-bot — the 5 second rule", () => {
  it("ACKs 200 well inside 5s even when the runtime takes 2s", async () => {
    const runtime = StubAgentRuntime.slow(2000, "A slow but valid answer.");
    const server = await startServer({ runtime });
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      // Chatwoot's open/read timeout is 5000ms. This must not be close.
      expect(res.latencyMs).toBeLessThan(1000);
      // The reply has NOT been sent yet: the work is genuinely asynchronous.
      expect(server.chatwoot.customerMessages).toHaveLength(0);

      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 10_000);

  it("ACKs with zero Chatwoot calls made on the handoff path too", async () => {
    // The handoff is four Chatwoot round trips — open, assign, note, ack. None
    // of them may happen before the 200 is written.
    const chatwoot = new StubChatwootApi();
    chatwoot.callDelayMs = 400;
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ escalationTeamId: 5 })]),
    });
    const server = await startServer({ chatwoot, config });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image"]) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      expect(res.latencyMs).toBeLessThan(1000);
      expect(server.chatwoot.calls).toEqual([]);
      expect((server.runtime as StubAgentRuntime).requests).toEqual([]);

      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(1);
      // Still never invoked, even after the whole handoff has run.
      expect((server.runtime as StubAgentRuntime).requests).toEqual([]);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe("the binding rules are unchanged on the handoff path", () => {
  it("an unknown inbox is still 401, even for an attachment-only message", async () => {
    const server = await startServer();
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image"], { inbox: { id: 999 } }) }),
      );
      expect(res.status).toBe(401);
      expect(res.json["outcome"]).toBe("unauthorized");
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a retired binding is still 200-and-nothing, even for an attachment-only message", async () => {
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ status: "retired" })]),
    });
    const server = await startServer({ config });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image"]) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("binding_retired");
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("an INTERNAL binding is still 200-and-nothing, even for an attachment-only message", async () => {
    const { StaticBindingStore } = await import("../src/bindings.js");
    const server = await startServer({
      bindingStore: new StaticBindingStore([
        { ...makeBinding(), exposure: "INTERNAL" as const, allowedSenders: [] },
      ]),
    });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image"]) }),
      );
      expect(res.status).toBe(200);
      // An EMPTY allowlist refuses everyone — fail-closed means fail-closed.
      expect(res.json["outcome"]).toBe("rejected_sender");
      await server.gateway.drain();
    } finally {
      await server.close();
    }
  });

  it("a bad signature on an attachment-only message is still 401", async () => {
    const server = await startServer();
    try {
      const res = await postWebhook(
        server.url,
        signRequest({
          body: attachmentOnlyPayload(["image"]),
          secret: placeholder("wrong-secret"),
        }),
      );
      expect(res.status).toBe(401);
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("routing", () => {
  it("405s a GET on the webhook path and 404s an unknown path", async () => {
    const server = await startServer();
    try {
      const bad = await fetch(`${server.url}/v1/chatwoot/agent-bot`);
      expect(bad.status).toBe(405);
      const missing = await fetch(`${server.url}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it("413s an oversized body without parsing it", async () => {
    const config = envConfig({ GATEWAY_MAX_REQUEST_BYTES: "64" });
    const server = await startServer({ config });
    try {
      const signed = signRequest({
        body: messageCreatedPayload({ content: "x".repeat(5000) }),
      });
      const res = await postWebhook(server.url, signed);
      expect(res.status).toBe(413);
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

describe("the binding actually used", () => {
  it("addresses the reply with that binding's account, conversation and access token", async () => {
    const server = await startServer();
    try {
      await postWebhook(server.url, signRequest());
      await server.gateway.drain();
      const message = server.chatwoot.customerMessages[0];
      expect(message?.accountId).toBe(ACCOUNT_ID);
      expect(message?.conversationId).toBe(CONVERSATION_DISPLAY_ID);
      expect(message?.accessToken).toBe(makeBinding().agentBotAccessToken);
      expect(BOT_SECRET).not.toBe(makeBinding().agentBotAccessToken);
    } finally {
      await server.close();
    }
  });
});
