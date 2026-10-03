/**
 * CODEX ROUND 6, G6-2 (review of 91a7ce4): a failed disposition write must not let the delivery
 * close with action rows still in_progress.
 *
 * `settleOpenActions` swallowed an individual failure, re-read the rows and returned them; its
 * callers closed the delivery regardless. Four paths did it (escalation, supersession,
 * provably-complete-with-annotation, attempt-cap abandonment). The leftovers were then invisible:
 * the sweeper selects unfinished DELIVERY rows, so an in_progress action under a completed
 * delivery is never looked at again.
 *
 * The rule under test: every action row ends with a recorded disposition BEFORE the delivery is
 * closed. If any required disposition cannot be recorded the delivery stays RECOVERABLE (open,
 * swept again), and the next sweep, once the ledger works, settles it. The success path (all
 * dispositions recordable) still closes the delivery: the positive control.
 *
 * Every test runs the REAL sweeper (Law 20). ALL TESTS ARE SOCKET-FREE. Laws 11, 19, 23, 28.
 */
import { describe, expect, it } from "vitest";

import { LedgerUnavailableError } from "../src/ledger.js";
import {
  build,
  inProgressActions,
  makeJob,
  refOf,
  reserve,
  row,
  stateOf,
  sweeperFor,
} from "./codex6-recovery-support.js";

type Route = "escalate" | "supersede" | "provably_complete" | "abandon";
const ROUTES: readonly Route[] = ["escalate", "supersede", "provably_complete", "abandon"];

/** The action whose disposition write is made to fail on each route. */
const STUCK: Record<Route, string> = {
  escalate: "reply",
  supersede: "reply",
  provably_complete: "labels",
  abandon: "reply",
};

async function arrange(route: Route) {
  const world = build();
  const job = makeJob();
  await reserve(world.ledger, job);
  const action = STUCK[route];
  await world.ledger.claimAction(job.identity, action, job.digest, job.correlationId, 300_000);
  if (route === "supersede") world.ownership.seed(refOf(job), "HUMAN_OWNED", 2);
  if (route === "provably_complete") {
    // The reply is a completed row (the customer-facing outcome); only a bookkeeping label claim is open.
    await world.ledger.claimAction(job.identity, "reply", job.digest, job.correlationId, 300_000);
    await world.ledger.complete(job.identity, "reply", 9010);
  }
  if (route === "abandon") {
    for (const [key, r] of world.ledger.rows) if (key.endsWith("|delivery")) r.attempts = 8;
  }
  return { world, job, action };
}

/** Make exactly one action's disposition write fail (`ledger.fail` throws), as a transient ledger error would. */
function breakDispositionWrite(world: Awaited<ReturnType<typeof arrange>>["world"], action: string) {
  const realFail = world.ledger.fail.bind(world.ledger);
  let broken = true;
  world.ledger.fail = async (identity, a, code) => {
    if (broken && a === action) throw new LedgerUnavailableError("one transient failed statement");
    await realFail(identity, a, code);
  };
  return { repair: () => void (broken = false) };
}

describe("G6-2: a disposition that cannot be recorded leaves the delivery recoverable", () => {
  for (const route of ROUTES) {
    it(`${route}: the delivery is NOT closed while an action row is still in_progress`, async () => {
      const { world, action } = await arrange(route);
      breakDispositionWrite(world, action);
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture).sweeper.sweep();
      expect(inProgressActions(world.ledger)).toContain(action);
      expect(["completed", "failed"]).not.toContain(stateOf(world.ledger, "delivery"));
    });

    it(`${route}: once the ledger works, the NEXT sweep records the disposition and closes the delivery`, async () => {
      const { world, action } = await arrange(route);
      const broken = breakDispositionWrite(world, action);
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture).sweeper.sweep();
      broken.repair();
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture).sweeper.sweep();
      expect(inProgressActions(world.ledger)).toEqual([]);
      expect(["completed", "failed"]).toContain(stateOf(world.ledger, "delivery"));
      expect(row(world.ledger, action)?.state).not.toBe("in_progress");
    });

    it(`CONTROL ${route}: when every disposition IS recordable the delivery closes with nothing in_progress`, async () => {
      const { world } = await arrange(route);
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture).sweeper.sweep();
      expect(inProgressActions(world.ledger)).toEqual([]);
      expect(["completed", "failed"]).toContain(stateOf(world.ledger, "delivery"));
    });
  }
});
