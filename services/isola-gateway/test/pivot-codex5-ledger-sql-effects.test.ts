/**
 * CODEX ROUND 5 sabotage gap: replacing the production `release` SQL with `... AND FALSE` left
 * 80 selected tests passing. The earlier SQL tests assert the emitted TEXT and then answer with a
 * SCRIPTED row count of one, whatever the predicate says, so a statement that updates nothing
 * looked identical to one that works (Laws 11, 19, 23).
 *
 * This file drives the PRODUCTION `PostgresLedger.release` through an executor that actually
 * EVALUATES the statement it is given -- an equality-conjunction UPDATE over an in-memory row
 * table -- so the assertion is on the EFFECT: the row's lease is cleared, or it is not. The
 * evaluator is deliberately narrow and THROWS on a shape it does not model, so a sabotage that
 * changes the statement into something unmodelled fails loudly instead of passing silently.
 *
 * SOCKET-FREE. Every refusal has its positive twin in the same evaluator.
 */
import { describe, expect, it } from "vitest";

import { PostgresLedger, type QueryResult } from "../src/ledger.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { ACCOUNT_ID, INBOX_ID, makeBinding, TENANT_ID } from "./harness.js";

const IDENTITY = {
  tenantId: TENANT_ID,
  bindingId: bindingIdentity(makeBinding()),
  chatwootAccountId: ACCOUNT_ID,
  chatwootInboxId: INBOX_ID,
  eventId: "delivery:sql-effects",
};
const INSTANCE = "instance-under-test";
const FUTURE = "FUTURE";

type Row = Record<string, unknown>;

class EvaluatingPostgresLedger extends PostgresLedger {
  rows: Row[] = [];
  constructor() {
    super({ connectionString: "postgres://scripted.invalid:1/none", instanceId: INSTANCE });
  }

  seed(action: string, over: Row = {}): Row {
    const row: Row = {
      tenant_id: IDENTITY.tenantId,
      binding_id: IDENTITY.bindingId,
      chatwoot_account_id: IDENTITY.chatwootAccountId,
      chatwoot_inbox_id: IDENTITY.chatwootInboxId,
      event_id: IDENTITY.eventId,
      action_type: action,
      delivery_state: "in_progress",
      attempts: 1,
      lease_owner: INSTANCE,
      lease_expires_at: FUTURE,
      ...over,
    };
    this.rows.push(row);
    return row;
  }

  override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    const flat = sql.replace(/\s+/g, " ").trim();
    const m = /^UPDATE delivery_ledger SET (.+?) WHERE (.+)$/i.exec(flat);
    if (m === null) throw new Error(`EvaluatingPostgresLedger: only UPDATE ... SET ... WHERE is modelled, got: ${flat.slice(0, 60)}`);
    const assignments = m[1]!.split(/\s*,\s*/);
    const conjuncts = m[2]!.split(/\s+AND\s+/i).map((c) => c.trim());

    const matches = (row: Row): boolean =>
      conjuncts.every((c) => {
        if (/^TRUE$/i.test(c)) return true;
        if (/^FALSE$/i.test(c)) return false;
        const eq = /^(\w+)\s*=\s*(\$(\d+)|'([^']*)')$/.exec(c);
        if (eq === null) throw new Error(`EvaluatingPostgresLedger: unmodelled predicate "${c}"`);
        const expected = eq[3] !== undefined ? params[Number(eq[3]) - 1] : eq[4];
        return String(row[eq[1]!]) === String(expected);
      });

    const matched = this.rows.filter(matches);
    for (const row of matched) {
      for (const a of assignments) {
        const set = /^(\w+)\s*=\s*(NULL|now\(\)|\$(\d+))$/i.exec(a);
        if (set === null) throw new Error(`EvaluatingPostgresLedger: unmodelled assignment "${a}"`);
        const value = /^NULL$/i.test(set[2]!) ? null : /^now\(\)$/i.test(set[2]!) ? "NOW" : params[Number(set[3]) - 1];
        row[set[1]!] = value;
      }
    }
    return { rows: [] as unknown as T[], rowCount: matched.length };
  }
}

describe("PostgresLedger.release (the production SQL, EVALUATED): the effect, not the text", () => {
  it("the holder's release clears the lease and returns true", async () => {
    const ledger = new EvaluatingPostgresLedger();
    const row = ledger.seed("reply");

    expect(await ledger.release(IDENTITY, "reply", 1)).toBe(true);

    expect(row["lease_owner"], "the lease owner was not cleared: the statement updated nothing").toBeNull();
    expect(row["lease_expires_at"]).toBe("NOW");
    expect(row["delivery_state"], "release must not close the row").toBe("in_progress");
  });

  it("a STALE token (the claim was taken over) matches nothing: returns false and leaves the new holder's lease alone", async () => {
    const ledger = new EvaluatingPostgresLedger();
    const row = ledger.seed("reply", { attempts: 3 });

    expect(await ledger.release(IDENTITY, "reply", 2)).toBe(false);

    expect(row["lease_owner"]).toBe(INSTANCE);
    expect(row["lease_expires_at"]).toBe(FUTURE);
  });

  it("a claim another PROCESS holds is not ours to release", async () => {
    const ledger = new EvaluatingPostgresLedger();
    const row = ledger.seed("reply", { lease_owner: "some-other-instance" });

    expect(await ledger.release(IDENTITY, "reply", 1)).toBe(false);

    expect(row["lease_owner"]).toBe("some-other-instance");
  });

  it("a TERMINAL row is never reopened", async () => {
    const ledger = new EvaluatingPostgresLedger();
    const row = ledger.seed("reply", { delivery_state: "completed" });

    expect(await ledger.release(IDENTITY, "reply", 1)).toBe(false);

    expect(row["delivery_state"]).toBe("completed");
    expect(row["lease_owner"]).toBe(INSTANCE);
  });

  it("only the NAMED action is touched (a sibling action row of the same delivery is left alone)", async () => {
    const ledger = new EvaluatingPostgresLedger();
    ledger.seed("reply");
    const sibling = ledger.seed("failure_note");

    expect(await ledger.release(IDENTITY, "reply", 1)).toBe(true);

    expect(sibling["lease_owner"]).toBe(INSTANCE);
    expect(sibling["lease_expires_at"]).toBe(FUTURE);
  });

  it("DISTINCTNESS (the evaluator is not a rubber stamp): a statement with `AND FALSE` really updates nothing here", async () => {
    const ledger = new EvaluatingPostgresLedger();
    const row = ledger.seed("reply");
    const result = await ledger.query(
      "UPDATE delivery_ledger SET lease_owner = NULL WHERE tenant_id = $1 AND FALSE",
      [IDENTITY.tenantId],
    );
    expect(result.rowCount).toBe(0);
    expect(row["lease_owner"]).toBe(INSTANCE);
  });
});
