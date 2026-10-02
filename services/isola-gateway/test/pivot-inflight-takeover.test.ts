/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, item (b)(1): IN-FLIGHT TAKEOVER RECHECK.
 *
 * TESTS FIRST. Several of these FAIL on the code this branch starts from
 * (8b5feb3, the deployed UAT gateway), and they are meant to: they are the
 * specification for the fix, which is NOT part of this change.
 *
 * THE DEFECT (CODE-ONLY until observed live, Law 5)
 *   `processDelivery` reads the ownership store ONCE, before `runtime.invoke`
 *   (pipeline.ts, "THE OWNERSHIP GATE"), and then writes the reply after the
 *   runtime returns — up to the 90 s runtime deadline later — with no second
 *   read. A human who takes the conversation while the model is thinking is
 *   talked over: the customer receives an AI message, and then any escalation /
 *   annotation business writes fire as well.
 *
 * THE CONTRACT THESE TESTS PIN
 *   Immediately before ANY reply write and before ANY business mutation, AFTER
 *   the runtime has returned, ownership is read again. If the conversation is no
 *   longer AI-authorised, or its episode (generation) is not the one the run
 *   started under, then:
 *     - nothing is written to the customer,
 *     - no business mutation fires (no status change, assignment, note, label
 *       or attribute write),
 *     - the delivery ends with the DISTINCT outcome "suppressed_in_flight",
 *     - and if the recheck itself cannot be completed the reply fails CLOSED.
 *
 * HOW THE FAILURES ARE KEPT HONEST (Laws 11, 19, 23, 28)
 *   - CONTROL A: the very same flow with ownership UNCHANGED does send exactly
 *     one reply, so "no reply" below cannot be explained by a broken fixture or
 *     a gateway that refuses everything.
 *   - CONTROL B: the mid-run mutation provably took effect (the store reads
 *     HUMAN_OWNED afterwards and the runtime ran exactly once), so the
 *     interleaving is real, not assumed.
 *   - CONTROL C (order): the failing assertions are about WHAT happened after
 *     the runtime returned; the event-order test proves the read-before-write
 *     requirement directly rather than inferring it from outcomes.
 *   Each failing test fails because the reply WAS sent / no second read
 *   happened (wrong behaviour of existing code), never because of a fixture.
 *
 * Reuses the gateway's own harness, ledger double and ownership model. No
 * network, no Postgres, no secrets.
 */
import { describe, expect, it } from "vitest";

import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { DISARMED } from "../src/failpoint.js";
import type { ConversationRef, OwnershipView } from "../src/ownership.js";
import type { AgentRuntimeResult } from "../src/runtime.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { parseWebhookPayload } from "../src/webhook.js";
import type { ChatwootTarget } from "../src/chatwoot.js";
import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  CapturingLogger,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
  UnavailableOwnershipGate,
} from "./harness.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};

function makeJob(): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-inflight",
    deliveryId: "delivery-inflight-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:inflight-1",
    },
    digest: "digest-inflight-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode: "answer",
    classification: null,
  };
}

const OK_RESULT: AgentRuntimeResult = {
  text: "Here is your answer.",
  action: null,
  actionUnrecognised: false,
  actionReason: null,
  outcome: "ok",
  correlationId: "runtime-correlation-id",
  completionState: "completed",
  contractVersion: 1,
};

/** A runtime that runs `whileRunning` (the human acting) and THEN answers. */
function runtimeThat(
  whileRunning: () => Promise<void> | void,
  result: AgentRuntimeResult = OK_RESULT,
): StubAgentRuntime {
  return new StubAgentRuntime(async () => {
    await whileRunning();
    return result;
  });
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): {
  deps: PipelineDeps;
  chatwoot: StubChatwootApi;
  runtime: StubAgentRuntime;
  logger: CapturingLogger;
  ledger: FakeLedger;
} {
  const chatwoot = new StubChatwootApi();
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const capture = new CapturingLogger();
  const ledger = new FakeLedger();
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: () => 0,
    ...overrides,
  };
  return { deps, chatwoot, runtime, logger: capture, ledger };
}

/** Everything that changes state in Chatwoot, as opposed to merely reading it. */
const WRITE_KINDS = new Set([
  "message",
  "toggle_status",
  "toggle_status_pending",
  "assignment",
  "labels_write",
  "attributes_write",
]);

function chatwootWrites(chatwoot: StubChatwootApi): string[] {
  return chatwoot.calls
    .filter((c) => WRITE_KINDS.has(c.kind))
    .map((c) => `${c.kind}${c.private === true ? ":private" : ""}`);
}

// ---------------------------------------------------------------------------
// CONTROLS — these PASS today, and they must keep passing after the fix.
// ---------------------------------------------------------------------------

describe("CONTROLS — the harness can produce the thing the failing tests forbid", () => {
  it("CONTROL A: with ownership UNCHANGED while the model runs, exactly one reply is sent", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(() => undefined),
    });

    const result = await processDelivery(deps, makeJob());

    expect(result.outcome).toBe("replied");
    expect(result.customerMessageSent).toBe(true);
    expect(chatwoot.customerMessages).toHaveLength(1);
  });

  it("CONTROL B: the mid-run mutation provably took effect — the interleaving is real", async () => {
    const ownership = new InMemoryOwnershipGate();
    let ranCount = 0;
    const { deps } = makeDeps({
      ownership,
      runtime: runtimeThat(() => {
        ranCount += 1;
        ownership.seed(REF, "HUMAN_OWNED", 1);
      }),
    });

    await processDelivery(deps, makeJob());

    expect(ranCount).toBe(1);
    // The store, read fresh AFTER the delivery, says a human holds it. If this
    // failed, every "was suppressed" assertion below would be meaningless.
    const after: OwnershipView = await ownership.read(REF);
    expect(after.state).toBe("HUMAN_OWNED");
    expect(after.episode).toBe(1);
  });

  it("CONTROL B2: ownership already held by a human BEFORE the run is already silenced (the existing pre-run gate)", async () => {
    const ownership = new InMemoryOwnershipGate();
    ownership.seed(REF, "HUMAN_OWNED", 1);
    const { deps, chatwoot, runtime } = makeDeps({ ownership });

    const result = await processDelivery(deps, makeJob());

    expect(result.outcome).toBe("human_owned");
    expect(runtime.requests).toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// THE SPECIFICATION — these FAIL today (wrong behaviour: the reply is sent).
// ---------------------------------------------------------------------------

describe("a human takes the conversation WHILE the model is running", () => {
  it("HUMAN_OWNED mid-run: NOTHING is sent to the customer", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(() => ownership.seed(REF, "HUMAN_OWNED", 1)),
    });

    await processDelivery(deps, makeJob());

    expect(chatwoot.customerMessages, "the AI talked over a human who took the conversation").toHaveLength(0);
  });

  it("HUMAN_REQUESTED via the REAL transition mid-run: NOTHING is sent to the customer", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(async () => {
        // The same transition a customer-asked-for-a-human escalation uses.
        await ownership.requestHuman({ conversation: REF, operationId: "human-clicked-take-over" });
      }),
    });

    await processDelivery(deps, makeJob());

    expect(chatwoot.customerMessages).toHaveLength(0);
  });

  it("the delivery ends with the DISTINCT outcome suppressed_in_flight and says no message was sent", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, logger } = makeDeps({
      ownership,
      runtime: runtimeThat(() => ownership.seed(REF, "HUMAN_OWNED", 1)),
    });

    const result = await processDelivery(deps, makeJob());

    expect(result.outcome).toBe("suppressed_in_flight");
    expect(result.customerMessageSent).toBe(false);
    expect(result.needsRetry).toBe(false);
    // Observable from the log alone: a suppression nobody can see is
    // indistinguishable from a dropped delivery.
    expect(logger.withOutcome("suppressed_in_flight")).toHaveLength(1);
  });

  it("the ledger row is CLOSED (completed), not left to be retried into a conversation a human holds", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, ledger } = makeDeps({
      ownership,
      runtime: runtimeThat(() => ownership.seed(REF, "HUMAN_OWNED", 1)),
    });
    const job = makeJob();
    // The webhook layer reserves the delivery before the pipeline runs; do the
    // same here, otherwise there is no row to close and the assertion is vacuous.
    await ledger.reserve({
      identity: job.identity,
      digest: job.digest,
      correlationId: job.correlationId,
      conversationId: job.conversationId,
      messageId: job.payload.messageId,
      mode: "answer",
      leaseMs: 60_000,
    });
    expect([...ledger.rows.values()].map((r) => r.state)).toEqual(["reserved"]);

    await processDelivery(deps, job);

    // Exactly ONE row (the delivery itself), completed. Today there are three:
    // the delivery row plus a claimed write row for the reply and one for the
    // annotation, because the reply path ran. A suppressed delivery claims no write.
    const states = [...ledger.rows.values()].map((r) => r.state);
    expect(states).toEqual(["completed"]);
    // and a recovery sweep finds nothing to resend
    ledger.expireAllLeases();
    expect(await ledger.dueForRecovery(10)).toHaveLength(0);
  });

  it("NO business mutation fires: no status change, assignment, note, label or attribute write", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(() => ownership.seed(REF, "HUMAN_OWNED", 1)),
    });

    await processDelivery(deps, makeJob());

    // Today this lists the customer message AND the "replied" annotation write.
    expect(chatwootWrites(chatwoot)).toEqual([]);
  });

  it("a runtime that asks for a human (structured request_human) does NOT escalate into a conversation a human already took", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(
        () => ownership.seed(REF, "HUMAN_OWNED", 1),
        {
          ...OK_RESULT,
          action: "request_human",
          actionReason: "explicit_human_request",
          contractVersion: 2,
        },
      ),
    });

    await processDelivery(deps, makeJob());

    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(chatwoot.assignments).toHaveLength(0);
    expect(chatwoot.privateNotes).toHaveLength(0);
  });
});

describe("the GENERATION (episode) is checked, not only the state", () => {
  it("a human took it AND handed it back mid-run (state is AI-authorised again, episode moved on): the stale answer is NOT sent", async () => {
    const ownership = new InMemoryOwnershipGate();
    const { deps, chatwoot } = makeDeps({
      ownership,
      // The run started under episode 0 (no row). While it ran a human held the
      // conversation (episode 1) and handed it back (state AI_RESUMED, episode 2).
      // The answer was composed for a conversation that has since moved on.
      runtime: runtimeThat(() => ownership.seed(REF, "AI_RESUMED", 2)),
    });

    const result = await processDelivery(deps, makeJob());

    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(result.outcome).toBe("suppressed_in_flight");
  });

  it("CONTROL: an AI-authorised state at the SAME episode is NOT suppressed (the recheck must not refuse everything)", async () => {
    const ownership = new InMemoryOwnershipGate();
    // Starts AI_RESUMED at episode 2 and is still AI_RESUMED at episode 2 after the run.
    ownership.seed(REF, "AI_RESUMED", 2);
    const { deps, chatwoot } = makeDeps({
      ownership,
      runtime: runtimeThat(() => ownership.seed(REF, "AI_RESUMED", 2)),
    });

    const result = await processDelivery(deps, makeJob());

    expect(result.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

describe("the recheck is the LAST thing before the write, and it fails CLOSED", () => {
  it("event order: runtime returns -> ownership is read AGAIN -> only then the reply is posted", async () => {
    const events: string[] = [];

    class OrderedOwnership extends InMemoryOwnershipGate {
      override async read(ref: ConversationRef): Promise<OwnershipView> {
        events.push("ownership.read");
        return super.read(ref);
      }
    }
    class OrderedChatwoot extends StubChatwootApi {
      override async postMessage(
        target: ChatwootTarget,
        content: string,
        isPrivate: boolean,
        deliveryRef?: string,
      ): Promise<number | null> {
        events.push(isPrivate ? "post.private" : "post.customer");
        return super.postMessage(target, content, isPrivate, deliveryRef);
      }
    }

    const ownership = new OrderedOwnership();
    const chatwoot = new OrderedChatwoot();
    const { deps } = makeDeps({
      ownership,
      chatwoot,
      runtime: new StubAgentRuntime(async () => {
        events.push("runtime.returned");
        return OK_RESULT;
      }),
    });

    await processDelivery(deps, makeJob());

    const returned = events.indexOf("runtime.returned");
    const post = events.indexOf("post.customer");
    expect(returned).toBeGreaterThanOrEqual(0);
    expect(post).toBeGreaterThan(returned);
    const readsBetween = events
      .slice(returned + 1, post)
      .filter((e) => e === "ownership.read").length;
    expect(
      readsBetween,
      `no ownership read between runtime return and the reply write; events: ${events.join(" > ")}`,
    ).toBeGreaterThanOrEqual(1);
  });

  it("if the store becomes unreachable for the recheck, the reply is NOT sent (fail closed) and the row stays open for the sweeper", async () => {
    // First read (pre-run gate) succeeds; every later read rejects.
    let reads = 0;
    class FlakyOwnership extends InMemoryOwnershipGate {
      override async read(ref: ConversationRef): Promise<OwnershipView> {
        reads += 1;
        if (reads > 1) throw new Error("ownership store unavailable");
        return super.read(ref);
      }
    }
    const { deps, chatwoot, ledger } = makeDeps({ ownership: new FlakyOwnership() });
    const job = makeJob();

    // The unreachable-store contract in this gateway is "reject, the lease
    // expires, the sweeper retries" — so a rejection is acceptable here; what is
    // NOT acceptable is a reply that went out without the second read succeeding.
    await processDelivery(deps, job).catch(() => undefined);

    expect(reads, "the recheck never happened").toBeGreaterThan(1);
    expect(chatwoot.customerMessages, "replied without being able to find out who owns the conversation").toHaveLength(0);
    expect([...ledger.rows.values()].map((r) => r.state)).not.toContain("completed");
  });

  it("CONTROL (same harness): an ownership store that is unreachable from the START already fails closed today", async () => {
    const { deps, chatwoot } = makeDeps({ ownership: new UnavailableOwnershipGate() });

    await processDelivery(deps, makeJob()).catch(() => undefined);

    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});
