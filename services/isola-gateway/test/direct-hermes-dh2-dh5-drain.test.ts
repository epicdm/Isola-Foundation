/**
 * CODEX DH2 + DH5 (direct Hermes path, review of d810455).
 *
 * DH2 (P2, blocking): the final stream DRAIN happened AFTER the acceptance checks. `conclude()` decided
 * success (ownership look, envelope) and `execute()` then awaited `settleStream()` and returned that
 * decision without revalidating, so an ownership change, a turn signal, a stream over 1 MiB or the run
 * deadline arriving DURING the drain still returned the answer; the drain was bounded by `Date.now() +
 * grace`, outside the absolute run deadline, and its abort listener was removed before it started.
 * Now: the drain runs FIRST (bounded by the absolute deadline, abortable by the turn signal), and EVERY
 * acceptance check runs AFTER it.
 *
 * DH5 (P2): an events stream that ended normally (EOF) with NO terminal event, or answered 404, still
 * accepted a LATER completed status and returned model text. Per the contract that must fail closed.
 *
 * SOCKET-FREE, a FAKE Hermes (not evidence of installed behaviour, Law 5). Every refusal has its positive
 * twin in the same file (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HERMES_OUTCOMES, HermesDirectRuntime, MAX_HERMES_RESPONSE_BYTES, type HermesRuntimeOptions } from "../src/hermes-runtime.js";
import type { AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";
import { FakeHermes, type FakeRun } from "./hermes-fake.js";
import { answerEnvelope, completeWith, directRig } from "./hermes-rig.js";

let n = 0;
function request(over: Partial<AgentRuntimeRequest> = {}): AgentRuntimeRequest {
  n += 1;
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: "delivery-1",
    idempotencyKey: `isolagw:tenant-acme|b1|1|7|delivery:dh25-${n}|answer`,
    historyMessageIds: [9001],
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, conversationStatus: "pending", messageId: 9001, customAttributes: {} },
      history: [{ role: "customer", content: "Do you sell calling plans?" }],
      historyTruncated: false,
      message: { role: "customer", content: "Do you sell calling plans?" },
    },
    ...over,
  };
}

function runtimeFor(fake: FakeHermes, over: Partial<HermesRuntimeOptions> = {}): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: fake.fetch,
    runDeadlineMs: 2000,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: 4,
    rateLimitBackoffMs: 20,
    streamDrainGraceMs: 400,
    ...over,
  });
}

const ANSWER = answerEnvelope("THE ANSWER");
const noText = (r: AgentRuntimeResult, outcome: string): void => {
  expect(r.outcome).toBe(outcome);
  expect(r.text).toBeNull();
  expect(r.action).toBeNull();
};

/**
 * The run completes (status + run.completed event) at 15 ms, but its STREAM stays open until
 * `closeAtMs`. `during` runs at `duringAtMs`, inside that drain window.
 */
function completesThenDrains(fake: FakeHermes, closeAtMs: number, during?: { atMs: number; fn: (run: FakeRun) => void }): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => run.complete(ANSWER, { closeStream: false }), 15);
    if (during !== undefined) setTimeout(() => during.fn(run), during.atMs);
    setTimeout(() => run.finishStream(), closeAtMs);
  };
}

// ===========================================================================
// DH2. Every acceptance check runs AFTER the final drain
// ===========================================================================

describe("DH2 the final drain comes BEFORE the acceptance checks", () => {
  it("CONTROL: nothing happens during the drain -> the answer is returned", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 120);
    const r = await runtimeFor(fake).invoke(request({ isStillOwned: async () => true }));
    expect(r).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });

  it("NEGATIVE: ownership CHANGES during the drain -> the answer is discarded (hermes_ownership_lost)", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 140);
    let owned = true;
    setTimeout(() => (owned = false), 70); // inside the drain: the run completed at ~15 ms, the stream closes at 140 ms
    const r = await runtimeFor(fake).invoke(request({ isStillOwned: async () => owned }));
    noText(r, HERMES_OUTCOMES.ownershipLost);
  });

  it("NEGATIVE: the TURN SIGNAL fires during the drain -> the answer is discarded (model_timeout), and the drain itself is aborted", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 300);
    const turn = new AbortController();
    setTimeout(() => turn.abort(), 70);
    const started = Date.now();
    const r = await runtimeFor(fake).invoke(request({ signal: turn.signal }));
    noText(r, HERMES_OUTCOMES.timeout);
    expect(Date.now() - started, "the drain was not abortable by the turn signal").toBeLessThan(250);
  });

  it("NEGATIVE: the stream goes OVER the byte cap during the drain -> the answer is discarded (hermes_response_too_large)", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 200, { atMs: 70, fn: (run) => run.push(`: ${"x".repeat(MAX_HERMES_RESPONSE_BYTES + 10)}\n\n`) });
    const r = await runtimeFor(fake).invoke(request());
    noText(r, HERMES_OUTCOMES.responseTooLarge);
  });

  it("NEGATIVE: the RUN DEADLINE passes during the drain -> no success after the deadline (model_timeout), and the drain is bounded by the deadline", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 600); // the stream outlives the deadline
    const started = Date.now();
    const r = await runtimeFor(fake, { runDeadlineMs: 160, streamDrainGraceMs: 500 }).invoke(request());
    noText(r, HERMES_OUTCOMES.timeout);
    expect(Date.now() - started, "the drain ran past the absolute run deadline").toBeLessThan(400);
  });

  it("CONTROL for the deadline: the same short deadline with a stream that closes in time returns the answer", async () => {
    const fake = new FakeHermes();
    completesThenDrains(fake, 60);
    const r = await runtimeFor(fake, { runDeadlineMs: 400, streamDrainGraceMs: 500 }).invoke(request());
    expect(r).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });
});

describe("DH2 the route: a stream that goes over the cap during the drain sends NO customer reply", () => {
  it("CONTROL: the same flow without the oversize chunk replies to the customer once", async () => {
    const r = directRig();
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answerEnvelope("THE ANSWER"), { closeStream: false }), 15);
      setTimeout(() => run.finishStream(), 90);
    };
    await r.post({ content: "What does the 200 minute plan cost?" });
    await r.gateway.drain();
    expect(JSON.stringify(r.chatwoot.customerMessages)).toContain("THE ANSWER");
  });

  it("NEGATIVE (Codex's route probe): the stream exceeds 1 MiB after the run completed -> no model text reaches the customer, a human is asked", async () => {
    const r = directRig();
    r.fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(answerEnvelope("THE ANSWER"), { closeStream: false }), 15);
      setTimeout(() => run.push(`: ${"x".repeat(MAX_HERMES_RESPONSE_BYTES + 10)}\n\n`), 40);
      setTimeout(() => run.finishStream(), 90);
    };
    await r.post({ content: "What does the 200 minute plan cost?" });
    await r.gateway.drain();
    expect(JSON.stringify(r.chatwoot.customerMessages), "model text reached the customer past the stream byte cap").not.toContain("THE ANSWER");
    expect(JSON.stringify(r.capture.lines)).toMatch(/hermes_response_too_large/);
  });
});

// ===========================================================================
// DH5. An abnormal end of the event stream never becomes a successful answer
// ===========================================================================

/** The run is COMPLETE by status (what a poll sees) at 20 ms, with NO run.completed event on the stream. */
function completedByStatusOnly(fake: FakeHermes, endStream: (run: FakeRun) => void, endAtMs = 45): void {
  fake.onRun = (run: FakeRun) => {
    run.running();
    setTimeout(() => {
      run.status = "completed";
      run.output = ANSWER;
    }, 20);
    setTimeout(() => endStream(run), endAtMs);
  };
}

describe("DH5 a stream that ends without saying how the run finished is not an answer", () => {
  it("CONTROL: events + the closing comment + a completed status -> answer", async () => {
    const fake = new FakeHermes();
    fake.onRun = (run) => {
      run.running();
      setTimeout(() => run.complete(ANSWER), 20);
    };
    const r = await runtimeFor(fake).invoke(request());
    expect(r).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });

  it("NEGATIVE: an ORDINARY EOF (no terminal event, no closing comment), then a completed status -> hermes_stream_closed_early, no text", async () => {
    const fake = new FakeHermes();
    completedByStatusOnly(fake, (run) => run.eof());
    noText(await runtimeFor(fake).invoke(request()), HERMES_OUTCOMES.streamClosedEarly);
  });

  it("NEGATIVE: a clean close (the closing comment) with NO terminal event, after the status already said completed -> hermes_stream_closed_early", async () => {
    const fake = new FakeHermes();
    completedByStatusOnly(fake, (run) => run.finishStream());
    noText(await runtimeFor(fake).invoke(request()), HERMES_OUTCOMES.streamClosedEarly);
  });

  it("NEGATIVE: the events route answers 404 and a completed status follows -> hermes_run_lost, no text", async () => {
    const fake = new FakeHermes();
    fake.eventsPlan = [404];
    completedByStatusOnly(fake, () => undefined);
    noText(await runtimeFor(fake).invoke(request()), HERMES_OUTCOMES.runLost);
  });

  it("NEGATIVE: the events route answers 401 (a credential defect) -> hermes_config_defect, no text", async () => {
    const fake = new FakeHermes();
    fake.eventsPlan = [401];
    completedByStatusOnly(fake, () => undefined);
    noText(await runtimeFor(fake).invoke(request()), HERMES_OUTCOMES.configDefect);
  });

  it("CONTROL (existing policy, unchanged): the connection DIES mid-stream (a transport failure) and the status says completed -> the answer comes from polling", async () => {
    const fake = new FakeHermes();
    completedByStatusOnly(fake, (run) => run.breakStream());
    const r = await runtimeFor(fake).invoke(request());
    expect(r).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });

  it("CONTROL (existing policy, unchanged): the events route answers 500 (a server fault, not 'the run is unknown') and the status says completed -> polling still answers", async () => {
    const fake = new FakeHermes();
    fake.eventsPlan = [500];
    completedByStatusOnly(fake, () => undefined);
    const r = await runtimeFor(fake).invoke(request());
    expect(r).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });

  it("CONTROL: completeWith (events + closing comment) through the helper still answers", async () => {
    const fake = new FakeHermes();
    completeWith(fake, ANSWER);
    expect(await runtimeFor(fake).invoke(request())).toMatchObject({ outcome: "ok", text: "THE ANSWER" });
  });
});
