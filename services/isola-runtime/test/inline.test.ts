/**
 * The versioned `responseMode: "inline"` contract.
 *
 * The Isola gateway replies to a customer in Chatwoot with the text this
 * service returns. Three properties therefore have to be true, and each of them
 * is pinned here rather than argued for in a comment:
 *
 *   1. the text returned is byte-for-byte the text that was persisted — not a
 *      regeneration, not a re-render, not a summary;
 *   2. the model is invoked exactly once, including across a replay;
 *   3. `answerText` is null on every single failure path, and `completed` is
 *      never reported unless Paperclip accepted the write-back.
 *
 * The fourth property — the answer never reaches a log line — is asserted at
 * the bottom, because a customer's reply text in an operational log is a data
 * leak even when nothing about it is secret.
 */
import { afterEach, describe, expect, it } from "vitest";

import { buildIdempotencyKey } from "../src/metering.js";
import type { ModelResponse } from "../src/model.js";
import {
  ModelInvalidOutputError,
  ModelProviderError,
  ModelTimeoutError,
  PaperclipApiError,
  RecorderError,
} from "../src/errors.js";
import { redact } from "../src/log.js";
import { NullRunRecorder, type RunRecorder } from "../src/recorder.js";
import {
  RESPONSE_CONTRACT_VERSION,
  completionStateForOutcome,
  inlineFailureBody,
  inlineHttpStatus,
  isCompletionState,
  parseResponseMode,
} from "../src/response.js";
import { InMemoryStateStore, type OutboxEntry, type StateStore } from "../src/state.js";
import { outboxKey } from "../src/outbox.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  AGENT7_SECRET,
  INTERNAL_TEMPLATE,
  OVERDUE_FIXTURE,
  RecordingRecorder,
  StubModelClient,
  StubPaperclipApi,
  envConfig,
  get,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

const COMPANY = "company-1";
const AGENT = "agent-7";
const AGENT_KEY = ["agent", "key", "internal"].join("-");

const INLINE_ENV: Record<string, string | undefined> = {
  PAPERCLIP_COMPANY_ID: COMPANY,
  PAPERCLIP_AGENT_KEY_INTERNAL: AGENT_KEY,
};

/**
 * A deliberately awkward answer: multi-line, with markdown, a trailing newline,
 * a non-ASCII character and a run of trailing spaces. Anything that trims,
 * normalises or re-renders on the way out will fail the byte-equality test.
 */
const ANSWER = [
  "| Account | Balance |",
  "|---|---|",
  "| ACC-1001 | USD 4,120.00 |",
  "",
  "Assumptions and gaps: none — the fixture was complete.  ",
  "I have contacted no one and changed no record.",
  "",
].join("\n");

function modelReturning(
  content: string,
  usage: ModelResponse["usage"] = {
    promptTokens: 1200,
    completionTokens: 340,
    cachedPromptTokens: 200,
  },
): StubModelClient {
  return new StubModelClient(
    async (): Promise<ModelResponse> => ({
      content,
      model: "deepseek-chat",
      finishReason: "stop",
      usage,
    }),
  );
}

interface Booted {
  server: TestServer;
  logger: CapturingLogger;
  model: StubModelClient;
  recorder: RecordingRecorder;
  paperclip: StubPaperclipApi;
  store: StateStore;
}

async function boot(
  opts: {
    model?: StubModelClient;
    recorder?: RunRecorder;
    paperclip?: StubPaperclipApi;
    store?: StateStore;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Booted> {
  const logger = new CapturingLogger();
  const model = opts.model ?? modelReturning(ANSWER);
  const recorder = (opts.recorder ?? new RecordingRecorder()) as RecordingRecorder;
  const paperclip = opts.paperclip ?? new StubPaperclipApi();
  const store = opts.store ?? new InMemoryStateStore();
  const server = await startServer({
    config: envConfig({ ...INLINE_ENV, ...(opts.env ?? {}) }),
    logger: logger.logger,
    modelClient: model,
    recorder,
    paperclipApi: paperclip,
    stateStore: store,
  });
  servers.push(server);
  return { server, logger, model, recorder, paperclip, store };
}

const body = (
  runId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  templateId: INTERNAL_TEMPLATE,
  exposure: "INTERNAL",
  agentId: AGENT,
  runId,
  context: OVERDUE_FIXTURE,
  ...overrides,
});

const inlineBody = (runId: string, overrides: Record<string, unknown> = {}) =>
  body(runId, { responseMode: "inline", ...overrides });

// ---------------------------------------------------------------------------
// The contract itself
// ---------------------------------------------------------------------------

describe("responseMode parsing", () => {
  it("absent and null mean today's behaviour", () => {
    expect(parseResponseMode(undefined)).toEqual({ kind: "ok", mode: "none" });
    expect(parseResponseMode(null)).toEqual({ kind: "ok", mode: "none" });
  });

  it("accepts exactly the two known tokens", () => {
    expect(parseResponseMode("none")).toEqual({ kind: "ok", mode: "none" });
    expect(parseResponseMode("inline")).toEqual({ kind: "ok", mode: "inline" });
  });

  it("rejects everything else rather than degrading to `none`", () => {
    for (const value of [
      "INLINE",
      "Inline",
      " inline",
      "inline ",
      "",
      "   ",
      "streaming",
      "inline-v2",
      1,
      true,
      {},
      [],
      ["inline"],
    ]) {
      expect(parseResponseMode(value)).toEqual({ kind: "unrecognised" });
    }
  });
});

describe("the failure body cannot carry an answer", () => {
  it("hardcodes answerText to null whatever the caller passes", () => {
    const built = inlineFailureBody({
      outcome: "model_timeout",
      completionState: "timeout",
      failureCategory: "model_timeout_after_1000ms",
      runId: "r1",
      recorded: false,
      recorderError: null,
      transitioned: false,
      issueStatus: null,
      replay: false,
      usage: {
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: null,
        model: null,
        provider: "deepseek",
        durationMs: 3,
      },
      // `extra` is the only free-form channel into the body; it must not be
      // usable to smuggle an answer past the contract.
      extra: { answerText: "a fabricated answer" },
    });
    expect(built["answerText"]).toBeNull();
    expect(JSON.stringify(built)).not.toContain("a fabricated answer");
  });

  it("maps the two new states to 502 and leaves every other status alone", () => {
    expect(inlineHttpStatus("completed", 200)).toBe(200);
    expect(inlineHttpStatus("persistence_failed", 200)).toBe(502);
    expect(inlineHttpStatus("invalid_output", 200)).toBe(502);
    expect(inlineHttpStatus("timeout", 504)).toBe(504);
    expect(inlineHttpStatus("provider_error", 502)).toBe(502);
    expect(inlineHttpStatus("budget_exhausted", 402)).toBe(402);
    expect(inlineHttpStatus("rejected", 403)).toBe(403);
  });

  it("classifies a legacy record's outcome without inventing a state", () => {
    expect(completionStateForOutcome("ok")).toBe("completed");
    expect(completionStateForOutcome("model_timeout")).toBe("timeout");
    expect(completionStateForOutcome("provider_error")).toBe("provider_error");
    expect(completionStateForOutcome("budget_exhausted")).toBe("budget_exhausted");
    expect(completionStateForOutcome("exposure_mismatch")).toBe("rejected");
    expect(isCompletionState("completed")).toBe(true);
    expect(isCompletionState("nonsense")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

describe("inline success", () => {
  it("returns exactly the persisted text, byte for byte", async () => {
    const { server, recorder, model } = await boot();
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(200);
    expect(res.json["completionState"]).toBe("completed");

    // THE assertion: the string the recorder was handed and the string the
    // response carries are the same bytes. Not "contains", not "trimmed equal".
    const handedToRecorder = recorder.outcomes[0]!.content!;
    const returned = res.json["answerText"] as string;
    expect(returned).toBe(handedToRecorder);
    expect(Buffer.from(returned, "utf8").equals(Buffer.from(handedToRecorder, "utf8"))).toBe(
      true,
    );
    // And it is the provider's own output, unaltered.
    expect(returned).toBe(ANSWER);
    expect(returned.endsWith("\n")).toBe(true);
    expect(returned).toContain("complete.  \n");

    // Exactly one model invocation.
    expect(model.calls).toHaveLength(1);
  });

  it("carries the full documented success shape", async () => {
    const { server } = await boot();
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.json).toMatchObject({
      ok: true,
      outcome: "ok",
      responseMode: "inline",
      contractVersion: RESPONSE_CONTRACT_VERSION,
      completionState: "completed",
      runId: "r1",
      failureCategory: null,
      recorded: true,
      recorderError: null,
      transitioned: true,
      issueStatus: "in_review",
      replay: false,
      // Safe usage metadata, measured — never estimated.
      inputTokens: 1000, // 1200 prompt - 200 cached
      cachedInputTokens: 200,
      outputTokens: 340,
      model: "deepseek-chat",
      provider: "deepseek",
    });
    expect(res.json["correlationId"]).toEqual(expect.any(String));
    expect(res.correlationHeader).toBe(res.json["correlationId"]);
    expect(res.json["durationMs"]).toEqual(expect.any(Number));
  });

  it("reports null token counts rather than zero when the provider reported none", async () => {
    const { server } = await boot({ model: modelReturning(ANSWER, null) });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["inputTokens"]).toBeNull();
    expect(res.json["cachedInputTokens"]).toBeNull();
    expect(res.json["outputTokens"]).toBeNull();
  });

  it("the answer it returns is the answer inside the Paperclip comment", async () => {
    // Proves the two are not merely equal by luck: the write-back body embeds
    // the same text the response carries.
    const { server, recorder } = await boot();
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    const outcome = recorder.outcomes[0]!;
    expect(outcome.status).toBe("succeeded");
    expect(outcome.content).toBe(res.json["answerText"]);
  });

  it("advertises the contract on /healthz", async () => {
    const { server } = await boot();
    const res = await get(server.url, "/healthz");
    expect(res.json["responseModes"]).toEqual(["none", "inline"]);
    expect(res.json["responseContractVersion"]).toBe(RESPONSE_CONTRACT_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe("a replayed inline request never runs the model again", () => {
  it("returns the stored answer with the provider called exactly once", async () => {
    const { server, model, recorder, paperclip } = await boot();

    const first = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    const replay = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(model.calls).toHaveLength(1); // <- the whole point
    expect(recorder.outcomes).toHaveLength(1); // no second comment
    expect(paperclip.transitions).toHaveLength(1); // no second transition

    expect(replay.status).toBe(200);
    expect(replay.json["replay"]).toBe(true);
    expect(replay.json["completionState"]).toBe("completed");
    expect(replay.json["answerText"]).toBe(first.json["answerText"]);
    expect(replay.json["answerText"]).toBe(ANSWER);
    expect(replay.json["outputTokens"]).toBe(340);
  });

  it("survives a process restart: a new runtime on the same store still replays it", async () => {
    const store = new InMemoryStateStore();
    const first = await boot({ store });
    const original = await invoke(first.server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    await first.server.close();
    servers.pop();

    // A brand new runtime, a brand new model stub, the same durable store.
    const second = await boot({ store, model: modelReturning("A DIFFERENT ANSWER") });
    const replay = await invoke(second.server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(second.model.calls).toHaveLength(0);
    expect(replay.json["answerText"]).toBe(original.json["answerText"]);
    expect(replay.json["answerText"]).not.toContain("DIFFERENT");
  });

  it("a non-inline run can be replayed inline, and still never re-runs", async () => {
    const { server, model } = await boot();
    const plain = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(plain.json["answerText"]).toBeUndefined();

    const replay = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(model.calls).toHaveLength(1);
    expect(replay.json["completionState"]).toBe("completed");
    expect(replay.json["answerText"]).toBe(ANSWER);
  });

  it("an inline run replayed WITHOUT inline returns the original plain body", async () => {
    const { server, model } = await boot();
    await invoke(server.url, { bearer: AGENT7_SECRET, body: inlineBody("r1") });
    const replay = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(model.calls).toHaveLength(1);
    expect(replay.status).toBe(200);
    expect(Object.keys(replay.json).sort()).toEqual(
      [
        "correlationId",
        "durationMs",
        "issueStatus",
        "ok",
        "outcome",
        "recorded",
        "recorderError",
        "replay",
        "transitioned",
      ].sort(),
    );
    expect(replay.json["answerText"]).toBeUndefined();
  });

  it("refuses to regenerate an answer a legacy record did not retain", async () => {
    const store = new InMemoryStateStore();
    const key = buildIdempotencyKey({
      companyId: COMPANY,
      agentId: AGENT,
      runId: "r-legacy",
      issueId: OVERDUE_FIXTURE.issueId,
      contextText: "",
    });
    await store.transact((draft) => {
      draft.idempotency[key] = {
        key,
        state: "complete",
        companyId: COMPANY,
        agentId: AGENT,
        runId: "r-legacy",
        issueId: OVERDUE_FIXTURE.issueId,
        createdAtMs: Date.now(),
        completedAtMs: Date.now(),
        // Exactly what a build older than this contract wrote.
        result: {
          httpStatus: 200,
          outcome: "ok",
          recorded: true,
          recorderError: null,
          transitioned: true,
          transitionStatus: "in_review",
          costEventKey: null,
          costKind: "actual",
          accruedMicrocents: 0,
          answerText: null,
          completionState: null,
          usage: null,
        },
      };
    });

    const { server, model } = await boot({ store });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r-legacy"),
    });

    expect(model.calls).toHaveLength(0); // never re-run to fill the gap
    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("invalid_output");
    expect(res.json["answerText"]).toBeNull();
    expect(String(res.json["failureCategory"])).toContain("not regenerated");
  });

  it("a duplicate arriving mid-run says so instead of inventing an answer", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new StubModelClient(async (): Promise<ModelResponse> => {
      await gate;
      return {
        content: ANSWER,
        model: "deepseek-chat",
        finishReason: "stop",
        usage: null,
      };
    });
    const { server } = await boot({ model });

    const first = invoke(server.url, { bearer: AGENT7_SECRET, body: inlineBody("r1") });
    // The duplicate has to arrive while the first is still inside the provider
    // call, which is what the gate guarantees.
    const duplicate = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    release!();
    await first;

    expect(duplicate.status).toBe(200);
    expect(duplicate.json["completionState"]).toBe("duplicate_in_flight");
    expect(duplicate.json["completionState"]).not.toBe("completed");
    expect(duplicate.json["answerText"]).toBeNull();
    expect(duplicate.json["replay"]).toBe(true);
    expect(model.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Failure shapes — answerText is null on every one of them
// ---------------------------------------------------------------------------

describe("inline failures are structured, truthful and answerless", () => {
  it("persistence failure is NOT completed and returns no answer", async () => {
    const recorder = new RecordingRecorder(
      new RecorderError("write-back returned HTTP 502"),
    );
    const { server, model } = await boot({ recorder });

    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(502);
    expect(res.json["ok"]).toBe(false);
    expect(res.json["outcome"]).toBe("persistence_failed");
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["completionState"]).not.toBe("completed");
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["recorded"]).toBe(false);
    expect(String(res.json["failureCategory"])).toContain("write-back");
    // The model still ran exactly once; the run is spent, not retried.
    expect(model.calls).toHaveLength(1);
    // And the answer never leaks through some other field.
    expect(res.text).not.toContain("ACC-1001");
  });

  it("a replay of a persistence failure stays a failure and yields no answer", async () => {
    const recorder = new RecordingRecorder(new RecorderError("write-back returned HTTP 502"));
    const { server, model } = await boot({ recorder });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: inlineBody("r1") });
    const replay = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(model.calls).toHaveLength(1);
    expect(replay.status).toBe(502);
    expect(replay.json["completionState"]).toBe("persistence_failed");
    expect(replay.json["answerText"]).toBeNull();
  });

  /**
   * SUPERSEDED TEST, DELIBERATELY INVERTED — read this before assuming a
   * weakened assertion.
   *
   * This block previously asserted "no recorder configured is a persistence
   * failure, not a success" (inline + NullRunRecorder => 502,
   * persistence_failed, answerText null). That behaviour was ratified away by
   * `dec-ai1b-inline-agent-answer-may-return-without-recorder-2026-08-27`,
   * which rules that for `responseMode:"inline"` a null/unconfigured recorder
   * is a valid NON-PERSISTED execution state, not a run failure.
   *
   * The old test was the bodyguard of the conflated condition (CLAUDE.md Law
   * 28). It is replaced — NOT deleted and not silently loosened — by the block
   * below, which is strictly MORE demanding: it requires the answer AND
   * requires the response to state honestly that nothing was written. The
   * fail-closed cases it used to sit beside (a CONFIGURED recorder that fails,
   * above) are untouched and still green, and are the positive control that
   * this change did not simply disable persistence enforcement.
   */
  it("no recorder configured returns the answer as a non-persisted success", async () => {
    // PAPERCLIP_API_KEY unset in production means NullRunRecorder: no write is
    // ever ATTEMPTED. That is a deployment property, not a runtime fault.
    const { server, model } = await boot({ recorder: new NullRunRecorder() });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["answerText"]).toBe(ANSWER);
    expect(model.calls).toHaveLength(1);
  });

  it("that non-persisted success states it was NOT recorded and says why", async () => {
    const { server } = await boot({ recorder: new NullRunRecorder() });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    // The whole point of the ruling: return the answer, but never pretend it
    // was written down.
    expect(res.json["recorded"]).toBe(false);
    expect(res.json["persistence"]).toBe("skipped_unconfigured");
    expect(String(res.json["recorderError"])).toContain("no recorder configured");
    // The observable shape changed, so the contract version must have moved.
    expect(res.json["contractVersion"]).toBe(RESPONSE_CONTRACT_VERSION);
    expect(RESPONSE_CONTRACT_VERSION).toBeGreaterThan(1);
  });

  it("POSITIVE CONTROL: a working recorder still reports recorded:true / persistence recorded", async () => {
    // Without this, the two assertions above could pass against a build that
    // simply never reports a successful write at all.
    const { server } = await boot();
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(200);
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["recorded"]).toBe(true);
    expect(res.json["persistence"]).toBe("recorded");
    expect(res.json["answerText"]).toBe(ANSWER);
  });

  it("a skipped-persistence run REPLAYS as the same non-persisted success", async () => {
    // The stored completionState is mode-independent, so the answer is now
    // retained and an inline replay returns it — without a second model call
    // and without ever claiming it was persisted.
    const { server, model } = await boot({ recorder: new NullRunRecorder() });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: inlineBody("r1") });
    const replay = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(model.calls).toHaveLength(1);
    expect(replay.status).toBe(200);
    expect(replay.json["replay"]).toBe(true);
    expect(replay.json["completionState"]).toBe("completed");
    expect(replay.json["answerText"]).toBe(ANSWER);
    expect(replay.json["recorded"]).toBe(false);
    expect(replay.json["persistence"]).toBe("skipped_unconfigured");
  });

  it("an EMPTY answer with skipped persistence is still invalid_output, never a success", async () => {
    // Skipping persistence must not become a way for an empty or whitespace
    // answer to be reported as completed.
    const { server } = await boot({
      recorder: new NullRunRecorder(),
      model: modelReturning("   "),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(502);
    expect(res.json["ok"]).toBe(false);
    expect(res.json["completionState"]).toBe("invalid_output");
    expect(res.json["answerText"]).toBeNull();
  });

  it("a CONFIGURED recorder that fails is still fail-closed in inline mode", async () => {
    // The distinction the whole change rests on: attempted-and-failed is not
    // the same as never-attempted, and only the first withholds the answer.
    const { server } = await boot({
      recorder: new RecordingRecorder(new RecorderError("write-back returned HTTP 502")),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });

    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("persistence_failed");
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["recorded"]).toBe(false);
    expect(res.json["persistence"]).toBeUndefined();
  });

  it("timeout", async () => {
    const { server } = await boot({
      model: StubModelClient.throwing(new ModelTimeoutError(60_000)),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(504);
    expect(res.json["outcome"]).toBe("model_timeout");
    expect(res.json["completionState"]).toBe("timeout");
    expect(res.json["answerText"]).toBeNull();
    expect(String(res.json["failureCategory"])).toContain("model_timeout_after_60000ms");
  });

  it("provider error", async () => {
    const { server } = await boot({
      model: StubModelClient.throwing(new ModelProviderError("provider returned HTTP 500", 500)),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("provider_error");
    expect(res.json["answerText"]).toBeNull();
  });

  it("invalid output — a provider response with no usable assistant text", async () => {
    const { server } = await boot({
      model: StubModelClient.throwing(
        new ModelInvalidOutputError("provider returned no usable completion content", 200),
      ),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(502);
    expect(res.json["completionState"]).toBe("invalid_output");
    expect(res.json["completionState"]).not.toBe("provider_error");
    expect(res.json["answerText"]).toBeNull();
  });

  it("internal error", async () => {
    const { server } = await boot({ model: StubModelClient.throwing(new TypeError("boom")) });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(500);
    expect(res.json["completionState"]).toBe("internal_error");
    expect(res.json["answerText"]).toBeNull();
    expect(res.text).not.toContain("boom");
  });

  it("budget exhausted — the provider was never called", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 100 };
    const { server, model } = await boot({ paperclip });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(402);
    expect(res.json["outcome"]).toBe("budget_exhausted");
    expect(res.json["completionState"]).toBe("budget_exhausted");
    expect(res.json["answerText"]).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("undelivered-spend fail-closed", async () => {
    const entry: OutboxEntry = {
      key: outboxKey(COMPANY, AGENT, "old-run"),
      companyId: COMPANY,
      agentId: AGENT,
      runId: "old-run",
      exposure: "INTERNAL",
      event: {
        agentId: AGENT,
        billingCode: "provider-rates@v1",
        provider: "deepseek",
        biller: "deepseek",
        billingType: "metered_api",
        model: "deepseek-chat",
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        costCents: 60,
        occurredAt: new Date(0).toISOString(),
      },
      costKind: "actual",
      state: "failed",
      attempts: 9,
      createdAtMs: 0,
      lastAttemptMs: 0,
      nextAttemptMs: 0,
      lastError: "returned HTTP 403",
      deliveredAtMs: null,
    };
    const store = new InMemoryStateStore();
    await store.transact((draft) => {
      draft.outbox[entry.key] = entry;
    });
    const paperclip = new StubPaperclipApi();
    paperclip.costEventFailures = [new PaperclipApiError("returned HTTP 403", 403, false)];
    const { server, model } = await boot({ store, paperclip });

    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.status).toBe(503);
    expect(res.json["completionState"]).toBe("rejected");
    expect(res.json["answerText"]).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it("unknown template and exposure mismatch are structured rejections", async () => {
    const { server, model } = await boot();

    const unknown = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1", { templateId: "no-such-template@v1" }),
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json["completionState"]).toBe("rejected");
    expect(unknown.json["answerText"]).toBeNull();
    expect(unknown.json["failureCategory"]).toBe("unknown_template");

    const mismatch = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r2", {
        templateId: "isola-ai-sales-front-desk-agent@v1",
        exposure: "PUBLIC",
      }),
    });
    expect(mismatch.status).toBe(403);
    expect(mismatch.json["completionState"]).toBe("rejected");
    expect(mismatch.json["answerText"]).toBeNull();

    expect(model.calls).toHaveLength(0);
  });

  it("every failure body agrees on the invariant: answerText is null", async () => {
    const cases: Array<{ label: string; booted: Booted; body: Record<string, unknown> }> = [
      {
        label: "timeout",
        booted: await boot({ model: StubModelClient.throwing(new ModelTimeoutError(1)) }),
        body: inlineBody("r1"),
      },
      {
        label: "provider",
        booted: await boot({
          model: StubModelClient.throwing(new ModelProviderError("provider returned HTTP 503", 503)),
        }),
        body: inlineBody("r1"),
      },
      {
        label: "persistence",
        booted: await boot({ recorder: new RecordingRecorder(new RecorderError("nope")) }),
        body: inlineBody("r1"),
      },
      {
        label: "unknown template",
        booted: await boot(),
        body: inlineBody("r1", { templateId: "nope@v1" }),
      },
    ];

    for (const c of cases) {
      const res = await invoke(c.booted.server.url, {
        bearer: AGENT7_SECRET,
        body: c.body,
      });
      expect(res.json, c.label).toMatchObject({
        ok: false,
        answerText: null,
        responseMode: "inline",
        contractVersion: RESPONSE_CONTRACT_VERSION,
      });
      expect(res.json["completionState"], c.label).not.toBe("completed");
      expect(String(res.json["failureCategory"]), c.label).not.toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Versioning and the untouched non-inline path
// ---------------------------------------------------------------------------

describe("an unrecognised responseMode is a 400, never a silent downgrade", () => {
  it("rejects before any work is done and names what it does support", async () => {
    const { server, model, recorder } = await boot();
    for (const mode of ["INLINE", "streaming", "inline-v2", "", 7, true, {}, ["inline"]]) {
      const res = await invoke(server.url, {
        bearer: AGENT7_SECRET,
        body: body("r1", { responseMode: mode }),
      });
      expect(res.status, JSON.stringify(mode)).toBe(400);
      expect(res.json["outcome"]).toBe("unsupported_response_mode");
      expect(res.json["supportedResponseModes"]).toEqual(["none", "inline"]);
      expect(res.json["contractVersion"]).toBe(RESPONSE_CONTRACT_VERSION);
      // A downgrade would have produced a 200 with no answer.
      expect(res.json["answerText"]).toBeUndefined();
    }
    expect(model.calls).toHaveLength(0);
    expect(recorder.outcomes).toHaveLength(0);
  });
});

describe("the INTERNAL non-inline path is unchanged", () => {
  it("an absent responseMode and an explicit \"none\" produce the identical body shape", async () => {
    const { server } = await boot();
    const absent = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    const none = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body("r2", { responseMode: "none" }),
    });

    const shape = (json: Record<string, unknown>): string[] => Object.keys(json).sort();
    expect(shape(none.json)).toEqual(shape(absent.json));
    expect(shape(absent.json)).toEqual(
      [
        "correlationId",
        "durationMs",
        "issueStatus",
        "ok",
        "outcome",
        "recorded",
        "recorderError",
        "transitioned",
      ].sort(),
    );
    // The fields the inline contract adds appear on neither.
    for (const json of [absent.json, none.json]) {
      expect(json["answerText"]).toBeUndefined();
      expect(json["completionState"]).toBeUndefined();
      expect(json["responseMode"]).toBeUndefined();
      expect(json["contractVersion"]).toBeUndefined();
    }
    expect(absent.status).toBe(200);
    expect(none.status).toBe(200);
  });

  it("a recorder failure still keeps the non-inline run a 200", async () => {
    // The behaviour the inline contract deliberately does NOT change.
    const { server } = await boot({
      recorder: new RecordingRecorder(new RecorderError("write-back returned HTTP 502")),
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
    expect(res.json["outcome"]).toBe("ok");
    expect(res.json["recorded"]).toBe(false);
  });

  it("non-inline failure statuses and outcomes are untouched", async () => {
    for (const [err, status, outcome] of [
      [new ModelTimeoutError(1000), 504, "model_timeout"],
      [new ModelProviderError("provider returned HTTP 500", 500), 502, "provider_error"],
      [
        new ModelInvalidOutputError("provider returned no usable completion content", 200),
        502,
        "provider_error",
      ],
    ] as const) {
      const { server } = await boot({ model: StubModelClient.throwing(err) });
      const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
      expect(res.status).toBe(status);
      expect(res.json["outcome"]).toBe(outcome);
      expect(res.json["completionState"]).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// The answer never reaches a log line
// ---------------------------------------------------------------------------

describe("answerText is never logged", () => {
  it("no log line from a successful inline run contains any of the answer", async () => {
    const marker = "SENTINEL-ANSWER-DO-NOT-LOG-9f2b";
    const answer = `${marker}\nsecond line of the reply`;
    const { server, logger } = await boot({ model: modelReturning(answer) });

    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(res.json["answerText"]).toBe(answer);

    const all = logger.raw.join("\n");
    expect(all).not.toContain(marker);
    expect(all).not.toContain("answerText");
    expect(all).not.toContain("second line of the reply");
    // The log line for the run still exists and is still useful.
    const line = logger.lines.find(
      (l) => l["event"] === "invoke" && l["completionState"] === "completed",
    );
    expect(line).toBeDefined();
    expect(line!["responseMode"]).toBe("inline");
  });

  it("nor from a replay, which is the path that reads the stored answer", async () => {
    const marker = "SENTINEL-REPLAY-ANSWER-4c81";
    const { server, logger } = await boot({ model: modelReturning(marker) });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: inlineBody("r1") });
    const replay = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: inlineBody("r1"),
    });
    expect(replay.json["answerText"]).toBe(marker);
    expect(logger.raw.join("\n")).not.toContain(marker);
  });

  it("redact() strips an answerText field even if a future call site adds one", () => {
    const out = redact({ answerText: "the reply", answer_text: "the reply", runId: "r1" }) as Record<
      string,
      unknown
    >;
    expect(out["answerText"]).toBe("[redacted]");
    expect(out["answer_text"]).toBe("[redacted]");
    expect(out["runId"]).toBe("r1");
  });
});
