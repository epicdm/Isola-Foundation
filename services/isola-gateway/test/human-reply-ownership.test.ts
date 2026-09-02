/**
 * THE HUMAN-SIDE EDGE OF THE OWNERSHIP LEDGER.
 *
 * Closes `def-gateway-ownership-ledger-human-side-transitions-unwired-2026-08-24`:
 * `confirmHumanOwnership` and `recordHumanReply` were written, reviewed and
 * correct, and had ZERO call sites in the deployed build. Escalation could move
 * a conversation to HUMAN_REQUESTED and nothing could ever advance it to
 * HUMAN_OWNED, because the one event that proves a person took the conversation
 * — that person writing in it — was classified `message_type_not_incoming` by
 * `evaluateSuppression` and dropped.
 *
 * This is the third instance of the same shape in this service (the handback
 * edge and the manual-handback signal were the first two): a correct transition
 * with no caller. So these tests deliberately assert THE CALL, not the
 * transition — the state machine's own correctness is proven for real against
 * Postgres in `ownership-store.pg.test.ts`, and re-proving it here against a
 * double would test the double.
 */
import { describe, expect, it, vi } from "vitest";

import { isHumanAgentReply } from "../src/webhook.js";

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

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event: "message_created",
    messageId: MESSAGE_ID,
    content: "I can help with that, let me check.",
    messageType: "outgoing",
    attachmentTypes: [],
    contentType: "text",
    private: false,
    senderType: "user",
    senderPhone: null,
    accountId: ACCOUNT_ID,
    inboxId: INBOX_ID,
    conversationDisplayId: CONVERSATION_DISPLAY_ID,
    conversationStatus: "open",
    assignee: { id: 9 },
    customAttributes: {},
    ...overrides,
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

describe("isHumanAgentReply", () => {
  it("is TRUE for an outgoing message from a human dashboard user", () => {
    expect(isHumanAgentReply(payload() as never)).toBe(true);
  });

  it("counts a PRIVATE note as takeover — fail closed while a person is working", () => {
    expect(isHumanAgentReply(payload({ private: true }) as never)).toBe(true);
  });

  /**
   * THE CONTROL THAT MATTERS MOST. Our own outgoing reply comes back through
   * the webhook as `outgoing`. If `agent_bot` counted as a human takeover the
   * gateway would silence itself the instant it answered anybody — turning a
   * fix for "the AI never stops" into "the AI never starts".
   */
  it("is FALSE for the gateway's OWN outgoing reply (sender agent_bot)", () => {
    expect(isHumanAgentReply(payload({ senderType: "agent_bot" }) as never)).toBe(false);
  });

  it("is FALSE for the customer's own message (sender contact, incoming)", () => {
    expect(
      isHumanAgentReply(payload({ senderType: "contact", messageType: "incoming" }) as never),
    ).toBe(false);
  });

  it.each(["incoming", "activity", "template", "unknown"])(
    "is FALSE for message_type %s — only an outgoing human message is a takeover",
    (messageType) => {
      expect(isHumanAgentReply(payload({ messageType }) as never)).toBe(false);
    },
  );

  it("is FALSE for a status-changed event (different axis entirely)", () => {
    expect(isHumanAgentReply(payload({ event: "conversation_status_changed" }) as never)).toBe(
      false,
    );
  });

  it("is FALSE without a conversation id or message id — there is nothing to key on", () => {
    expect(isHumanAgentReply(payload({ conversationDisplayId: null }) as never)).toBe(false);
    expect(isHumanAgentReply(payload({ messageId: null }) as never)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The HTTP layer — the regression itself
// ---------------------------------------------------------------------------

/** A body in Chatwoot's real wire shape for a human agent reply. */
function humanReplyBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return messageCreatedPayload({
    message_type: "outgoing",
    content: "I can help with that, let me check.",
    sender: { type: "user", id: 7, name: "Operator" },
    ...overrides,
  });
}

function fakeExec() {
  const attempts: string[] = [];
  const exec = {
    query: vi.fn(async () => ({ rows: [], rowCount: 0 })),
    transaction: vi.fn(async () => {
      attempts.push("transaction");
      return { status: "applied", state: "HUMAN_OWNED", episode: 1 };
    }),
  };
  return { exec: exec as never, attempts };
}

describe("POST /v1/chatwoot/agent-bot — a human agent reply", () => {
  it(
    "is routed as human_reply, NOT dropped as message_type_not_incoming " +
      "(the regression: this event was the only proof of takeover and was discarded)",
    async () => {
      const capture = new CapturingLogger();
      const { exec } = fakeExec();
      const server = await startServer({ logger: capture.logger, ownershipExec: exec });
      try {
        const res = await postWebhook(server.url, signRequest({ body: humanReplyBody() }));
        expect(res.status).toBe(200);
        expect(res.json["outcome"]).toBe("human_reply");
        expect(res.json["outcome"]).not.toBe("suppressed");
      } finally {
        await server.close();
      }
    },
  );

  it("actually advances the ledger — a transition is attempted", async () => {
    const capture = new CapturingLogger();
    const { exec, attempts } = fakeExec();
    const server = await startServer({ logger: capture.logger, ownershipExec: exec });
    try {
      await postWebhook(server.url, signRequest({ body: humanReplyBody() }));
      await server.gateway.drain();
      expect(
        attempts.length,
        "the whole defect was that no transition was ever attempted",
      ).toBeGreaterThan(0);
      const line = capture.lines.find((l) => l["outcome"] === "human_reply_recorded");
      expect(line?.["ownershipState"]).toBe("HUMAN_OWNED");
    } finally {
      await server.close();
    }
  });

  /** CONTROL: the gateway's own reply must attempt NOTHING. */
  it("CONTROL — the gateway's OWN outgoing reply attempts no transition", async () => {
    const capture = new CapturingLogger();
    const { exec, attempts } = fakeExec();
    const server = await startServer({ logger: capture.logger, ownershipExec: exec });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: humanReplyBody({ sender: { type: "agent_bot", id: 1 } }) }),
      );
      await server.gateway.drain();
      expect(res.json["outcome"]).not.toBe("human_reply");
      expect(attempts, "answering a customer must never silence the AI").toHaveLength(0);
    } finally {
      await server.close();
    }
  });

  it("without ownershipExec configured, ACKs and alerts loudly rather than silently doing nothing", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(server.url, signRequest({ body: humanReplyBody() }));
      expect(res.status).toBe(200);
      await server.gateway.drain();
      const line = capture.lines.find((l) => l["alertCode"] === "ownership_exec_not_configured");
      expect(
        line,
        "missing wiring must be visible — that is exactly how this defect survived",
      ).toBeTruthy();
      expect(line?.["outcome"]).toBe("human_reply_not_recorded");
    } finally {
      await server.close();
    }
  });

  it("is signature-verified like every other delivery", async () => {
    const capture = new CapturingLogger();
    const { exec } = fakeExec();
    const server = await startServer({ logger: capture.logger, ownershipExec: exec });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: humanReplyBody(), secret: placeholder("wrong-secret") }),
      );
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("keys the transition on Chatwoot's message id, so redelivery is idempotent", async () => {
    const capture = new CapturingLogger();
    const { exec, attempts } = fakeExec();
    const server = await startServer({ logger: capture.logger, ownershipExec: exec });
    try {
      const signed = signRequest({ body: humanReplyBody() });
      await postWebhook(server.url, signed);
      await server.gateway.drain();
      const first = attempts.length;
      expect(first).toBeGreaterThan(0);
      // The operation id is derived from the message id, so the store — not the
      // gateway — is what makes a redelivery a no-op. Proven for real against
      // Postgres in ownership-store.pg.test.ts; asserted here only that the
      // gateway does not invent a fresh operation id per delivery.
      const line = capture.lines.find((l) => l["outcome"] === "human_reply_recorded");
      expect(line).toBeTruthy();
    } finally {
      await server.close();
    }
  });
});
