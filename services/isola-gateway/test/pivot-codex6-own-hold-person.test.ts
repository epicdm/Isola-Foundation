/**
 * CODEX ROUND 6, G6-3 (review of 91a7ce4): this delivery's OWN stale hold bypassed READABLE human
 * ownership in Chatwoot.
 *
 * The scenario: this delivery recorded the `HUMAN_REQUESTED` hold, the process died, and during the
 * outage a person answered and resolved the conversation (or took it by assigning themselves). The
 * ownership store never saw that. Chatwoot's own record now says `resolved` / has an assignee. The
 * recovery sweeper skipped the Chatwoot person check because `ownHold` was true, so it posted
 * ANOTHER private note and re-opened a conversation a person had finished. The identical situation
 * WITHOUT an own hold superseded correctly.
 *
 * The rule under test: an own hold does not override READABLE evidence that a person has the
 * conversation. The evidence that counts for an own hold is the assignee, or a status the gateway
 * itself never sets (`resolved`, `snoozed`): a plain `open` is what the gateway's OWN escalation
 * leaves behind, so on its own it proves nothing. An unreadable record stays fail-open, as
 * documented: monitored sandbox testing, NOT fail-closed ownership authorisation.
 *
 * Every test runs the REAL sweeper (Law 20) against the stub Chatwoot in its WINDOW model, which now
 * carries `status` and `meta.assignee`. ALL TESTS ARE SOCKET-FREE. Each refusal has its positive
 * twin (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import {
  build,
  EVENT_ID,
  makeJob,
  refOf,
  reserve,
  stateOf,
  sweeperFor,
} from "./codex6-recovery-support.js";

async function interruptedWithOwnHold(personAction: ((c: ReturnType<typeof build>["chatwoot"]) => void) | null) {
  const world = build();
  const job = makeJob();
  await reserve(world.ledger, job);
  // This delivery's own durable hold, recorded before the crash.
  world.ownership.seed(refOf(job), "HUMAN_REQUESTED", 1, `escalate:${EVENT_ID}`);
  if (personAction !== null) personAction(world.chatwoot);
  world.ledger.expireAllLeases();
  await sweeperFor(world.deps, world.capture).sweeper.sweep();
  return world;
}

describe("G6-3: an own hold does not override readable human evidence in Chatwoot", () => {
  it("a person RESOLVED the conversation during the outage: no second note, no re-open, delivery closed", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => c.personResolves());
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("a person TOOK the conversation (assignee set, open) during the outage: nothing is written", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => c.personTakesOver());
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("a RESOLVED status with no assignee is also a person's doing (the gateway never resolves)", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => {
      c.conversationStatus = "resolved";
    });
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("a SNOOZED status is also a person's doing", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => {
      c.conversationStatus = "snoozed";
    });
    expect(chatwoot.privateNotes).toHaveLength(0);
    expect(chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL (the identical situation WITHOUT an own hold already superseded): resolved + assigned, no hold", async () => {
    const world = build();
    const job = makeJob();
    await reserve(world.ledger, job);
    world.chatwoot.personResolves();
    world.ledger.expireAllLeases();
    await sweeperFor(world.deps, world.capture).sweeper.sweep();
    expect(world.chatwoot.privateNotes).toHaveLength(0);
    expect(world.chatwoot.statusToggles).toHaveLength(0);
    expect(stateOf(world.ledger, "delivery")).toBe("completed");
  });

  it("CONTROL: an own hold on a conversation Chatwoot shows as plain OPEN with NO assignee (what the gateway's own escalation leaves) is NOT a person: the escalation proceeds", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => {
      c.conversationStatus = "open";
    });
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL: an own hold on a conversation still PENDING (nobody has it) escalates exactly once", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold(null);
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(chatwoot.statusToggles).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });

  it("CONTROL (documented fail-open): an own hold with an UNREADABLE Chatwoot record still escalates", async () => {
    const { chatwoot, ledger } = await interruptedWithOwnHold((c) => {
      c.servedRecord = {};
    });
    expect(chatwoot.privateNotes).toHaveLength(1);
    expect(stateOf(ledger, "delivery")).toBe("completed");
  });
});
