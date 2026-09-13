/**
 * Handback — the return edge that had no caller.
 *
 * These are unit proofs of the DECISION logic. The transition guarantees
 * themselves (locking, unique claim, episode fencing) are proven against real
 * Postgres in `ownership-store.pg.test.ts`, which refuses to pass without a
 * database. Nothing here re-asserts those.
 */
import { describe, expect, it } from "vitest";

import { readAssignee, readConversationStatus, readLastActivityMs } from "../src/handback.js";
import { hasAssignee } from "../src/webhook.js";

describe("readLastActivityMs — idleness is read from Chatwoot, not inferred", () => {
  it("reads seconds and converts to milliseconds", () => {
    expect(readLastActivityMs({ payload: { last_activity_at: 1_786_900_000 } })).toBe(
      1_786_900_000_000,
    );
  });

  it("reads an unwrapped record as well as a payload-wrapped one", () => {
    expect(readLastActivityMs({ last_activity_at: 1_786_900_000 })).toBe(1_786_900_000_000);
  });

  it("accepts an ISO timestamp", () => {
    expect(readLastActivityMs({ last_activity_at: "2026-08-16T22:42:04.000Z" })).toBe(
      Date.parse("2026-08-16T22:42:04.000Z"),
    );
  });

  /**
   * THE ONE THAT MATTERS. A shape we do not recognise must return null, never 0.
   *
   * 0 would read as "idle since 1970" and the sweeper would hand back EVERY
   * human-held conversation on its first pass — silently taking live
   * conversations away from the people holding them. Returning null makes an
   * unreadable record mean "leave it alone", which is the safe direction.
   */
  it("returns null — never 0 — for a record it cannot read", () => {
    for (const bad of [
      null,
      undefined,
      42,
      "nope",
      {},
      { payload: {} },
      { last_activity_at: null },
      { last_activity_at: 0 },
      { last_activity_at: -1 },
      { last_activity_at: "not a date" },
      { last_activity_at: Number.NaN },
    ]) {
      expect(readLastActivityMs(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("an unreadable record is NOT treated as idle at any threshold", () => {
    const idleMs = 10 * 60 * 1000;
    const now = 1_786_900_000_000;
    const lastActivity = readLastActivityMs({ payload: { conversation: "no timestamp" } });
    // The sweeper's own predicate: null must short-circuit before the comparison.
    const wouldHandBack = lastActivity !== null && now - lastActivity >= idleMs;
    expect(wouldHandBack).toBe(false);
  });
});

/**
 * TRIGGER 1 — the manual trigger's compound condition.
 *
 * GitHub Codex review of PR #135: "pending" alone is not a completed
 * handback. def-handback-sweeper-is-blind-to-manually-assigned-conversations
 * -2026-09-13's own fix (reconcileObservedAssignment) can now put a
 * conversation into HANDBACK_ELIGIBLE_STATES while it is STILL genuinely
 * assigned in Chatwoot — "pending + assigned" is a real, measured production
 * state (6 such conversations), not a hypothetical. Before that fix this gap
 * was latent: a manually-assigned conversation never reached the sweeper at
 * all. This mirrors the sweeper's own predicate directly, the same way
 * `readLastActivityMs`'s sibling describe block above tests the idle
 * predicate by reconstructing the expression rather than invoking the whole
 * sweep loop.
 */
describe("readAssignee — the manual trigger's OTHER half", () => {
  it("reads meta.assignee from a payload-wrapped record", () => {
    expect(readAssignee({ payload: { meta: { assignee: { id: 7 } } } })).toEqual({ id: 7 });
  });

  it("reads meta.assignee from an unwrapped record", () => {
    expect(readAssignee({ meta: { assignee: { id: 7 } } })).toEqual({ id: 7 });
  });

  it("returns null for every shape it cannot read, never throwing", () => {
    for (const bad of [null, undefined, 42, "nope", {}, { meta: {} }, { meta: null }]) {
      expect(readAssignee(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe("the manual trigger requires BOTH pending AND no assignee — status alone is not the gesture", () => {
  const manualTrigger = (record: unknown, recordReadable: boolean): boolean =>
    recordReadable && readConversationStatus(record) === "pending" && !hasAssignee(readAssignee(record));

  it("fires on a genuine handback: pending, and unassigned", () => {
    expect(manualTrigger({ status: "pending", meta: { assignee: null } }, true)).toBe(true);
  });

  it("does NOT fire on pending-but-still-assigned — the exact production shape (6 measured rows)", () => {
    expect(manualTrigger({ status: "pending", meta: { assignee: { id: 7 } } }, true)).toBe(false);
  });

  it("does not fire on an assigned conversation with no status change at all", () => {
    expect(manualTrigger({ status: "open", meta: { assignee: { id: 7 } } }, true)).toBe(false);
  });

  it("does not fire when the record could not be read at all — unreadable is never treated as a gesture", () => {
    expect(manualTrigger({ status: "pending", meta: { assignee: null } }, false)).toBe(false);
  });

  it("an assignee object with no usable id does not count as assigned (matches hasAssignee's own rule)", () => {
    expect(manualTrigger({ status: "pending", meta: { assignee: {} } }, true)).toBe(true);
  });
});

describe("the idle threshold is measured from the LAST MESSAGE, not from takeover", () => {
  const IDLE_MS = 10 * 60 * 1000;
  const now = 1_786_900_000_000;

  it("does not hand back while a human is still replying", () => {
    // Took over 30 minutes ago, spoke 1 minute ago. An elapsed-since-takeover
    // timer would cut across a live conversation; an idle timer must not.
    const lastActivity = now - 60_000;
    expect(now - lastActivity >= IDLE_MS).toBe(false);
  });

  it("hands back once the conversation itself has gone quiet", () => {
    const lastActivity = now - 11 * 60 * 1000;
    expect(now - lastActivity >= IDLE_MS).toBe(true);
  });

  it("does not hand back one second early", () => {
    const lastActivity = now - (IDLE_MS - 1000);
    expect(now - lastActivity >= IDLE_MS).toBe(false);
  });
});

/**
 * The IDLE trigger's OWN assignee guard.
 *
 * GitHub Codex review of PR #135, pass 2 (P2): the manual trigger got the
 * `!hasAssignee` guard, but the idle trigger — a fully independent branch —
 * did not. A directly-assigned conversation sitting idle for the threshold,
 * while STILL genuinely assigned, would be handed back on the idle clock
 * alone: same defect, a different door in.
 *
 * ONLY when the record is readable, deliberately — see the sweeper's own
 * comment: an unreadable record is the EXPECTED shape once a conversation
 * has a TEAM assigned (conversations#show 500s for an AgentBot token then),
 * which is exactly what this gateway's own escalation flow does. Making
 * idle depend on record-readability would silently stop the idle trigger
 * from ever firing for that case — the one it exists for.
 */
describe("the idle trigger also requires no assignee — but ONLY when the record is readable", () => {
  const idleTrigger = (record: unknown, recordReadable: boolean): boolean => {
    const stillAssigned = recordReadable && hasAssignee(readAssignee(record));
    return !stillAssigned;
  };

  it("does not block idle handback when unassigned", () => {
    expect(idleTrigger({ meta: { assignee: null } }, true)).toBe(true);
  });

  it("blocks idle handback while genuinely still assigned", () => {
    expect(idleTrigger({ meta: { assignee: { id: 7 } } }, true)).toBe(false);
  });

  it("does NOT block idle handback when the record is unreadable — the team-assigned, 500-on-read case this trigger exists for", () => {
    // Even though this record, if it COULD be read, shows an assignee — the
    // point is precisely that an unreadable record must not be treated as
    // "still assigned" and must not silently disable the idle trigger.
    expect(idleTrigger({ meta: { assignee: { id: 7 } } }, false)).toBe(true);
  });
});
