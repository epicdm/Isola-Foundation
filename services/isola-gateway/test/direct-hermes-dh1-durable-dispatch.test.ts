/**
 * CODEX DH1 (direct Hermes path, review of d810455) - P1, blocking.
 *
 * "A gateway restart permits a second Hermes run for the same ledger key." The first run and the reply
 * complete; only the final delivery closure fails; the lease expires; a FRESH gateway instance receives
 * the same signed delivery. The adapter's `started` set is in memory (and capped at 10,000), so the new
 * instance has never heard of the key: TWO model runs, one customer reply.
 *
 * /v1/runs ignores Idempotency-Key, so the guard cannot be delegated to Hermes. It must be DURABLE: a
 * `model_run` marker in the delivery ledger (an ordinary action row; `action_type` is free text, no schema
 * change), CLAIMED BEFORE the POST /v1/runs. A redelivery of any delivery that has already claimed it
 * escalates WITHOUT calling Hermes.
 *
 * RESIDUAL, stated: a crash AFTER the marker and BEFORE the POST means that turn is escalated and never
 * retried (fail closed: one human follow-up instead of a possible second run).
 *
 * SOCKET-FREE. Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { DELIVERY_ACTION } from "../src/deliveryref.js";
import { HermesDirectRuntime, HERMES_OUTCOMES } from "../src/hermes-runtime.js";
import { LedgerUnavailableError, type LedgerIdentity } from "../src/ledger.js";
import { WRITE } from "../src/pipeline.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { FakeLedger } from "./harness.js";
import { FakeHermes } from "./hermes-fake.js";
import { answerEnvelope, completeWith, directRig, sleep } from "./hermes-rig.js";

const MODEL_RUN = "model_run";

/** A ledger whose FINAL delivery closure fails: the work is done, only the bookkeeping is lost. */
class ClosureFailsLedger extends FakeLedger {
  failClosure = true;
  override async complete(identity: LedgerIdentity, action: string, chatwootMessageId: number | null): Promise<void> {
    if (this.failClosure && action === DELIVERY_ACTION) throw new LedgerUnavailableError("simulated: the closure write was lost");
    return super.complete(identity, action, chatwootMessageId);
  }
}

const keyOf = (ledger: FakeLedger, action: string): string | undefined =>
  [...ledger.rows.keys()].find((k) => k.endsWith(`|${action}`));

/** Make every lease in the ledger expire NOW, as if the first worker's lease had run out. */
function expireLeases(ledger: FakeLedger): void {
  for (const row of ledger.rows.values()) {
    if (row.state === "reserved" || row.state === "in_progress") row.leaseExpiresAt = Date.now() - 1;
  }
}

// ---------------------------------------------------------------------------
// A. The runtime contract: the claim comes BEFORE the POST
// ---------------------------------------------------------------------------

const KEY = "isolagw:tenant-acme|b1|1|7|delivery:dh1-unit|answer";
function request(over: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    historyMessageIds: [9001],
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, conversationStatus: "pending", messageId: 9001, customAttributes: {} },
      history: [{ role: "customer", content: "hello" }],
      historyTruncated: false,
      message: { role: "customer", content: "hello" },
    },
    ...over,
  };
}
function runtimeFor(fake: FakeHermes, require = true): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: fake.fetch,
    runDeadlineMs: 1500,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: 4,
    rateLimitBackoffMs: 20,
    streamDrainGraceMs: 100,
    requireDurableDispatch: require,
  });
}

describe("DH1 the dispatch claim is taken BEFORE the POST and decides whether Hermes is called at all", () => {
  it("CONTROL: the claim says 'first' -> exactly one POST, and the claim came before it", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("ok"));
    const order: string[] = [];
    const r = await runtimeFor(fake).invoke(
      request({
        claimDispatch: async () => {
          order.push(`claim@creates=${fake.creates.length}`);
          return true;
        },
      }),
    );
    expect(r.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(1);
    expect(order).toEqual(["claim@creates=0"]);
  });

  it("NEGATIVE: the claim says 'already' (an earlier delivery attempt claimed it, possibly on another instance) -> NO POST, hermes_duplicate_invoke", async () => {
    const fake = new FakeHermes();
    const r = await runtimeFor(fake).invoke(request({ claimDispatch: async () => false }));
    expect(r.outcome).toBe(HERMES_OUTCOMES.duplicateInvoke);
    expect(r.text).toBeNull();
    expect(fake.log, "Hermes was contacted although the key had already started a run").toHaveLength(0);
  });

  it("NEGATIVE: the ledger cannot record the claim -> NO POST (a run that cannot be recorded is a run that could be repeated)", async () => {
    const fake = new FakeHermes();
    const r = await runtimeFor(fake).invoke(
      request({
        claimDispatch: async () => {
          throw new LedgerUnavailableError("down");
        },
      }),
    );
    expect(r.outcome).toBe(HERMES_OUTCOMES.dispatchUnrecorded);
    expect(r.text).toBeNull();
    expect(fake.log).toHaveLength(0);
  });

  it("NEGATIVE: durable dispatch is REQUIRED (production wiring) and the request carries no claim -> NO POST", async () => {
    const fake = new FakeHermes();
    const r = await runtimeFor(fake, true).invoke(request());
    expect(r.outcome).toBe(HERMES_OUTCOMES.dispatchUnrecorded);
    expect(fake.log).toHaveLength(0);
  });

  it("CONTROL: durable dispatch not required (a direct unit use) and no claim -> proceeds on the in-memory guard alone", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("ok"));
    const r = await runtimeFor(fake, false).invoke(request());
    expect(r.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(1);
  });

  it("the in-memory guard still refuses a same-process replay even when the durable claim would say 'first'", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("ok"));
    const rt = runtimeFor(fake);
    const claim = async (): Promise<boolean> => true;
    await rt.invoke(request({ claimDispatch: claim }));
    const second = await rt.invoke(request({ claimDispatch: claim }));
    expect(second.outcome).toBe(HERMES_OUTCOMES.duplicateInvoke);
    expect(fake.creates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// B. The route: two gateway instances sharing one ledger (the restart Codex ran)
// ---------------------------------------------------------------------------

describe("DH1 the route: a delivery whose closure was lost is NOT run a second time by a fresh gateway instance", () => {
  it("NEGATIVE (Codex's probe): run + reply complete, closure fails, lease expires, a FRESH instance gets the same signed delivery -> ONE Hermes run, one reply, a human is asked", async () => {
    const ledger = new ClosureFailsLedger();
    const first = directRig({ ledger });
    completeWith(first.fake, answerEnvelope("THE ONE ANSWER"));
    expect((await first.post({ content: "What does the 200 minute plan cost?" }, "00000000-0000-4000-8000-0000000d1001")).status).toBe(200);
    await first.gateway.drain();

    // the work is done: one run, one reply; only the closure of the delivery row was lost
    expect(first.fake.creates).toHaveLength(1);
    expect(first.chatwoot.customerMessages).toHaveLength(1);
    const deliveryKey = keyOf(ledger, DELIVERY_ACTION)!;
    expect(["reserved", "in_progress"]).toContain(ledger.rows.get(deliveryKey)!.state);
    expect(ledger.rows.get(keyOf(ledger, WRITE.reply)!)!.state).toBe("completed");
    expireLeases(ledger);

    // a FRESH instance (a new adapter with an EMPTY in-memory guard, a different ledger instance id) over the same durable store
    const second = directRig({
      ledger: ledger.survivesRestart(),
      chatwoot: first.chatwoot,
      turns: first.turns,
      ownership: first.ownership,
      fake: first.fake,
    });
    const again = await second.post({ content: "What does the 200 minute plan cost?" }, "00000000-0000-4000-8000-0000000d1001");
    expect(again.status).toBe(200);
    await second.gateway.drain();

    expect(first.fake.creates, "a fresh gateway instance started a SECOND model run for the same delivery").toHaveLength(1);
    expect(first.fake.runs.size).toBe(1);
    expect(second.capture.lines.map((l) => JSON.stringify(l)).join("\n")).toMatch(/hermes_duplicate_invoke/);
  });

  it("POSITIVE TWIN: the SAME fresh instance DOES call Hermes for a NEW delivery (so the refusal above is the marker, not a dead rig)", async () => {
    const ledger = new ClosureFailsLedger();
    const first = directRig({ ledger });
    completeWith(first.fake, answerEnvelope("ANSWER ONE"));
    await first.post({ content: "first question" }, "00000000-0000-4000-8000-0000000d1002");
    await first.gateway.drain();
    expireLeases(ledger);

    const second = directRig({ ledger: ledger.survivesRestart(), chatwoot: first.chatwoot, turns: first.turns, ownership: first.ownership, fake: first.fake });
    completeWith(first.fake, answerEnvelope("ANSWER TWO"));
    await second.post({ content: "a different question" }, "00000000-0000-4000-8000-0000000d1003");
    await second.gateway.drain();
    expect(first.fake.creates).toHaveLength(2);
  });

  it("the marker is an ordinary ledger action row, claimed and then COMPLETED when the turn ended (no unsettled action is left under a closed delivery)", async () => {
    const ledger = new FakeLedger();
    const r = directRig({ ledger });
    completeWith(r.fake, answerEnvelope("fine"));
    await r.post({ content: "hello there" }, "00000000-0000-4000-8000-0000000d1004");
    await r.gateway.drain();
    const marker = ledger.rows.get(keyOf(ledger, MODEL_RUN) ?? "");
    expect(marker, "no model_run marker was recorded").toBeDefined();
    expect(marker!.state).toBe("completed");
    expect([...ledger.rows.values()].every((row) => row.state === "completed")).toBe(true);
  });

  it("the marker is also settled when the turn FAILED (an envelope the gateway refuses): the delivery is closed and nothing stays in progress", async () => {
    const ledger = new FakeLedger();
    const r = directRig({ ledger });
    completeWith(r.fake, "this is not the one-line envelope");
    await r.post({ content: "hello there" }, "00000000-0000-4000-8000-0000000d1005");
    await r.gateway.drain();
    expect(ledger.rows.get(keyOf(ledger, MODEL_RUN)!)!.state).toBe("completed");
    expect([...ledger.rows.values()].filter((row) => row.state === "in_progress")).toEqual([]);
  });

  it("RESIDUAL: a marker left UNSETTLED (the crash window: claimed, never completed) is treated exactly like a settled one -> the redelivery never calls Hermes", async () => {
    const ledger = new ClosureFailsLedger();
    const first = directRig({ ledger });
    completeWith(first.fake, answerEnvelope("ANSWER"));
    await first.post({ content: "hello" }, "00000000-0000-4000-8000-0000000d1006");
    await first.gateway.drain();
    expect(first.fake.creates).toHaveLength(1);

    // what a crash between the claim and the end of the turn leaves behind: the marker claimed and unsettled
    const marker = ledger.rows.get(keyOf(ledger, MODEL_RUN)!)!;
    marker.state = "in_progress";
    expireLeases(ledger);
    const createsBefore = first.fake.creates.length;

    const second = directRig({ ledger: ledger.survivesRestart(), chatwoot: first.chatwoot, turns: first.turns, ownership: first.ownership, fake: first.fake });
    await second.post({ content: "hello" }, "00000000-0000-4000-8000-0000000d1006");
    await second.gateway.drain();
    expect(first.fake.creates.length, "the redelivery POSTed to Hermes although a marker was already recorded").toBe(createsBefore);
  });});

describe("DH1 the production wiring REQUIRES the durable claim", () => {
  it("src/app.ts builds the HermesDirectRuntime with requireDurableDispatch: true (a source pin: the pipeline always offers the claim, so only the wiring flag keeps a future caller from sending without one)", () => {
    const app = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
    const at = app.indexOf("new HermesDirectRuntime(");
    expect(at).toBeGreaterThan(0);
    const block = app.slice(at, app.indexOf("new Set(hermesCfg.agentIds)", at));
    expect(block).toMatch(/requireDurableDispatch:\s*true/);
    expect(block).not.toMatch(/requireDurableDispatch:\s*false/);
  });
});