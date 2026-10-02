/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, item (b)(1): the in-flight takeover
 * recheck, tested THROUGH THE ROUTE (Law 20: test the path, not the pieces).
 *
 * `pivot-inflight-takeover.test.ts` calls `processDelivery` directly. That
 * proves the pipeline function; it does not prove the route reaches it with the
 * seam wired. This file drives a real socket: a SIGNED webhook is POSTed, the
 * gateway ACKs, the pipeline runs on the accepted delivery, and the assertions
 * are about what the customer and Chatwoot finally received.
 *
 * CONTROL (same harness, same route): the identical signed delivery with
 * ownership unchanged mid-run DOES produce exactly one customer reply, so the
 * "nothing was sent" assertion cannot be explained by a gateway that refuses
 * everything or a webhook that never reached the pipeline.
 */
import { describe, expect, it } from "vitest";

import type { ConversationRef } from "../src/ownership.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  InMemoryOwnershipGate,
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

describe("signed webhook -> pipeline -> reply, with a human taking over mid-run", () => {
  it("CONTROL: ownership unchanged while the model runs -> exactly one customer reply over the route", async () => {
    const ownership = new InMemoryOwnershipGate();
    const server = await startServer({
      ownership,
      runtime: new StubAgentRuntime(async () => ({
        text: "Here is your answer.",
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome: "ok",
        correlationId: "runtime-correlation-id",
        completionState: "completed",
        contractVersion: 1,
      })),
    });
    try {
      const res = await postWebhook(server.url, signRequest());
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      expect(server.chatwoot.customerMessages).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("a human takes the conversation while the model runs: the accepted delivery sends NOTHING, writes NOTHING, and closes its one ledger row", async () => {
    const ownership = new InMemoryOwnershipGate();
    const capture = new CapturingLogger();
    const server = await startServer({
      ownership,
      logger: capture.logger,
      runtime: new StubAgentRuntime(async () => {
        // The human acts during the model run.
        ownership.seed(REF, "HUMAN_OWNED", 1);
        return {
          text: "Here is your answer.",
          action: null,
          actionUnrecognised: false,
          actionReason: null,
          outcome: "ok",
          correlationId: "runtime-correlation-id",
          completionState: "completed",
          contractVersion: 1,
        };
      }),
    });
    try {
      const res = await postWebhook(server.url, signRequest());
      // The gateway ACKed normally: this is NOT a rejected request.
      expect(res.status).toBe(200);
      expect(res.json["outcome"]).toBe("accepted");
      await server.gateway.drain();

      // The runtime really ran (the interleaving is real).
      expect((await ownership.read(REF)).state).toBe("HUMAN_OWNED");

      expect(server.chatwoot.customerMessages).toHaveLength(0);
      const writes = server.chatwoot.calls.filter((c) =>
        ["message", "toggle_status", "toggle_status_pending", "assignment", "labels_write", "attributes_write"].includes(
          c.kind,
        ),
      );
      expect(writes).toEqual([]);
      expect([...server.ledger.rows.values()].map((r) => r.state)).toEqual(["completed"]);
      expect(capture.withOutcome("suppressed_in_flight")).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});
