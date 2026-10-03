/**
 * CODEX ROUND 6, G6-4 (review of 91a7ce4): a FULLY PUBLISHED handoff, interrupted only at the
 * close of the delivery, received a SECOND private note from recovery.
 *
 * The live handoff opens the conversation, posts `handoff_note` and completes
 * `handoff_customer_message`. The ownership hold it recorded is `handoff:<event>`. If the process
 * dies only when the delivery row is being closed, recovery found an own hold, so the completed
 * acknowledgement did not count as complete; it then claimed the DISTINCT `failure_note` action
 * and posted a second private note for the same handover (private notes 1 -> 2).
 *
 * The rule under test: a durably COMPLETED handoff publication (status change, note and
 * acknowledgement all completed rows) is recognised and the delivery is simply closed; an
 * UNFINISHED own hold (the publication did not finish) still escalates. Recovery does not ignore
 * own holds in general.
 *
 * Every test runs the REAL sweeper (Law 20). ALL TESTS ARE SOCKET-FREE. Laws 11, 19, 23, 28.
 */
import { describe, expect, it } from "vitest";

import { ChatwootApiError } from "../src/errors.js";
import { processDelivery } from "../src/pipeline.js";
import {
  build,
  inProgressActions,
  makeJob,
  reserve,
  stateOf,
  sweeperFor,
} from "./codex6-recovery-support.js";

/** Simulate a crash at the very end: every action is done, the DELIVERY row is not closed. */
function crashAtDeliveryClose(ledger: ReturnType<typeof build>["ledger"]): void {
  for (const [key, r] of ledger.rows) if (key.endsWith("|delivery")) r.state = "in_progress";
}

describe("G6-4: a fully published handover is not escalated a second time", () => {
  it("handoff: opened, noted and acknowledged, then a crash at the delivery close: NO second note, NO second customer message", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob("handoff");
    await reserve(ledger, job);
    await processDelivery(deps, job);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);

    crashAtDeliveryClose(ledger);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);
  });

  it("CONTROL: an escalating REPLY (reply, note and status completed) interrupted only at the close gets no second note either", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob("answer");
    await reserve(ledger, job);
    await processDelivery(deps, job);
    const notes = chatwoot.privateNotes.length;
    const replies = chatwoot.customerMessages.length;
    expect(replies).toBe(1);
    expect(notes).toBe(1);

    crashAtDeliveryClose(ledger);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();

    expect(chatwoot.privateNotes).toHaveLength(notes);
    expect(chatwoot.customerMessages).toHaveLength(replies);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL (the publication check is real): a handoff whose NOTE failed (the customer WAS acknowledged) still gets one recovery escalation, so a colleague gets the context", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob("handoff");
    await reserve(ledger, job);
    chatwoot.privateNoteFailure = new ChatwootApiError("note refused", 500);
    await processDelivery(deps, job);
    expect(chatwoot.customerMessages).toHaveLength(1);
    chatwoot.privateNoteFailure = null;

    crashAtDeliveryClose(ledger);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();

    const recoveryNotes = chatwoot.privateNotes.filter((n) => (n.content ?? "").includes("recovery_escalated"));
    expect(recoveryNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("the completed handoff gets NO recovery note at all", async () => {
    const { deps, chatwoot, ledger, capture } = build();
    const job = makeJob("handoff");
    await reserve(ledger, job);
    await processDelivery(deps, job);
    crashAtDeliveryClose(ledger);
    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();
    expect(chatwoot.privateNotes.filter((n) => (n.content ?? "").includes("recovery_escalated"))).toHaveLength(0);
  });

  it("CONTROL (the unfinished own hold is NOT ignored): a handoff cut off BEFORE its note and acknowledgement still escalates once", async () => {
    // The turn clock jumps past the budget the moment `handoff_note` is claimed: the status change
    // is done, the note and the acknowledgement are not.
    const { deps, chatwoot, ledger, capture } = build({ stallAt: "handoff_note" });
    const job = makeJob("handoff");
    await reserve(ledger, job);
    await processDelivery(deps, job);
    expect(chatwoot.customerMessages).toHaveLength(0);

    ledger.expireAllLeases();
    await sweeperFor(deps, capture).sweeper.sweep();

    // The recovery escalation note (a different, distinct action) is the one note that exists.
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
    expect(inProgressActions(ledger)).toEqual([]);
  });
});
