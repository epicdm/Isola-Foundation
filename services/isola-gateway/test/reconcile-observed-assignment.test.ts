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
 *
 * PAYLOAD SHAPE — READ THIS BEFORE EDITING A FIXTURE HERE.
 * GitHub Codex review of PR #135, pass 2: `conversation_updated` (and
 * `conversation_status_changed`/`opened`/`resolved`) do NOT nest the
 * conversation under a `conversation` key the way `message_created` does.
 * Confirmed against Chatwoot source (`Conversations::EventDataPresenter
 * #webhook_data`, delivered verbatim by `Webhooks::Trigger`, no re-wrapping)
 * and empirically, by running a real-shaped payload through this file's own
 * parseRouting/parseWebhookPayload before the fix: it produced
 * `inboxId: null` and `conversationDisplayId: null`, meaning every such
 * delivery was being 401-rejected at signature selection, never even
 * reaching evaluateSuppression. `conversationUpdatedPayload` below builds
 * the CONFIRMED real shape: `id`/`inbox_id`/`status`/`meta` all at the ROOT,
 * `inbox_id` a bare number (no nested `inbox` object at all).
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

/**
 * The CONFIRMED real shape of conversation_updated/status_changed/opened/
 * resolved — see this file's own header doc comment. `id`/`inbox_id`/
 * `status`/`meta` are all top-level; there is no nested `conversation` and
 * no nested `inbox` object.
 */
function conversationUpdatedPayload(overrides: {
  event?: string;
  status?: string;
  assignee?: unknown;
  id?: unknown;
  inboxId?: unknown;
} = {}): Record<string, unknown> {
  return {
    event: overrides.event ?? "conversation_updated",
    id: "id" in overrides ? overrides.id : CONVERSATION_DISPLAY_ID,
    inbox_id: "inboxId" in overrides ? overrides.inboxId : INBOX_ID,
    status: overrides.status ?? "open",
    meta: { assignee: "assignee" in overrides ? overrides.assignee : { id: 99 }, sender: { id: 55 } },
    account: { id: ACCOUNT_ID, name: "EPIC" },
    custom_attributes: {},
  };
}

describe("reconcileObservedAssignment — wired at the webhook boundary", () => {
  it("an 'Assign to me' on an OPEN conversation (conversation_updated, not message_created) is suppressed for reply as before, AND creates an eligible ownership row", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(server.url, signRequest({ body: conversationUpdatedPayload() }));

      // The REPLY decision is exactly what it always was for a non-message_created
      // event — unaffected by anything this fix adds.
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("not_message_created");

      // Reconciliation is fire-and-forget (tracked, not awaited on the
      // response path — see reconcileAssignmentBestEffort's own doc comment,
      // added after GitHub Codex caught the first version blocking the ACK
      // on it). `drain()` is the same wait `close()` performs; called
      // explicitly here so the assertion below is not a race.
      await server.gateway.drain();

      // But the ledger now knows a human holds this conversation.
      expect(ownership.hasRow(REF)).toBe(true);
      const view: OwnershipView = await ownership.read(REF);
      expect(view.state).toBe("HUMAN_OWNED");
    } finally {
      await server.close();
    }
  });

  it("the same event on account/inbox ROUTING alone (not the reconciliation payload) is what changed — confirm parseRouting/binding resolution succeed for this real shape", async () => {
    // A DIRECT regression proof for the pass-2 finding: before the fix,
    // inbox_id (a bare number, no nested `inbox` object) was read as null by
    // parseRouting, so candidateSecrets found nothing and the delivery
    // 401'd before evaluateSuppression ever ran. If that regressed, this
    // would come back 401 instead of 200.
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(server.url, signRequest({ body: conversationUpdatedPayload() }));
      expect(res.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  for (const event of [
    "conversation_status_changed",
    "conversation_opened",
    "conversation_resolved",
  ] as const) {
    it(`the same real shape for ${event} routes and parses correctly too — not just conversation_updated`, async () => {
      const ownership = new InMemoryOwnershipGate();
      const server = await startServer({ ownership });
      try {
        const res = await postWebhook(
          server.url,
          signRequest({ body: conversationUpdatedPayload({ event, status: event === "conversation_resolved" ? "resolved" : "open" }) }),
        );
        expect(res.status).toBe(200);
        expect(res.json["outcome"]).toBe("suppressed");
        await server.gateway.drain();
        // Only conversation_resolved should create no row (status excludes it);
        // the other two, carrying an assignee on a non-resolved status, should.
        expect(ownership.hasRow(REF)).toBe(event !== "conversation_resolved");
      } finally {
        await server.close();
      }
    });
  }

  it("the SAME event on a RESOLVED conversation: still suppressed as before, and NO row is created — resolve stays terminal", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: conversationUpdatedPayload({ status: "resolved" }) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      await server.gateway.drain();
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
        signRequest({ body: conversationUpdatedPayload({ status: "pending", assignee: null }) }),
      );
      expect(res.status).toBe(200);
      await server.gateway.drain();
      const view = await ownership.read(REF);
      expect(view.state).toBe("HUMAN_OWNED"); // untouched
      expect(view.episode).toBe(3); // untouched
    } finally {
      await server.close();
    }
  });

  it("a conversation_updated payload missing `id` at the root: reconciliation's own null-guard no-ops safely, the reply path still runs to completion", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const res = await postWebhook(
        server.url,
        signRequest({ body: conversationUpdatedPayload({ id: undefined }) }),
      );
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("not_message_created");
      await server.gateway.drain();
      expect(ownership.hasRow(REF)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("a message_created event with no conversation object at all: reconciliation's own null-guard is what prevents a crash", async () => {
    // A DIFFERENT malformed shape from the one above — this is the
    // message_created nested shape, deliberately missing its `conversation`
    // key, exercising the OTHER branch of parseWebhookPayload.
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const body = messageCreatedPayload({ conversation: undefined });
      const res = await postWebhook(server.url, signRequest({ body }));

      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("suppressed");
      expect(res.json["suppressionReason"]).toBe("no_conversation_id");
      await server.gateway.drain();
      expect(ownership.hasRow(REF)).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("an event for an inbox with NO binding: no row, no crash, the existing binding_refused outcome is unchanged", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({ ownership });
    try {
      const body = conversationUpdatedPayload({ inboxId: 999_999 });
      const res = await postWebhook(server.url, signRequest({ body }));

      expect(res.status).toBe(401); // no binding secret matches this inbox at all
      await server.gateway.drain();
      expect(ownership.hasRow({ ...REF, chatwootInboxId: 999_999 })).toBe(false);
    } finally {
      await server.close();
    }
  });

  it("a SLOW ownership store never delays the ACK — reconciliation is fire-and-forget, not awaited on the response path", async () => {
    // Regression test for GitHub Codex's finding on PR #135: the first
    // version awaited reconcileObservedAssignment before `finish(...)`, so a
    // slow or hung ownership store gated the customer-facing ACK itself.
    const inner = new InMemoryOwnershipGate();
    const DELAY_MS = 500;
    let resolved = false;
    const slow = {
      read: inner.read.bind(inner),
      requestHuman: inner.requestHuman.bind(inner),
      claimAck: inner.claimAck.bind(inner),
      reconcileObservedAssignment: (
        input: Parameters<InMemoryOwnershipGate["reconcileObservedAssignment"]>[0],
      ) =>
        new Promise<TransitionOutcome | null>((resolve) => {
          setTimeout(() => {
            resolved = true;
            resolve(inner.reconcileObservedAssignment(input));
          }, DELAY_MS);
        }),
    };

    const server = await startServer({ ownership: slow });
    try {
      const startedAt = Date.now();
      const res = await postWebhook(server.url, signRequest({ body: conversationUpdatedPayload() }));
      const elapsedMs = Date.now() - startedAt;

      expect(res.status).toBe(200);
      // The ACK came back well before the slow store's own delay — proof, not
      // just "under 5s": if this were still awaited, elapsedMs would be >= 500.
      expect(elapsedMs).toBeLessThan(DELAY_MS);
      expect(resolved).toBe(false); // the slow work had not even finished yet

      // But it DOES eventually land — this is fire-and-forget, not fire-and-drop.
      await server.gateway.drain();
      expect(resolved).toBe(true);
      expect(inner.hasRow(REF)).toBe(true);
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
      const res = await postWebhook(withThrow.url, signRequest({ body: conversationUpdatedPayload() }));
      throwingResult = { status: res.status, outcome: res.json["outcome"], reason: res.json["suppressionReason"] };
    } finally {
      await withThrow.close();
    }

    // The exact same delivery, byte-identical body, against a healthy gate.
    const healthy = new InMemoryOwnershipGate();
    const withoutThrow = await startServer({ ownership: healthy });
    let healthyResult: { status: number; outcome: unknown; reason: unknown };
    try {
      const res = await postWebhook(withoutThrow.url, signRequest({ body: conversationUpdatedPayload() }));
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
