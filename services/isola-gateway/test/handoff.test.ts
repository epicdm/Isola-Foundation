/**
 * The no-usable-text handoff.
 *
 * The rule these tests exist to protect: a verified incoming customer message
 * that carries no text the AI can read is never silently dropped, the model is
 * never invoked to look at it, the attachment is never fetched, and the customer
 * is told a human has it ONLY when a human actually has it.
 */
import { describe, expect, it } from "vitest";

import { ChatwootApiError } from "../src/errors.js";
import {
  ATTACHMENT_ACKNOWLEDGEMENT,
  customerAcknowledgement,
  EMPTY_MESSAGE_ACKNOWLEDGEMENT,
  renderHandoffBlockedNote,
  renderHandoffNote,
  summariseAttachments,
} from "../src/handoff.js";
import { MemoryIdempotencyStore, writeKey } from "../src/idempotency.js";
import {
  classifyNoText,
  hasUsableText,
  parseWebhookPayload,
  readAttachmentType,
  readAttachmentTypes,
  readContentType,
  UNKNOWN_ATTACHMENT_TYPE,
} from "../src/webhook.js";
import {
  ACCOUNT_ID,
  ATTACHMENT_FILE_NAME,
  ATTACHMENT_HOST,
  ATTACHMENT_URL,
  attachmentOnlyPayload,
  bindingsJson,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  emptyMessagePayload,
  envConfig,
  makeBinding,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startRealClientServer,
  startServer,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const TEAM_ID = 5;

function payloadFrom(body: Record<string, unknown>) {
  const parsed = parseWebhookPayload(Buffer.from(JSON.stringify(body), "utf8"));
  if (parsed === null) throw new Error("fixture did not parse");
  return parsed;
}

/** A binding with an escalation team, which is the configured-team case. */
function withTeamConfig() {
  return envConfig({
    GATEWAY_BINDINGS_JSON: bindingsJson([makeBinding({ escalationTeamId: TEAM_ID })]),
  });
}

interface RunArgs {
  body: Record<string, unknown>;
  chatwoot?: StubChatwootApi;
  config?: ReturnType<typeof envConfig>;
  runtime?: StubAgentRuntime;
  logger?: CapturingLogger;
  deliveryId?: string;
}

async function run(args: RunArgs) {
  const logger = args.logger ?? new CapturingLogger();
  const runtime = args.runtime ?? StubAgentRuntime.answering("should never be used");
  const server = await startServer({
    ...(args.chatwoot === undefined ? {} : { chatwoot: args.chatwoot }),
    ...(args.config === undefined ? {} : { config: args.config }),
    runtime,
    logger: logger.logger,
  });
  const res = await postWebhook(
    server.url,
    signRequest({ body: args.body, ...(args.deliveryId ? { deliveryId: args.deliveryId } : {}) }),
  );
  await server.gateway.drain();
  const chatwoot = server.chatwoot;
  await server.close();
  return { res, chatwoot, runtime, logger };
}

// ---------------------------------------------------------------------------
// Classification — pure, no HTTP
// ---------------------------------------------------------------------------

describe("classification of a message with no usable text", () => {
  it("is not a handoff when there IS usable text", () => {
    expect(hasUsableText(payloadFrom(messageCreatedPayload()))).toBe(true);
    expect(hasUsableText(payloadFrom(messageCreatedPayload({ content: "  \n " })))).toBe(false);
    expect(hasUsableText(payloadFrom(messageCreatedPayload({ content: null })))).toBe(false);
  });

  it("classifies attachments as the attachment case, with type and count", () => {
    const classification = classifyNoText(
      payloadFrom(attachmentOnlyPayload(["image", "file", "image"])),
    );
    expect(classification.reason).toBe("attachment_or_unsupported_content");
    expect(classification.attachmentCount).toBe(3);
    expect(classification.attachmentTypes).toEqual(["image", "file", "image"]);
  });

  it("classifies a non-text content_type as the attachment case even with no attachments", () => {
    const classification = classifyNoText(
      payloadFrom(messageCreatedPayload({ content: null, content_type: "location" })),
    );
    expect(classification.reason).toBe("attachment_or_unsupported_content");
    expect(classification.attachmentCount).toBe(0);
  });

  it("classifies a truly empty message as the empty case", () => {
    const classification = classifyNoText(payloadFrom(emptyMessagePayload()));
    expect(classification.reason).toBe("empty_message");
    expect(classification.attachmentCount).toBe(0);
    expect(classification.attachmentTypes).toEqual([]);
  });

  it("maps an unknown file_type onto a closed vocabulary rather than carrying it", () => {
    // The defence that makes it safe to print an attachment type: an attacker
    // cannot get arbitrary text — a filename, a URL — into a note or a log.
    expect(readAttachmentType("image")).toBe("image");
    expect(readAttachmentType("IMAGE")).toBe("image");
    expect(readAttachmentType(0)).toBe("image");
    expect(readAttachmentType(3)).toBe("file");
    expect(readAttachmentType(ATTACHMENT_URL)).toBe(UNKNOWN_ATTACHMENT_TYPE);
    expect(readAttachmentType(ATTACHMENT_FILE_NAME)).toBe(UNKNOWN_ATTACHMENT_TYPE);
    expect(readAttachmentType(null)).toBe(UNKNOWN_ATTACHMENT_TYPE);
    expect(readAttachmentTypes("not an array")).toEqual([]);
    expect(readContentType("location")).toBe("location");
    expect(readContentType(ATTACHMENT_URL)).toBe(UNKNOWN_ATTACHMENT_TYPE);
    expect(readContentType(null)).toBeNull();
  });

  it("parsing keeps NO attachment url and NO filename anywhere in the payload", () => {
    const parsed = payloadFrom(attachmentOnlyPayload(["image", "file"]));
    const serialised = JSON.stringify(parsed);
    expect(serialised).not.toContain(ATTACHMENT_URL);
    expect(serialised).not.toContain(ATTACHMENT_HOST);
    expect(serialised).not.toContain(ATTACHMENT_FILE_NAME);
  });
});

// ---------------------------------------------------------------------------
// The verbatim customer strings
// ---------------------------------------------------------------------------

describe("the customer-visible strings", () => {
  it("are exactly the two the owner specified, byte for byte", () => {
    // Built from escapes so this assertion proves the SOURCE bytes: an em dash
    // (U+2014) in the attachment string, and an ASCII apostrophe (U+0027) in
    // "couldn't" — not a typographic one.
    expect(ATTACHMENT_ACKNOWLEDGEMENT).toBe(
      "Thanks — I received your attachment and passed this conversation to a team member for review.",
    );
    expect(EMPTY_MESSAGE_ACKNOWLEDGEMENT).toBe(
      "I couldn't read that message, so I passed the conversation to a team member.",
    );
    expect(EMPTY_MESSAGE_ACKNOWLEDGEMENT).not.toContain("’");
    expect(customerAcknowledgement("attachment_or_unsupported_content")).toBe(
      ATTACHMENT_ACKNOWLEDGEMENT,
    );
    expect(customerAcknowledgement("empty_message")).toBe(EMPTY_MESSAGE_ACKNOWLEDGEMENT);
  });
});

describe("the private note", () => {
  const classification = {
    reason: "attachment_or_unsupported_content" as const,
    attachmentCount: 3,
    attachmentTypes: ["image", "file", "image"],
    contentType: "text",
  };

  it("states the type and the count, and nothing else about the attachment", () => {
    expect(summariseAttachments(["image", "file", "image"])).toBe("file x1, image x2");
    expect(summariseAttachments([])).toBe("none");
    const note = renderHandoffNote({
      classification,
      correlationId: "corr-1",
      tenantId: TENANT_ID,
      assignedTeamId: TEAM_ID,
    });
    expect(note).toContain("image x2");
    expect(note).toContain("file x1");
    expect(note).toContain("3");
    expect(note).toContain("corr-1");
    expect(note).toContain(TENANT_ID);
    expect(note).not.toContain(ATTACHMENT_URL);
    expect(note).not.toContain(ATTACHMENT_FILE_NAME);
    expect(note).not.toContain(ATTACHMENT_HOST);
  });

  it("says plainly, when the handoff was blocked, that the customer was told nothing", () => {
    const note = renderHandoffBlockedNote({
      classification,
      correlationId: "corr-1",
      tenantId: TENANT_ID,
      assignedTeamId: TEAM_ID,
      failedStep: "toggle_status",
    });
    expect(note).toContain("No message was sent to the customer");
    expect(note).toContain("toggle_status");
    expect(note).not.toContain(ATTACHMENT_URL);
  });
});

// ---------------------------------------------------------------------------
// Case A — attachment or unsupported content
// ---------------------------------------------------------------------------

describe("Case A — an attachment-only message", () => {
  it("opens, assigns, notes once, and only then sends the exact attachment wording", async () => {
    const { chatwoot, res } = await run({
      body: attachmentOnlyPayload(["image"]),
      config: withTeamConfig(),
    });

    expect(res.status).toBe(200);
    expect(res.json["outcome"]).toBe("accepted");

    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(chatwoot.assignments).toHaveLength(1);
    expect(chatwoot.assignments[0]?.teamId).toBe(TEAM_ID);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.customerMessages[0]?.content).toBe(ATTACHMENT_ACKNOWLEDGEMENT);

    // The canonical order: open, assign, note, and the customer message LAST.
    const kinds = chatwoot.calls.map((c) =>
      c.kind === "message" ? (c.private === true ? "note" : "customer") : c.kind,
    );
    expect(kinds.indexOf("toggle_status")).toBeLessThan(kinds.indexOf("assignment"));
    expect(kinds.indexOf("assignment")).toBeLessThan(kinds.indexOf("note"));
    expect(kinds.indexOf("note")).toBeLessThan(kinds.indexOf("customer"));
  });

  it("hands off with no assignment when no escalation team is configured", async () => {
    const { chatwoot } = await run({ body: attachmentOnlyPayload(["file"]) });
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(chatwoot.assignments).toHaveLength(0);
    expect(chatwoot.customerMessages[0]?.content).toBe(ATTACHMENT_ACKNOWLEDGEMENT);
  });

  it("uses the attachment wording for unsupported non-text content too", async () => {
    const { chatwoot } = await run({
      body: messageCreatedPayload({ content: null, content_type: "location" }),
    });
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.customerMessages[0]?.content).toBe(ATTACHMENT_ACKNOWLEDGEMENT);
  });

  it("NEVER invokes the model, and never mentions the attachment beyond type and count", async () => {
    const runtime = StubAgentRuntime.answering("the model must not run");
    const { chatwoot } = await run({
      body: attachmentOnlyPayload(["image", "image"]),
      runtime,
      config: withTeamConfig(),
    });
    expect(runtime.requests).toHaveLength(0);

    const everythingWritten = chatwoot.calls.map((c) => c.content ?? "").join("\n");
    expect(everythingWritten).not.toContain(ATTACHMENT_URL);
    expect(everythingWritten).not.toContain(ATTACHMENT_HOST);
    expect(everythingWritten).not.toContain(ATTACHMENT_FILE_NAME);
    expect(chatwoot.privateNotes[0]?.content).toContain("image x2");
  });

  it("labels and attributes the conversation as handed_off", async () => {
    const { chatwoot } = await run({ body: attachmentOnlyPayload() });
    expect(chatwoot.labelWrites[0]?.labels).toContain("isola-ai-escalated");
    expect(chatwoot.attributeWrites[0]?.attributes?.["isola_last_outcome"]).toBe("handed_off");
  });
});

// ---------------------------------------------------------------------------
// Case B — a truly empty message
// ---------------------------------------------------------------------------

describe("Case B — a truly empty message", () => {
  it("runs the same handoff and sends the exact empty wording", async () => {
    const { chatwoot } = await run({
      body: emptyMessagePayload(),
      config: withTeamConfig(),
    });
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(chatwoot.assignments).toHaveLength(1);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(chatwoot.customerMessages[0]?.content).toBe(EMPTY_MESSAGE_ACKNOWLEDGEMENT);
  });

  it("NEVER invokes the model", async () => {
    const runtime = StubAgentRuntime.answering("the model must not run");
    await run({ body: emptyMessagePayload(), runtime });
    expect(runtime.requests).toHaveLength(0);
  });

  it("treats a null content with no attachments as the empty case", async () => {
    const { chatwoot } = await run({ body: messageCreatedPayload({ content: null }) });
    expect(chatwoot.customerMessages[0]?.content).toBe(EMPTY_MESSAGE_ACKNOWLEDGEMENT);
  });
});

// ---------------------------------------------------------------------------
// Honesty: the customer message comes last, and only if the handoff worked
// ---------------------------------------------------------------------------

describe("a failed handoff tells the customer NOTHING", () => {
  it("sends no customer message when toggle_status fails", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.openConversationFailure = new ChatwootApiError("returned HTTP 500", 500);
    const logger = new CapturingLogger();
    const { chatwoot: after } = await run({
      body: attachmentOnlyPayload(),
      chatwoot,
      logger,
      config: withTeamConfig(),
    });

    expect(after.customerMessages).toHaveLength(0);
    // Never assigned either: the sequence stops at the first failure.
    expect(after.assignments).toHaveLength(0);

    const line = logger.withOutcome("handoff_blocked")[0];
    expect(line).toBeDefined();
    expect(line?.["level"]).toBe("error");
    expect(line?.["failedStep"]).toBe("toggle_status");
    expect(line?.["customerMessageSent"]).toBe(false);
    expect(line?.["needsRetry"]).toBe(true);
  });

  it("sends no customer message when the assignment fails", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.assignTeamFailure = new ChatwootApiError("returned HTTP 404", 404);
    const logger = new CapturingLogger();
    const { chatwoot: after } = await run({
      body: attachmentOnlyPayload(),
      chatwoot,
      logger,
      config: withTeamConfig(),
    });

    expect(after.customerMessages).toHaveLength(0);
    // The conversation is LEFT OPEN where that succeeded — not rolled back.
    expect(after.statusToggles).toHaveLength(1);

    const line = logger.withOutcome("handoff_blocked")[0];
    expect(line?.["level"]).toBe("error");
    expect(line?.["failedStep"]).toBe("assignment");
  });

  it("records the blockage as a private note and surfaces it for retry", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.openConversationFailure = new ChatwootApiError("returned HTTP 500", 500);
    const { chatwoot: after } = await run({
      body: emptyMessagePayload(),
      chatwoot,
      config: withTeamConfig(),
    });
    expect(after.privateNotes).toHaveLength(1);
    expect(after.privateNotes[0]?.content).toContain("No message was sent to the customer");
    expect(after.attributeWrites[0]?.attributes?.["isola_last_outcome"]).toBe(
      "handoff_blocked",
    );
  });

  it("never re-sends the acknowledgement when it fails", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.postMessageFailure = new ChatwootApiError("returned HTTP 502", 502);
    const logger = new CapturingLogger();
    const { chatwoot: after } = await run({
      body: attachmentOnlyPayload(),
      chatwoot,
      logger,
    });
    // One attempt, which threw. No retry.
    expect(after.customerMessages).toHaveLength(1);
    const line = logger.withOutcome("handoff_ack_failed")[0];
    expect(line?.["level"]).toBe("error");
    expect(line?.["customerMessageSent"]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("idempotency by the Chatwoot delivery id", () => {
  it("a duplicate delivery produces exactly one note, one assignment and one customer message", async () => {
    const config = withTeamConfig();
    const logger = new CapturingLogger();
    const server = await startServer({ config, logger: logger.logger });
    try {
      const signed = signRequest({
        body: attachmentOnlyPayload(["image"]),
        deliveryId: "delivery-handoff-1",
      });

      const first = await postWebhook(server.url, signed);
      expect(first.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      const second = await postWebhook(server.url, signed);
      expect(second.status).toBe(200);
      expect(second.json["outcome"]).toBe("duplicate_suppressed");
      await server.gateway.drain();

      expect(server.chatwoot.privateNotes).toHaveLength(1);
      expect(server.chatwoot.assignments).toHaveLength(1);
      expect(server.chatwoot.customerMessages).toHaveLength(1);
      expect(server.chatwoot.statusToggles).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("the per-write guard is the SAME store, keyed under the delivery key", async () => {
    // The second line of defence: even if a duplicate ever reached the
    // pipeline, each individual write is claimed beneath the delivery key.
    const store = new MemoryIdempotencyStore({ ttlMs: 60_000, maxEntries: 100 });
    const config = withTeamConfig();
    const server = await startServer({ config, idempotency: store });
    try {
      await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(), deliveryId: "delivery-handoff-2" }),
      );
      await server.gateway.drain();
      // Claimed already => claim() returns false for each write name.
      for (const write of [
        "handoff_toggle_status",
        "handoff_assignment",
        "handoff_note",
        "handoff_customer_message",
      ]) {
        expect(store.claim(writeKey("delivery:delivery-handoff-2", write), Date.now())).toBe(
          false,
        );
      }
    } finally {
      await server.close();
    }
  });

  it("a second attachment on the now-open conversation is suppressed, not handed off again", async () => {
    // The existing predicate is the AI suppression mechanism after a handoff.
    // No second mechanism was added, so this asserts the first one holds.
    const server = await startServer({ config: withTeamConfig() });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({
          body: attachmentOnlyPayload(["image"], {
            conversation: {
              id: CONVERSATION_DISPLAY_ID,
              status: "open",
              meta: { assignee: { id: 12 } },
              custom_attributes: {},
            },
          }),
          deliveryId: "delivery-handoff-3",
        }),
      );
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("status_not_pending");
      await server.gateway.drain();
      expect(server.chatwoot.calls).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The ACK path, and the network
// ---------------------------------------------------------------------------

describe("the handoff is off the ACK path", () => {
  it("ACKs immediately with ZERO Chatwoot calls made, even though the handoff is slow", async () => {
    const chatwoot = new StubChatwootApi();
    chatwoot.callDelayMs = 500; // 4 writes => 2s of work, well past Chatwoot's 5s/4.
    const server = await startServer({ chatwoot, config: withTeamConfig() });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image"]) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      expect(res.latencyMs).toBeLessThan(1000);
      // Nothing at all has been done to the conversation at ACK time.
      expect(chatwoot.calls).toEqual([]);

      await server.gateway.drain();
      expect(chatwoot.statusToggles).toHaveLength(1);
      expect(chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  }, 15_000);
});

describe("no attachment is ever fetched", () => {
  it("contacts only Chatwoot — never the attachment host, and never the runtime", async () => {
    // Real Chatwoot and runtime clients over a recording egress primitive, so
    // the recorded host list is EVERY host this service tried to reach.
    const server = await startRealClientServer({ config: withTeamConfig() });
    try {
      await postWebhook(
        server.url,
        signRequest({ body: attachmentOnlyPayload(["image", "file"]) }),
      );
      await server.gateway.drain();

      expect(server.egress.hosts.length).toBeGreaterThan(0);
      expect(server.egress.hosts).not.toContain(ATTACHMENT_HOST);
      // And the model was not called at all: no runtime host appears.
      expect(new Set(server.egress.hosts)).toEqual(new Set(["chatwoot.example.test"]));
      for (const url of server.egress.urls) {
        expect(url).not.toContain(ATTACHMENT_HOST);
        expect(url).not.toContain(ATTACHMENT_FILE_NAME);
        expect(url).not.toContain("/v1/invoke");
      }
    } finally {
      await server.close();
    }
  });
});

describe("logging discipline on the handoff path", () => {
  it("logs the type and count but never a url, a filename or customer content", async () => {
    const logger = new CapturingLogger();
    await run({
      body: attachmentOnlyPayload(["image", "file"]),
      logger,
      config: withTeamConfig(),
    });
    const all = logger.raw.join("\n");
    expect(all).not.toContain(ATTACHMENT_URL);
    expect(all).not.toContain(ATTACHMENT_HOST);
    expect(all).not.toContain(ATTACHMENT_FILE_NAME);

    const line = logger.withOutcome("handed_off")[0];
    expect(line).toBeDefined();
    expect(line?.["attachmentCount"]).toBe(2);
    expect(line?.["attachmentTypes"]).toEqual(["image", "file"]);
    expect(line?.["runtimeInvoked"]).toBe(false);
    expect(line?.["customerMessageSent"]).toBe(true);
    expect(line?.["accountId"]).toBe(ACCOUNT_ID);
    expect(line?.["tenantId"]).toBe(TENANT_ID);
  });
});
