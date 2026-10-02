/**
 * THE MANUAL HANDBACK SIGNAL, ON THE WEBHOOK PATH.
 *
 * Reproduces and closes `def-explicit-handback-unreachable-after-team-
 * assignment-2026-08-24`: once an escalation assigns a team, `conversations#show`
 * 500s for the AgentBot's own token, so the sweeper's ONLY manual-detection path
 * (re-fetching the conversation to read its status) could never fire for the
 * normal, intended escalation shape. Chatwoot's own signed
 * `conversation_status_changed` webhook reports the status directly and needs no
 * re-fetch, closing the gap without an admin-token escape hatch and without any
 * change to the conversation lifecycle a human agent already uses.
 *
 * Two layers, matching this suite's own established split:
 *   - HTTP layer: proves the SIGNED delivery is routed correctly and is never
 *     swallowed by the message-reply predicate (the regression itself).
 *   - Decision layer: proves `handleManualHandbackWebhook`'s eligibility
 *     branching, using the same `exec.transaction`-as-spy style
 *     `handback-sweeper.test.ts` already established — "did it decide to act"
 *     is the property under test; the transition's own correctness is proven
 *     for real in `ownership-store.pg.test.ts`.
 */
import { describe, expect, it, vi } from "vitest";

import { isManualHandbackSignal, STATUS_CHANGED_EVENT } from "../src/webhook.js";
import { handleManualHandbackWebhook } from "../src/handback.js";
import type { ConversationRef } from "../src/ownership.js";
import type { SqlExecutor } from "../src/ledger.js";

import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  CapturingLogger,
  messageCreatedPayload,
  placeholder,
  postWebhook,
  signRequest,
  startServer,
} from "./harness.js";

// ---------------------------------------------------------------------------
// The predicate — pure, no HTTP
// ---------------------------------------------------------------------------

describe("isManualHandbackSignal", () => {
  it("is true for a status-changed event reporting pending", () => {
    expect(
      isManualHandbackSignal({
        event: STATUS_CHANGED_EVENT,
        messageId: null,
        content: null,
        messageType: "unknown",
        attachmentTypes: [],
        contentType: null,
        private: null,
        senderType: null,
        senderPhone: null,
        channelSubject: null,
        accountId: 2,
        inboxId: 7,
        conversationDisplayId: 42,
        conversationStatus: "pending",
        assignee: { id: 9 },
        customAttributes: {},
      }),
    ).toBe(true);
  });

  /** POSITIVE CONTROL, in the same suite: the predicate can be true at all. */
  it("CONTROL — the true case above is not vacuous", () => {
    // Re-asserted explicitly so a future refactor that always returns false
    // cannot pass every negative case below by accident.
    expect(
      isManualHandbackSignal({
        event: STATUS_CHANGED_EVENT,
        messageId: null,
        content: null,
        messageType: "unknown",
        attachmentTypes: [],
        contentType: null,
        private: null,
        senderType: null,
        senderPhone: null,
        channelSubject: null,
        accountId: 2,
        inboxId: 7,
        conversationDisplayId: 42,
        conversationStatus: "pending",
        assignee: null,
        customAttributes: {},
      }),
    ).toBe(true);
  });

  it("is false for message_created — this is a different axis entirely", () => {
    expect(
      isManualHandbackSignal({
        event: "message_created",
        messageId: 1,
        content: "hi",
        messageType: "incoming",
        attachmentTypes: [],
        contentType: "text",
        private: false,
        senderType: "contact",
        senderPhone: null,
        channelSubject: null,
        accountId: 2,
        inboxId: 7,
        conversationDisplayId: 42,
        conversationStatus: "pending",
        assignee: null,
        customAttributes: {},
      }),
    ).toBe(false);
  });

  it.each(["open", "resolved", "snoozed", null])(
    "is false for a status-changed event reporting %s — only pending is the handback gesture",
    (status) => {
      expect(
        isManualHandbackSignal({
          event: STATUS_CHANGED_EVENT,
          messageId: null,
          content: null,
          messageType: "unknown",
          attachmentTypes: [],
          contentType: null,
          private: null,
          senderType: null,
          senderPhone: null,
          channelSubject: null,
          accountId: 2,
          inboxId: 7,
          conversationDisplayId: 42,
          conversationStatus: status,
          assignee: null,
          customAttributes: {},
        }),
      ).toBe(false);
    },
  );
});

// ---------------------------------------------------------------------------
// The HTTP layer — the regression itself
// ---------------------------------------------------------------------------

function statusChangedPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return messageCreatedPayload({
    event: STATUS_CHANGED_EVENT,
    message_type: undefined,
    content: undefined,
    content_type: undefined,
    private: undefined,
    sender: undefined,
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: "pending",
      meta: { assignee: { id: 9 } },
      custom_attributes: {},
    },
    ...overrides,
  });
}

/** A minimal SqlExecutor double, in the exact style `handback-sweeper.test.ts`
 *  already established: `.transaction` is a spy recording attempts, not a
 *  transaction simulator. */
function fakeOwnershipExec(state: string, episode = 1) {
  const attempts: Array<{ sql: string }> = [];
  const exec = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM conversation_ownership")) {
        return {
          rows: [
            {
              ownership_state: state,
              ownership_episode: episode,
              handover_ack_episode: null,
              ownership_escalation_operation_id: null,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    }),
    transaction: vi.fn(async () => {
      attempts.push({ sql: "transaction" });
      return { ok: false, status: "conflict" };
    }),
  };
  // `SqlExecutor.transaction` is generic (`transaction<T>(fn): Promise<T>`) and
  // `vi.fn()` erases that generic, so the double can never structurally satisfy
  // the interface no matter how its body is written. The cast is applied ONCE
  // here rather than at every call site: what is being faked is "a transaction
  // was attempted", and `attempts` — not the return value — is what every
  // assertion reads.
  return { exec: exec as unknown as SqlExecutor, attempts };
}

describe("POST /v1/chatwoot/agent-bot — a signed status-changed(pending) delivery", () => {
  it(
    "is routed as manual_handback_signal, NOT suppressed as not_message_created " +
      "(the regression: this event used to be silently dropped by the reply predicate)",
    async () => {
      const capture = new CapturingLogger();
      const server = await startServer({ logger: capture.logger });
      try {
        const res = await postWebhook(server.url, signRequest({ body: statusChangedPayload() }));
        expect(res.status).toBe(200);
        expect(res.json["outcome"]).toBe("manual_handback_signal");
        expect(res.json["outcome"]).not.toBe("suppressed");
      } finally {
        await server.close();
      }
    },
  );

  it("without ownershipExec configured, ACKs and logs loudly rather than silently doing nothing", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger }); // no ownershipExec
    try {
      const res = await postWebhook(server.url, signRequest({ body: statusChangedPayload() }));
      expect(res.status).toBe(200);
      await server.gateway.drain();
      const line = capture.lines.find((l) => l["alertCode"] === "ownership_exec_not_configured");
      expect(line, "the missing-wiring case must alert, not silently no-op").toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("with ownershipExec wired and the conversation HUMAN_REQUESTED, attempts a real handback", async () => {
    const { exec, attempts } = fakeOwnershipExec("HUMAN_REQUESTED");
    const capture = new CapturingLogger();
    const server = await startServer({
      logger: capture.logger,
      ownershipExec: exec as never,
    });
    try {
      const res = await postWebhook(server.url, signRequest({ body: statusChangedPayload() }));
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("manual_handback_signal");
      await server.gateway.drain();
      expect(attempts.length, "performHandback must have attempted a transition").toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it("with ownershipExec wired and the conversation already AI_OWNED, attempts NOTHING", async () => {
    const { exec, attempts } = fakeOwnershipExec("AI_OWNED");
    const capture = new CapturingLogger();
    const server = await startServer({
      logger: capture.logger,
      ownershipExec: exec as never,
    });
    try {
      const res = await postWebhook(server.url, signRequest({ body: statusChangedPayload() }));
      expect(res.status).toBe(200);
      await server.gateway.drain();
      expect(attempts).toHaveLength(0);
      const line = capture.lines.find((l) => l["outcome"] === "webhook_no_handback_needed");
      expect(line?.["ownershipState"]).toBe("AI_OWNED");
    } finally {
      await server.close();
    }
  });

  it("a status-changed event is signature-verified exactly like every other delivery", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: statusChangedPayload(), secret: placeholder("wrong-secret") }),
      );
      expect(res.status).toBe(401);
      expect(res.json["outcome"]).toBe("unauthorized");
    } finally {
      await server.close();
    }
  });

  it("account/inbox routing is unaffected: an unbound inbox is still refused", async () => {
    const capture = new CapturingLogger();
    const server = await startServer({ logger: capture.logger });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: statusChangedPayload({ inbox: { id: 999 } }) }),
      );
      expect(res.status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

// ---------------------------------------------------------------------------
// The decision layer — eligibility, called directly
// ---------------------------------------------------------------------------

const REF: ConversationRef = {
  tenantId: "epic-frontdesk-6737-isola-chat",
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
  chatwootInboxId: 7,
};

describe("handleManualHandbackWebhook — eligibility", () => {
  it.each(["HUMAN_REQUESTED", "HUMAN_OWNED", "HANDING_BACK"])(
    "attempts a handback from %s",
    async (state) => {
      const { exec, attempts } = fakeOwnershipExec(state);
      const result = await handleManualHandbackWebhook(
        {
          exec,
          chatwoot: { pendConversation: vi.fn(async () => ({ ok: true })) } as never,
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
          now: () => Date.parse("2026-08-24T12:00:00.000Z"),
        },
        { conversation: REF, target: { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "t" } },
      );
      expect(attempts.length).toBeGreaterThan(0);
      expect(result.outcome).not.toBe("no_handback_needed");
    },
  );

  it.each(["AI_OWNED", "AI_RESUMED"])(
    "attempts NOTHING from %s — the AI already owns it",
    async (state) => {
      const { exec, attempts } = fakeOwnershipExec(state);
      const result = await handleManualHandbackWebhook(
        {
          exec,
          chatwoot: { pendConversation: vi.fn(async () => ({ ok: true })) } as never,
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
          now: () => Date.parse("2026-08-24T12:00:00.000Z"),
        },
        { conversation: REF, target: { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "t" } },
      );
      expect(attempts).toHaveLength(0);
      expect(result).toEqual({ outcome: "no_handback_needed", state });
    },
  );
});
