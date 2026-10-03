/**
 * CODEX N1 (direct Hermes path, short re-review of bd5b8f5) - P2, blocking.
 *
 * N1. `claimDispatch()` (the durable "a run was started" marker, DH1) was awaited with NO bound. A claim
 *     that never settles (a lock wait, a stalled connection) ignored the runtime deadline AND the turn's
 *     cancellation: `inflight()` stayed 1, repeated up to capacity it blocked ALL dispatch, and the 300 s
 *     release cannot help because no run was ever created. Now the claim is bounded by the deadline and by
 *     cancellation, the local slots are released, a claim that resolves LATE never dispatches, and any
 *     claim that may have been recorded stays recorded (so a redelivery still escalates and never POSTs).
 *
 *
 * SOCKET-FREE. Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HermesDirectRuntime, HERMES_OUTCOMES } from "../src/hermes-runtime.js";
import { LedgerUnavailableError, type LedgerIdentity } from "../src/ledger.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { FakeLedger } from "./harness.js";
import { FakeHermes } from "./hermes-fake.js";
import { answerEnvelope, completeWith, directRig, sleep } from "./hermes-rig.js";

const MODEL_RUN = "model_run";
/** A short, VALID turn: the Hermes run deadline (300 ms) < runtime timeout < turn budget, so a claim delayed 600 ms outlives the run deadline. */
const SHORT_TURN_ENV: Record<string, string> = {
  GATEWAY_HERMES_RUN_DEADLINE_MS: "300",
  GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "200",
  GATEWAY_RUNTIME_TIMEOUT_MS: "400",
  GATEWAY_CHATWOOT_TIMEOUT_MS: "500",
  GATEWAY_TURN_BUDGET_MS: "1200",
};
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** Never waits forever: a hang is reported as a failure instead of a vitest timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const guard = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HUNG: ${what} did not finish within ${ms} ms`)), ms);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, guard]);
}

function request(n: number, over: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  const key = `isolagw:tenant-acme|b1|1|7|delivery:n1-${n}|answer`;
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: `delivery-${n}`,
    idempotencyKey: key,
    historyMessageIds: [9000 + n],
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      // a DIFFERENT conversation per request, so the per-conversation limit is not what is being tested
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 100 + n, conversationStatus: "pending", messageId: 9000 + n, customAttributes: {} },
      history: [{ role: "customer", content: "hello" }],
      historyTruncated: false,
      message: { role: "customer", content: "hello" },
    },
    ...over,
  };
}

function runtimeFor(fake: FakeHermes, over: { runDeadlineMs?: number; maxInflight?: number } = {}): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: fake.fetch,
    runDeadlineMs: over.runDeadlineMs ?? 1500,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: over.maxInflight ?? 4,
    rateLimitBackoffMs: 20,
    streamDrainGraceMs: 100,
    requireDurableDispatch: true,
  });
}

// ---------------------------------------------------------------------------
// N1. The dispatch claim is bounded
// ---------------------------------------------------------------------------

describe("N1 a stalled dispatch claim is bounded by the deadline and by cancellation", () => {
  it("CONTROL: a healthy claim -> one POST, the slot is released afterwards", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("ok"));
    const rt = runtimeFor(fake);
    const r = await rt.invoke(request(1, { claimDispatch: async () => true }));
    expect(r.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(1);
    expect(rt.inflight()).toBe(0);
  });

  it("NEGATIVE (Codex's probe): a claim that never settles + the runtime deadline -> the turn ends AT the deadline, no POST, no slot held", async () => {
    const fake = new FakeHermes();
    const rt = runtimeFor(fake, { runDeadlineMs: 200 });
    const started = Date.now();
    const r = await within(rt.invoke(request(2, { claimDispatch: () => never<boolean>() })), 1200, "invoke with a stalled claim");
    expect(Date.now() - started).toBeLessThan(900);
    expect(r.outcome).toBe(HERMES_OUTCOMES.timeout);
    expect(r.text).toBeNull();
    expect(fake.log, "Hermes was contacted although the claim never settled").toHaveLength(0);
    expect(rt.inflight(), "the stalled claim kept its slot").toBe(0);
  });

  it("NEGATIVE (Codex's probe): a claim that never settles + the turn is CANCELLED -> the turn ends at the cancellation, no POST, no slot held", async () => {
    const fake = new FakeHermes();
    const rt = runtimeFor(fake, { runDeadlineMs: 5000 });
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 60);
    const started = Date.now();
    const r = await within(rt.invoke(request(3, { signal: abort.signal, claimDispatch: () => never<boolean>() })), 1500, "invoke with a stalled claim and a cancellation");
    expect(Date.now() - started).toBeLessThan(900);
    expect(r.outcome).toBe(HERMES_OUTCOMES.timeout);
    expect(fake.log).toHaveLength(0);
    expect(rt.inflight()).toBe(0);
  });

  it("NEGATIVE: stalled claims repeated up to CAPACITY do not block later turns", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("later turn answered"));
    const rt = runtimeFor(fake, { runDeadlineMs: 150, maxInflight: 2 });
    // two stalled claims fill both slots until their deadline
    const stalled = [10, 11].map((n) => rt.invoke(request(n, { claimDispatch: () => never<boolean>() })));
    await within(Promise.all(stalled), 1500, "the stalled turns");
    expect(rt.inflight(), "the stalled turns still hold slots").toBe(0);
    // a later, healthy turn is not blocked
    const later = await within(rt.invoke(request(12, { claimDispatch: async () => true })), 1500, "the later turn");
    expect(later.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(1);
  });

  it("NEGATIVE: a claim that resolves LATE (after the deadline) never dispatches", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("must never be requested"));
    const rt = runtimeFor(fake, { runDeadlineMs: 120 });
    let resolveClaim: (v: boolean) => void = () => undefined;
    const claim = new Promise<boolean>((resolve) => (resolveClaim = resolve));
    const r = await within(rt.invoke(request(20, { claimDispatch: () => claim })), 1200, "invoke");
    expect(r.outcome).toBe(HERMES_OUTCOMES.timeout);
    resolveClaim(true); // the ledger answers 'claimed' AFTER the turn gave up
    await sleep(250);
    expect(fake.creates, "a late claim resolution started a run").toHaveLength(0);
    expect(fake.log).toHaveLength(0);
  });

  it("NEGATIVE: a claim that resolves LATE after a CANCELLATION never dispatches either", async () => {
    const fake = new FakeHermes();
    const rt = runtimeFor(fake, { runDeadlineMs: 5000 });
    const abort = new AbortController();
    let resolveClaim: (v: boolean) => void = () => undefined;
    const claim = new Promise<boolean>((resolve) => (resolveClaim = resolve));
    setTimeout(() => abort.abort(), 40);
    await within(rt.invoke(request(21, { signal: abort.signal, claimDispatch: () => claim })), 1500, "invoke");
    resolveClaim(true);
    await sleep(200);
    expect(fake.creates).toHaveLength(0);
  });

  it("NEGATIVE: a claim that settles 'first' only AFTER the deadline has passed (the event loop was blocked) never dispatches; the claim stays", async () => {
    const fake = new FakeHermes();
    completeWith(fake, answerEnvelope("must never be requested"));
    const rt = runtimeFor(fake, { runDeadlineMs: 80 });
    let calls = 0;
    const r = await within(
      rt.invoke(
        request(24, {
          claimDispatch: async () => {
            calls += 1;
            const until = Date.now() + 160; // blocks past the 80 ms deadline before answering 'first'
            while (Date.now() < until) {
              /* busy */
            }
            return true;
          },
        }),
      ),
      2000,
      "invoke",
    );
    expect(calls).toBe(1);
    expect(r.outcome).toBe(HERMES_OUTCOMES.timeout);
    expect(fake.log, "a claim answered after the deadline started a run").toHaveLength(0);
    expect(rt.inflight()).toBe(0);
  });

  it("a claim that REJECTS after the turn gave up is swallowed (no unhandled rejection)", async () => {
    const fake = new FakeHermes();
    const rt = runtimeFor(fake, { runDeadlineMs: 100 });
    let rejectClaim: (e: Error) => void = () => undefined;
    const claim = new Promise<boolean>((_resolve, reject) => (rejectClaim = reject));
    const unhandled: unknown[] = [];
    const on = (reason: unknown): void => void unhandled.push(reason);
    process.on("unhandledRejection", on);
    try {
      await within(rt.invoke(request(22, { claimDispatch: () => claim })), 1200, "invoke");
      rejectClaim(new LedgerUnavailableError("late failure"));
      await sleep(150);
    } finally {
      process.off("unhandledRejection", on);
    }
    expect(unhandled).toEqual([]);
  });

  it("the claim is attempted ONCE (never retried, never released) when it stalls", async () => {
    const fake = new FakeHermes();
    const rt = runtimeFor(fake, { runDeadlineMs: 100 });
    let calls = 0;
    await within(rt.invoke(request(23, { claimDispatch: () => ((calls += 1), never<boolean>()) })), 1200, "invoke");
    await sleep(100);
    expect(calls).toBe(1);
  });
});

/** A ledger whose model_run claim lands LATE (after the runtime gave up), as a lock wait would. */
class SlowClaimLedger extends FakeLedger {
  delayClaimMs = 0;
  override async claimAction(
    identity: LedgerIdentity,
    action: string,
    digest: string,
    correlationId: string,
    leaseMs: number,
  ): ReturnType<FakeLedger["claimAction"]> {
    if (action === MODEL_RUN && this.delayClaimMs > 0) await sleep(this.delayClaimMs);
    return super.claimAction(identity, action, digest, correlationId, leaseMs);
  }
}

describe("N1 route: an UNCERTAIN claim stays recorded, so a redelivery escalates without calling Hermes", () => {
  it("the claim lands after the turn gave up -> no run now; a redelivery on a FRESH instance after the lease expires still makes NO run", async () => {
    const ledger = new SlowClaimLedger();
    ledger.delayClaimMs = 600;
    const first = directRig({ ledger, env: SHORT_TURN_ENV });
    completeWith(first.fake, answerEnvelope("must not be sent"));
    await first.post({ content: "hello" }, "00000000-0000-4000-8000-0000000051a1");
    await first.gateway.drain();
    await sleep(900); // the delayed claim lands now
    expect(first.fake.creates, "the late claim started a run").toHaveLength(0);
    expect(first.chatwoot.customerMessages).toHaveLength(0);
    const marker = [...ledger.rows.entries()].find(([k]) => k.endsWith(`|${MODEL_RUN}`));
    expect(marker, "the claim that landed late must stay recorded").toBeDefined();

    ledger.expireAllLeases();
    ledger.delayClaimMs = 0;
    const second = directRig({
      ledger: ledger.survivesRestart(),
      chatwoot: first.chatwoot,
      turns: first.turns,
      ownership: first.ownership,
      fake: first.fake,
    });
    await second.post({ content: "hello" }, "00000000-0000-4000-8000-0000000051a1");
    await second.gateway.drain();
    expect(first.fake.creates, "a redelivery started a run although a claim had been recorded").toHaveLength(0);
  });

  it("POSITIVE TWIN: the same rig with a prompt claim answers the customer (so the above is the bound, not a dead rig)", async () => {
    const ledger = new SlowClaimLedger();
    const r = directRig({ ledger });
    completeWith(r.fake, answerEnvelope("prompt claim, answered"));
    await r.post({ content: "hello" }, "00000000-0000-4000-8000-0000000051a2");
    await r.gateway.drain();
    expect(r.fake.creates).toHaveLength(1);
    expect(JSON.stringify(r.chatwoot.customerMessages)).toContain("prompt claim, answered");
  });
});
