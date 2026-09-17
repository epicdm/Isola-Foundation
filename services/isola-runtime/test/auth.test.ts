import { afterEach, describe, expect, it } from "vitest";

import { constantTimeEquals, extractBearer, resolveCredential } from "../src/auth.js";
import {
  CapturingLogger,
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  PUBLIC_SECRET,
  StubModelClient,
  RecordingRecorder,
  envConfig,
  get,
  invoke,
  placeholder,
  startServer,
  type TestServer,
} from "./harness.js";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("constantTimeEquals", () => {
  it("is true only for identical strings", () => {
    expect(constantTimeEquals("abc", "abc")).toBe(true);
    expect(constantTimeEquals("abc", "abd")).toBe(false);
    // Different lengths must not throw — the hash makes both sides equal length.
    expect(constantTimeEquals("a", "aaaaaaaaaaaaaaaaaaaaaaaaaaaa")).toBe(false);
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

describe("extractBearer", () => {
  it("parses a well-formed header and rejects everything else", () => {
    expect(extractBearer("Bearer abc")).toBe("abc");
    expect(extractBearer("bearer abc")).toBe("abc");
    expect(extractBearer("Bearer   abc  ")).toBe("abc");
    expect(extractBearer("Basic abc")).toBeNull();
    expect(extractBearer("abc")).toBeNull();
    expect(extractBearer("Bearer ")).toBeNull();
    expect(extractBearer(undefined)).toBeNull();
  });
});

describe("resolveCredential", () => {
  it("maps each bearer to its own exposure class", () => {
    const config = envConfig();
    expect(resolveCredential(config, `Bearer ${INTERNAL_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "INTERNAL",
      credentialAgentId: null,
    });
    expect(resolveCredential(config, `Bearer ${PUBLIC_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "PUBLIC",
      credentialAgentId: null,
    });
  });

  it("refuses when both secrets are set to the same value", () => {
    const config = envConfig({ RUNTIME_SECRET_PUBLIC: INTERNAL_SECRET });
    expect(resolveCredential(config, `Bearer ${INTERNAL_SECRET}`)).toEqual({
      kind: "unauthorized",
    });
  });

  it("reports not_configured when neither secret is set", () => {
    const config = envConfig({
      RUNTIME_SECRET_INTERNAL: undefined,
      RUNTIME_SECRET_PUBLIC: undefined,
    });
    expect(resolveCredential(config, `Bearer ${INTERNAL_SECRET}`)).toEqual({
      kind: "not_configured",
    });
  });
});

describe("resolveCredential -- agent-bound credentials (the caller-to-agent binding)", () => {
  const AGENT_A = "eeeeeeee-1111-4111-8111-111111111111";
  const AGENT_B = "eeeeeeee-2222-4222-8222-222222222222";
  const AGENT_A_SECRET = placeholder("agent-a");
  const AGENT_B_SECRET = placeholder("agent-b");

  it("a caller presenting an agent-bound secret is resolved to that specific agent, at PUBLIC exposure", () => {
    const config = envConfig({
      PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({ [AGENT_A]: AGENT_A_SECRET, [AGENT_B]: AGENT_B_SECRET }),
    });
    expect(resolveCredential(config, `Bearer ${AGENT_A_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "PUBLIC",
      credentialAgentId: AGENT_A,
    });
    expect(resolveCredential(config, `Bearer ${AGENT_B_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "PUBLIC",
      credentialAgentId: AGENT_B,
    });
  });

  it("THE EXACT IMPERSONATION QUESTION -- the plain shared PUBLIC secret proves no specific agent, even when agent-bound secrets are configured", () => {
    // This is the confirmed gap PAPERCLIP_BUSINESS_FACTS_MAP alone could not close:
    // a caller holding only the shared class secret must never be treated as
    // representing any particular agent, no matter what a request body claims.
    const config = envConfig({
      PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({ [AGENT_A]: AGENT_A_SECRET, [AGENT_B]: AGENT_B_SECRET }),
    });
    expect(resolveCredential(config, `Bearer ${PUBLIC_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "PUBLIC",
      credentialAgentId: null,
    });
  });

  it("an agent-bound secret colliding with the shared PUBLIC secret is refused entirely, not silently resolved to one identity", () => {
    const config = envConfig({
      PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({ [AGENT_A]: PUBLIC_SECRET }),
    });
    expect(resolveCredential(config, `Bearer ${PUBLIC_SECRET}`)).toEqual({ kind: "unauthorized" });
  });

  it("two agents sharing the same secret by misconfiguration are refused, never resolved to either", () => {
    const config = envConfig({
      PAPERCLIP_AGENT_CALLER_SECRETS: JSON.stringify({ [AGENT_A]: AGENT_A_SECRET, [AGENT_B]: AGENT_A_SECRET }),
    });
    expect(resolveCredential(config, `Bearer ${AGENT_A_SECRET}`)).toEqual({ kind: "unauthorized" });
  });

  it("no agent-bound secrets configured at all -- behaviour is exactly what it was before this mechanism existed", () => {
    const config = envConfig();
    expect(resolveCredential(config, `Bearer ${PUBLIC_SECRET}`)).toEqual({
      kind: "ok",
      credentialExposure: "PUBLIC",
      credentialAgentId: null,
    });
  });
});

describe("POST /v1/invoke auth", () => {
  async function boot(envOverrides = {}) {
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("stub answer");
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig(envOverrides),
      logger: logger.logger,
      modelClient: model,
      recorder,
    });
    return { logger, model, recorder };
  }

  it("rejects a missing Authorization header with 401", async () => {
    const { model } = await boot();
    const res = await invoke(server!.url, {
      bearer: null,
      body: { templateId: INTERNAL_TEMPLATE, agentId: "a", runId: "r", context: {} },
    });
    expect(res.status).toBe(401);
    expect(res.json["outcome"]).toBe("unauthorized");
    expect(model.calls).toHaveLength(0);
  });

  it("rejects a wrong bearer with 401 and never reaches the model", async () => {
    const { model, recorder } = await boot();
    const res = await invoke(server!.url, {
      bearer: "totally-wrong-value",
      body: { templateId: INTERNAL_TEMPLATE, agentId: "a", runId: "r", context: {} },
    });
    expect(res.status).toBe(401);
    expect(model.calls).toHaveLength(0);
    expect(recorder.outcomes).toHaveLength(0);
  });

  it("always returns a correlation id in body and header", async () => {
    await boot();
    const res = await invoke(server!.url, { bearer: null, body: {} });
    expect(res.json["correlationId"]).toEqual(expect.any(String));
    expect(res.correlationHeader).toBe(res.json["correlationId"]);
  });

  it("returns 503 when neither exposure credential is configured", async () => {
    await boot({ RUNTIME_SECRET_INTERNAL: undefined, RUNTIME_SECRET_PUBLIC: undefined });
    const res = await invoke(server!.url, {
      bearer: INTERNAL_SECRET,
      body: { templateId: INTERNAL_TEMPLATE, exposure: "INTERNAL", context: {} },
    });
    expect(res.status).toBe(503);
    expect(res.json["outcome"]).toBe("no_credential_configured");
  });

  it("gates GET /v1/templates behind a credential and never leaks a prompt", async () => {
    await boot();
    const denied = await get(server!.url, "/v1/templates");
    expect(denied.status).toBe(401);

    const allowed = await get(server!.url, "/v1/templates", INTERNAL_SECRET);
    expect(allowed.status).toBe(200);
    const templates = allowed.json["templates"] as Array<Record<string, unknown>>;
    expect(templates).toHaveLength(3);
    for (const t of templates) {
      expect(Object.keys(t)).not.toContain("systemPrompt");
      expect(t["id"]).toEqual(expect.any(String));
      expect(t["version"]).toEqual(expect.any(String));
      expect(t["exposure"]).toEqual(expect.any(String));
      expect(t["model"]).toEqual(expect.any(String));
      expect(t["timeoutMs"]).toEqual(expect.any(Number));
      expect(t["toolPolicy"]).toBeTypeOf("object");
    }
    expect(allowed.text).not.toContain("You are the EPIC Staff Operations Coordinator");
  });

  it("serves /healthz without auth and without secrets", async () => {
    await boot();
    const res = await get(server!.url, "/healthz");
    expect(res.status).toBe(200);
    expect(res.json["status"]).toBe("ok");
    expect(res.json["version"]).toEqual(expect.any(String));
    expect(res.json["templates"]).toHaveLength(3);
    expect(res.json["egressAllowlist"]).toEqual([
      "api.deepseek.com",
      "paperclip.example.test",
      // Contributed by the internal-manager template's declared brain.
      "hermes-tunnel",
    ]);
    expect(res.text).not.toContain(INTERNAL_SECRET);
    expect(res.text).not.toContain(PUBLIC_SECRET);
  });
});
