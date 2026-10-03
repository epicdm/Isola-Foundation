/**
 * STEP A+ (direct Hermes path): WHAT MAY BE SENT AFTER THE TURN SIGNAL FIRES.
 *
 * Lane A ruling: the ONE best-effort `POST /v1/runs/{id}/stop` that the runtime sends after the turn
 * signal fires is ACCEPTED as a CANCELLATION, not a dispatch. `AgentRuntimeRequest.signal` says a
 * runtime must start no request once it fires; the stop is the single, documented exception, because
 * it REMOVES work (Step B measured: /stop halts model execution, provider stream closed 0.08 s later)
 * and the alternative is a model call that keeps running after its turn is spent.
 *
 * So after the signal the ONLY request that may leave this runtime is exactly one POST to
 * `/v1/runs/{run_id}/stop` for the run this turn created. No create, no status poll, no event stream,
 * no second stop, and no customer write. The tests read the request log of the fake Hermes (no socket)
 * and each has its positive control in the same run: BEFORE the signal the very same log DOES contain
 * a create, polls and a stream, so "nothing after the signal" is not a property of an empty log
 * (Laws 11, 19, 23, 28). The fake follows lane 59's Step-B-verified contract and is not evidence of
 * installed behaviour (Law 5).
 */
import { describe, expect, it } from "vitest";

import { HermesDirectRuntime, HERMES_OUTCOMES, type HermesRuntimeOptions } from "../src/hermes-runtime.js";
import type { AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";
import { FakeHermes } from "./hermes-fake.js";

const BEARER = `fake-hermes-${"0".repeat(32)}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
let n = 0;

function request(signal: AbortSignal): AgentRuntimeRequest {
  n += 1;
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    idempotencyKey: `isolagw:tenant-acme|b1|1|7|delivery:post-signal-${n}|answer`,
    historyMessageIds: [9001],
    signal,
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, conversationStatus: "pending", messageId: 9001, customAttributes: {} },
      history: [{ role: "customer", content: "Do you sell calling plans?" }],
      historyTruncated: false,
      message: { role: "customer", content: "Do you sell calling plans?" },
    },
  };
}

function runtimeFor(fake: FakeHermes, over: Partial<HermesRuntimeOptions> = {}): HermesDirectRuntime {
  fake.bearer = BEARER;
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: BEARER,
    safeFetch: fake.fetch,
    runDeadlineMs: 5000,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: 4,
    rateLimitBackoffMs: 20,
    streamDrainGraceMs: 200,
    ...over,
  });
}

function noText(r: AgentRuntimeResult): void {
  expect(r.text ?? "").toBe("");
  expect(r.outcome).not.toBe("ok");
}

describe("after the turn signal fires, the ONLY request that may leave the runtime is one POST /stop (a cancellation, not a dispatch)", () => {
  it("POSITIVE CONTROL + RULE: before the signal the log holds a create, polls and a stream; after it, exactly one stop for THAT run and nothing else", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => run.running(); // the run never finishes by itself
    const turn = new AbortController();
    const pending = runtimeFor(fake).invoke(request(turn.signal));
    await sleep(120);

    // control: work really was in flight before the signal (so an empty tail below means something)
    const before = fake.log.slice();
    expect(before.some((l) => l.method === "POST" && l.path === "/v1/runs")).toBe(true);
    expect(before.some((l) => l.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(l.path))).toBe(true);
    expect(before.some((l) => l.method === "GET" && l.path.endsWith("/events"))).toBe(true);
    const runId = /^\/v1\/runs\/([^/]+)$/.exec(before.find((l) => l.method === "GET" && /^\/v1\/runs\/[^/]+$/.test(l.path))!.path)![1];

    // the log position is read and the signal fired in the SAME synchronous step: nothing can slip in between
    const atAbort = fake.log.length;
    turn.abort();
    const result = await pending;
    noText(result);
    await sleep(60); // anything late would land here

    expect(fake.log.slice(atAbort).map((l) => `${l.method} ${l.path}`)).toEqual([`POST /v1/runs/${runId}/stop`]);
  });

  it("a stop that FAILS (HTTP 500) is not retried and changes nothing: still exactly one stop attempt, still no text", async () => {
    const fake = new FakeHermes();
    fake.stopStatus = 500;
    fake.onRun = (run) => run.running();
    const turn = new AbortController();
    const pending = runtimeFor(fake).invoke(request(turn.signal));
    await sleep(100);
    const atAbort = fake.log.length;
    turn.abort();
    noText(await pending);
    await sleep(60);
    expect(fake.log.slice(atAbort).filter((l) => l.method === "POST")).toHaveLength(1);
    expect(fake.log.slice(atAbort).filter((l) => l.method === "GET")).toHaveLength(0);
    expect(fake.stops).toHaveLength(1);
    expect(fake.creates).toHaveLength(1);
  });

  it("a stop answered 404 (the run had ALREADY finished) is also one attempt, and the finished text is never used", async () => {
    const fake = new FakeHermes();
    fake.stopStatus = 404;
    fake.onRun = (run) => run.running();
    const turn = new AbortController();
    const pending = runtimeFor(fake).invoke(request(turn.signal));
    await sleep(100);
    // the run finishes at the very moment the turn is spent: the stop then answers 404 ("maybe finished")
    fake.onRun = null;
    turn.abort();
    noText(await pending);
    expect(fake.stops).toHaveLength(1);
  });

  it("a signal that is ALREADY aborted dispatches NOTHING, not even a stop (there is no run to cancel)", async () => {
    const fake = new FakeHermes();
    const turn = new AbortController();
    turn.abort();
    const result = await runtimeFor(fake).invoke(request(turn.signal));
    expect(result.outcome).toBe(HERMES_OUTCOMES.timeout);
    expect(fake.log).toHaveLength(0);
  });
});
