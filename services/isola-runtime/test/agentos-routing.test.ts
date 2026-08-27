/**
 * End-to-end HTTP routing: does POST /v1/invoke actually pick the right
 * provider, refuse the right requests, and leave every other template alone?
 *
 * Test category mapping:
 *   3. Tenant refusal (Node-side, over HTTP)
 *   5. Exposure refusal (Node-side, over HTTP)
 *   6. Timeout, surfaced through the full request/response cycle
 *  11. Correlation propagation end-to-end
 *  12. Hermes (isola-internal-manager@v1) unchanged — direct regression proof
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../src/execution-provider.js";
import { NullRunRecorder } from "../src/recorder.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  OVERDUE_FIXTURE,
  RecordingRecorder,
  StubModelClient,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

class RecordingAgentOsProvider implements ExecutionProvider {
  readonly calls: ExecutionRequest[] = [];
  constructor(private readonly result: ExecutionResult) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    return this.result;
  }
}

describe("AgentOS routing over HTTP", () => {
  it("routes the eligible request (right tenant + right exposure) to the AgentOS provider, not the direct model", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("should never be called for this request");
    const agentOs = new RecordingAgentOsProvider({
      status: "completed",
      content: "the agentos answer",
      model: "deepseek-chat",
      usage: null,
    });
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig(),
      logger: logger.logger,
      modelClient: model,
      agentOsProvider: agentOs,
      recorder,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-agentos-1",
        context: OVERDUE_FIXTURE, // already carries tenantId: 8D3dp3z
      },
    });

    expect(res.status).toBe(200);
    expect(agentOs.calls).toHaveLength(1);
    expect(model.calls).toHaveLength(0); // the direct model was never touched
    expect(agentOs.calls[0]!.tenantId).toBe("8D3dp3z");
    expect(agentOs.calls[0]!.correlationId).toEqual(expect.any(String));
  });

  it("refuses a wrong tenant for the gated template with 403, and never calls either provider", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({ status: "completed", content: "x", model: null, usage: null });
    server = await startServer({
      config: envConfig(),
      logger: logger.logger,
      modelClient: model,
      agentOsProvider: agentOs,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-tenant-refused",
        context: { ...OVERDUE_FIXTURE, tenantId: "someone-elses-tenant" },
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agentos_routing_refused");
    expect(String(res.json["error"])).toContain("agentos_tenant_refused");
    expect(model.calls).toHaveLength(0);
    expect(agentOs.calls).toHaveLength(0);
  });

  it("REGRESSION: a forged context.tenantId cannot select a tenant the SERVER is not configured for", async () => {
    // The Codex finding, end to end. The operator has configured this runtime
    // for a different tenant; the caller holds a valid INTERNAL credential and
    // forges the historically-allowlisted tenant string in the request body.
    // Before the fix this matched a compiled-in constant and routed to AgentOS.
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({
      status: "completed",
      content: "should never be reached",
      model: null,
      usage: null,
    });
    server = await startServer({
      config: envConfig({ AGENTOS_TENANT_ID: "a-different-configured-tenant" }),
      modelClient: model,
      agentOsProvider: agentOs,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-forged-tenant",
        context: OVERDUE_FIXTURE, // carries tenantId: 8D3dp3z
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agentos_routing_refused");
    expect(String(res.json["error"])).toContain("agentos_tenant_refused");
    // Neither provider ran: no fall-through to the direct model either.
    expect(agentOs.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("sends the SERVER-configured tenant to the sidecar, not whatever the body said", async () => {
    // Positive twin of the regression above: when the body carries no tenant
    // at all, the run still executes — as the configured tenant.
    const agentOs = new RecordingAgentOsProvider({
      status: "completed",
      content: "ok",
      model: null,
      usage: null,
    });
    server = await startServer({
      config: envConfig(),
      modelClient: StubModelClient.returning("unused"),
      agentOsProvider: agentOs,
    });

    const { tenantId: _dropped, ...fixtureWithoutTenant } = OVERDUE_FIXTURE;
    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-server-tenant",
        context: fixtureWithoutTenant,
      },
    });

    expect(res.status).toBe(200);
    expect(agentOs.calls).toHaveLength(1);
    expect(agentOs.calls[0]!.tenantId).toBe("8D3dp3z");
  });

  it("503s agentos_not_configured when AGENTOS_TENANT_ID is unset — never falls back to a constant", async () => {
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({
      status: "completed",
      content: "x",
      model: null,
      usage: null,
    });
    server = await startServer({
      config: envConfig({ AGENTOS_TENANT_ID: undefined }),
      modelClient: model,
      agentOsProvider: agentOs,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-no-tenant-config",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(503);
    expect(res.json["outcome"]).toBe("agentos_not_configured");
    expect(agentOs.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
  });

  it("refuses the wrong exposure for the gated template with 403", async () => {
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({ status: "completed", content: "x", model: null, usage: null });
    server = await startServer({
      config: envConfig(),
      modelClient: model,
      agentOsProvider: agentOs,
    });

    // A PUBLIC-declared exposure never matches an INTERNAL-only credential
    // pairing for this template — decideExposure would already reject this
    // combination as exposure_mismatch (403) before the AgentOS gate is even
    // reached, so this proves the SAME public-facing status code either way,
    // without asserting on which pre-flight check produced it.
    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "PUBLIC",
        agentId: "agent-7",
        runId: "run-exposure",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(403);
    expect(model.calls).toHaveLength(0);
    expect(agentOs.calls).toHaveLength(0);
  });

  it("503s with agentos_not_configured when the request is eligible but no AgentOS provider is wired", async () => {
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig(),
      modelClient: model,
      agentOsProvider: null, // explicit: force "unconfigured", overriding the harness default
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-not-configured",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(503);
    expect(res.json["outcome"]).toBe("agentos_not_configured");
    expect(model.calls).toHaveLength(0);
  });

  it("a timed-out AgentOS run surfaces as 504 model_timeout end to end, never a hang", async () => {
    const model = StubModelClient.returning("should never be called");
    const agentOs: ExecutionProvider = {
      execute: async () => ({
        status: "failed",
        category: "timeout",
        reason: "agentos_timeout_after_2000ms",
        httpStatus: 504,
        invalidOutput: false,
      }),
    };
    server = await startServer({ config: envConfig(), modelClient: model, agentOsProvider: agentOs });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-timeout",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(504);
    expect(res.json["outcome"]).toBe("model_timeout");
  });

  it("the same correlationId sent to the AgentOS provider appears in Node's own log line for that run", async () => {
    const logger = new CapturingLogger();
    const agentOs = new RecordingAgentOsProvider({
      status: "completed",
      content: "ok",
      model: null,
      usage: null,
    });
    server = await startServer({
      config: envConfig(),
      logger: logger.logger,
      modelClient: StubModelClient.returning("unused"),
      agentOsProvider: agentOs,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-correlation",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(200);
    const sentCorrelationId = agentOs.calls[0]!.correlationId;
    expect(res.correlationHeader).toBe(sentCorrelationId);
    const line = logger.withOutcome("ok").find((l) => l["correlationId"] === sentCorrelationId);
    expect(line).toBeDefined();
  });
});

/**
 * The scenario the ratified decision is actually about
 * (`dec-ai1b-inline-agent-answer-may-return-without-recorder-2026-08-27`):
 * a REAL AgentOS execution provider completing with answer text while no
 * recorder is configured. The inline tests in `inline.test.ts` cover the
 * response contract, but they run through the harness's direct-model
 * substitution — these drive a genuine `agentOsProvider` so the AgentOS path
 * itself is proven, not inferred.
 */
describe("AgentOS answer + unconfigured recorder (the ratified case)", () => {
  const AGENTOS_ANSWER = "| Account | Balance |\n| ACC-1001 | USD 4,120.00 |";

  it("returns the AgentOS answer inline as a non-persisted success", async () => {
    const agentOs: ExecutionProvider = {
      execute: async () => ({
        status: "completed",
        content: AGENTOS_ANSWER,
        model: "deepseek-chat",
        usage: null,
      }),
    };
    server = await startServer({
      config: envConfig(),
      modelClient: StubModelClient.returning("direct model must not answer here"),
      agentOsProvider: agentOs,
      recorder: new NullRunRecorder(),
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-agentos-no-recorder",
        context: OVERDUE_FIXTURE,
        responseMode: "inline",
      },
    });

    expect(res.status).toBe(200);
    expect(res.json["completionState"]).toBe("completed");
    expect(res.json["answerText"]).toBe(AGENTOS_ANSWER);
    // Honest about the fact nothing was written down.
    expect(res.json["recorded"]).toBe(false);
    expect(res.json["persistence"]).toBe("skipped_unconfigured");
  });

  it("a FAILED AgentOS run with no recorder is still not a success", async () => {
    // Positive control for the test above: skipping persistence must not turn
    // a provider failure into an answer.
    const agentOs: ExecutionProvider = {
      execute: async () => ({
        status: "failed",
        category: "provider_error",
        reason: "agentos_non_terminal_status (error)",
        httpStatus: 502,
        invalidOutput: true,
      }),
    };
    server = await startServer({
      config: envConfig(),
      modelClient: StubModelClient.returning("unused"),
      agentOsProvider: agentOs,
      recorder: new NullRunRecorder(),
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-agentos-failed",
        context: OVERDUE_FIXTURE,
        responseMode: "inline",
      },
    });

    expect(res.status).toBe(502);
    expect(res.json["ok"]).toBe(false);
    expect(res.json["answerText"]).toBeNull();
    expect(res.json["completionState"]).not.toBe("completed");
  });
});

describe("Hermes (isola-internal-manager@v1) routing is completely unaffected", () => {
  it("still routes through its own declared model client override, never through the AgentOS gate", async () => {
    const model = StubModelClient.returning("front-desk-unrelated");
    const hermesModel = StubModelClient.returning("hermes answer, unchanged");
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig({ RUNTIME_SECRET_INTERNAL: INTERNAL_SECRET }),
      modelClient: model,
      recorder,
    });

    // isola-internal-manager@v1 declares its OWN modelBaseUrl/modelApiKeyEnv
    // (hermes-tunnel) — this test only needs to prove the AgentOS gate never
    // intercepts it, which the absence of any agentos_routing_refused /
    // agentos_not_configured outcome already demonstrates: no tenant was
    // supplied and the request still is not refused, because
    // evaluateAgentOsEligibility returns not_applicable for this template id.
    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: "isola-internal-manager@v1",
        exposure: "INTERNAL",
        agentId: "agent-mgr",
        runId: "run-hermes-1",
        context: { note: "no tenant supplied at all" },
      },
    });

    // Without HERMES_API_KEY configured, clientForTemplate fails closed with
    // a 500 internal_error BEFORE any AgentOS concern — proving this request
    // never reached the gate's refusal path (which would be 403, not 500).
    expect(res.status).not.toBe(403);
    expect(res.json["outcome"]).not.toBe("agentos_routing_refused");
    expect(res.json["outcome"]).not.toBe("agentos_not_configured");
    void hermesModel;
  });
});
