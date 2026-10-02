/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, item (b)(3): EXPLICIT-ONLY HANDBACK.
 *
 * TESTS FIRST; the idle-sweeper tests FAIL today on purpose.
 *
 * THE RATIFIED CONTRACT
 *   A conversation a human holds is handed back to the AI ONLY by an explicit,
 *   verified Chatwoot transition: the human pressing "Mark as pending", which
 *   Chatwoot reports as a signed `conversation_status_changed` -> `pending`.
 *   Idleness is not consent: a human who went to lunch has not handed the
 *   customer back. Open Port defect
 *   def-idle-timeout-handback-contradicts-ratified-explicit-contract-2026-08-20
 *   (P1) records that the idle-timer sweeper does exactly that.
 *
 * WHAT THE CODE DOES TODAY (CODE-ONLY, read at 8b5feb3)
 *   `createHandbackSweeper` (handback.ts) has two triggers: MANUAL (Chatwoot
 *   status is already `pending`) and IDLE (no business turn for
 *   `handbackIdleMs`, default 10 min). The idle trigger runs `performHandback`
 *   with reason "idle_timeout" and actor "gateway:handback-sweeper", and
 *   server.ts starts it unconditionally.
 *
 * AN HONEST WARNING ABOUT THE EXISTING SUITE (Law 28)
 *   test/handback-sweeper.test.ts asserts the OPPOSITE of the tests below
 *   ("still hands back when the Chatwoot record is unreadable", "a recent
 *   CUSTOMER message does not delay handback", "falls back to the ownership
 *   clock"). Those tests PASS today and encode idle handback as intended.
 *   Whoever implements this contract must change or delete them in the same
 *   commit; they are not wrong tests, they are tests of a decision the contract
 *   has since overturned. They are deliberately NOT edited here.
 *
 * CONTROLS (same harness, so the negatives cannot pass vacuously: Laws 19/23)
 *   - the manual trigger (status already `pending`) DOES hand back through the
 *     very same sweeper and the very same fake store;
 *   - the signed-webhook explicit path (`handleManualHandbackWebhook`) DOES
 *     attempt the handback from every human-held state.
 */
import { describe, expect, it, vi } from "vitest";

import { createHandbackSweeper, handleManualHandbackWebhook } from "../src/handback.js";
import type { HandbackSweeperDeps } from "../src/handback.js";

const NOW = Date.parse("2026-10-02T12:00:00.000Z");
const IDLE_MS = 10 * 60 * 1000;

function ownershipRow(): Record<string, unknown> {
  return {
    tenant_id: "pivot-test-tenant",
    conversation_key: "cw:2:2",
    ownership_episode: 1,
    chatwoot_account_id: 2,
    chatwoot_conversation_id: 2,
    chatwoot_inbox_id: 7,
    // The human took it ten hours ago and has been silent since.
    ownership_changed_at: new Date(NOW - 10 * 60 * 60 * 1000).toISOString(),
  };
}

interface Harness {
  deps: HandbackSweeperDeps;
  logs: Array<Record<string, unknown>>;
  /** One entry per `performHandback` transition attempt (exec.transaction is the seam). */
  attempts: Array<Record<string, unknown>>;
}

function harness(opts: {
  showStatus?: string;
  showThrows?: boolean;
  lastBusinessTurnAt?: number | null;
}): Harness {
  const logs: Array<Record<string, unknown>> = [];
  const attempts: Array<Record<string, unknown>> = [];

  const exec = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("FROM conversation_ownership")) {
        return { rows: [ownershipRow()], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }),
    transaction: vi.fn(async () => {
      attempts.push({ attempted: true });
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
      return { payload: { status: opts.showStatus ?? "open" } };
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
    turnStore,
  } as unknown as HandbackSweeperDeps;

  return { deps, logs, attempts };
}

const skips = (logs: Array<Record<string, unknown>>) =>
  logs.filter((l) => l["outcome"] === "sweep_skipped");

// ---------------------------------------------------------------------------
// CONTROLS: PASS today.
// ---------------------------------------------------------------------------

describe("CONTROLS: an explicit gesture hands back, in this very harness", () => {
  it("CONTROL: the human pressed 'Mark as pending' (status already pending) -> the sweeper hands back, ignoring the clock", async () => {
    const h = harness({ showStatus: "pending", lastBusinessTurnAt: NOW - 1_000 });

    await createHandbackSweeper(h.deps).sweep();

    expect(h.attempts, "the explicit gesture must hand back").toHaveLength(1);
  });

  it.each(["HUMAN_REQUESTED", "HUMAN_OWNED", "HANDING_BACK"])(
    "CONTROL: the signed status-changed webhook attempts the handback from %s",
    async (state) => {
      const attempts: unknown[] = [];
      const exec = {
        query: vi.fn(async (sql: string) =>
          sql.includes("FROM conversation_ownership")
            ? {
                rows: [
                  {
                    ownership_state: state,
                    ownership_episode: 1,
                    handover_ack_episode: null,
                    ownership_escalation_operation_id: null,
                  },
                ],
                rowCount: 1,
              }
            : { rows: [], rowCount: 0 },
        ),
        transaction: vi.fn(async () => {
          attempts.push({ attempted: true });
          return { ok: false, status: "conflict" };
        }),
      };
      await handleManualHandbackWebhook(
        {
          exec: exec as never,
          chatwoot: { pendConversation: vi.fn(async () => ({ ok: true })) } as never,
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never,
          now: () => NOW,
        },
        {
          conversation: { tenantId: "pivot-test-tenant", chatwootAccountId: 2, chatwootConversationId: 2 },
          target: { accountId: 2, conversationId: 2, accessToken: "t" } as never,
        },
      );
      expect(attempts, "the explicit signed path must hand back").toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// THE SPECIFICATION: FAIL today (wrong behaviour: the idle timer hands back).
// ---------------------------------------------------------------------------

describe("idleness is NOT a handback", () => {
  it("a human-held conversation whose human went quiet 3 h ago is NOT handed back by the sweeper", async () => {
    const h = harness({ showStatus: "open", lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000 });

    await createHandbackSweeper(h.deps).sweep();

    expect(h.attempts, "the idle timer handed a customer back to the AI with no explicit gesture").toHaveLength(0);
  });

  it("... and the skip is OBSERVABLE (a silent do-nothing is indistinguishable from a dead loop)", async () => {
    const h = harness({ showStatus: "open", lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000 });

    await createHandbackSweeper(h.deps).sweep();

    expect(skips(h.logs)).toHaveLength(1);
  });

  it("an UNREADABLE Chatwoot record plus a long idle is still not a handback (absence of evidence is not consent)", async () => {
    const h = harness({ showThrows: true, lastBusinessTurnAt: NOW - 3 * 60 * 60 * 1000 });

    await createHandbackSweeper(h.deps).sweep();

    expect(h.attempts).toHaveLength(0);
  });

  it("no clock at all (no turn, no activity) is not a handback either: ownership age alone never hands back", async () => {
    const h = harness({ showThrows: true, lastBusinessTurnAt: null });

    await createHandbackSweeper(h.deps).sweep();

    expect(h.attempts).toHaveLength(0);
  });
});
