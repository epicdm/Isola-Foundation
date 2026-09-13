/**
 * Ownership reconciliation from an OBSERVED Chatwoot assignee, at the HTTP
 * boundary — proving it never affects the reply decision, only ever runs
 * alongside it.
 *
 * def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13.
 *
 * The store-level state machine (AI_OWNED -> HUMAN_OWNED, resolved is never
 * touched, an in-flight escalation is never overtaken, replays are
 * idempotent) is proven against a REAL Postgres in
 * test/ownership-store.pg.test.ts, per this codebase's own rule that a fake
 * cannot prove a database guarantee. This file proves the OTHER half: that
 * wiring this into the webhook handler is genuinely additive and genuinely
 * isolated — the live per-message reply decision is byte-identical whether
 * reconciliation succeeds, no-ops, or throws.
 */
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  INBOX_ID,
  InMemoryOwnershipGate,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startServer,
  TENANT_ID,
  CapturingLogger,
} from "./harness.js";
import type { ConversationRef, OwnershipView, TransitionOutcome } from "../src/ownership.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
  chatwootInboxId: INBOX_ID,
};

function assigneeConversationUpdated(overrides: {
  status?: string;
  assignee?: unknown;
} = {}): Record<string, unknown> {
  return messageCreatedPayload({
    event: "conversation_updated",
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: overrides.status ?? "open",
      meta: { assignee: "assignee" in overrides ? overrides.assignee : { id: 99 } },
      custom_attributes: {},
    },
  });
}

describe("reconcileObservedAssignment — wired at the webhook boundary", () => {
  it("an 'Assign to me' on an OPEN conversation (conversation_updated, not message_created) is suppressed for reply as before, AND creates an eligible ownership row", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(server.url, signRequest({ body: assigneeConversationUpdated() }));

      // The REPLY decision is exactly what it always was for a non-message_created
      // event — unaffected by anything this fix adds.
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("not_message_created");

      // But the ledger now knows a human holds this conversation.
      expect(ownership.hasRow(REF)).toBe(true);
      const view: OwnershipView = await ownership.read(REF);
      expect(view.state).toBe("HUMAN_OWNED");
    } finally {
      await server.close();
    }
  });

  it("the SAME event on a RESOLVED conversation: still suppressed as before, and NO row is created — resolve stays terminal", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: assigneeConversationUpdated({ status: "resolved" }) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(ownership.hasRow(REF)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("an unassign event (no assignee) is a no-op even against an existing human hold — it does not clear or corrupt the row", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_OWNED", 3);
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: assigneeConversationUpdated({ status: "pending", assignee: null }) }),
      );
      expect(res.status).toBe(200);
      const view = await ownership.read(REF);
      expect(view.state).toBe("HUMAN_OWNED"); // untouched
      expect(view.episode).toBe(3); // untouched
    } finally {
      await server.close();
    }
  });

  it("a malformed/partial payload (no conversation object at all) no-ops reconciliation and the reply path still runs to completion", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      // No `conversation` key at all — conversationDisplayId parses to null.
      // evaluateSuppression's OWN event-type check fires first ("conversation_updated"
      // is not "message_created"), so the reply decision is `not_message_created`
      // regardless of this fix — but the reconciliation block runs unconditionally
      // for every "suppressed" decision, so this still exercises ITS OWN
      // `conversationDisplayId !== null` guard directly: nothing here should throw,
      // and the reply path must still reach a normal 200.
      const body = messageCreatedPayload({ event: "conversation_updated", conversation: undefined });
      const res = await postWebhook(server.url, signRequest({ body }));

      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("not_message_created");
      expect(ownership.hasRow(REF)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("a message_created event with no conversation object at all: reconciliation's own null-guard is what prevents a crash", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const body = messageCreatedPayload({ conversation: undefined });
      const res = await postWebhook(server.url, signRequest({ body }));

      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("no_conversation_id");
      expect(ownership.hasRow(REF)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("an event for an inbox with NO binding: no row, no crash, the existing binding_refused outcome is unchanged", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const body = assigneeConversationUpdated();
      (body["inbox"] as Record<string, unknown>)["id"] = 999_999;
      const res = await postWebhook(server.url, signRequest({ body }));

      expect(res.status).toBe(401); // no binding secret matches this inbox at all
      expect(ownership.hasRow({ ...REF, chatwootInboxId: 999_999 })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("reconciliation THROWING never affects the reply decision — prove the isolation, not the assertion of it", async () => {
    const capture = new CapturingLogger();

    // A gate that delegates everything except reconciliation, which always
    // throws — isolating exactly the one code path under test.
    const inner = new InMemoryOwnershipGate();
    const throwing = {
      read: inner.read.bind(inner),
      requestHuman: inner.requestHuman.bind(inner),
      claimAck: inner.claimAck.bind(inner),
      reconcileObservedAssignment: async (): Promise<TransitionOutcome | null> => {
        throw new Error("simulated ownership store failure");
      },
    };

    const withThrow = await startServer({ ownership: throwing, logger: capture.logger });
    let throwingResult: { status: number; outcome: unknown; reason: unknown };
    try {
      const res = await postWebhook(withThrow.url, signRequest({ body: assigneeConversationUpdated() }));
      throwingResult = { status: res.status, outcome: res.json["outcome"], reason: res.json["suppressionReason"] };
    } finally {
      await withThrow.close();
    }

    // The exact same delivery, byte-identical body, against a healthy gate.
    const healthy = new InMemoryOwnershipGate();
    const withoutThrow = await startServer({ ownership: healthy });
    let healthyResult: { status: number; outcome: unknown; reason: unknown };
    try {
      const res = await postWebhook(withoutThrow.url, signRequest({ body: assigneeConversationUpdated() }));
      healthyResult = { status: res.status, outcome: res.json["outcome"], reason: res.json["suppressionReason"] };
    } finally {
      await withoutThrow.close();
    }

    // PROOF, not assertion: the two deliveries produced the IDENTICAL reply
    // decision, even though one gate's reconciliation call threw and the
    // other's succeeded. Nothing about "did reconciliation work" leaked into
    // the response.
    expect(throwingResult).toEqual(healthyResult);

    // And the failure was not silent — it is visible in the log, which is
    // where a real operator would notice it, never in the customer-facing path.
    expect(
      capture.lines.some(
        (l) =>
          l["event"] === "ownership" &&
          l["outcome"] === "reconcile_observed_assignment_failed",
      ),
    ).toBe(true);
  });
});
