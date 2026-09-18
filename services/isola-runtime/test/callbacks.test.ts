/**
 * Work item 1 — the callbacks and the loop fix.
 *
 * Defect: one wakeup produced 53 runs, because `heartbeat.enabled = false` only
 * stops the timer. Paperclip keeps re-scheduling an employee that still has an
 * actionable assigned issue, and the `http` adapter cannot transition an issue.
 * The runtime therefore transitions the issue itself, and every write is
 * idempotent on the run id so a duplicate webhook, an adapter retry or a
 * process restart cannot produce a second comment, transition or charge.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ModelProviderError, ModelTimeoutError, PaperclipApiError } from "../src/errors.js";
import { nextActionFor, statusForRun, transitionIssue, DEFAULT_HANDOFF } from "../src/callbacks.js";
import { buildIdempotencyKey } from "../src/metering.js";
import { renderOutcomeBody } from "../src/recorder.js";
import { FileStateStore, InMemoryStateStore, type StateStore } from "../src/state.js";
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
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const AGENT_KEY_INTERNAL = ["agent", "key", "internal"].join("-");

const CALLBACK_ENV = {
  PAPERCLIP_COMPANY_ID: "company-1",
  PAPERCLIP_AGENT_KEY_INTERNAL: AGENT_KEY_INTERNAL,
};

const servers: TestServer[] = [];
const dirs: string[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "isola-runtime-callbacks-"));
  dirs.push(dir);
  return dir;
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
    recorder?: RecordingRecorder;
    paperclip?: StubPaperclipApi;
    store?: StateStore;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<Booted> {
  const logger = new CapturingLogger();
  const model = opts.model ?? StubModelClient.returning("the answer");
  const recorder = opts.recorder ?? new RecordingRecorder();
  const paperclip = opts.paperclip ?? new StubPaperclipApi();
  const store = opts.store ?? new InMemoryStateStore();
  const server = await startServer({
    config: envConfig({ ...CALLBACK_ENV, ...(opts.env ?? {}) }),
    logger: logger.logger,
    modelClient: model,
    recorder,
    paperclipApi: paperclip,
    stateStore: store,
  });
  servers.push(server);
  return { server, logger, model, recorder, paperclip, store };
}

const body = (overrides: Record<string, unknown> = {}) => ({
  templateId: INTERNAL_TEMPLATE,
  exposure: "INTERNAL",
  agentId: "agent-7",
  runId: "run-9",
  context: OVERDUE_FIXTURE,
  ...overrides,
});

describe("issue transition — the loop fix", () => {
  it("a successful run moves the issue to in_review", async () => {
    const { server, paperclip, logger } = await boot();
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });

    expect(res.status).toBe(200);
    expect(res.json["transitioned"]).toBe(true);
    expect(res.json["issueStatus"]).toBe("in_review");

    expect(paperclip.transitions).toHaveLength(1);
    expect(paperclip.transitions[0]!.issueId).toBe("ISSUE-4821");
    expect(paperclip.transitions[0]!.status).toBe("in_review");
    expect(logger.withOutcome("issue_transitioned")).toHaveLength(1);
  });

  it("every callback authenticates as the employee's own agent, and carries the run id WHEN PAPERCLIP ISSUED IT", async () => {
    // This simulates Paperclip's own http adapter, which declares provenance in
    // adapterConfig.payloadTemplate. Only then may the id be sent: it is written
    // into two foreign keys pointing at a table only Paperclip populates.
    const { server, paperclip } = await boot();
    await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body({ runIdIssuedBy: "paperclip" }),
    });

    expect(paperclip.calls.length).toBeGreaterThan(0);
    for (const call of paperclip.calls) {
      expect(call.apiKey).toBe(AGENT_KEY_INTERNAL);
      expect(call.runId).toBe("run-9");
    }
  });

  it("THE GATEWAY PATH: no provenance -> no run id on any callback", async () => {
    // The gateway sends its OWN delivery id. Forwarding it guaranteed a
    // Paperclip 500 on every customer reply (53 measured in one window) and, on
    // 2026-08-17, cost a customer an answer that had already been generated and
    // billed. Absence of `runIdIssuedBy` means "not issued" — the safe default.
    const { server, paperclip } = await boot();
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });

    expect(paperclip.calls.length).toBeGreaterThan(0);
    for (const call of paperclip.calls) {
      expect(call.apiKey).toBe(AGENT_KEY_INTERNAL);
      expect(call.runId, "null is the honest value").toBeNull();
    }
  });

  it("only the exact string counts — a near-miss is still not issued", async () => {
    const { server, paperclip } = await boot();
    for (const claim of ["Paperclip", "paperclip ", true, 1, "gateway"]) {
      paperclip.calls.length = 0;
      await invoke(server.url, {
        bearer: AGENT7_SECRET,
        body: body({ runIdIssuedBy: claim }),
      });
      for (const call of paperclip.calls) {
        expect(call.runId, JSON.stringify(claim)).toBeNull();
      }
    }
  });

  it("a timed-out run moves the issue to blocked and names an owner and a next action", async () => {
    const model = StubModelClient.throwing(new ModelTimeoutError(60_000));
    const { server, paperclip, recorder } = await boot({ model });

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    expect(res.status).toBe(504);
    expect(res.json["issueStatus"]).toBe("blocked");

    expect(paperclip.transitions).toHaveLength(1);
    expect(paperclip.transitions[0]!.status).toBe("blocked");

    const comment = renderOutcomeBody(recorder.outcomes[0]!);
    expect(comment).toContain("This run FAILED");
    expect(comment).toContain("**Owner:**");
    expect(comment).toContain(DEFAULT_HANDOFF.owner);
    expect(comment).toContain("**Next action:**");
    expect(comment).toContain("re-run this issue manually");
    // Still no fabricated answer anywhere in it.
    expect(comment).not.toContain("ACC-1001");
  });

  it("a provider error also blocks, with its own next action", async () => {
    const model = StubModelClient.throwing(
      new ModelProviderError("provider returned HTTP 500", 500),
    );
    const { server, paperclip, recorder } = await boot({ model });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    expect(res.status).toBe(502);
    expect(paperclip.transitions[0]!.status).toBe("blocked");
    expect(renderOutcomeBody(recorder.outcomes[0]!)).toContain("MODEL_API_KEY");
  });

  it("a successful run's comment carries no owner block", async () => {
    const { server, recorder } = await boot();
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    const comment = renderOutcomeBody(recorder.outcomes[0]!);
    expect(comment).toContain("the answer");
    expect(comment).not.toContain("**Owner:**");
  });

  it("the handoff statuses and next actions are the documented ones", () => {
    expect(statusForRun("succeeded", DEFAULT_HANDOFF)).toBe("in_review");
    for (const failure of ["timed_out", "provider_error", "internal_error"] as const) {
      expect(statusForRun(failure, DEFAULT_HANDOFF)).toBe("blocked");
      expect(nextActionFor(failure).length).toBeGreaterThan(20);
    }
  });

  it("honours configured statuses and owner", async () => {
    const { server, paperclip, recorder } = await boot({
      model: StubModelClient.throwing(new ModelTimeoutError(1000)),
      env: {
        PAPERCLIP_FAILURE_STATUS: "todo",
        PAPERCLIP_FAILURE_OWNER: "the Isola duty operator",
      },
    });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    expect(paperclip.transitions[0]!.status).toBe("todo");
    expect(renderOutcomeBody(recorder.outcomes[0]!)).toContain("the Isola duty operator");
  });

  it("ignores a status Paperclip would reject and falls back to the default", async () => {
    const { server, paperclip } = await boot({
      env: { PAPERCLIP_SUCCESS_STATUS: "totally-not-a-status" },
    });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    expect(paperclip.transitions[0]!.status).toBe("in_review");
  });

  it("a transition failure never flips a successful run into a failed status", async () => {
    const paperclip = new StubPaperclipApi();
    const { server, logger } = await boot({ paperclip });
    const { PaperclipApiError } = await import("../src/errors.js");
    paperclip.transitionFailure = new PaperclipApiError("returned HTTP 500", 500, true);

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    expect(res.status).toBe(200);
    expect(res.json["ok"]).toBe(true);
    expect(res.json["transitioned"]).toBe(false);
    expect(logger.withOutcome("issue_transition_failed")).toHaveLength(1);
  });
});

describe("no issue context", () => {
  it("transitions nothing, guesses nothing, and still returns the model outcome", async () => {
    const { server, paperclip, logger } = await boot();
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body({ context: { fixture: "overdue-invoices", invoices: [], tenantId: "8D3dp3z" } }),
    });

    expect(res.status).toBe(200);
    expect(res.json["transitioned"]).toBe(false);
    expect(res.json["issueStatus"]).toBeNull();
    expect(paperclip.transitions).toHaveLength(0);

    const line = logger.withOutcome("no_issue_context");
    expect(line).toHaveLength(1);
    expect(String(line[0]!["detail"])).toContain("no issue id was guessed");
  });

  it("returns the failing status too, still without transitioning", async () => {
    const { server, paperclip } = await boot({
      model: StubModelClient.throwing(new ModelTimeoutError(1000)),
    });
    const res = await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body({ context: { nothing: "here", tenantId: "8D3dp3z" } }),
    });
    expect(res.status).toBe(504);
    expect(paperclip.transitions).toHaveLength(0);
  });

  it("resolves the issue id from the shapes Paperclip actually sends", async () => {
    for (const [label, context] of [
      ["issueId", { issueId: "I-1" }],
      ["issue_id", { issue_id: "I-2" }],
      ["issue.id", { issue: { id: "I-3" } }],
      ["task.issueId", { task: { issueId: "I-4" } }],
      ["assignedIssue.id", { assignedIssue: { id: "I-5" } }],
      ["paperclip.issueId", { paperclip: { issueId: "I-6" } }],
    ] as const) {
      const { server, paperclip } = await boot();
      await invoke(server.url, {
        bearer: AGENT7_SECRET,
        body: body({ context: { ...context, tenantId: "8D3dp3z" }, runId: `run-${label}` }),
      });
      expect(paperclip.transitions).toHaveLength(1);
      expect(paperclip.transitions[0]!.issueId).toMatch(/^I-\d$/);
    }
  });

  it("does not go fishing in an array of issues", async () => {
    const { server, paperclip } = await boot();
    await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body({ context: { issues: [{ id: "I-9" }], tenantId: "8D3dp3z" } }),
    });
    expect(paperclip.transitions).toHaveLength(0);
  });
});

describe("idempotency", () => {
  it("a replayed run id produces exactly one comment and one transition", async () => {
    const { server, model, recorder, paperclip, logger } = await boot();

    const first = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    const second = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    const third = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });

    expect(first.status).toBe(200);
    // The replay returns the ORIGINAL result, not a fresh one.
    expect(second.status).toBe(200);
    expect(second.json["replay"]).toBe(true);
    expect(second.json["outcome"]).toBe("ok");
    expect(second.json["issueStatus"]).toBe("in_review");
    expect(third.json["replay"]).toBe(true);

    // Exactly one of everything, and the provider was called once.
    expect(model.calls).toHaveLength(1);
    expect(recorder.outcomes).toHaveLength(1);
    expect(paperclip.transitions).toHaveLength(1);
    expect(logger.withOutcome("duplicate_run_suppressed")).toHaveLength(2);
  });

  it("replays a failed run's status rather than re-running it", async () => {
    const { server, model, paperclip } = await boot({
      model: StubModelClient.throwing(new ModelTimeoutError(1000)),
    });
    const first = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    const second = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });

    expect(first.status).toBe(504);
    expect(second.status).toBe(504);
    expect(second.json["replay"]).toBe(true);
    expect(model.calls).toHaveLength(1);
    expect(paperclip.transitions).toHaveLength(1);
  });

  it("a duplicate arriving while the original is in flight does nothing and reports 2xx", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new StubModelClient(async () => {
      await gate;
      return { content: "answer", model: "m", finishReason: "stop", usage: null };
    });
    const { server, recorder, paperclip } = await boot({ model });

    const inFlight = invoke(server.url, { bearer: AGENT7_SECRET, body: body() });
    // Give the first request time to claim the idempotency record.
    await new Promise((resolve) => setTimeout(resolve, 25));
    const duplicate = await invoke(server.url, { bearer: AGENT7_SECRET, body: body() });

    expect(duplicate.status).toBe(200);
    expect(duplicate.json["outcome"]).toBe("duplicate_run_suppressed");

    release();
    const original = await inFlight;
    expect(original.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(recorder.outcomes).toHaveLength(1);
    expect(paperclip.transitions).toHaveLength(1);
  });

  it("distinct run ids are distinct runs", async () => {
    const { server, model, paperclip } = await boot();
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body({ runId: "run-A" }) });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body({ runId: "run-B" }) });
    expect(model.calls).toHaveLength(2);
    expect(paperclip.transitions).toHaveLength(2);
  });

  it("with no run id, the issue plus the context fingerprint keys the run", async () => {
    // This is the 53-run shape: the same issue, re-dispatched with no run id.
    const { server, model, paperclip } = await boot();
    for (let i = 0; i < 5; i += 1) {
      await invoke(server.url, {
        bearer: AGENT7_SECRET,
        body: body({ runId: undefined }),
      });
    }
    expect(model.calls).toHaveLength(1);
    expect(paperclip.transitions).toHaveLength(1);
  });

  it("survives a restart: a replay after a new process is still a no-op", async () => {
    const dir = tempDir();
    const paperclip = new StubPaperclipApi();
    const recorder = new RecordingRecorder();

    const firstBoot = await boot({
      store: new FileStateStore({ dir }),
      paperclip,
      recorder,
    });
    const first = await invoke(firstBoot.server.url, {
      bearer: AGENT7_SECRET,
      body: body(),
    });
    expect(first.status).toBe(200);
    await firstBoot.server.close();
    servers.splice(servers.indexOf(firstBoot.server), 1);

    // A brand new process reading the same state directory.
    const secondBoot = await boot({
      store: new FileStateStore({ dir }),
      paperclip,
      recorder,
    });
    const replay = await invoke(secondBoot.server.url, {
      bearer: AGENT7_SECRET,
      body: body(),
    });

    expect(replay.status).toBe(200);
    expect(replay.json["replay"]).toBe(true);
    expect(replay.json["issueStatus"]).toBe("in_review");
    // Across both processes: one comment, one transition, one model call.
    expect(recorder.outcomes).toHaveLength(1);
    expect(paperclip.transitions).toHaveLength(1);
    expect(secondBoot.model.calls).toHaveLength(0);
  });

  it("the key is stable for the same run and different for a different one", () => {
    const base = {
      companyId: "c",
      agentId: "a",
      runId: "r",
      issueId: "i",
      contextText: "ctx",
    };
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey(base));
    expect(buildIdempotencyKey(base)).not.toBe(
      buildIdempotencyKey({ ...base, runId: "r2" }),
    );
    // No run id: the issue and the context decide.
    const noRun = { ...base, runId: null };
    expect(buildIdempotencyKey(noRun)).toBe(buildIdempotencyKey(noRun));
    expect(buildIdempotencyKey(noRun)).not.toBe(
      buildIdempotencyKey({ ...noRun, contextText: "different" }),
    );
    expect(buildIdempotencyKey(noRun)).toContain("issue:i");
    // The fingerprint is a hash, never the context itself.
    expect(buildIdempotencyKey(noRun)).not.toContain("ctx\"");
  });
});

/**
 * Regression: Paperclip refuses an agent-driven move to `in_review` unless a review
 * path exists (server/src/routes/issues.ts:872, `invalid_issue_disposition`). The
 * first live run 422'd on exactly this, the issue stayed actionable, and the
 * scheduler re-woke the agent — the very loop this work exists to close. We satisfy
 * `human_assignee_user_id` by handing the issue to a named human in the same PATCH.
 */
const silentLogger = () => new CapturingLogger().logger;

describe("in_review requires a review path", () => {
  const call = { apiKey: "agent-key", runId: "run-1" };
  const base = {
    issueId: "issue-1",
    call,
    logger: silentLogger(),
    correlationId: "corr-1",
    runId: "run-1",
    agentId: "agent-1",
  };

  it("assigns the configured human reviewer when moving to in_review", async () => {
    const api = new StubPaperclipApi();
    await transitionIssue({
      ...base, api, status: "in_review", reviewAssigneeUserId: "user-42",
    });
    expect(api.transitions).toHaveLength(1);
    expect(api.transitions[0]!.status).toBe("in_review");
    expect(api.transitions[0]!.extra).toEqual({ assigneeUserId: "user-42" });
  });

  it("does not reassign a blocked issue — blocked is already a human-attention state", async () => {
    const api = new StubPaperclipApi();
    await transitionIssue({
      ...base, api, status: "blocked", reviewAssigneeUserId: "user-42",
    });
    expect(api.transitions[0]!.status).toBe("blocked");
    expect(api.transitions[0]!.extra ?? null).toBeNull();
  });

  it("still attempts in_review with no reviewer configured, and reports the failure honestly", async () => {
    // Without a reviewer Paperclip 422s. We must surface that, not pretend it worked.
    const api = new StubPaperclipApi();
    api.transitionFailure = new PaperclipApiError("invalid_issue_disposition", 422, false);
    const out = await transitionIssue({
      ...base, api, status: "in_review", reviewAssigneeUserId: null,
    });
    expect(api.transitions[0]!.extra ?? null).toBeNull();
    expect(out.transitioned).toBe(false);
    expect(out.attempted).toBe(true);
  });

  it("never throws — a transition failure must not flip a successful run to failed", async () => {
    const api = new StubPaperclipApi();
    api.transitionFailure = new PaperclipApiError("boom", 500, true);
    await expect(
      transitionIssue({ ...base, api, status: "in_review", reviewAssigneeUserId: "user-42" }),
    ).resolves.toMatchObject({ transitioned: false });
  });
});
