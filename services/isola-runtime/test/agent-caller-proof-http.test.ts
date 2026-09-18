/**
 * The agent-caller-proof gate, exercised over the real HTTP route, not just
 * the pure decision function -- same discipline as agentos-routing.test.ts:
 * a unit test on the decision function proves nothing about whether app.ts
 * actually wired it in.
 */
import { afterEach, describe, expect, it } from "vitest";

import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "../src/execution-provider.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  OVERDUE_FIXTURE,
  StubModelClient,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

class RecordingAgentOsProvider implements ExecutionProvider {
  readonly calls: ExecutionRequest[] = [];
  constructor(private readonly result: ExecutionResult) {}
  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    this.calls.push(request);
    return this.result;
  }
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("agent caller proof over HTTP", () => {
  it("POSITIVE CONTROL: with the feature NOT opted in (the shipped default), the gated template invokes exactly as it always has -- no callerProof required", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("hello");
    server = await startServer({
      config: envConfig(), // no RUNTIME_AGENT_CALLER_PROOF_* overrides
      logger: logger.logger,
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-no-opt-in",
        context: OVERDUE_FIXTURE,
        // no callerProof field at all
      },
    });

    expect(res.status).not.toBe(403);
    expect(logger.withOutcome("agent_caller_proof_required")).toHaveLength(0);
  });

  it("refuses with 403 agent_caller_proof_required when the template is opted in and no callerProof is supplied -- the shared bearer alone is not enough", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({ status: "completed", content: "x", model: null, usage: null });
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_AGENT_CALLER_PROOF_MAP: JSON.stringify({ "agent-7": "the-real-proof" }),
      }),
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
        runId: "run-no-proof",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agent_caller_proof_required");
    expect(agentOs.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
    const lines = logger.withOutcome("agent_caller_proof_required");
    expect(lines).toHaveLength(1);
    expect(lines[0]!["reason"]).toBe("missing_proof");
  });

  it("refuses with proof_mismatch when the supplied callerProof does not match this agentId's configured value", async () => {
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_AGENT_CALLER_PROOF_MAP: JSON.stringify({ "agent-7": "the-real-proof" }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-wrong-proof",
        context: OVERDUE_FIXTURE,
        callerProof: "a-guess",
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agent_caller_proof_required");
    expect(model.calls).toHaveLength(0);
  });

  it("succeeds when the correct callerProof for this exact agentId is supplied", async () => {
    const model = StubModelClient.returning("the real answer");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_AGENT_CALLER_PROOF_MAP: JSON.stringify({ "agent-7": "the-real-proof" }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-right-proof",
        context: OVERDUE_FIXTURE,
        callerProof: "the-real-proof",
      },
    });

    expect(res.status).not.toBe(403);
  });

  it("a DIFFERENT agent's correct proof is still refused for agent-7 -- proof is per-agent, not a second shared secret", async () => {
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_AGENT_CALLER_PROOF_MAP: JSON.stringify({
          "agent-7": "proof-for-seven",
          "agent-8": "proof-for-eight",
        }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-cross-agent-proof",
        context: OVERDUE_FIXTURE,
        callerProof: "proof-for-eight",
      },
    });

    expect(res.status).toBe(403);
    expect(model.calls).toHaveLength(0);
  });

  it("an UNGATED template is completely unaffected even when the feature is opted in for a DIFFERENT template", async () => {
    const model = StubModelClient.returning("public answer");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_AGENT_CALLER_PROOF_MAP: JSON.stringify({ "agent-7": "the-real-proof" }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: "isola-internal-manager@v1",
        exposure: "INTERNAL",
        agentId: "agent-mgr",
        runId: "run-ungated",
        context: { note: "not the gated template" },
        // no callerProof -- must not matter for an ungated template
      },
    });

    expect(res.status).not.toBe(403);
  });
});
