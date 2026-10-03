/**
 * CODEX DH4 (direct Hermes path, review of d810455) - P2.
 *
 * After an event connection BROKE, the adapter answered by polling but never drained that run's event
 * stream, then released its local slot. The service counts a run against its cap of 10 until its stream
 * is read to the end OR its own 300 s sweep removes it, so the remote slot stayed taken while the local
 * gauge read zero: the third turn (cap two in Codex's rig) met `hermes_rate_limited`.
 *
 * The honest accounting: a run whose stream was NOT drained keeps its LOCAL slot until the service's own
 * sweep has had time to release the remote one (`remoteSweepMs`, default 300 s). The gauge then tells
 * the truth, and a turn that cannot get a slot says `hermes_busy` WITHOUT sending a request.
 *
 * SOCKET-FREE, a FAKE Hermes that models the cap and (optionally) the sweep. Positive twins in the same
 * file (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HERMES_OUTCOMES, HermesDirectRuntime, type HermesRuntimeOptions } from "../src/hermes-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { answerEnvelope, sleep } from "./hermes-rig.js";

let n = 0;
function request(conversation = 42): AgentRuntimeRequest {
  n += 1;
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    idempotencyKey: `isolagw:tenant-acme|b1|1|7|delivery:dh4-${n}|answer`,
    historyMessageIds: [9001],
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: conversation, conversationStatus: "pending", messageId: 9001, customAttributes: {} },
      history: [{ role: "customer", content: "Do you sell calling plans?" }],
      historyTruncated: false,
      message: { role: "customer", content: "Do you sell calling plans?" },
    },
  };
}

function runtimeFor(fake: FakeHermes, over: Partial<HermesRuntimeOptions> = {}): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: fake.fetch,
    runDeadlineMs: 300,
    pollIntervalMs: 10,
    requestTimeoutMs: 300,
    maxInflight: 2,
    rateLimitBackoffMs: 10,
    streamDrainGraceMs: 100,
    ...over,
  });
}

/** The run COMPLETES by status and its event connection then DIES: the answer comes from polling; the stream is never drained. */
function brokenStreamRuns(fake: FakeHermes): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => {
      run.status = "completed";
      run.output = answerEnvelope("THE ANSWER");
    }, 15);
    setTimeout(() => run.breakStream(), 30);
  };
}
function drainedRuns(fake: FakeHermes): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(answerEnvelope("THE ANSWER")), 15);
  };
}

describe("DH4 a run whose event stream was never drained keeps its slot until the service's own sweep", () => {
  it("CONTROL: drained runs release their slot at once -> after two turns the gauge is zero and a third turn is answered", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    drainedRuns(fake);
    const rt = runtimeFor(fake);
    expect((await rt.invoke(request(1))).outcome).toBe("ok");
    expect((await rt.invoke(request(2))).outcome).toBe("ok");
    expect(rt.inflight()).toBe(0);
    expect((await rt.invoke(request(3))).outcome).toBe("ok");
    expect(fake.creates).toHaveLength(3);
  });

  it("NEGATIVE (Codex's probe): two broken-stream turns answer by polling, the gauge still counts BOTH runs, and the third turn is `busy` WITHOUT a request", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    brokenStreamRuns(fake);
    const rt = runtimeFor(fake);
    expect((await rt.invoke(request(1))).outcome).toBe("ok");
    expect((await rt.invoke(request(2))).outcome).toBe("ok");
    expect(fake.counted, "the fake service counts both undrained runs").toBe(2);
    expect(rt.inflight(), "the local gauge reads zero while the service still counts two runs").toBe(2);

    const third = await rt.invoke(request(3));
    expect(third.outcome).toBe(HERMES_OUTCOMES.busy);
    expect(third.text).toBeNull();
    expect(fake.creates, "a third create was sent into a service whose cap is held by our own undrained runs").toHaveLength(2);
  });

  it("the hold ENDS with the service's own sweep: after remoteSweepMs the slots are free and the third turn is answered", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    fake.sweepMs = 150; // the (modelled) service sweep
    brokenStreamRuns(fake);
    const rt = runtimeFor(fake, { remoteSweepMs: 150 });
    await rt.invoke(request(1));
    await rt.invoke(request(2));
    expect(rt.inflight()).toBe(2);
    await sleep(220);
    expect(rt.inflight(), "the slots were not released when the sweep time passed").toBe(0);
    const third = await rt.invoke(request(3));
    expect(third.outcome).toBe("ok");
    expect(fake.creates).toHaveLength(3);
  });

  it("only an UNDRAINED run holds a slot: a run whose stream ended normally is released at once even when remoteSweepMs is large", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    drainedRuns(fake);
    const rt = runtimeFor(fake, { remoteSweepMs: 60_000 });
    await rt.invoke(request(1));
    await rt.invoke(request(2));
    expect(rt.inflight()).toBe(0);
  });

  it("the hold is not extended by waiting: it is measured from when the run was CREATED (a slow turn holds only what is left of the sweep window)", async () => {
    const fake = new FakeHermes();
    fake.cap = 2;
    fake.sweepMs = 200;
    // completes late (~120 ms after creation) and breaks: roughly 80 ms of the 200 ms window remain
    fake.onRun = (run: FakeRun) => {
      run.running();
      setTimeout(() => {
        run.status = "completed";
        run.output = answerEnvelope("THE ANSWER");
      }, 100);
      setTimeout(() => run.breakStream(), 120);
    };
    const rt = runtimeFor(fake, { remoteSweepMs: 200, runDeadlineMs: 600 });
    const started = Date.now();
    await rt.invoke(request(1));
    expect(rt.inflight()).toBe(1);
    await sleep(Math.max(0, 200 - (Date.now() - started)) + 80);
    expect(rt.inflight(), "the hold outlived the sweep window measured from creation").toBe(0);
  });
});
