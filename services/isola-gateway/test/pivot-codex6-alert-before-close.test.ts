/**
 * CODEX ROUND 6, G6-5 (review of 91a7ce4): the delivery closed BEFORE its required alert.
 *
 * The specified order is dispositions -> ALERT -> close. The code did close -> alert, so an alert
 * sink that threw (or a process that died between the two) left a closed delivery whose required
 * alert could never be retried: the sweeper only looks at unfinished DELIVERY rows.
 *
 * The rule under test: the alert is raised BEFORE the delivery is closed; if the sink throws the
 * delivery stays open and the next sweep tries again; with a working sink the delivery closes and
 * the alert was seen exactly once.
 *
 * WHAT THIS DOES NOT GUARANTEE (stated, not hidden): the alert is at-least-once, not exactly-once
 * (a crash after the alert and before the close raises it again on the next sweep); there is no
 * durable "alert acknowledged" state (that needs a schema this slice does not have); and the
 * default sink is a loud ERROR log line, which reaches no person out-of-band today.
 *
 * Every test runs the REAL sweeper (Law 20). ALL TESTS ARE SOCKET-FREE. Laws 11, 19, 23, 28.
 */
import { describe, expect, it } from "vitest";

import type { RecoveryAlert } from "../src/recovery-escalation.js";
import {
  build,
  makeJob,
  reserve,
  stateOf,
  sweeperFor,
} from "./codex6-recovery-support.js";

type Route = "escalate" | "abandon";

async function arrange(route: Route) {
  const world = build();
  const job = makeJob();
  await reserve(world.ledger, job);
  if (route === "abandon") {
    for (const [key, r] of world.ledger.rows) if (key.endsWith("|delivery")) r.attempts = 8;
  }
  return { world, job };
}

/** A sink that records the delivery's state AT the moment it is called, and can be made to throw. */
function observingSink(world: Awaited<ReturnType<typeof arrange>>["world"]) {
  const seen: Array<{ code: string; deliveryState: string }> = [];
  const control = { throwing: false };
  return {
    seen,
    control,
    sink: {
      raise(alert: RecoveryAlert): void {
        seen.push({ code: alert.alertCode, deliveryState: stateOf(world.ledger, "delivery") });
        if (control.throwing) throw new Error("alert sink failed");
      },
    },
  };
}

const TERMINAL: Record<Route, string> = { escalate: "completed", abandon: "failed" };
const ALERT_CODE: Record<Route, string> = {
  escalate: "recovery_escalated_to_human",
  abandon: "recovery_abandoned",
};

describe("G6-5: the alert is raised BEFORE the delivery is closed", () => {
  for (const route of ["escalate", "abandon"] as const) {
    it(`${route}: when the alert is raised the delivery is NOT yet terminal`, async () => {
      const { world } = await arrange(route);
      const watcher = observingSink(world);
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture, { alertSink: watcher.sink }).sweeper.sweep();
      const alert = watcher.seen.find((s) => s.code === ALERT_CODE[route]);
      expect(alert).toBeDefined();
      expect(["completed", "failed"]).not.toContain(alert!.deliveryState);
      // ... and afterwards it is closed.
      expect(stateOf(world.ledger, "delivery")).toBe(TERMINAL[route]);
    });

    it(`${route}: a sink that THROWS leaves the delivery open, and the next sweep retries the alert and closes it`, async () => {
      const { world } = await arrange(route);
      const watcher = observingSink(world);
      watcher.control.throwing = true;
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture, { alertSink: watcher.sink }).sweeper.sweep();
      expect(["completed", "failed"]).not.toContain(stateOf(world.ledger, "delivery"));

      watcher.control.throwing = false;
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture, { alertSink: watcher.sink }).sweeper.sweep();
      expect(stateOf(world.ledger, "delivery")).toBe(TERMINAL[route]);
      // The alert reached the sink at least twice (the failed attempt and the successful one).
      expect(watcher.seen.filter((s) => s.code === ALERT_CODE[route]).length).toBeGreaterThanOrEqual(2);
    });

    it(`CONTROL ${route}: with a working sink the alert is seen exactly once and the delivery is closed`, async () => {
      const { world } = await arrange(route);
      const watcher = observingSink(world);
      world.ledger.expireAllLeases();
      await sweeperFor(world.deps, world.capture, { alertSink: watcher.sink }).sweeper.sweep();
      expect(watcher.seen.filter((s) => s.code === ALERT_CODE[route])).toHaveLength(1);
      expect(stateOf(world.ledger, "delivery")).toBe(TERMINAL[route]);
    });
  }
});
