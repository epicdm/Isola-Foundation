/**
 * CODEX ROUND 4 (review of 103c353): the ledger's action claim and release.
 *
 *  - `Ledger.release` had no holder/attempt predicate: a stale worker could clear an unfinished
 *    action's lease while another worker was processing it.
 *  - `claimAction()` neither checked lease expiry nor incremented the action's SQL attempt
 *    count: re-claiming an existing action merely returned `ambiguous`, so nothing said who held
 *    it, and "release" (which only expires a lease) changed nothing observable.
 *  - The tests did not catch removing the release call, nor a no-op production SQL release.
 *
 * SEMANTICS CHOSEN (state of play, not exclusivity -- F2/F3 stay open by design):
 *  - `claimAction`: a fresh claim inserts (`claimed`, attempts 1). A claim whose lease has
 *    EXPIRED or been RELEASED is taken over by the caller in the same statement: attempts + 1,
 *    new owner, new lease; reported `ambiguous` with `owned: true`. A claim another worker still
 *    holds under a LIVE lease is reported `ambiguous` with `owned: false` and left untouched.
 *    Completed and failed rows are never touched.
 *  - `release(identity, action, attempts)`: applies only to an `in_progress` row that still
 *    carries that attempts token AND this process's lease owner. Returns true/false.
 *  - The DELIVERY attempts cap (MAX_RECOVERY_ATTEMPTS = 8) is the only cap. Release never touches
 *    the delivery row, so it can neither reset nor bypass it: a delivery whose actions are
 *    released forever is abandoned and alerted at the cap.
 *
 * SOCKET-FREE. The Postgres class is exercised through a scripted `query()` (no connection);
 * what that can prove is the SQL TEXT and PARAMETERS the production code issues and how it
 * reads the result. What only a database can prove (lock behaviour, `xmax`, the predicate
 * actually filtering rows) is in `ownership-store.pg.test.ts` (skipped without a database).
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity, deliveryRef } from "../src/deliveryref.js";
import { ChatwootApiError } from "../src/errors.js";
import { DISARMED } from "../src/failpoint.js";
import { PostgresLedger, type QueryResult } from "../src/ledger.js";
import { createSweeper, MAX_RECOVERY_ATTEMPTS } from "../src/recovery.js";
import { sendGuardedMessage, type WriteContext, type WriteDeps } from "../src/writes.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const IDENTITY = {
  tenantId: TENANT_ID,
  bindingId: bindingIdentity(makeBinding()),
  chatwootAccountId: ACCOUNT_ID,
  chatwootInboxId: INBOX_ID,
  eventId: "delivery:ledger-r4",
};
const TARGET = { accountId: ACCOUNT_ID, conversationId: CONVERSATION_DISPLAY_ID, accessToken: "tok" };
const LEASE = 300_000;

const claim = (ledger: FakeLedger, action = "reply") =>
  ledger.claimAction(IDENTITY, action, "digest-r4", "corr-r4", LEASE);

// ---------------------------------------------------------------------------
// 1. The ledger contract (FakeLedger mirrors the SQL; the scripted Postgres class below pins the SQL)
// ---------------------------------------------------------------------------

describe("claimAction: insert-or-ACQUIRE, with lease expiry and the attempts token", () => {
  it("a fresh claim is `claimed` with attempts 1", async () => {
    const ledger = new FakeLedger();
    expect(await claim(ledger)).toEqual({ kind: "claimed", attempts: 1 });
  });

  it("a claim another worker holds under a LIVE lease is `ambiguous`, NOT owned, and the token does not move", async () => {
    const ledger = new FakeLedger();
    await claim(ledger);

    const again = await claim(ledger);

    expect(again).toEqual({ kind: "ambiguous", attempts: 1, owned: false });
  });

  it("an EXPIRED claim is taken over: `ambiguous`, owned, attempts + 1", async () => {
    const ledger = new FakeLedger();
    await claim(ledger);
    ledger.expireAllLeases();

    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 2, owned: true });
    // ...and it now holds a live lease: a third claim does not take it.
    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 2, owned: false });
  });

  it("a completed or failed row is never touched", async () => {
    const ledger = new FakeLedger();
    await claim(ledger, "a");
    await claim(ledger, "b");
    await ledger.complete(IDENTITY, "a", 77);
    await ledger.fail(IDENTITY, "b");
    ledger.expireAllLeases();

    expect(await claim(ledger, "a")).toEqual({ kind: "completed", chatwootMessageId: 77 });
    expect((await claim(ledger, "b")).kind).toBe("completed");
  });
});

describe("release: holder- and attempt-fenced", () => {
  it("the holder, at its token, releases: true, and the action is immediately re-acquirable", async () => {
    const ledger = new FakeLedger();
    const first = await claim(ledger);
    expect(first.kind).toBe("claimed");

    expect(await ledger.release(IDENTITY, "reply", 1)).toBe(true);

    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 2, owned: true });
  });

  it("a STALE worker (its claim was taken over) cannot clear the new holder's lease", async () => {
    const ledger = new FakeLedger();
    await claim(ledger); // worker A: attempts 1
    ledger.expireAllLeases();
    const b = await claim(ledger); // worker B takes over: attempts 2
    expect(b).toEqual({ kind: "ambiguous", attempts: 2, owned: true });

    const staleRelease = await ledger.release(IDENTITY, "reply", 1); // A, still holding token 1

    expect(staleRelease).toBe(false);
    // B's lease is intact: nobody can take the action from B.
    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 2, owned: false });
  });

  it("a different PROCESS (another lease owner) cannot release this process's claim", async () => {
    const a = new FakeLedger();
    await claim(a);
    const otherProcess = a.survivesRestart();

    expect(await otherProcess.release(IDENTITY, "reply", 1)).toBe(false);
    expect(await claim(a)).toEqual({ kind: "ambiguous", attempts: 1, owned: false });
  });

  it("a completed or failed row is never reopened by release", async () => {
    const ledger = new FakeLedger();
    await claim(ledger, "a");
    await claim(ledger, "b");
    await ledger.complete(IDENTITY, "a", 5);
    await ledger.fail(IDENTITY, "b");

    expect(await ledger.release(IDENTITY, "a", 1)).toBe(false);
    expect(await ledger.release(IDENTITY, "b", 1)).toBe(false);
    expect((await claim(ledger, "a")).kind).toBe("completed");
    expect((await claim(ledger, "b")).kind).toBe("completed");
  });

  it("DISTINCTNESS: the stale and the current token are different values for the same row", async () => {
    const ledger = new FakeLedger();
    await claim(ledger);
    ledger.expireAllLeases();
    const b = await claim(ledger);
    expect(b.kind === "ambiguous" && b.attempts).not.toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. The PATH: the writers release only a claim they hold, and release really releases
// ---------------------------------------------------------------------------

function writeFixture(deadline: boolean, fence: () => Promise<boolean>) {
  const ledger = new FakeLedger();
  const chatwoot = new StubChatwootApi();
  const capture = new CapturingLogger();
  const deps: WriteDeps = { chatwoot, ledger, logger: capture.logger, leaseMs: LEASE, failpoint: DISARMED };
  const context: WriteContext = {
    identity: IDENTITY,
    digest: "digest-r4",
    correlationId: "corr-r4",
    pivotMessageId: 9001,
    base: {},
    fence,
    authority: { heldEpisode: null, fenced: true, deadlineExceeded: deadline },
  };
  return { deps, context, ledger, chatwoot };
}

describe("the writers: a deadline-fenced claim is genuinely RELEASED, and only if it is this call's", () => {
  it("deadline-fenced: the claim is released AND immediately re-acquirable (catches a removed or no-op release)", async () => {
    const { deps, context, ledger } = writeFixture(true, async () => false);

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    // A live lease would answer `owned: false`. Only a real release makes the next claim ours.
    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 2, owned: true });
  });

  it("a RESUMED worker (it took over an expired claim, attempts 2) releases with ITS token, not a constant", async () => {
    const { deps, context, ledger } = writeFixture(true, async () => false);
    // A previous attempt claimed the action and died; its lease expired before this call.
    await claim(ledger);
    ledger.expireAllLeases();

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    // Released at attempts 2 => the next claim takes it over as attempts 3. A release at a
    // made-up token would have been refused and the lease would still be live (`owned: false`).
    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 3, owned: true });
  });

  it("STALE worker: A's claim was taken over by B before A's fence tripped => A's release is refused and B keeps its lease", async () => {
    let ledgerRef: FakeLedger | null = null;
    const takeOver = async (): Promise<boolean> => {
      ledgerRef!.expireAllLeases();
      const b = await claim(ledgerRef!); // worker B takes the action over (attempts 2)
      expect(b).toEqual({ kind: "ambiguous", attempts: 2, owned: true });
      return false; // ...and A's fence then says no (the turn budget is spent)
    };
    const { deps, context, ledger } = writeFixture(true, takeOver);
    ledgerRef = ledger;

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    expect(await claim(ledger), "A's release cleared B's live lease").toEqual({
      kind: "ambiguous",
      attempts: 2,
      owned: false,
    });
  });

  it("a claim ANOTHER worker still holds is not ours to release: the fenced call leaves it alone", async () => {
    const { deps, context, ledger } = writeFixture(true, async () => false);
    // Another worker holds a live lease on the action before this call claims.
    await claim(ledger);

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    expect(await claim(ledger)).toEqual({ kind: "ambiguous", attempts: 1, owned: false });
  });

  it("CONTROL: fenced because a PERSON took the conversation stays a terminal suppression, not a release", async () => {
    const { deps, context, ledger } = writeFixture(false, async () => false);

    const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);

    expect(outcome.kind).toBe("fenced");
    expect((await claim(ledger)).kind).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// 3. The PRODUCTION SQL, through a scripted query() (text, parameters, how results are read)
// ---------------------------------------------------------------------------

class ScriptedPostgresLedger extends PostgresLedger {
  readonly statements: Array<{ sql: string; params: unknown[] }> = [];
  script: Array<QueryResult<Record<string, unknown>>> = [];
  constructor() {
    super({ connectionString: "postgres://scripted.invalid:1/none", instanceId: "instance-under-test" });
  }
  override async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    this.statements.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });
    const next = this.script.shift();
    if (next === undefined) throw new Error("ScriptedPostgresLedger: unscripted query");
    return next as unknown as QueryResult<T>;
  }
}
const result = (rows: Array<Record<string, unknown>>, rowCount = rows.length): QueryResult<Record<string, unknown>> => ({
  rows,
  rowCount,
});

describe("PostgresLedger (production SQL): claimAction", () => {
  it("issues an insert-or-ACQUIRE that checks lease expiry and increments attempts", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([{ inserted: true, attempts: 1 }])];

    const claimed = await ledger.claimAction(IDENTITY, "reply", "d", "c", LEASE);

    expect(claimed).toEqual({ kind: "claimed", attempts: 1 });
    const sql = ledger.statements[0]!.sql;
    expect(sql).toContain("ON CONFLICT ON CONSTRAINT delivery_ledger_pkey DO UPDATE");
    expect(sql).toContain("attempts = delivery_ledger.attempts + 1");
    expect(sql).toContain("delivery_ledger.delivery_state = 'in_progress'");
    expect(sql).toContain("delivery_ledger.lease_expires_at <= now()");
    expect(sql).toContain("RETURNING (xmax = 0) AS inserted, attempts");
  });

  it("an updated row (a taken-over claim) is `ambiguous`, owned, with the NEW attempts", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([{ inserted: false, attempts: 3 }])];
    expect(await ledger.claimAction(IDENTITY, "reply", "d", "c", LEASE)).toEqual({
      kind: "ambiguous",
      attempts: 3,
      owned: true,
    });
  });

  it("no row returned and the row is in progress under a live lease => `ambiguous`, NOT owned", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([]), result([{ delivery_state: "in_progress", chatwoot_message_id: null, attempts: 2 }])];
    expect(await ledger.claimAction(IDENTITY, "reply", "d", "c", LEASE)).toEqual({
      kind: "ambiguous",
      attempts: 2,
      owned: false,
    });
  });

  it("no row returned and the row is completed / failed => `completed`", async () => {
    const done = new ScriptedPostgresLedger();
    done.script = [result([]), result([{ delivery_state: "completed", chatwoot_message_id: "88", attempts: 1 }])];
    expect(await done.claimAction(IDENTITY, "reply", "d", "c", LEASE)).toEqual({ kind: "completed", chatwootMessageId: 88 });
    const failed = new ScriptedPostgresLedger();
    failed.script = [result([]), result([{ delivery_state: "failed", chatwoot_message_id: null, attempts: 1 }])];
    expect(await failed.claimAction(IDENTITY, "reply", "d", "c", LEASE)).toEqual({ kind: "completed", chatwootMessageId: null });
  });
});

describe("PostgresLedger (production SQL): release", () => {
  it("is fenced by state, attempts token and lease owner, and passes all three", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([], 1)];

    const released = await ledger.release(IDENTITY, "reply", 4);

    expect(released).toBe(true);
    const { sql, params } = ledger.statements[0]!;
    expect(sql).toContain("SET lease_owner = NULL, lease_expires_at = now()");
    expect(sql).toContain("AND delivery_state = 'in_progress'");
    expect(sql).toContain("AND attempts = $7");
    expect(sql).toContain("AND lease_owner = $8");
    expect(params.slice(6)).toEqual([4, "instance-under-test"]);
  });

  it("reports false when no row matched (stale token, another owner, or a terminal row)", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([], 0)];
    expect(await ledger.release(IDENTITY, "reply", 4)).toBe(false);
  });
});

describe("PostgresLedger (production SQL): unsettledActions", () => {
  it("reads only this delivery's in-progress ACTION rows (never the delivery row)", async () => {
    const ledger = new ScriptedPostgresLedger();
    ledger.script = [result([{ action_type: "failure_note" }, { action_type: "labels" }])];

    expect(await ledger.unsettledActions(IDENTITY)).toEqual(["failure_note", "labels"]);

    const { sql, params } = ledger.statements[0]!;
    expect(sql).toContain("event_id = $5");
    expect(sql).toContain("action_type <> $6");
    expect(sql).toContain("delivery_state = 'in_progress'");
    expect(params).toEqual([
      IDENTITY.tenantId,
      IDENTITY.bindingId,
      IDENTITY.chatwootAccountId,
      IDENTITY.chatwootInboxId,
      IDENTITY.eventId,
      "delivery",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The cap: repeated release cannot loop forever, and cannot reset the delivery cap
// ---------------------------------------------------------------------------

// CHANGED (Codex R5, Lane A direction): recovery no longer re-drives a delivery, so a delivery can no
// longer be fenced and released on every attempt by the sweeper. What the cap protected is still
// true and is asserted here against the thing that CAN now repeat: an escalation that never becomes
// visible (the status change fails every time). It must end at the cap, ALERTED, with a single
// note across every attempt and no customer message, never an endless quiet loop.
describe("the delivery attempts cap is not reset by repeated recovery attempts", () => {
  it("a delivery whose escalation is NEVER visible is abandoned and alerted at the cap; one note in total; no reply is ever sent", async () => {
    const chatwoot = new StubChatwootApi();
    const ledger = new FakeLedger();
    const capture = new CapturingLogger();
    const config = envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" });
    const ownership = new InMemoryOwnershipGate();
    const binding = makeBinding();
    chatwoot.openConversationFailure = new ChatwootApiError("returned HTTP 500", 500);
    const identity = { ...IDENTITY, eventId: "delivery:cap" };
    await ledger.reserve({
      identity,
      digest: "digest-cap",
      correlationId: "corr-cap",
      conversationId: CONVERSATION_DISPLAY_ID,
      messageId: 9001,
      mode: "answer",
      leaseMs: LEASE,
    });
    await ledger.claimAction(identity, "reply", "digest-cap", "corr-cap", LEASE);

    const sweeper = createSweeper({
      config,
      ledger,
      bindingStore: { list: () => [binding] },
      chatwoot,
      runtime: StubAgentRuntime.answering("must not be called"),
      logger: capture.logger,
      ownership,
      failpoint: DISARMED,
      now: () => Date.now(),
    });
    let sweeps = 0;
    for (; sweeps < MAX_RECOVERY_ATTEMPTS + 4; sweeps += 1) {
      ledger.expireAllLeases();
      await sweeper.sweep();
      const delivery = [...ledger.rows.entries()].find(([k]) => k.endsWith("|delivery") && k.includes("delivery:cap"));
      if (delivery?.[1].state === "failed") break;
    }

    expect(chatwoot.customerMessages, "a reply was sent by recovery").toHaveLength(0);
    expect(chatwoot.privateNotes, "the note must be posted once across every attempt, not once per attempt").toHaveLength(1);
    const abandoned = capture.lines.filter((r) => r["alertCode"] === "recovery_attempts_exhausted");
    expect(abandoned, "repeated failure must end in the cap, with an alert").toHaveLength(1);
    expect(sweeps, "the cap did not bound the loop").toBeLessThanOrEqual(MAX_RECOVERY_ATTEMPTS);
    const replyRow = [...ledger.rows.entries()].find(([k]) => k.endsWith("|reply") && k.includes("delivery:cap"));
    expect(replyRow?.[1].state, "the open reply action must not stay in_progress under a failed delivery").toBe("failed");
  });

  it("DISTINCTNESS: release never touches the delivery row's attempts", async () => {
    const ledger = new FakeLedger();
    await ledger.reserve({
      identity: IDENTITY,
      digest: "d",
      correlationId: "c",
      conversationId: 1,
      messageId: 1,
      mode: "answer",
      leaseMs: LEASE,
    });
    await claim(ledger);
    const before = [...ledger.rows.entries()].find(([k]) => k.endsWith("|delivery"))![1].attempts;
    await ledger.release(IDENTITY, "reply", 1);
    await claim(ledger);
    await ledger.release(IDENTITY, "reply", 2);
    const after = [...ledger.rows.entries()].find(([k]) => k.endsWith("|delivery"))![1].attempts;
    expect(after).toBe(before);
    expect(deliveryRef(IDENTITY, "reply")).not.toBe(deliveryRef(IDENTITY, "labels"));
  });
});
