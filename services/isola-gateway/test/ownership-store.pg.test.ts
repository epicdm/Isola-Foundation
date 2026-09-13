/**
 * The durable ownership store, proven against a REAL Postgres.
 *
 * WHY THIS FILE EXISTS AND WHY IT REFUSES TO BE SKIPPED QUIETLY
 * ------------------------------------------------------------
 * Every guarantee this store makes is a database guarantee. A test double
 * cannot prove any of them: an in-memory fake would report `duplicate` because
 * the fake was written to, and would keep reporting it after the real UNIQUE
 * index had been dropped. So these run against a live server or they do not
 * count, and a run without a server FAILS rather than passing quietly — a
 * not-run proof is not a passed proof.
 *
 * To run:
 *   OWNERSHIP_TEST_DATABASE_URL=postgres://user:pw@host:port/db npx vitest run
 *
 * To decline deliberately (recorded as SKIPPED, never as passed):
 *   OWNERSHIP_PG_TESTS=skip npx vitest run
 *
 * THE NEGATIVE CONTROLS ARE THE POINT
 * -----------------------------------
 * A concurrency test that passes because the race never happened is worthless.
 * Two of the cases below are controls that deliberately REMOVE the mechanism
 * under test and assert the bad outcome appears. If a control ever goes green
 * alongside its positive case, the positive case was not testing what it claims.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import pgPkg from "pg";
import type { Client as PgClient, Pool as PgPool } from "pg";

import { createLedger } from "../src/ledger.js";
import type { SqlExecutor } from "../src/ledger.js";
import { conversationKey } from "../src/ownership.js";
import {
  applyOwnershipTransition,
  beginHandback,
  claimHandoverAck,
  completeHandback,
  confirmHumanOwnership,
  migrateOwnershipStore,
  readConversationOwnership,
  reconcileObservedAssignment,
  recordHumanReply,
  recordResolution,
  requestHumanOwnership,
  type ConversationRef,
} from "../src/ownership-store.js";

const { Client, Pool } = pgPkg;

const URL = process.env["OWNERSHIP_TEST_DATABASE_URL"] ?? "";
const DECLINED = process.env["OWNERSHIP_PG_TESTS"] === "skip";

if (!URL && !DECLINED) {
  describe("durable ownership store", () => {
    it("REFUSES TO REPORT A PASS WITHOUT A DATABASE", () => {
      throw new Error(
        "OWNERSHIP_TEST_DATABASE_URL is unset. Every guarantee this store makes is a " +
          "database guarantee, so these proofs cannot run against a fake and a run " +
          "without a server is not evidence. Set OWNERSHIP_TEST_DATABASE_URL, or set " +
          "OWNERSHIP_PG_TESTS=skip to decline explicitly and have it recorded as skipped.",
      );
    });
  });
}

if (DECLINED && !URL) {
  describe("durable ownership store", () => {
    it.skip("SKIPPED BY OPERATOR: OWNERSHIP_PG_TESTS=skip, no database was used", () => {
      /* recorded as skipped so the tally can never read as a pass */
    });
  });
}

const maybe = URL ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let exec: SqlExecutor & { close(): Promise<void> };
let pool: PgPool;

/** A conversation nobody else in this file touches. */
function freshConversation(): ConversationRef {
  return {
    tenantId: `t-${randomUUID()}`,
    chatwootAccountId: 1,
    chatwootConversationId: Math.floor(Math.random() * 2_000_000_000) + 1,
    chatwootInboxId: 46,
    bindingId: "binding-under-test",
  };
}

async function rawClient(): Promise<PgClient> {
  const client = new Client({ connectionString: URL });
  await client.connect();
  return client;
}

async function transitionRows(
  ref: ConversationRef,
): Promise<Array<{ from_state: string; to_state: string; operation_id: string; episode: number }>> {
  const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
  const result = await pool.query(
    `SELECT from_state, to_state, operation_id, episode
       FROM conversation_ownership_transition
      WHERE tenant_id = $1 AND conversation_key = $2
      ORDER BY id`,
    [ref.tenantId, key],
  );
  return result.rows;
}

beforeAll(async () => {
  if (!URL) return;
  exec = createLedger({
    connectionString: URL,
    instanceId: "ownership-proof",
    // The lock-contention cases below deliberately make one transaction wait
    // for another. The production default of 3s is right for webhook traffic
    // and too tight for a test that holds a lock on purpose.
    statementTimeoutMs: 30_000,
    connectionTimeoutMs: 10_000,
    poolSize: 12,
  }) as SqlExecutor & { close(): Promise<void> };
  pool = new Pool({ connectionString: URL, max: 6 });

  await migrateOwnershipStore(exec);
  // Idempotent DDL means idempotent: this runs on every boot, so running it
  // twice in a row must be a no-op rather than an error.
  await migrateOwnershipStore(exec);

  // The negative-control table: the same shape as the claim table with NO
  // unique index. Created once, never dropped — this database is a throwaway
  // fixture and a DROP is a habit worth not having.
  await pool.query(
    `CREATE TABLE IF NOT EXISTS ownership_control_no_unique (
       tenant_id        text NOT NULL,
       conversation_key text NOT NULL,
       operation_id     text NOT NULL
     )`,
  );
}, 60_000);

afterAll(async () => {
  if (!URL) return;
  await pool?.end();
  await exec?.close();
});

// ---------------------------------------------------------------------------
// 1. The substrate itself
// ---------------------------------------------------------------------------

maybe("the schema declares the constraints the contract requires", () => {
  it("the claim is a UNIQUE index on exactly (tenant_id, conversation_key, operation_id)", async () => {
    const result = await pool.query<{ indisunique: boolean; cols: string[] }>(
      `
      SELECT i.indisunique,
             -- ::text because attname has the Postgres "name" type, which the
             -- driver hands back as an unparsed array literal.
             array_agg(a.attname::text ORDER BY k.ord) AS cols
        FROM pg_class      c
        JOIN pg_index      i ON i.indexrelid = c.oid
        JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
        JOIN pg_attribute  a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE c.relname = 'conversation_ownership_transition_claim_key'
       GROUP BY i.indisunique
      `,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.indisunique).toBe(true);
    expect(result.rows[0]!.cols).toEqual(["tenant_id", "conversation_key", "operation_id"]);
  });

  it("a transition cannot exist without its conversation row", async () => {
    await expect(
      pool.query(
        `INSERT INTO conversation_ownership_transition
           (tenant_id, conversation_key, episode, from_state, to_state, reason,
            operation_id, operation_kind)
         VALUES ($1, 'cw:1:999999999', 0, 'AI_OWNED', 'HUMAN_REQUESTED', 'orphan',
                 'op-orphan', 'escalate')`,
        [`t-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: "23503" }); // foreign_key_violation
  });

  it("refuses a negative episode", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "op-neg",
      reason: "explicit_human_request",
    });
    const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
    await expect(
      pool.query(
        `UPDATE conversation_ownership SET ownership_episode = -1
          WHERE tenant_id = $1 AND conversation_key = $2`,
        [ref.tenantId, key],
      ),
    ).rejects.toMatchObject({ code: "23514" }); // check_violation
  });
});

// ---------------------------------------------------------------------------
// 2. THE CONSTRAINT rejects the concurrent duplicate — not application code
// ---------------------------------------------------------------------------

maybe("exactly-once is enforced by the database", () => {
  /**
   * The choreography is deterministic, not a hope that two things collide:
   * A inserts and HOLDS the transaction open, B inserts the same key and is
   * BLOCKED by Postgres, A commits, and B's blocked statement then resolves —
   * as a unique violation. No application code participates in the rejection.
   */
  it("two concurrent raw INSERTs of one operation id: one wins, one raises 23505", async () => {
    const ref = freshConversation();
    // The conversation row must exist for the FK; created through the engine.
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "op-seed",
      reason: "explicit_human_request",
    });
    const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
    const opId = `op-race-${randomUUID()}`;

    const a = await rawClient();
    const b = await rawClient();
    try {
      const insert = (c: PgClient) =>
        c.query(
          `INSERT INTO conversation_ownership_transition
             (tenant_id, conversation_key, episode, from_state, to_state, reason,
              operation_id, operation_kind)
           VALUES ($1, $2, 1, 'HUMAN_REQUESTED', 'HUMAN_OWNED', 'race', $3, 'human_assigned')`,
          [ref.tenantId, key, opId],
        );

      await a.query("BEGIN");
      await b.query("BEGIN");

      await insert(a); // A holds the key
      const bInsert = insert(b).then(
        () => "b_succeeded" as const,
        (err: unknown) => ({ err }),
      );

      // Prove B really is blocked rather than already finished: if it had
      // resolved either way, this race would report it instead of the marker.
      const pending = await Promise.race([
        bInsert.then((v) => (v === "b_succeeded" ? "b_succeeded_early" : "b_failed_early")),
        new Promise<"still_blocked">((r) => setTimeout(() => r("still_blocked"), 750)),
      ]);
      expect(pending).toBe("still_blocked");

      await a.query("COMMIT");

      const outcome = await bInsert;
      expect(outcome).not.toBe("b_succeeded");
      expect((outcome as { err: { code?: string; constraint?: string } }).err).toMatchObject({
        code: "23505",
        constraint: "conversation_ownership_transition_claim_key",
      });
      await b.query("ROLLBACK");
    } finally {
      await a.end();
      await b.end();
    }

    const rows = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM conversation_ownership_transition
        WHERE tenant_id = $1 AND conversation_key = $2 AND operation_id = $3`,
      [ref.tenantId, key, opId],
    );
    expect(rows.rows[0]!.n).toBe(1);
  }, 30_000);

  /**
   * NEGATIVE CONTROL. The identical choreography against a table shaped the
   * same way but WITHOUT the unique index. Both inserts succeed and two rows
   * land. This is exactly what the test above would report if the index were
   * dropped — which is what makes that test capable of failing.
   */
  it("CONTROL: without the unique index the same race writes two rows", async () => {
    const marker = `control-${randomUUID()}`;
    const a = await rawClient();
    const b = await rawClient();
    try {
      const insert = (c: PgClient) =>
        c.query(`INSERT INTO ownership_control_no_unique VALUES ('t', 'cw:1:1', $1)`, [marker]);
      await a.query("BEGIN");
      await b.query("BEGIN");
      await insert(a);
      await insert(b); // does NOT block: there is nothing to conflict with
      await a.query("COMMIT");
      await b.query("COMMIT");
    } finally {
      await a.end();
      await b.end();
    }
    const n = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ownership_control_no_unique WHERE operation_id = $1`,
      [marker],
    );
    expect(n.rows[0]!.n).toBe(2);
  }, 30_000);

  it("the engine reports one applied and one duplicate for a concurrent replay", async () => {
    const ref = freshConversation();
    const opId = `op-${randomUUID()}`;
    const escalate = () =>
      requestHumanOwnership(exec, {
        conversation: ref,
        operationId: opId,
        reason: "explicit_human_request",
      });

    const [x, y] = await Promise.all([escalate(), escalate()]);
    expect([x.status, y.status].sort()).toEqual(["applied", "duplicate"]);
    expect(x.ok && y.ok).toBe(true);

    expect(await transitionRows(ref)).toHaveLength(1);

    const view = await readConversationOwnership(exec, ref);
    expect(view.state).toBe("HUMAN_REQUESTED");
    expect(view.episode).toBe(1);

    // HONEST NOTE, asserted rather than left to a comment: with the row lock
    // held, the two transactions serialise, so the loser's REPLAY PRE-CHECK
    // sees the winner's row and reports `replay`. The unique index is the
    // backstop here, not the arbiter — which is precisely why the raw-SQL case
    // above exists, and why it bypasses the pre-check entirely to exercise the
    // constraint. If this ever reports `constraint`, the lock stopped working.
    const loser = x.status === "duplicate" ? x : y;
    expect(loser.duplicateSource).toBe("replay");
  }, 30_000);

  it("a caller's stale view cannot skip recording a real human takeover", async () => {
    const ref = freshConversation();
    // The conversation is AI_OWNED in the store. A caller that read it before a
    // human arrived might believe otherwise; `recordHumanReply` takes no such
    // argument, so there is nothing to be stale about — it decides under the
    // lock, from the row.
    const before = await readConversationOwnership(exec, ref);
    expect(before.state).toBe("AI_OWNED");

    const applied = await recordHumanReply(exec, {
      conversation: ref,
      operationId: "cw-message-1",
    });
    expect(applied.status).toBe("applied");
    expect(applied.state).toBe("HUMAN_OWNED");
    expect(applied.episode).toBe(1);

    // A second physical human message is a different operation id. The
    // conversation is already human-owned, so nothing MOVES — but the operation
    // is still CLAIMED, recorded as an observation (from_state == to_state).
    const second = await recordHumanReply(exec, {
      conversation: ref,
      operationId: "cw-message-2",
    });
    expect(second.status).toBe("applied");
    expect(second.state).toBe("HUMAN_OWNED");
    const view = await readConversationOwnership(exec, ref);
    expect(view.episode).toBe(1); // no second episode
    const observation = (await transitionRows(ref)).find(
      (r) => r.operation_id === "cw-message-2",
    )!;
    expect(observation.from_state).toBe("HUMAN_OWNED");
    expect(observation.to_state).toBe("HUMAN_OWNED");

    // And re-presenting that same message is recognised as a replay.
    const replay = await recordHumanReply(exec, {
      conversation: ref,
      operationId: "cw-message-2",
    });
    expect(replay.status).toBe("duplicate");
    expect(replay.duplicateSource).toBe("replay");
  }, 30_000);

  /**
   * The hole an adversarial review found: when an already-human-held
   * conversation claimed NOTHING, a replay of that message arriving after a
   * handback would find no claim, see AI_RESUMED, and apply a brand new human
   * takeover for a message the human sent in a PREVIOUS episode.
   */
  it("a human message replayed after a handback does not re-take the conversation", async () => {
    const ref = freshConversation();
    // Episode 1: a human takes over, then sends a second message.
    await recordHumanReply(exec, { conversation: ref, operationId: "m1" });
    await recordHumanReply(exec, { conversation: ref, operationId: "m2" });
    expect((await readConversationOwnership(exec, ref)).episode).toBe(1);

    // Handback: the conversation returns to the AI.
    await beginHandback(exec, {
      conversation: ref,
      operationId: "hb",
      episode: 1,
      actorRef: "user:9",
    });
    await completeHandback(exec, {
      conversation: ref,
      operationId: "hb",
      episode: 1,
      actorRef: "user:9",
    });
    expect((await readConversationOwnership(exec, ref)).state).toBe("AI_RESUMED");

    // The old message is redelivered. It must change nothing.
    const replayed = await recordHumanReply(exec, { conversation: ref, operationId: "m2" });
    expect(replayed.status).toBe("duplicate");
    expect(replayed.duplicateSource).toBe("replay");

    const after = await readConversationOwnership(exec, ref);
    expect(after.state).toBe("AI_RESUMED"); // NOT dragged back to HUMAN_OWNED
    expect(after.episode).toBe(1);
  }, 30_000);

  it("refuses to persist a reason that is free text rather than a code", async () => {
    const ref = freshConversation();
    await expect(
      requestHumanOwnership(exec, {
        conversation: ref,
        operationId: "op-prose",
        // A customer's message, passed by accident. The audit table promises it
        // holds no customer content, so this must not reach it.
        reason: "Hi, my card was charged twice and I need a refund please",
      }),
    ).rejects.toThrow(/reason must be a lower-case code/);

    // Nothing was written — not the transition, and not the conversation row.
    expect(await transitionRows(ref)).toHaveLength(0);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 3. allowedFrom and expectedEpisode hold UNDER THE LOCK
// ---------------------------------------------------------------------------

maybe("preconditions are evaluated under the row lock", () => {
  /**
   * The failure mode that matters most, and the one a JSON file cannot prevent:
   * two DIFFERENT operations, both legal from AI_OWNED, arriving together. The
   * unique index does not help — the operation ids differ. Only the row lock
   * does, by making the second read happen after the first write.
   */
  it("two concurrent escalations with different operation ids: one applies, one is refused", async () => {
    const ref = freshConversation();
    const escalate = (op: string) =>
      requestHumanOwnership(exec, {
        conversation: ref,
        operationId: op,
        reason: "explicit_human_request",
      });

    const [x, y] = await Promise.all([escalate("op-a"), escalate("op-b")]);
    expect([x.status, y.status].sort()).toEqual(["applied", "illegal_transition"]);

    // The episode advanced EXACTLY ONCE. Two escalations of one conversation
    // would mean two spans of human involvement where there was one, and a
    // later handback naming episode 1 would then be judged against episode 2.
    const view = await readConversationOwnership(exec, ref);
    expect(view.episode).toBe(1);
    expect(view.state).toBe("HUMAN_REQUESTED");
    expect(await transitionRows(ref)).toHaveLength(1);
  }, 30_000);

  /**
   * NEGATIVE CONTROL for the lock. The same two escalations applied by a store
   * that reads, thinks, then writes WITHOUT `FOR UPDATE` — which is precisely
   * what a whole-file read-modify-write does. Both see AI_OWNED, both pass
   * `allowedFrom`, both apply. Two escalations, one conversation, no error.
   */
  it("CONTROL: without FOR UPDATE both escalations apply", async () => {
    const ref = freshConversation();
    const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
    await pool.query(
      `INSERT INTO conversation_ownership
         (tenant_id, conversation_key, chatwoot_account_id, chatwoot_conversation_id)
       VALUES ($1, $2, $3, $4)`,
      [ref.tenantId, key, ref.chatwootAccountId, ref.chatwootConversationId],
    );

    /** The naive engine: identical logic, no lock, with the read and the write
     *  separated by the kind of gap any real handler has. */
    const naiveEscalate = async (op: string): Promise<string> => {
      const c = await rawClient();
      try {
        await c.query("BEGIN");
        const cur = await c.query<{ ownership_state: string; ownership_episode: number }>(
          `SELECT ownership_state, ownership_episode FROM conversation_ownership
            WHERE tenant_id = $1 AND conversation_key = $2`, // <-- no FOR UPDATE
          [ref.tenantId, key],
        );
        const state = cur.rows[0]!.ownership_state;
        if (state !== "AI_OWNED") {
          await c.query("ROLLBACK");
          return "illegal_transition";
        }
        await new Promise((r) => setTimeout(r, 150));
        const next = Number(cur.rows[0]!.ownership_episode) + 1;
        await c.query(
          `INSERT INTO conversation_ownership_transition
             (tenant_id, conversation_key, episode, from_state, to_state, reason,
              operation_id, operation_kind)
           VALUES ($1, $2, $3, 'AI_OWNED', 'HUMAN_REQUESTED', 'naive', $4, 'escalate')`,
          [ref.tenantId, key, next, op],
        );
        await c.query(
          `UPDATE conversation_ownership
              SET ownership_state = 'HUMAN_REQUESTED', ownership_episode = $3
            WHERE tenant_id = $1 AND conversation_key = $2`,
          [ref.tenantId, key, next],
        );
        await c.query("COMMIT");
        return "applied";
      } finally {
        await c.end();
      }
    };

    const results = await Promise.all([naiveEscalate("naive-a"), naiveEscalate("naive-b")]);
    expect(results).toEqual(["applied", "applied"]);

    // Two escalation rows for one conversation, and the episode counted once
    // because both writers computed 0 + 1. That is the silent corruption.
    expect(await transitionRows(ref)).toHaveLength(2);
    expect((await readConversationOwnership(exec, ref)).episode).toBe(1);
  }, 30_000);

  it("a handback naming a superseded episode is refused as stale", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-1",
      reason: "explicit_human_request",
    });
    // Episode 1 is now current. A handback that still believes it is episode 0
    // is a late message from a previous span of human involvement.
    const stale = await beginHandback(exec, {
      conversation: ref,
      operationId: "hb-stale",
      episode: 0,
      actorRef: "user:1",
    });
    expect(stale.status).toBe("stale_episode");
    expect(stale.ok).toBe(false);

    const current = await beginHandback(exec, {
      conversation: ref,
      operationId: "hb-current",
      episode: 1,
      actorRef: "user:1",
    });
    expect(current.status).toBe("applied");
    expect(current.state).toBe("HANDING_BACK");
  }, 30_000);

  it("a retried operation is a duplicate, never an illegal transition", async () => {
    const ref = freshConversation();
    const first = await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-retry",
      reason: "explicit_human_request",
    });
    expect(first.status).toBe("applied");

    // The conversation is now HUMAN_REQUESTED, which is NOT in this
    // transition's allowedFrom. Judged on preconditions alone it would be
    // refused — for an operation that in fact succeeded.
    const retry = await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-retry",
      reason: "explicit_human_request",
    });
    expect(retry.status).toBe("duplicate");
    expect(retry.duplicateSource).toBe("replay");
    expect(retry.ok).toBe(true);
    expect(retry.episode).toBe(1);
    expect(await transitionRows(ref)).toHaveLength(1);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 4. The acknowledgement claim
// ---------------------------------------------------------------------------

maybe("the handover acknowledgement is claimed, not checked", () => {
  it("eight concurrent claims for one episode: exactly one may send", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-ack",
      reason: "explicit_human_request",
    });

    // EIGHT DISTINCT claimants: eight different deliveries racing, which is the
    // case the claim exists to arbitrate. (The same claimant re-entering is a
    // retry of one delivery and is asserted separately below.)
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_unused, i) =>
        claimHandoverAck(exec, ref, 1, `delivery-${i}`),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  }, 30_000);

  /**
   * The counterpart, and the reason the claimant exists at all: a delivery
   * whose acknowledgement did not send is retried by the recovery sweeper, and
   * a claim it could not re-enter would mean the customer is greeted ZERO
   * times rather than once.
   */
  it("the SAME delivery re-enters its own claim, so a retry can still send", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-reenter",
      reason: "explicit_human_request",
    });

    expect(await claimHandoverAck(exec, ref, 1, "delivery-x")).toBe(true);
    // The send failed; the sweeper retries the same delivery.
    expect(await claimHandoverAck(exec, ref, 1, "delivery-x")).toBe(true);
    // A different delivery is still locked out.
    expect(await claimHandoverAck(exec, ref, 1, "delivery-y")).toBe(false);
  }, 30_000);

  it("a claim for an episode the conversation is not in matches nothing", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-ack2",
      reason: "explicit_human_request",
    });
    // Current episode is 1; a claim naming 2 must not mint a right to send
    // that nobody granted.
    expect(await claimHandoverAck(exec, ref, 2, "claimant-a")).toBe(false);
    expect(await claimHandoverAck(exec, ref, 1, "claimant-a")).toBe(true);
  }, 30_000);

  it("a new episode may be acknowledged again", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "e1",
      reason: "explicit_human_request",
    });
    expect(await claimHandoverAck(exec, ref, 1, "delivery-a")).toBe(true);
    // A DIFFERENT delivery is refused: one greeting per handover.
    expect(await claimHandoverAck(exec, ref, 1, "delivery-b")).toBe(false);

    await beginHandback(exec, {
      conversation: ref,
      operationId: "hb1",
      episode: 1,
      actorRef: "user:1",
    });
    await completeHandback(exec, {
      conversation: ref,
      operationId: "hb1",
      episode: 1,
      actorRef: "user:1",
    });
    expect((await readConversationOwnership(exec, ref)).state).toBe("AI_RESUMED");

    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "e2",
      reason: "explicit_human_request",
    });
    const after = await readConversationOwnership(exec, ref);
    expect(after.episode).toBe(2);
    // Episode 2 is a genuinely new span of human involvement, so it gets its
    // own acknowledgement.
    expect(await claimHandoverAck(exec, ref, 2, "claimant-a")).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5. The behaviour the Chatwoot-derived predicate gets wrong
// ---------------------------------------------------------------------------

maybe("resolution is an observation, not a grant of authority", () => {
  it("resolving a human-owned conversation does NOT return it to the AI", async () => {
    const ref = freshConversation();
    await recordHumanReply(exec, {
      conversation: ref,
      operationId: "msg-1",
    });
    const held = await readConversationOwnership(exec, ref);
    expect(held.state).toBe("HUMAN_OWNED");

    const resolved = await recordResolution(exec, {
      conversation: ref,
      operationId: "resolve-1",
    });
    expect(resolved.status).toBe("applied");

    const after = await readConversationOwnership(exec, ref);
    expect(after.state).toBe("HUMAN_OWNED"); // unchanged
    expect(after.episode).toBe(held.episode); // unchanged

    const observation = (await transitionRows(ref)).find(
      (r) => r.operation_id === "resolve-1",
    )!;
    expect(observation.from_state).toBe("HUMAN_OWNED");
    expect(observation.to_state).toBe("HUMAN_OWNED"); // recorded, moved nothing
  }, 30_000);

  it("only a reconciled handback returns authority, and it is the only such edge", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc",
      reason: "explicit_human_request",
    });
    // Cannot jump straight back to the AI.
    const jump = await applyOwnershipTransition(exec, {
      conversation: ref,
      operationId: "cheat",
      operationKind: "resumed_settled",
      toState: "AI_OWNED",
      reason: "attempt_to_bypass_handback",
      allowedFrom: ["HUMAN_REQUESTED", "HUMAN_OWNED", "HANDING_BACK"],
    });
    expect(jump.status).toBe("illegal_transition");
    expect((await readConversationOwnership(exec, ref)).state).toBe("HUMAN_REQUESTED");

    await beginHandback(exec, {
      conversation: ref,
      operationId: "hb",
      episode: 1,
      actorRef: "user:7",
    });
    // Mid-handback nobody speaks.
    expect((await readConversationOwnership(exec, ref)).state).toBe("HANDING_BACK");

    await completeHandback(exec, {
      conversation: ref,
      operationId: "hb",
      episode: 1,
      actorRef: "user:7",
    });
    expect((await readConversationOwnership(exec, ref)).state).toBe("AI_RESUMED");
  }, 30_000);

  it("an unreadable stored state fails closed to HUMAN_OWNED", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-div",
      reason: "explicit_human_request",
    });
    const key = conversationKey(ref.chatwootAccountId, ref.chatwootConversationId);
    // A row written by a future build, or by hand.
    await pool.query(
      `UPDATE conversation_ownership SET ownership_state = 'AI_SUPERVISED'
        WHERE tenant_id = $1 AND conversation_key = $2`,
      [ref.tenantId, key],
    );
    const view = await readConversationOwnership(exec, ref);
    expect(view.state).toBe("HUMAN_OWNED");
    expect(view.diverged).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 5b. Reconciliation of an assignee observed outside the escalation flow
// def-handback-sweeper-is-blind-to-manually-assigned-conversations-2026-09-13
// ---------------------------------------------------------------------------

maybe("an assignee observed outside the escalation flow is reconciled", () => {
  it("assign-outside-escalation on an OPEN conversation: a row is created, eligible for the sweeper", async () => {
    const ref = freshConversation();
    expect((await readConversationOwnership(exec, ref)).state).toBe("AI_OWNED"); // no row yet

    const outcome = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-1",
      hasAssignee: true,
      status: "open",
    });
    expect(outcome?.status).toBe("applied");
    expect(outcome?.state).toBe("HUMAN_OWNED");

    const after = await readConversationOwnership(exec, ref);
    // HUMAN_OWNED is one of handback.ts's own HANDBACK_ELIGIBLE_STATES
    // (["HUMAN_REQUESTED", "HUMAN_OWNED", "HANDING_BACK"]) — this is exactly
    // the row `selectHumanHeldConversations` will now find that it could not
    // find before this fix.
    expect(after.state).toBe("HUMAN_OWNED");
    expect(after.episode).toBe(1); // a new episode opened — a takeover with no prior escalation

    const row = (await transitionRows(ref)).find((r) => r.operation_id === "assignee_observed:evt-1")!;
    expect(row.from_state).toBe("AI_OWNED");
    expect(row.to_state).toBe("HUMAN_OWNED");
  }, 30_000);

  it("the SAME check on a RESOLVED conversation: NO row is created, nothing touched", async () => {
    const ref = freshConversation();

    const outcome = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-2",
      hasAssignee: true,
      status: "resolved",
    });
    expect(outcome).toBeNull();

    // Not just "still AI_OWNED" (a state a real row could also hold) — no row
    // exists at all, and no transition was ever written under this operation id.
    expect((await readConversationOwnership(exec, ref)).episode).toBe(0);
    expect(await transitionRows(ref)).toHaveLength(0);
  }, 30_000);

  it("no assignee present (the unassign direction): a no-op, even against an EXISTING human hold — no stale row is corrupted", async () => {
    const ref = freshConversation();
    await recordHumanReply(exec, { conversation: ref, operationId: "msg-1" });
    const held = await readConversationOwnership(exec, ref);
    expect(held.state).toBe("HUMAN_OWNED");

    const outcome = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-3",
      hasAssignee: false,
      status: "pending",
    });
    expect(outcome).toBeNull();

    const after = await readConversationOwnership(exec, ref);
    expect(after.state).toBe("HUMAN_OWNED"); // untouched
    expect(after.episode).toBe(held.episode); // untouched
    // This function deliberately does not act on the unassign direction — the
    // EXISTING sweeper (handback.ts's MANUAL trigger, `readConversationStatus
    // (record) === "pending"`) already completes that side once a row exists
    // in an eligible state, the same way it already does for a gateway-
    // escalated conversation. Recording it here too would be a second path
    // to the same outcome.
    expect(await transitionRows(ref)).toHaveLength(1); // only msg-1, no evt-3 row
  }, 30_000);

  it("a replayed identical event is a duplicate, not a second episode", async () => {
    const ref = freshConversation();
    const first = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-4",
      hasAssignee: true,
      status: "open",
    });
    expect(first?.status).toBe("applied");
    expect(first?.episode).toBe(1);

    const replay = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-4",
      hasAssignee: true,
      status: "open",
    });
    expect(replay?.status).toBe("duplicate");
    expect(replay?.episode).toBe(1); // unchanged — not a second takeover
  }, 30_000);

  it("an escalation already in flight (HUMAN_REQUESTED) is observed, never overtaken — confirmHumanOwnership still gets to complete it", async () => {
    const ref = freshConversation();
    await requestHumanOwnership(exec, {
      conversation: ref,
      operationId: "esc-1",
      reason: "explicit_human_request",
    });
    expect((await readConversationOwnership(exec, ref)).state).toBe("HUMAN_REQUESTED");

    const observed = await reconcileObservedAssignment(exec, {
      conversation: ref,
      operationId: "assignee_observed:evt-5",
      hasAssignee: true,
      status: "pending",
    });
    // Observed, not applied over — state and episode are unchanged.
    expect(observed?.status).toBe("applied"); // the observation ITSELF claims and is recorded
    expect(observed?.state).toBe("HUMAN_REQUESTED");
    const mid = await readConversationOwnership(exec, ref);
    expect(mid.state).toBe("HUMAN_REQUESTED");
    expect(mid.episode).toBe(1);

    // The escalation flow's own completion is NOT refused as illegal — proving
    // the two writers do not race each other for the same transition.
    const confirmed = await confirmHumanOwnership(exec, {
      conversation: ref,
      operationId: "confirm-1",
      episode: 1,
      reason: "human_assigned",
    });
    expect(confirmed.status).toBe("applied");
    expect(confirmed.state).toBe("HUMAN_OWNED");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// 6. Tenant isolation
// ---------------------------------------------------------------------------

maybe("tenants cannot see or move each other's conversations", () => {
  it("the same Chatwoot conversation under two tenants is two independent rows", async () => {
    const shared = { chatwootAccountId: 1, chatwootConversationId: 987_654 };
    const a: ConversationRef = { tenantId: `t-${randomUUID()}`, ...shared };
    const b: ConversationRef = { tenantId: `t-${randomUUID()}`, ...shared };

    await requestHumanOwnership(exec, {
      conversation: a,
      operationId: "op-shared",
      reason: "explicit_human_request",
    });

    // Same conversation key, same operation id, different tenant: the claim is
    // scoped by tenant, so this is NOT a duplicate and B is unaffected by A.
    const bResult = await requestHumanOwnership(exec, {
      conversation: b,
      operationId: "op-shared",
      reason: "explicit_human_request",
    });
    expect(bResult.status).toBe("applied");

    expect((await readConversationOwnership(exec, a)).state).toBe("HUMAN_REQUESTED");
    expect((await readConversationOwnership(exec, b)).state).toBe("HUMAN_REQUESTED");
    expect(await transitionRows(a)).toHaveLength(1);
    expect(await transitionRows(b)).toHaveLength(1);
  }, 30_000);

  it("a read for the wrong tenant sees the default, never another tenant's hold", async () => {
    const ref = freshConversation();
    await recordHumanReply(exec, {
      conversation: ref,
      operationId: "msg-x",
    });
    const impostor: ConversationRef = { ...ref, tenantId: `t-${randomUUID()}` };
    const view = await readConversationOwnership(exec, impostor);
    expect(view.state).toBe("AI_OWNED");
    expect(view.episode).toBe(0);
  }, 30_000);
});
