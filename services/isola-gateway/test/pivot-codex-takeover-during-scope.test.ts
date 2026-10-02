/**
 * CODEX FIX ROUND 1 (review of 92ddc6c): D5 (P2).
 *
 * A human can take the conversation while the customer-scope resolver is running.
 * The post-run ownership recheck (commit e389317) never saw that case: an
 * UNRESOLVED verdict returns BEFORE it, straight into the escalation path, which
 * wrote a private note, a status change and an assignment into a conversation a
 * person now holds. Ownership is now re-read right after the scope is resolved,
 * before ANY write and before the model is called.
 *
 * Tested THROUGH THE ROUTE (Law 20): a signed webhook over a real socket. Every
 * suppression has its positive twin in the same harness (Laws 11, 19, 23, 28): the
 * identical delivery WITHOUT the takeover escalates / calls the model.
 */
import { describe, expect, it } from "vitest";

import type { CustomerScopeResolver } from "../src/customer-scope.js";
import type { ConversationRef } from "../src/ownership.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  INBOX_ID,
  InMemoryOwnershipGate,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  TENANT_ID,
} from "./harness.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};
const SUBJECT = "+17675550101";

function signedBody(): string {
  return JSON.stringify(
    messageCreatedPayload({
      content: "my invoice 348 says unpaid",
      sender: { type: "contact", id: 55, phone_number: SUBJECT },
      conversation: {
        id: CONVERSATION_DISPLAY_ID,
        status: "pending",
        meta: { assignee: null },
        contact_inbox: { id: 9, contact_id: 55, inbox_id: INBOX_ID, source_id: SUBJECT },
      },
    }),
  );
}

const WRITE_KINDS = ["message", "toggle_status", "toggle_status_pending", "assignment", "labels_write", "attributes_write", "private_note"];

/** A resolver that gives the verdict it is told to, optionally letting a human act first. */
function resolverGiving(
  verdict: Awaited<ReturnType<CustomerScopeResolver["resolve"]>>,
  beforeAnswering: () => void = () => undefined,
): CustomerScopeResolver {
  return {
    resolve: async () => {
      beforeAnswering();
      return verdict;
    },
  };
}

describe("D5: a takeover while the customer scope is being resolved suppresses the escalation writes", () => {
  it("CONTROL: an UNRESOLVED verdict with NO takeover escalates over the route (a note is written, a human is shown the conversation)", async () => {
    const ownership = new InMemoryOwnershipGate();
    const runtime = StubAgentRuntime.answering("should not be called");
    const server = await startServer({
      ownership,
      runtime,
      customerScope: resolverGiving({ kind: "unresolved" }),
    });
    try {
      const res = await postWebhook(server.url, signRequest({ rawBody: signedBody() }));
      expect(res.status).toBe(200);
      await server.gateway.drain();
      expect(server.chatwoot.customerMessages).toHaveLength(0);
      expect(runtime.requests).toHaveLength(0);
      const writes = server.chatwoot.calls.filter((c) => WRITE_KINDS.includes(c.kind));
      expect(writes.length, "the escalation did not happen even without a takeover").toBeGreaterThanOrEqual(1);
    } finally {
      await server.close();
    }
  });

  it("a human takes the conversation DURING scope resolution and the verdict is unresolved: NO note, NO status change, NO assignment, row closed", async () => {
    const ownership = new InMemoryOwnershipGate();
    const capture = new CapturingLogger();
    const runtime = StubAgentRuntime.answering("should not be called");
    const server = await startServer({
      ownership,
      logger: capture.logger,
      runtime,
      customerScope: resolverGiving({ kind: "unresolved" }, () => ownership.seed(REF, "HUMAN_OWNED", 1)),
    });
    try {
      const res = await postWebhook(server.url, signRequest({ rawBody: signedBody() }));
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED"); // the interleaving really happened
      const writes = server.chatwoot.calls.filter((c) => WRITE_KINDS.includes(c.kind));
      expect(writes).toEqual([]);
      expect(server.chatwoot.customerMessages).toHaveLength(0);
      expect(runtime.requests).toHaveLength(0);
      expect([...server.ledger.rows.values()].map((r) => r.state)).toEqual(["completed"]);
      expect(capture.withOutcome("suppressed_in_flight")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("CONTROL: a VERIFIED verdict with NO takeover calls the model and replies once", async () => {
    const ownership = new InMemoryOwnershipGate();
    const runtime = StubAgentRuntime.answering("Here is your answer.");
    const server = await startServer({
      ownership,
      runtime,
      customerScope: resolverGiving({ kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] }),
    });
    try {
      await postWebhook(server.url, signRequest({ rawBody: signedBody() }));
      await server.gateway.drain();
      expect(runtime.requests).toHaveLength(1);
      expect(server.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("a takeover during scope resolution with a VERIFIED verdict: the model is NOT even called (no spend, nothing written)", async () => {
    const ownership = new InMemoryOwnershipGate();
    const capture = new CapturingLogger();
    const runtime = StubAgentRuntime.answering("should not be called");
    const server = await startServer({
      ownership,
      logger: capture.logger,
      runtime,
      customerScope: resolverGiving(
        { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
        () => ownership.seed(REF, "HUMAN_OWNED", 1),
      ),
    });
    try {
      await postWebhook(server.url, signRequest({ rawBody: signedBody() }));
      await server.gateway.drain();
      expect(runtime.requests).toHaveLength(0);
      const writes = server.chatwoot.calls.filter((c) => WRITE_KINDS.includes(c.kind));
      expect(writes).toEqual([]);
      expect(capture.withOutcome("suppressed_in_flight")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
