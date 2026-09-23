/**
 * ROLLING-DEPLOY STATE (b): the OLD runtime (PR base 93cf73f, extracted by
 * `git archive`) receiving the NEW gateway's request shape — a top-level,
 * signed `principal`. Run against the base code, not the PR code.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  CapturingLogger,
  INTERNAL_SECRET,
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
  delete process.env["HERMES_API_KEY"];
});

const signedPrincipal = (runId: string) => ({
  channel: "whatsapp",
  senderE164: "+17675550101",
  verifiedBy: "gateway-allowlist",
  bindingKey: "2/10",
  issuedAt: Math.floor(Date.now() / 1000),
  nonce: runId,
  contextSha256: "a".repeat(64),
  signature: "b".repeat(64),
});

async function boot() {
  process.env["HERMES_API_KEY"] = "not-a-real-staff-hermes-key";
  const model = StubModelClient.returning("default-brain answer");
  const brain: Array<{ url: string; body: Record<string, unknown> }> = [];
  const safeFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    brain.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return new Response(JSON.stringify({ choices: [{ message: { content: "staff-brain answer" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  server = await startServer({
    config: envConfig(),
    logger: new CapturingLogger().logger,
    modelClient: model,
    recorder: new RecordingRecorder(),
    safeFetch: safeFetch as never,
  });
  return { model, brain, url: server.url };
}

describe("OLD runtime + NEW gateway request shape", () => {
  it.each(["epic-staff-operations-coordinator@v1", "isola-internal-manager@v1"])(
    "%s: the extra top-level principal is ignored and the template answers as before",
    async (templateId) => {
      const answers: unknown[] = [];
      const bodies: Array<Record<string, unknown>> = [];
      for (const withPrincipal of [false, true]) {
        const { model, brain, url } = await boot();
        const runId = `run-${withPrincipal ? "p" : "n"}-${Math.random().toString(16).slice(2)}`;
        const res = await invoke(url, {
          bearer: INTERNAL_SECRET,
          body: {
            templateId,
            exposure: "INTERNAL",
            agentId: "agent-compat",
            runId,
            context: { hello: "world" },
            responseMode: "inline",
            ...(withPrincipal ? { principal: signedPrincipal(runId) } : {}),
          },
        });
        expect(res.status, res.text).toBe(200);
        answers.push(res.json["answerText"]);
        const call = model.calls[0] ?? brain[0]?.body;
        expect(call, "positive control: the brain was called").toBeTruthy();
        bodies.push(JSON.parse(JSON.stringify(call)) as Record<string, unknown>);
        await server?.close();
        server = null;
      }
      // Same answer, and the brain request is identical with or without the field.
      expect(answers[1]).toBe(answers[0]);
      expect(bodies[1]).toEqual(bodies[0]);
      expect(JSON.stringify(bodies[1])).not.toContain("17675550101");
    },
  );

  it("the owner template does not exist on the old runtime: 400 unknown_template (fails closed)", async () => {
    const { model, brain, url } = await boot();
    const res = await invoke(url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: "isola-owner-manager@v1",
        exposure: "INTERNAL",
        agentId: "agent-owner",
        runId: "run-owner",
        context: { hello: "world" },
        responseMode: "inline",
        principal: signedPrincipal("run-owner"),
      },
    });
    expect(res.status).toBe(400);
    expect(res.json["outcome"]).toBe("unknown_template");
    expect(model.calls.length + brain.length).toBe(0);
  });
});
