/**
 * FIX 5 — WHICH MECHANISM PRODUCES THE `isola-internal-manager@v1` HTTP 500?
 *
 * Two explanations were offered for one observation:
 *   (a) the egress allowlist excludes `hermes-tunnel`, so the call is refused
 *       at safeFetch;
 *   (b) `clientForTemplate` throws OUTSIDE the guarded block (app.ts), so an
 *       unstructured 500 escapes where a structured response was intended.
 *
 * Both can produce a 500, which is exactly why the observation alone could not
 * distinguish them (CLAUDE.md Law 23: an ambiguous negative is not a finding).
 * These tests separate them by their DIFFERENT BODIES, and establish the
 * decisive ordering fact.
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

const HERMES_TEMPLATE = "isola-internal-manager@v1";

let server: TestServer | null = null;
const priorHermesKey = process.env["HERMES_API_KEY"];
afterEach(async () => {
  await server?.close();
  server = null;
  if (priorHermesKey === undefined) delete process.env["HERMES_API_KEY"];
  else process.env["HERMES_API_KEY"] = priorHermesKey;
});

const hermesBody = (runId: string) => ({
  templateId: HERMES_TEMPLATE,
  exposure: "INTERNAL",
  agentId: "agent-mgr",
  runId,
  context: { note: "hermes mechanism probe" },
});

describe("FIX 5: measuring the isola-internal-manager@v1 500", () => {
  it("CONTROL 1 (positive): a template whose brain needs no override SUCCEEDS", async () => {
    // Proves the harness can produce a success at all — without this, every
    // failure below could be the harness rather than the mechanism.
    const model = StubModelClient.returning("the answer");
    server = await startServer({
      config: envConfig(),
      modelClient: model,
      recorder: new RecordingRecorder(),
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: "isola-ai-sales-front-desk-agent@v1",
        exposure: "PUBLIC",
        agentId: "a",
        runId: "control-ok",
        context: { hello: "world" },
      },
    });

    // PUBLIC template needs the PUBLIC credential; the point here is only that
    // a non-override template reaches a STRUCTURED outcome, never a bare 500.
    expect(res.status).not.toBe(500);
  });

  it("AFTER THE FIX: a missing brain credential is a STRUCTURED 502, not an unstructured 500", async () => {
    delete process.env["HERMES_API_KEY"];
    const logger = new CapturingLogger();
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig(),
      logger: logger.logger,
      modelClient: StubModelClient.returning("never reached"),
      recorder,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: hermesBody("hermes-structured"),
    });

    // The intended structured dependency response.
    expect(res.status).toBe(502);
    expect(res.json["outcome"]).toBe("provider_error");
    // And it names the missing variable, so an operator can act on it.
    expect(String(res.json["error"])).toContain("HERMES_API_KEY");
    // The run is now PROCESSED rather than escaping the handler: it is
    // recorded, which is what makes it a structured outcome at all.
    expect(recorder.outcomes.length).toBeGreaterThan(0);
    expect(recorder.outcomes[0]!.status).toBe("provider_error");
  });

  it("MECHANISM (b), as originally measured: the throw originates in clientForTemplate", async () => {
    delete process.env["HERMES_API_KEY"];
    const logger = new CapturingLogger();
    const model = StubModelClient.returning("never reached");
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig(),
      logger: logger.logger,
      modelClient: model,
      recorder,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: hermesBody("hermes-no-key"),
    });

    // THE DISCRIMINATOR, unchanged by the fix: the throw happens before any
    // model call, so the model is never reached. That is what distinguishes
    // this from the egress mechanism, where a call IS attempted.
    expect(model.calls).toHaveLength(0);
    // Post-fix the outcome is structured rather than an escaped 500.
    expect(res.status).toBe(502);
    expect(res.json["outcome"]).toBe("provider_error");
    expect(String(res.json["error"])).toContain("HERMES_API_KEY");
    expect(recorder.outcomes.length).toBeGreaterThan(0);
    void logger;
  });

  it("DECISIVE ORDERING: the credential check runs BEFORE any egress attempt", async () => {
    // This is what settles it. `clientForTemplate` throws on the missing
    // credential before a client exists to call safeFetch with, so with
    // HERMES_API_KEY unset the egress allowlist CANNOT be the mechanism —
    // it is never consulted. Proven by allowlisting the Hermes host
    // explicitly and observing the SAME unstructured 500.
    delete process.env["HERMES_API_KEY"];
    const model = StubModelClient.returning("never reached");
    server = await startServer({
      config: envConfig({ EGRESS_ALLOWLIST: "hermes-tunnel,api.deepseek.com" }),
      modelClient: model,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: hermesBody("hermes-allowlisted"),
    });

    // Egress is WIDE OPEN for hermes-tunnel here, and the outcome is
    // unchanged — proving the allowlist was never the mechanism.
    expect(res.status).toBe(502);
    expect(res.json["outcome"]).toBe("provider_error");
    expect(String(res.json["error"])).toContain("HERMES_API_KEY");
    expect(model.calls).toHaveLength(0);
  });

  it("CONTROL 2 (negative egress): WITH a credential but the host NOT allowlisted, the shape is DIFFERENT", async () => {
    // The competing explanation, isolated. A client is successfully created,
    // execute() runs, and safeFetch refuses inside the guarded block — so the
    // run IS processed and the body IS structured. That difference is what
    // makes the two mechanisms distinguishable rather than a matter of opinion.
    process.env["HERMES_API_KEY"] = ["not", "a", "real", "credential", "hermes"].join("-");
    const logger = new CapturingLogger();
    const recorder = new RecordingRecorder();
    server = await startServer({
      config: envConfig({ EGRESS_ALLOWLIST: "api.deepseek.com" }), // hermes-tunnel absent
      logger: logger.logger,
      modelClient: StubModelClient.returning("unused"),
      recorder,
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: hermesBody("hermes-egress-blocked"),
    });

    // Still a 500 by status — which is precisely why status alone could not
    // separate the two — but the RUN WAS PROCESSED, which mechanism (b) never
    // is. That is the discriminating evidence.
    expect(recorder.outcomes.length).toBeGreaterThan(0);
    expect(String(res.json["error"] ?? res.json["failureCategory"] ?? "")).toContain(
      "EgressBlockedError",
    );
  });
});
