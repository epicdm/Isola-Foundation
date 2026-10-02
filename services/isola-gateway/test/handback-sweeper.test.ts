/**
 * THE SWEEPER LOOP ITSELF — the thing that had no test and stranded a customer.
 *
 * `handback.test.ts` proves the pure helpers, and every one of them passed while
 * the loop they serve ran once a minute for nine hours and recovered nothing.
 * The helpers were never the defect: the loop's four silent `continue`s were.
 * These tests drive `createHandbackSweeper` end to end against fakes.
 *
 * CHANGED 2026-10-02 (pivot packet ISOLA-PIVOT-20261002-01, same commit as the
 * fix). The ratified contract is EXPLICIT-ONLY handback, so the idle trigger is
 * OFF by default and `test/pivot-explicit-handback-only.test.ts` pins that. The
 * cases below tested idle handback as THE behaviour; they are not wrong tests,
 * they are tests of a decision the contract has since overturned. They are kept
 * as tests of the explicit OPT-IN path (`idleHandbackEnabled: true`, i.e.
 * GATEWAY_HANDBACK_IDLE_ENABLED=true), because that path must still behave
 * exactly as described for any deployment that deliberately turns it on. The
 * default-off behaviour is asserted at the end of this file, against the same
 * harness, so the opt-in flag is the ONLY difference.
 *
 * Measured on 66.118.37.110, 2026-08-17 — conversation cw:2:2, HUMAN_REQUESTED
 * since 01:59:54, still stranded at 12:51 with the customer's message suppressed
 * as `status_not_pending`. `conversations#show` answered 500 for the AgentBot
 * token (a team is assigned, and escalation is what assigns it) while
 * `conversations/2/labels` answered 200 with the SAME token — so the credential
 * was fine and the endpoint was not.
 */
import { describe, expect, it, vi } from "vitest";

import { createHandbackSweeper } from "../src/handback.js";
import type { HandbackSweeperDeps } from "../src/handback.js";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const IDLE_MS = 10 * 60 * 1000;

/** One HUMAN_REQUESTED row, escalated 10 hours ago. */
function ownershipRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: "epic-frontdesk-6737-isola-chat",
    conversation_key: "cw:2:2",
    ownership_episode: 1,
    chatwoot_account_id: 2,
    chatwoot_conversation_id: 2,
    chatwoot_inbox_id: 7,
    ownership_changed_at: new Date(NOW - 10 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

interface Harness {
  deps: HandbackSweeperDeps;
  logs: Array<Record<string, unknown>>;
  claimed: Array<Record<string, unknown>>;
}

function harness(opts: {
  showThrows?: boolean;
  showStatus?: string;
  lastActivityAt?: number | null;
  lastBusinessTurnAt?: number | null;
  withTurnStore?: boolean;
  idleHandbackEnabled?: boolean;
}): Harness {
  const logs: Array<Record<string, unknown>> = [];
  const claimed: Array<Record<string, unknown>> = [];

  /**
   * `exec.transaction` IS THE SEAM. The sweeper calling it is the decision to
   * hand back; what the transition then does to Postgres is proven for real in
   * `ownership-store.pg.test.ts`, which refuses to pass without a database.
   * Asserting here on "did it decide to act" keeps this test about the loop.
   */
  const exec = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM conversation_ownership")) {
        return { rows: [ownershipRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    transaction: vi.fn(async () => {
      claimed.push({ attempted: true });
      return { ok: false, status: "conflict" };
    }),
  };

  const turnStore = {
    query: vi.fn(async () => ({
      rows: [
        {
          last_business:
            opts.lastBusinessTurnAt === null || opts.lastBusinessTurnAt === undefined
              ? null
              : new Date(opts.lastBusinessTurnAt).toISOString(),
        },
      ],
      rowCount: 1,
    })),
  };

  const logger = {
    info: (e: Record<string, unknown>) => logs.push(e),
    warn: (e: Record<string, unknown>) => logs.push(e),
    error: (e: Record<string, unknown>) => logs.push(e),
    debug: (e: Record<string, unknown>) => logs.push(e),
  };

  const chatwoot = {
    getConversationRecord: vi.fn(async () => {
      if (opts.showThrows === true) throw new Error("HTTP 500");
      return {
        payload: {
          status: opts.showStatus ?? "open",
          last_activity_at:
            opts.lastActivityAt === null || opts.lastActivityAt === undefined
              ? undefined
              : Math.floor(opts.lastActivityAt / 1000),
        },
      };
    }),
    pendConversation: vi.fn(async () => ({ ok: true })),
  };

  const deps = {
    exec,
    chatwoot,
    logger,
    idleMs: IDLE_MS,
    intervalMs: 60_000,
    batch: 25,
    now: () => NOW,
    resolveTarget: () => ({ accountId: 2, conversationId: 2, accessToken: "t" }),
    ...(opts.withTurnStore === false ? {} : { turnStore }),
    // OPT-IN idle handback (default is OFF; see the header of this file).
    idleHandbackEnabled: opts.idleHandbackEnabled ?? true,
  } as unknown as HandbackSweeperDeps;

  return { deps, logs, claimed };
}

function skips(logs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return logs.filter((l) => l["outcome"] === "sweep_skipped");
}

describe("[OPT-IN idle handback] A BROKEN conversations#show MUST NOT STRAND THE CUSTOMER", () => {
  /**
   * THE REGRESSION. Before the fix this threw, hit `continue`, and the
   * conversation stayed HUMAN_REQUESTED for ever — silently.
   */
  it("still hands back when the Chatwoot record is unreadable", async () => {
    const h = harness({
      showThrows: true,
      lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000, // human went quiet 3h ago
    });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(skips(h.logs), "it must not have skipped").toHaveLength(0);
    expect(h.claimed, "handback must have been attempted").toHaveLength(1);
  });

  it("falls back to the ownership clock when there is no turn either", async () => {
    // A conversation escalated BEFORE the turn store existed: no business turn,
    // no readable record. It must still become eligible, not be ineligible for
    // ever.
    const h = harness({ showThrows: true, lastBusinessTurnAt: null });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(h.claimed, "handback must have been attempted").toHaveLength(1);
  });
});

describe("[OPT-IN idle handback] THE CLOCK MEASURES THE SIDE THAT OWES A REPLY", () => {
  /**
   * `last_activity_at` moves on ANY message, so a customer sending "are you
   * still there?" reset their own handback clock — the more they chased, the
   * longer they were ignored. Idleness is a property of the business side.
   */
  it("a recent CUSTOMER message does not delay handback", async () => {
    const h = harness({
      lastActivityAt: NOW - 5_000, // customer just chased, 5 seconds ago
      lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000, // business silent 3 hours
    });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(h.claimed, "handback must have been attempted").toHaveLength(1);
  });

  it("a recent BUSINESS message does delay handback", async () => {
    const h = harness({
      lastActivityAt: NOW - 3 * 60 * 60 * 1000,
      lastBusinessTurnAt: NOW - 60_000, // human replied a minute ago
    });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(h.claimed, "handback must NOT have been attempted").toHaveLength(0);
    const s = skips(h.logs);
    expect(s).toHaveLength(1);
    expect(s[0]!["reason"]).toBe("not_idle_yet");
    expect(s[0]!["clock"]).toBe("turn_store");
  });
});

describe("EVERY SKIP IS OBSERVABLE", () => {
  /**
   * The loop ran 540 times over nine hours and logged nothing but "started".
   * A sweeper that cannot say why it did nothing cannot be distinguished from
   * one that is working.
   */
  it("logs a reason when no binding resolves", async () => {
    const h = harness({ lastBusinessTurnAt: NOW - 60_000 });
    const deps = { ...h.deps, resolveTarget: () => null } as HandbackSweeperDeps;
    const sweeper = createHandbackSweeper(deps);
    await sweeper.sweep();

    const s = skips(h.logs);
    expect(s).toHaveLength(1);
    expect(s[0]!["reason"]).toBe("no_binding");
    expect(s[0]!["conversationId"]).toBe(2);
  });

  it("names the clock it used, so a wrong clock is visible in the log", async () => {
    const h = harness({ withTurnStore: false, lastActivityAt: NOW - 60_000 });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(skips(h.logs)[0]!["clock"]).toBe("chatwoot");
  });
});

describe("the manual trigger still works", () => {
  it("hands back immediately when a human marked it pending, ignoring the clock", async () => {
    const h = harness({
      showStatus: "pending",
      lastBusinessTurnAt: NOW - 1_000, // not idle at all
    });
    const sweeper = createHandbackSweeper(h.deps);
    await sweeper.sweep();

    expect(h.claimed, "handback must have been attempted").toHaveLength(1);
  });
});

describe("DEFAULT: idle handback is OFF — the same harness, the flag is the only difference", () => {
  it("CONTROL: with idle handback opted in, the long-idle conversation IS handed back", async () => {
    const h = harness({ lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000, idleHandbackEnabled: true });
    await createHandbackSweeper(h.deps).sweep();

    expect(h.claimed, "the opt-in path must still hand back").toHaveLength(1);
  });

  it("with the flag OFF the very same conversation is NOT handed back, and the skip says why", async () => {
    const h = harness({ lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000, idleHandbackEnabled: false });
    await createHandbackSweeper(h.deps).sweep();

    expect(h.claimed).toHaveLength(0);
    const s = skips(h.logs);
    expect(s).toHaveLength(1);
    expect(s[0]!["reason"]).toBe("idle_handback_disabled");
  });

  it("with the flag ABSENT (the shape of every deployment that never set it) it is off", async () => {
    const h = harness({ lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000 });
    delete (h.deps as unknown as Record<string, unknown>)["idleHandbackEnabled"];
    await createHandbackSweeper(h.deps).sweep();

    expect(h.claimed).toHaveLength(0);
  });
});
