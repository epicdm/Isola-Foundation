/**
 * The agent-caller-proof gate, exercised over the real HTTP route, not just
 * the pure decision function -- same discipline as agentos-routing.test.ts:
 * a unit test on the decision function proves nothing about whether app.ts
 * actually wired it in.
 *
 * The proof is the CALLER'S BEARER (RUNTIME_INTERNAL_AGENT_CALLER_SECRETS,
 * resolved via auth.ts's resolveCredential into credentialAgentId) -- never a
 * request-body field. There is nothing to "supply" in the body at all.
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
  placeholder,
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

const CCO_AGENT = "cco-agent-real-42";
const CCO_AGENT_SECRET = placeholder("cco-agent");

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("agent caller proof over HTTP", () => {
  it("CORRECTED 2026-09-18 (owner ruling) — with NO explicit RUNTIME_AGENT_CALLER_PROOF_* override at all, the CCO template is STILL refused for a caller holding only the shared bearer: the requirement is hardcoded (MANDATORY_AGENT_CALLER_PROOF_TEMPLATE_IDS), never something a missing config value can opt out of", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig(), // deliberately NO RUNTIME_AGENT_CALLER_PROOF_*/RUNTIME_INTERNAL_AGENT_CALLER_SECRETS override — the baseline shipped config
      logger: logger.logger,
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET, // the plain shared bearer only — no agent-bound proof
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-no-config-at-all",
        context: OVERDUE_FIXTURE,
      },
    });

    // This is the exact, intended, owner-ruled consequence: even Paperclip's
    // OWN existing dispatch (which presents no agent-bound secret today) is
    // refused until RUNTIME_INTERNAL_AGENT_CALLER_SECRETS is populated.
    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agent_caller_proof_required");
    expect(model.calls).toHaveLength(0);
    const lines = logger.withOutcome("agent_caller_proof_required");
    expect(lines).toHaveLength(1);
    expect(lines[0]!["reason"]).toBe("no_agent_bound_credential");
  });

  it("POSITIVE CONTROL: an honest agent-bound caller still succeeds — the mandatory gate refuses an UNPROVEN caller, not every caller", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("hello");
    server = await startServer({
      // Still NO explicit RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES override
      // — proving the CCO is gated by the hardcoded default, not by this test
      // opting it in itself. Only the secret map is supplied.
      config: envConfig({ RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({ [CCO_AGENT]: CCO_AGENT_SECRET }) }),
      logger: logger.logger,
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: CCO_AGENT_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: CCO_AGENT,
        runId: "run-mandatory-but-provable",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).not.toBe(403);
    expect(logger.withOutcome("agent_caller_proof_required")).toHaveLength(0);
  });

  it("refuses with 403 agent_caller_proof_required when the template is opted in and the caller holds only the shared INTERNAL bearer -- the shared bearer alone is not enough", async () => {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("should never be called");
    const agentOs = new RecordingAgentOsProvider({ status: "completed", content: "x", model: null, usage: null });
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({ [CCO_AGENT]: CCO_AGENT_SECRET }),
      }),
      logger: logger.logger,
      modelClient: model,
      agentOsProvider: agentOs,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET, // the plain shared bearer, not the agent-bound one
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: CCO_AGENT,
        runId: "run-shared-bearer-only",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agent_caller_proof_required");
    expect(agentOs.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(0);
    const lines = logger.withOutcome("agent_caller_proof_required");
    expect(lines).toHaveLength(1);
    expect(lines[0]!["reason"]).toBe("no_agent_bound_credential");
  });

  it("refuses agent_identity_mismatch when the caller's OWN agent-bound credential claims a DIFFERENT agentId than the one it actually proves", async () => {
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({ [CCO_AGENT]: CCO_AGENT_SECRET }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: CCO_AGENT_SECRET, // proves CCO_AGENT
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "some-other-claimed-agent", // CROSS-AGENT CLAIM
        runId: "run-cross-agent-claim",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(403);
    expect(res.json["outcome"]).toBe("agent_caller_proof_required");
    expect(model.calls).toHaveLength(0);
  });

  it("succeeds when the caller's own agent-bound credential proves exactly the agentId it claims", async () => {
    const model = StubModelClient.returning("the real answer");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({ [CCO_AGENT]: CCO_AGENT_SECRET }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: CCO_AGENT_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: CCO_AGENT,
        runId: "run-honest-agent-bound-caller",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).not.toBe(403);
  });

  it("a DIFFERENT agent's own real, valid credential is still refused when claiming CCO_AGENT -- proof is per-agent, not a second shared secret", async () => {
    const OTHER_AGENT = "other-internal-agent-7";
    const OTHER_AGENT_SECRET = placeholder("other-internal-agent");
    const model = StubModelClient.returning("should never be called");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({
          [CCO_AGENT]: CCO_AGENT_SECRET,
          [OTHER_AGENT]: OTHER_AGENT_SECRET,
        }),
      }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: OTHER_AGENT_SECRET, // OTHER_AGENT's own real, valid, working credential
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: CCO_AGENT, // claiming to be CCO_AGENT
        runId: "run-different-agents-real-credential",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(403);
    expect(model.calls).toHaveLength(0);
  });

  it("BOTH agents' own honest calls still work -- the refusal above is identity-specific, not a blanket failure", async () => {
    const OTHER_AGENT = "other-internal-agent-7";
    const OTHER_AGENT_SECRET = placeholder("other-internal-agent");
    const model = StubModelClient.returning("ok");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({
          [CCO_AGENT]: CCO_AGENT_SECRET,
          [OTHER_AGENT]: OTHER_AGENT_SECRET,
        }),
      }),
      modelClient: model,
    });

    const resCco = await invoke(server.url, {
      bearer: CCO_AGENT_SECRET,
      body: { templateId: INTERNAL_TEMPLATE, exposure: "INTERNAL", agentId: CCO_AGENT, runId: "run-cco-honest", context: OVERDUE_FIXTURE },
    });
    const resOther = await invoke(server.url, {
      bearer: OTHER_AGENT_SECRET,
      body: { templateId: INTERNAL_TEMPLATE, exposure: "INTERNAL", agentId: OTHER_AGENT, runId: "run-other-honest", context: OVERDUE_FIXTURE },
    });

    expect(resCco.status).not.toBe(403);
    expect(resOther.status).not.toBe(403);
  });

  it("an UNGATED template is completely unaffected even when the feature is opted in for a DIFFERENT template", async () => {
    const model = StubModelClient.returning("public answer");
    server = await startServer({
      config: envConfig({
        RUNTIME_AGENT_CALLER_PROOF_REQUIRED_TEMPLATES: INTERNAL_TEMPLATE,
        RUNTIME_INTERNAL_AGENT_CALLER_SECRETS: JSON.stringify({ [CCO_AGENT]: CCO_AGENT_SECRET }),
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
      },
    });

    expect(res.status).not.toBe(403);
  });
});
