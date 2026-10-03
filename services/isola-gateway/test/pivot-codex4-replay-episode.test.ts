/**
 * CODEX ROUND 4 (review of 103c353): G4-2 -- `applyOwnershipTransition` answered a REPLAY
 * (`duplicate`, with the CURRENT episode) BEFORE it checked `expectedEpisode`. So a delivery
 * that resumed at its own hold (episode 1) and was overtaken (a person took the conversation,
 * it was handed back, and ANOTHER delivery's hold became the current episode) got back
 * `duplicate` carrying the OTHER delivery's episode, adopted it, and every later fence
 * authorised the old delivery against someone else's hold.
 *
 * WHY THIS FILE DRIVES THE PRODUCTION FUNCTION AND NOT A DOUBLE (Codex: removing the
 * production check was NOT caught, because the suites used `InMemoryOwnershipGate`, a double
 * that had its own copy of the rule). `applyOwnershipTransition` / `requestHumanOwnership`
 * here run UNMODIFIED against a small scripted SQL executor that models exactly the
 * statements the function issues (the row lock, the replay lookup, the claim INSERT, the
 * state UPDATE). It proves the ORDER OF CHECKS in the production code, which is the defect.
 * What it cannot prove is lock behaviour under real concurrency: that stays with the
 * real-Postgres file (`ownership-store.pg.test.ts`), which this commit also extends.
 *
 * ALL TESTS HERE ARE SOCKET-FREE.
 */
import { describe, expect, it } from "vitest";

import type { QueryResult, SqlClient, SqlExecutor } from "../src/ledger.js";
import { requestHumanOwnership, type ConversationRef } from "../src/ownership-store.js";

const REF: ConversationRef = {
  tenantId: "tenant-g42",
  chatwootAccountId: 1,
  chatwootConversationId: 4242,
  chatwootInboxId: 7,
  bindingId: "binding-g42",
};

/** One conversation row and its transition claims, behind the statements the store issues. */
class ScriptedOwnershipSql implements SqlExecutor {
  state = "AI_OWNED";
  episode = 0;
  escalationOperationId: string | null = null;
  /** operation_id -> the episode that operation was recorded under. */
  readonly claims = new Map<string, number>();
  readonly statements: string[] = [];

  private result<T>(rows: unknown[], rowCount = rows.length): QueryResult<T> {
    return { rows: rows as T[], rowCount };
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    this.statements.push(sql.replace(/\s+/g, " ").trim());
    return this.run<T>(sql, params);
  }

  private run<T>(sql: string, params: unknown[]): QueryResult<T> {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^INSERT INTO conversation_ownership \(/.test(s)) return this.result<T>([], 0);
    if (/FROM conversation_ownership WHERE tenant_id = \$1 AND conversation_key = \$2 FOR UPDATE/.test(s)) {
      return this.result<T>([
        {
          ownership_state: this.state,
          ownership_episode: this.episode,
          handover_ack_episode: null,
          ownership_escalation_operation_id: this.escalationOperationId,
        },
      ]);
    }
    if (/FROM conversation_ownership_transition WHERE tenant_id = \$1 AND conversation_key = \$2 AND operation_id = \$3/.test(s)) {
      const operationId = String(params[2]);
      const episode = this.claims.get(operationId);
      return this.result<T>(episode === undefined ? [] : [{ episode }]);
    }
    if (/^SAVEPOINT|^RELEASE SAVEPOINT|^ROLLBACK TO SAVEPOINT/.test(s)) return this.result<T>([], 0);
    if (/^INSERT INTO conversation_ownership_transition/.test(s)) {
      const operationId = String(params[6]);
      if (this.claims.has(operationId)) {
        const err = new Error("duplicate key value violates unique constraint") as Error & { code: string };
        err.code = "23505";
        throw err;
      }
      this.claims.set(operationId, Number(params[2]));
      return this.result<T>([], 1);
    }
    if (/^UPDATE conversation_ownership SET ownership_state/.test(s)) {
      this.state = String(params[2]);
      this.episode = Number(params[3]);
      if (params[7] !== null && params[7] !== undefined) this.escalationOperationId = String(params[7]);
      return this.result<T>([], 1);
    }
    throw new Error(`ScriptedOwnershipSql: unmodelled statement: ${s.slice(0, 120)}`);
  }

  async transaction<T>(fn: (client: SqlClient) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const escalate = (sql: SqlExecutor, operationId: string, expectedEpisode: number | null) =>
  requestHumanOwnership(sql, {
    conversation: REF,
    operationId,
    reason: "explicit_human_request",
    actorRef: "gateway:escalate",
    expectedEpisode,
  });

describe("G4-2 (the PRODUCTION function): a replay is judged against expectedEpisode FIRST", () => {
  it("harness sanity: the scripted SQL models a first escalation (applied, episode 1) and its claim", async () => {
    const sql = new ScriptedOwnershipSql();
    const first = await escalate(sql, "escalate:delivery-A", 0);
    expect(first.status).toBe("applied");
    expect(first.episode).toBe(1);
    expect(sql.claims.get("escalate:delivery-A")).toBe(1);
  });

  it("THE DEFECT: A's own hold is overtaken (person -> handback -> B's hold, episode 2); A replays with expectedEpisode 1 => stale_episode, NOT a duplicate carrying B's episode", async () => {
    const sql = new ScriptedOwnershipSql();
    expect((await escalate(sql, "escalate:delivery-A", 0)).episode).toBe(1);

    // A person takes it, hands it back, and ANOTHER delivery opens its own hold.
    sql.state = "AI_RESUMED";
    expect((await escalate(sql, "escalate:delivery-B", 1)).status).toBe("applied");
    expect(sql.episode).toBe(2);
    expect(sql.escalationOperationId).toBe("escalate:delivery-B");

    const replay = await escalate(sql, "escalate:delivery-A", 1);

    expect(replay.status, "A's replay adopted another delivery's hold").toBe("stale_episode");
    expect(replay.ok).toBe(false);
    expect(replay.episode).toBe(2); // the truth is reported, so the caller can stop; it is NOT adopted
    // Nothing was claimed or written by the replay.
    expect(sql.claims.has("escalate:delivery-A")).toBe(true);
    expect(sql.episode).toBe(2);
    expect(sql.escalationOperationId).toBe("escalate:delivery-B");
  });

  it("CONTROL: the same replay while A's hold is STILL the current episode is a valid duplicate", async () => {
    const sql = new ScriptedOwnershipSql();
    await escalate(sql, "escalate:delivery-A", 0);

    const replay = await escalate(sql, "escalate:delivery-A", 1);

    expect(replay.status).toBe("duplicate");
    expect(replay.ok).toBe(true);
    expect(replay.episode).toBe(1);
  });

  it("CONTROL: a replay with NO precondition (expectedEpisode null) keeps its documented behaviour: duplicate", async () => {
    const sql = new ScriptedOwnershipSql();
    await escalate(sql, "escalate:delivery-A", 0);
    sql.state = "AI_RESUMED";
    await escalate(sql, "escalate:delivery-B", 1);

    const replay = await escalate(sql, "escalate:delivery-A", null);

    expect(replay.status).toBe("duplicate");
  });

  it("DISTINCTNESS: the stale replay and the valid replay differ only in the episode the caller expects", async () => {
    const sql = new ScriptedOwnershipSql();
    await escalate(sql, "escalate:delivery-A", 0);
    sql.state = "AI_RESUMED";
    await escalate(sql, "escalate:delivery-B", 1);
    const stale = await escalate(sql, "escalate:delivery-A", 1);
    expect(stale.status).toBe("stale_episode");
    expect(sql.episode).not.toBe(1); // the conversation really is on a different episode than A expected
  });
});
