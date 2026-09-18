/**
 * Work item 2 — metering, reservations and budget enforcement, end to end over
 * HTTP.
 *
 * Defect: after 53 runs the employee reported `spentMonthlyCents: 0`, because
 * Paperclip's `http` adapter discards the adapter response so cost never
 * reached it, so neither the 80% alert nor the 100% hard stop could ever fire.
 * The runtime meters from the provider's own usage response and pushes cost
 * events into Paperclip, which remains the canonical ledger.
 */
import { afterEach, describe, expect, it } from "vitest";

import { PaperclipApiError } from "../src/errors.js";
import { evaluateBudget, decideThreshold, budgetPeriod } from "../src/budget.js";
import { MICROCENTS_PER_CENT } from "../src/money.js";
import { outboxKey } from "../src/outbox.js";
import { InMemoryStateStore, type OutboxEntry, type StateStore } from "../src/state.js";
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
import type { ModelResponse } from "../src/model.js";

const AGENT_KEY = ["agent", "key", "internal"].join("-");

const METERING_ENV: Record<string, string | undefined> = {
  PAPERCLIP_COMPANY_ID: "company-1",
  PAPERCLIP_AGENT_KEY_INTERNAL: AGENT_KEY,
  // 1000 input tokens costs 1000 * 250 microcents = 0.25 cents per run, so four
  // runs make exactly one whole cent. Output is free here to keep the
  // arithmetic in the test as legible as the arithmetic in the code.
  MODEL_PRICE_INPUT_PER_MTOK_CENTS: "250",
  MODEL_PRICE_OUTPUT_PER_MTOK_CENTS: "0",
  MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS: "0",
};

const servers: TestServer[] = [];
afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function modelWithUsage(
  promptTokens: number,
  completionTokens = 0,
  cachedPromptTokens: number | null = null,
): StubModelClient {
  return new StubModelClient(
    async (): Promise<ModelResponse> => ({
      content: "the answer",
      model: "deepseek-chat",
      finishReason: "stop",
      usage: { promptTokens, completionTokens, cachedPromptTokens },
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
  clock: { ms: number };
}

async function boot(
  opts: {
    model?: StubModelClient;
    paperclip?: StubPaperclipApi;
    store?: StateStore;
    env?: Record<string, string | undefined>;
    clock?: { ms: number };
  } = {},
): Promise<Booted> {
  const logger = new CapturingLogger();
  const model = opts.model ?? modelWithUsage(1000);
  const recorder = new RecordingRecorder();
  const paperclip = opts.paperclip ?? new StubPaperclipApi();
  const store = opts.store ?? new InMemoryStateStore();
  const clock = opts.clock ?? { ms: Date.now() };
  const server = await startServer({
    config: envConfig({ ...METERING_ENV, ...(opts.env ?? {}) }),
    logger: logger.logger,
    modelClient: model,
    recorder,
    paperclipApi: paperclip,
    stateStore: store,
    now: () => clock.ms,
  });
  servers.push(server);
  return { server, logger, model, recorder, paperclip, store, clock };
}

const body = (runId: string, overrides: Record<string, unknown> = {}) => ({
  templateId: INTERNAL_TEMPLATE,
  exposure: "INTERNAL",
  agentId: "agent-7",
  runId,
  context: OVERDUE_FIXTURE,
  ...overrides,
});

// ---------------------------------------------------------------------------

describe("sub-cent accumulation over HTTP", () => {
  it("emits no cost event until a whole cent has accrued, then exactly one", async () => {
    const { server, paperclip } = await boot();

    for (const runId of ["r1", "r2", "r3"]) {
      const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body(runId) });
      expect(res.status).toBe(200);
    }
    // 3 x 0.25 cents = 0.75 cents. Rounding up here would have invented money.
    expect(paperclip.costEvents).toHaveLength(0);

    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r4") });
    expect(paperclip.costEvents).toHaveLength(1);
    const event = paperclip.costEvents[0]!;
    expect(event.costCents).toBe(1);
    // The usage of all four runs rode out with the event: none was lost.
    expect(event.inputTokens).toBe(4000);
    expect(event.outputTokens).toBe(0);
  });

  it("eight runs produce two events totalling two cents, with nothing dropped", async () => {
    const { server, paperclip, store } = await boot();
    for (let i = 1; i <= 8; i += 1) {
      await invoke(server.url, { bearer: AGENT7_SECRET, body: body(`run-${i}`) });
    }
    expect(paperclip.costEvents).toHaveLength(2);
    const total = paperclip.costEvents.reduce((sum, e) => sum + e.costCents, 0);
    expect(total).toBe(2);
    expect(paperclip.costEvents.reduce((s, e) => s + e.inputTokens, 0)).toBe(8000);
    // 8 x 250,000 microcents = 2,000,000 exactly, so no remainder is carried.
    const state = await store.read();
    expect(state.accumulators["company-1|agent-7|actual"]!.microcents).toBe(0);
  });

  it("carries a genuine remainder forward rather than dropping or inflating it", async () => {
    const { server, paperclip, store } = await boot();
    for (let i = 1; i <= 5; i += 1) {
      await invoke(server.url, { bearer: AGENT7_SECRET, body: body(`run-${i}`) });
    }
    // 1.25 cents accrued: one cent billed, a quarter of a cent carried.
    expect(paperclip.costEvents.reduce((s, e) => s + e.costCents, 0)).toBe(1);
    const state = await store.read();
    expect(state.accumulators["company-1|agent-7|actual"]!.microcents).toBe(250_000);
    expect(state.accumulators["company-1|agent-7|actual"]!.microcents).toBeLessThan(
      MICROCENTS_PER_CENT,
    );
  });

  it("the emitted event matches Paperclip's cost-event schema exactly", async () => {
    const { server, paperclip } = await boot();
    for (let i = 1; i <= 4; i += 1) {
      await invoke(server.url, { bearer: AGENT7_SECRET, body: body(`run-${i}`) });
    }
    const event = paperclip.costEvents[0]!;
    expect(event.agentId).toBe("agent-7");
    expect(event.issueId).toBe("ISSUE-4821");
    // NEVER send heartbeatRunId. It is a FOREIGN KEY into Paperclip's
    // `heartbeat_runs`, and this runtime never holds an id Paperclip issued —
    // it executes the model itself and reports cost afterwards.
    //
    // This assertion previously read `.toBe("run-4")` and PASSED, because the
    // harness's fake Paperclip has no foreign key. The real one does:
    //   violates foreign key constraint
    //   "cost_events_heartbeat_run_id_heartbeat_runs_id_fk"
    // The test asserted conformance to a schema it was not actually testing
    // against — the fake accepted precisely what production refused.
    //
    // The cost of getting this wrong was not a metric. The event stuck in the
    // outbox, aged past the delivery limit, and the runtime failed closed and
    // stopped invoking the model: one undelivered cent took the 6737 front desk
    // offline on 2026-08-17.
    expect(event.heartbeatRunId).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(event, "heartbeatRunId")).toBe(false);
    expect(event.provider).toBe("deepseek");
    expect(event.biller).toBe("deepseek");
    expect(event.billingType).toBe("metered_api");
    expect(event.billingCode).toBe("provider-rates@v1");
    expect(event.model).toBe("deepseek-chat");
    expect(Number.isInteger(event.costCents)).toBe(true);
    expect(event.costCents).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(event.inputTokens)).toBe(true);
    expect(new Date(event.occurredAt).toISOString()).toBe(event.occurredAt);

    // Delivered as the employee's own agent, with the run-id header.
    const call = paperclip.calls.find((c) => c.kind === "cost_event")!;
    expect(call.apiKey).toBe(AGENT_KEY);
    expect(call.companyId).toBe("company-1");
    expect(call.runId).toBe("run-4");
  });

  it("splits cached input tokens out of the provider's total prompt count", async () => {
    const { server, paperclip } = await boot({
      model: modelWithUsage(4000, 0, 1000),
      env: { MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS: "50" },
    });
    // 3000 fresh at 250 + 1000 cached at 50 = 750,000 + 50,000 = 800,000 mc.
    // Two runs = 1,600,000 -> one cent, 600,000 carried.
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r2") });
    expect(paperclip.costEvents).toHaveLength(1);
    expect(paperclip.costEvents[0]!.costCents).toBe(1);
    expect(paperclip.costEvents[0]!.inputTokens).toBe(6000);
    expect(paperclip.costEvents[0]!.cachedInputTokens).toBe(2000);
  });

  it("a replayed run never accrues cost twice", async () => {
    const { server, paperclip, store } = await boot();
    for (let i = 0; i < 6; i += 1) {
      // The same run id every time — a duplicate webhook or an adapter retry.
      await invoke(server.url, { bearer: AGENT7_SECRET, body: body("same-run") });
    }
    expect(paperclip.costEvents).toHaveLength(0);
    const state = await store.read();
    expect(state.accumulators["company-1|agent-7|actual"]!.microcents).toBe(250_000);
  });
});

describe("never fabricate cost", () => {
  it("records usage with costCents 0 and an unpriced label when no rate is known", async () => {
    const { server, paperclip } = await boot({
      env: {
        MODEL_NAME: "local-model-x",
        MODEL_PROVIDER: "ollama",
        MODEL_PRICE_INPUT_PER_MTOK_CENTS: undefined,
        MODEL_PRICE_OUTPUT_PER_MTOK_CENTS: undefined,
        MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS: undefined,
      },
      model: modelWithUsage(1234, 567),
    });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(paperclip.costEvents).toHaveLength(1);
    const event = paperclip.costEvents[0]!;
    expect(event.costCents).toBe(0);
    expect(event.billingCode).toBe("unpriced@v1");
    expect(event.billingType).not.toBe("metered_api");
    // The usage is preserved even though no money is claimed.
    expect(event.inputTokens).toBe(1234);
    expect(event.outputTokens).toBe(567);
    expect(event.provider).toBe("ollama");
  });

  it("labels synthetic pricing, and never presents it as actual expenditure", async () => {
    const { server, paperclip, store, logger } = await boot({
      env: {
        MODEL_NAME: "local-model-x",
        MODEL_PROVIDER: "ollama",
        RUNTIME_SYNTHETIC_PRICING: "on",
        MODEL_PRICE_INPUT_PER_MTOK_CENTS: undefined,
        MODEL_PRICE_OUTPUT_PER_MTOK_CENTS: undefined,
        MODEL_PRICE_CACHED_INPUT_PER_MTOK_CENTS: undefined,
      },
      // Synthetic input is 10 cents/Mtok, so 150,000 tokens is 1.5 cents.
      model: modelWithUsage(150_000),
    });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(paperclip.costEvents).toHaveLength(1);
    const event = paperclip.costEvents[0]!;
    expect(event.costCents).toBe(1);
    expect(event.billingCode).toBe("synthetic-pricing@v1");
    expect(event.billingCode).toContain("@v");
    // Not real money: never the metered enum, never billed to the real provider.
    expect(event.billingType).not.toBe("metered_api");
    expect(event.biller).toBe("ollama-synthetic");
    expect(event.biller).not.toBe(event.provider);

    // The provenance is recorded in the outbox and in the log, not just guessed
    // at from the billing code.
    const state = await store.read();
    const entry = state.outbox[outboxKey("company-1", "agent-7", "r1")]!;
    expect(entry.costKind).toBe("synthetic");
    expect(entry.costKind).not.toBe("actual");
    const enqueued = logger.withOutcome("cost_event_enqueued")[0]!;
    expect(enqueued["costKind"]).toBe("synthetic");

    // Synthetic cost is kept in its own accumulator, never blended into actual.
    expect(state.accumulators["company-1|agent-7|synthetic"]).toBeDefined();
    expect(state.accumulators["company-1|agent-7|actual"]).toBeUndefined();
  });

  it("synthetic pricing never displaces a model that has a real rate", async () => {
    const { server, paperclip } = await boot({
      env: { RUNTIME_SYNTHETIC_PRICING: "on" },
    });
    for (let i = 1; i <= 4; i += 1) {
      await invoke(server.url, { bearer: AGENT7_SECRET, body: body(`r${i}`) });
    }
    expect(paperclip.costEvents[0]!.billingCode).toBe("provider-rates@v1");
    expect(paperclip.costEvents[0]!.billingType).toBe("metered_api");
  });

  it("emits nothing at all when the provider reported no usage", async () => {
    const { server, paperclip, logger } = await boot({
      model: StubModelClient.returning("answer"),
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(200);
    expect(paperclip.costEvents).toHaveLength(0);
    expect(logger.withOutcome("cost_usage_unavailable")).toHaveLength(1);
  });

  it("skips the cost event, loudly, when no company can be resolved", async () => {
    const { server, paperclip, logger } = await boot({
      env: { PAPERCLIP_COMPANY_ID: undefined },
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(200);
    expect(paperclip.costEvents).toHaveLength(0);
    expect(logger.withOutcome("cost_no_company_context")).toHaveLength(1);
  });

  it("takes the company from the run context when one is supplied", async () => {
    const { server, paperclip } = await boot({
      env: { PAPERCLIP_COMPANY_ID: undefined },
      model: modelWithUsage(20_000),
    });
    await invoke(server.url, {
      bearer: AGENT7_SECRET,
      body: body("r1", { context: { ...OVERDUE_FIXTURE, companyId: "company-from-ctx" } }),
    });
    const call = paperclip.calls.find((c) => c.kind === "cost_event")!;
    expect(call.companyId).toBe("company-from-ctx");
  });
});

describe("budget thresholds", () => {
  it("fires the 80% alert once per crossing, not once per run", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 10_000, spentMonthlyCents: 8_000 };
    const { server, logger } = await boot({ paperclip });

    for (const runId of ["r1", "r2", "r3"]) {
      const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body(runId) });
      expect(res.status).toBe(200);
    }

    const alerts = logger.withOutcome("budget_alert");
    expect(alerts).toHaveLength(1);
    expect(Number(alerts[0]!["usedPct"])).toBeGreaterThanOrEqual(80);

    const alertComments = paperclip.comments.filter((c) =>
      String(c.body).includes("BUDGET ALERT"),
    );
    expect(alertComments).toHaveLength(1);
    expect(String(alertComments[0]!.body)).toContain("not model output");
  });

  it("does not alert below the threshold", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 10_000, spentMonthlyCents: 100 };
    const { server, logger } = await boot({ paperclip });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(logger.withOutcome("budget_alert")).toHaveLength(0);
  });

  /**
   * THE SABOTAGE PROOF FOR THE FALLBACK CEILING.
   *
   * Paperclip supplies NO budget here — the exact state the internal manager was
   * found in (`budgetMonthlyCents: 0`) and the state every newly created agent
   * starts in. Before 2026-08-19 that meant "unlimited" and this request would
   * have succeeded. A money control that has never refused anything is unproven,
   * so this fires it.
   */
  it("SABOTAGE: no Paperclip budget + spend past the FALLBACK ceiling => 402, provider untouched", async () => {
    const paperclip = new StubPaperclipApi();
    // No ceiling from Paperclip, and prior spend already past the fallback.
    paperclip.budget = { budgetMonthlyCents: null, spentMonthlyCents: 50 };
    const { server, model, logger } = await boot({
      paperclip,
      env: { RUNTIME_BUDGET_FALLBACK_CENTS: "10" },
    });

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(res.status).toBe(402);
    expect(res.json["outcome"]).toBe("budget_exhausted");
    // THE ASSERTION THAT MATTERS: refused before any money was spent.
    expect(model.calls).toHaveLength(0);
    expect(logger.withOutcome("budget_exhausted")[0]!["providerCalled"]).toBe(false);
  });

  it("POSITIVE CONTROL: the same agent with spend UNDER the fallback still runs", async () => {
    // Without this, the test above would pass just as well against a runtime
    // that refused everything — which is the failure mode the owner's ruling
    // exists to avoid ("no agent starts refusing on deploy").
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: null, spentMonthlyCents: 1 };
    const { server, model } = await boot({
      paperclip,
      env: { RUNTIME_BUDGET_FALLBACK_CENTS: "5000" },
    });

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
  });

  it("rejects at 100% BEFORE calling the provider, and pauses the employee", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 100 };
    const { server, model, logger } = await boot({ paperclip });

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(res.status).toBe(402);
    expect(res.json["outcome"]).toBe("budget_exhausted");
    // The single most important assertion here.
    expect(model.calls).toHaveLength(0);
    expect(res.json["agentPaused"]).toBe(true);

    expect(paperclip.pauses).toHaveLength(1);
    expect(paperclip.pauses[0]!.agentId).toBe("agent-7");
    expect(paperclip.pauses[0]!.apiKey).toBe(AGENT_KEY);

    const line = logger.withOutcome("budget_exhausted")[0]!;
    expect(line["providerCalled"]).toBe(false);
    expect(line["httpStatus"]).toBe(402);

    const comment = paperclip.comments.find((c) =>
      String(c.body).includes("BUDGET EXHAUSTED"),
    );
    expect(comment).toBeDefined();
    expect(String(comment!.body)).toContain("before the model provider was called");
    expect(String(comment!.body)).toContain("Owner:");
    expect(String(comment!.body)).toContain("Next action:");
  });

  it("pauses once per period, not once per rejected run", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 100 };
    const { server, model } = await boot({ paperclip });
    for (const runId of ["r1", "r2", "r3"]) {
      const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body(runId) });
      expect(res.status).toBe(402);
    }
    expect(paperclip.pauses).toHaveLength(1);
    expect(model.calls).toHaveLength(0);
  });

  it("a rejected run is retryable later — the claim is released, not finalized", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 100 };
    const { server, model, store, clock } = await boot({ paperclip });

    expect((await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") })).status).toBe(402);
    // Nothing is remembered as a completed result for this run.
    expect(Object.keys((await store.read()).idempotency)).toHaveLength(0);

    // Budget raised. The cached ledger snapshot has to expire first — until it
    // does, the runtime keeps failing closed on the figure it last read.
    paperclip.budget = { budgetMonthlyCents: 100_000, spentMonthlyCents: 100 };
    expect((await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") })).status).toBe(402);
    clock.ms += 60_000;

    const retry = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(retry.status).toBe(200);
    expect(model.calls).toHaveLength(1);
  });

  it("keeps running with no enforcement when the budget cannot be read", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budgetFailure = new PaperclipApiError("returned HTTP 500", 500, true);
    const { server, model, logger } = await boot({ paperclip });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(logger.withOutcome("budget_read_failed")).toHaveLength(1);
  });

  it("RUNTIME_BUDGET_ENFORCEMENT=off skips the ledger read entirely", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 100 };
    const { server, model } = await boot({
      paperclip,
      env: { RUNTIME_BUDGET_ENFORCEMENT: "off" },
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
  });
});

describe("reservations", () => {
  it("concurrent runs cannot collectively exceed the remaining budget", async () => {
    // Each run reserves 1000 estimated output tokens at 40,000 cents/Mtok =
    // 40 cents. With a 100 cent budget exactly two runs fit; the third must be
    // rejected before it reaches the provider.
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 0 };

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = new StubModelClient(async (): Promise<ModelResponse> => {
      await gate;
      return {
        content: "answer",
        model: "deepseek-chat",
        finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 0, cachedPromptTokens: null },
      };
    });

    const { server } = await boot({
      paperclip,
      model,
      env: {
        MODEL_PRICE_INPUT_PER_MTOK_CENTS: "0",
        MODEL_PRICE_OUTPUT_PER_MTOK_CENTS: "40000",
        RUNTIME_ESTIMATED_OUTPUT_TOKENS: "1000",
      },
    });

    const responses = Promise.all(
      ["c1", "c2", "c3"].map((runId) =>
        invoke(server.url, { bearer: AGENT7_SECRET, body: body(runId) }),
      ),
    );

    // Let all three reach preflight, then let the two that got through finish.
    await new Promise((resolve) => setTimeout(resolve, 60));
    release();
    const settled = await responses;

    const statuses = settled.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 402]);
    // The rejected run never touched the provider.
    expect(model.calls).toHaveLength(2);
    expect(
      settled.find((r) => r.status === 402)!.json["outcome"],
    ).toBe("budget_exhausted");
  });

  it("releases the reservation once the run settles, so the next run fits", async () => {
    const paperclip = new StubPaperclipApi();
    paperclip.budget = { budgetMonthlyCents: 100, spentMonthlyCents: 0 };
    const { server, store } = await boot({
      paperclip,
      env: {
        MODEL_PRICE_INPUT_PER_MTOK_CENTS: "0",
        MODEL_PRICE_OUTPUT_PER_MTOK_CENTS: "40000",
        RUNTIME_ESTIMATED_OUTPUT_TOKENS: "1000",
      },
    });
    for (const runId of ["s1", "s2", "s3", "s4"]) {
      const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body(runId) });
      expect(res.status).toBe(200);
    }
    // Serial runs each reserve and release, so nothing accumulates.
    expect(await store.read().then((s) => Object.keys(s.reservations))).toHaveLength(0);
  });

  it("a reservation never outlives a failed run", async () => {
    const { server, store } = await boot({
      model: StubModelClient.throwing(new PaperclipApiError("x", null, true)),
    });
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("f1") });
    expect(Object.keys((await store.read()).reservations)).toHaveLength(0);
  });
});

describe("fail closed on undelivered spend", () => {
  function undelivered(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
      key: outboxKey("company-1", "agent-7", "old-run"),
      companyId: "company-1",
      agentId: "agent-7",
      runId: "old-run",
      exposure: "INTERNAL",
      event: {
        agentId: "agent-7",
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
      ...overrides,
    };
  }

  async function storeWith(entry: OutboxEntry): Promise<InMemoryStateStore> {
    const store = new InMemoryStateStore();
    await store.transact((draft) => {
      draft.outbox[entry.key] = entry;
    });
    return store;
  }

  it("rejects with 503 rather than spending more it cannot account for", async () => {
    const store = await storeWith(undelivered());
    const { server, model, logger } = await boot({ store });

    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });

    expect(res.status).toBe(503);
    expect(res.json["outcome"]).toBe("cost_delivery_unconfirmed");
    expect(res.json["pendingCostCents"]).toBe(60);
    // The provider is never called while spend is unaccounted for.
    expect(model.calls).toHaveLength(0);
    const line = logger.withOutcome("cost_delivery_unconfirmed")[0]!;
    expect(String(line["failureCategory"])).toContain("over the 50 cent limit");
  });

  it("respects a configured threshold", async () => {
    const store = await storeWith(undelivered({ event: { ...undelivered().event, costCents: 5 } }));
    const { server, model } = await boot({
      store,
      env: { RUNTIME_MAX_UNDELIVERED_COST_CENTS: "4" },
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(503);
    expect(model.calls).toHaveLength(0);
  });

  it("also fails closed on age, not only on amount", async () => {
    const store = await storeWith(
      undelivered({ event: { ...undelivered().event, costCents: 1 }, createdAtMs: 0 }),
    );
    const { server, model, logger } = await boot({
      store,
      env: { RUNTIME_MAX_UNDELIVERED_AGE_MS: "1000" },
    });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    expect(res.status).toBe(503);
    expect(model.calls).toHaveLength(0);
    expect(String(logger.withOutcome("cost_delivery_unconfirmed")[0]!["failureCategory"])).toContain(
      "old",
    );
  });

  it("lets the run through once the backlog is delivered", async () => {
    const store = await storeWith(undelivered({ state: "pending", attempts: 0 }));
    const { server, model, paperclip } = await boot({ store });
    const res = await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    // The flush at the start of the invocation clears the backlog first.
    expect(res.status).toBe(200);
    expect(model.calls).toHaveLength(1);
    expect(paperclip.costEvents.map((e) => e.costCents)).toContain(60);
  });
});

describe("outbox delivery over HTTP", () => {
  it("retries a failed delivery on the next invocation and then succeeds", async () => {
    const clock = { ms: 1_000_000 };
    const paperclip = new StubPaperclipApi();
    paperclip.costEventFailures = [new PaperclipApiError("returned HTTP 503", 503, true)];
    // 2 cents per run, so every run emits an event immediately.
    const { server, store } = await boot({
      paperclip,
      clock,
      env: { MODEL_PRICE_INPUT_PER_MTOK_CENTS: "2000" },
    });

    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r1") });
    let state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-7", "r1")]!.state).toBe("pending");
    expect(state.outbox[outboxKey("company-1", "agent-7", "r1")]!.attempts).toBe(1);

    // Move past the backoff and run again: the pending entry is flushed first.
    clock.ms += 5000;
    await invoke(server.url, { bearer: AGENT7_SECRET, body: body("r2") });

    state = await store.read();
    expect(state.outbox[outboxKey("company-1", "agent-7", "r1")]!.state).toBe("delivered");
    expect(state.outbox[outboxKey("company-1", "agent-7", "r2")]!.state).toBe("delivered");
    // Three attempts in total: the failure, its retry, and the new event.
    expect(paperclip.costEvents).toHaveLength(3);
  });

  it("reconciles on startup and re-delivers what the store still owes", async () => {
    const store = new InMemoryStateStore();
    await store.transact((draft) => {
      draft.outbox["company-1|agent-7|earlier"] = {
        key: "company-1|agent-7|earlier",
        companyId: "company-1",
        agentId: "agent-7",
        runId: "earlier",
        exposure: "INTERNAL",
        event: {
          agentId: "agent-7",
          heartbeatRunId: "earlier",
          billingCode: "provider-rates@v1",
          provider: "deepseek",
          biller: "deepseek",
          billingType: "metered_api",
          model: "deepseek-chat",
          inputTokens: 5000,
          cachedInputTokens: 0,
          outputTokens: 100,
          costCents: 4,
          occurredAt: new Date(0).toISOString(),
        },
        costKind: "actual",
        state: "pending",
        attempts: 4,
        createdAtMs: 0,
        lastAttemptMs: 0,
        // Far in the future: reconciliation must ignore the stale schedule.
        nextAttemptMs: 9_999_999_999_999,
        lastError: "returned HTTP 503",
        deliveredAtMs: null,
      };
    });

    const { server, paperclip } = await boot({ store });
    expect(paperclip.costEvents).toHaveLength(0);

    const summary = await server.runtime.metering.reconcile();

    expect(summary.delivered).toBe(1);
    expect(paperclip.costEvents).toHaveLength(1);
    expect(paperclip.costEvents[0]!.costCents).toBe(4);
    expect((await store.read()).outbox["company-1|agent-7|earlier"]!.state).toBe("delivered");
  });
});

describe("budget arithmetic", () => {
  it("counts undelivered, accrued and reserved on top of Paperclip's figure", () => {
    const verdict = evaluateBudget({
      budgetCents: 100,
      fallbackCents: 5000,
      spentCents: 50,
      localUndeliveredCents: 20,
      localAccruedMicrocents: 5 * MICROCENTS_PER_CENT,
      reservedMicrocents: 4 * MICROCENTS_PER_CENT,
      requestMicrocents: 1 * MICROCENTS_PER_CENT,
      alertPct: 80,
    });
    // 50 + 20 + 5 + 4 + 1 = 80 of 100.
    expect(verdict.kind).toBe("alert");
    if (verdict.kind !== "unlimited") expect(verdict.usedPct).toBe(80);
  });

  /**
   * THIS TEST USED TO ASSERT THE DEFECT. Until 2026-08-19 it read "treats an
   * absent or zero budget as unlimited" and passed — the behaviour was written
   * down, agreed with the code, and was still wrong. A test can only protect a
   * decision someone made; nobody decided that new agents have no ceiling.
   */
  it("applies the FALLBACK ceiling when Paperclip supplies no budget — never unlimited", () => {
    for (const budgetCents of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const verdict = evaluateBudget({
        budgetCents,
        fallbackCents: 5000,
        spentCents: 1_000_000, // far past any sane ceiling
        localUndeliveredCents: 0,
        localAccruedMicrocents: 0,
        reservedMicrocents: 0,
        requestMicrocents: 0,
        alertPct: 80,
      });
      expect(verdict.kind, `budgetCents=${String(budgetCents)}`).toBe("exhausted");
      // And it reports the ceiling it actually enforced, so an operator reading
      // the refusal is not left guessing which number stopped the run.
      if (verdict.kind !== "unlimited") expect(verdict.budgetCents).toBe(5000);
    }
  });

  it("an agent WITHIN the fallback still runs — the fallback guards, it does not block", () => {
    // The other half of the ruling: nothing that was working may start refusing
    // on deploy. A brand-new agent with no Paperclip budget and trivial spend
    // must proceed exactly as before.
    const verdict = evaluateBudget({
      budgetCents: null,
      fallbackCents: 5000,
      spentCents: 6, // the internal manager's real spend when this was found
      localUndeliveredCents: 0,
      localAccruedMicrocents: 0,
      reservedMicrocents: 0,
      requestMicrocents: 1 * MICROCENTS_PER_CENT,
      alertPct: 80,
    });
    expect(verdict.kind).toBe("ok");
  });

  it("a zero FALLBACK refuses rather than permitting — fail closed at the last resort", () => {
    // If the fallback itself is ever 0 (config bug, adopted default), the safe
    // failure is refusal. This is what stops the hole reopening one layer down.
    const verdict = evaluateBudget({
      budgetCents: null,
      fallbackCents: 0,
      spentCents: 0,
      localUndeliveredCents: 0,
      localAccruedMicrocents: 0,
      reservedMicrocents: 0,
      requestMicrocents: 0,
      alertPct: 80,
    });
    expect(verdict.kind).toBe("exhausted");
  });

  it("is exhausted exactly at 100%, not only past it", () => {
    const verdict = evaluateBudget({
      budgetCents: 100,
      fallbackCents: 5000,
      spentCents: 100,
      localUndeliveredCents: 0,
      localAccruedMicrocents: 0,
      reservedMicrocents: 0,
      requestMicrocents: 0,
      alertPct: 80,
    });
    expect(verdict.kind).toBe("exhausted");
  });

  it("re-arms the alert when the crossing is genuinely new", () => {
    const period = budgetPeriod(Date.UTC(2026, 7, 11));
    const first = decideThreshold({
      existing: undefined,
      agentId: "a",
      period,
      budgetCents: 100,
      usedPct: 85,
      alertPct: 80,
      exhausted: false,
    });
    expect(first.alert).toBe(true);

    const second = decideThreshold({
      existing: first.record,
      agentId: "a",
      period,
      budgetCents: 100,
      usedPct: 90,
      alertPct: 80,
      exhausted: false,
    });
    expect(second.alert).toBe(false);

    // Budget raised: a new regime, and a new crossing later on.
    const raised = decideThreshold({
      existing: second.record,
      agentId: "a",
      period,
      budgetCents: 1000,
      usedPct: 10,
      alertPct: 80,
      exhausted: false,
    });
    expect(raised.alert).toBe(false);
    const crossedAgain = decideThreshold({
      existing: raised.record,
      agentId: "a",
      period,
      budgetCents: 1000,
      usedPct: 81,
      alertPct: 80,
      exhausted: false,
    });
    expect(crossedAgain.alert).toBe(true);

    // A new month re-arms everything, including the pause.
    const nextMonth = decideThreshold({
      existing: crossedAgain.record,
      agentId: "a",
      period: budgetPeriod(Date.UTC(2026, 8, 1)),
      budgetCents: 1000,
      usedPct: 81,
      alertPct: 80,
      exhausted: true,
    });
    expect(nextMonth.alert).toBe(true);
    expect(nextMonth.pause).toBe(true);
  });
});
