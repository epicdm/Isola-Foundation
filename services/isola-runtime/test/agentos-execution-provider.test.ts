/**
 * `AgentOsExecutionProvider` — the only code in this service that talks to
 * the private Python sidecar. All network access is through a stub
 * `SafeFetch` transport; no test here opens a real socket.
 *
 * Test category mapping:
 *   6. Timeout (sidecar unreachable/slow -> ExecutionResult "failed", never a hang)
 *   7. Dependency unavailable (sidecar's own model backend down -> clear failure)
 *   8. Failed AgentOS run (non-"completed" terminal status -> failure)
 *   9. Malformed/ambiguous response (invalid JSON, missing fields -> failure, never guessed)
 *  11. Correlation propagation (correlationId sent in the envelope)
 *  13. No business-system writes (envelope carries exactly 5 fields)
 */
import { describe, expect, it } from "vitest";

import { createAgentOsExecutionProvider } from "../src/agentos-execution-provider.js";
import { renderContext } from "../src/context.js";
import { createSafeFetch } from "../src/egress.js";
import { findTemplate } from "../src/registry.js";

// Built at runtime, not written as a string literal, so no scanner ever has
// to decide whether it is real — same convention as test/harness.ts's
// `placeholder()`.
const FAKE_SHARED_SECRET = ["not", "a", "real", "credential", "agentos"].join("-") + "-" + "0".repeat(16);

const TEMPLATE = findTemplate("epic-staff-operations-coordinator@v1")!;
const BASE_URL = "https://agentos-sidecar.internal.example.test";
const ALLOWED = ["agentos-sidecar.internal.example.test"];

function baseRequest(overrides: Record<string, unknown> = {}) {
  return {
    template: TEMPLATE,
    tenantId: "8D3dp3z",
    exposure: "INTERNAL" as const,
    model: "deepseek-chat",
    systemPrompt: TEMPLATE.systemPrompt,
    renderedContext: renderContext({ fixture: "overdue-invoices" }, TEMPLATE.maxContextBytes),
    correlationId: "corr-agentos-1",
    timeoutMs: 2000,
    ...overrides,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createAgentOsExecutionProvider", () => {
  it("sends EXACTLY the six-field envelope — correlationId, tenantId, templateId, exposure, systemPrompt, context", async () => {
    let sentUrl = "";
    let sentBody: Record<string, unknown> = {};
    let sentAuth = "";
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async (input, init) => {
        sentUrl = String(input);
        sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        sentAuth = String((init?.headers as Record<string, string>)?.["authorization"]);
        return jsonResponse(200, { status: "completed", content: "ok" });
      },
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: FAKE_SHARED_SECRET,
      safeFetch,
      timeoutMs: 5000,
    });

    await provider.execute(baseRequest());

    expect(sentUrl).toBe(`${BASE_URL}/v1/agent-run`);
    expect(sentAuth).toBe(`Bearer ${FAKE_SHARED_SECRET}`);
    expect(Object.keys(sentBody).sort()).toEqual(
      ["context", "correlationId", "exposure", "systemPrompt", "templateId", "tenantId"].sort(),
    );
    // FIX 4: the SERVER-AUTHORITATIVE instruction is carried, and carried
    // SEPARATELY from the caller-supplied context.
    expect(sentBody["systemPrompt"]).toBe(TEMPLATE.systemPrompt);
    expect(String(sentBody["context"])).not.toContain(TEMPLATE.systemPrompt);
    expect(sentBody["correlationId"]).toBe("corr-agentos-1");
    expect(sentBody["tenantId"]).toBe("8D3dp3z");
    expect(sentBody["templateId"]).toBe("epic-staff-operations-coordinator@v1");
    expect(sentBody["exposure"]).toBe("INTERNAL");
    expect(typeof sentBody["context"]).toBe("string");
    // No Odoo/Chatwoot/host-credential-shaped field ever leaves this provider.
    for (const forbidden of ["odooApiKey", "chatwootToken", "dbUrl", "sshKey", "hostCredential"]) {
      expect(sentBody[forbidden]).toBeUndefined();
    }
  });

  it("maps an exact 'completed' body to status:completed with usage parsed", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () =>
        jsonResponse(200, {
          status: "completed",
          content: "the table",
          model: "deepseek-chat",
          usage: { promptTokens: 100, completionTokens: 40, cachedPromptTokens: 10 },
        }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());

    expect(result).toEqual({
      status: "completed",
      content: "the table",
      model: "deepseek-chat",
      usage: { promptTokens: 100, completionTokens: 40, cachedPromptTokens: 10 },
    });
  });

  it("times out cleanly — never hangs, never retries, maps to failed/timeout/504", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 50,
    });

    const result = await provider.execute(baseRequest({ timeoutMs: 50 }));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.category).toBe("timeout");
      expect(result.httpStatus).toBe(504);
      expect(result.reason).toContain("agentos_timeout_after_50ms");
    }
  });

  it("FIX 3A: the configured AGENTOS_TIMEOUT_MS wins when it is the tighter one", async () => {
    // `options.timeoutMs` was never read, so AGENTOS_TIMEOUT_MS was
    // configuration with no effect. Here the per-run deadline is generous and
    // the configured ceiling is tight — the tight one must fire.
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: FAKE_SHARED_SECRET,
      safeFetch,
      timeoutMs: 40, // the configured ceiling
    });

    const started = Date.now();
    const result = await provider.execute(baseRequest({ timeoutMs: 30_000 }));
    const elapsed = Date.now() - started;

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.category).toBe("timeout");
      // Names the deadline that actually applied, not the per-run one.
      expect(result.reason).toContain("agentos_timeout_after_40ms");
    }
    // And it really fired at the tight bound rather than waiting for 30s.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("FIX 3A: the per-run deadline still wins when IT is the tighter one", async () => {
    // POSITIVE CONTROL for the test above — otherwise "tighter wins" could be
    // satisfied by always using the configured value.
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: FAKE_SHARED_SECRET,
      safeFetch,
      timeoutMs: 30_000,
    });

    const result = await provider.execute(baseRequest({ timeoutMs: 40 }));

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agentos_timeout_after_40ms");
    }
  });

  it("FIX 3B: a sidecar that sends headers then STALLS mid-body still times out", async () => {
    // The abort timer used to be cleared in a `finally` that ran as soon as
    // the headers arrived, so this case hung past the deadline while holding a
    // budget reservation. The body below never completes.
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async (_input, init) => {
        // Models REAL fetch semantics: the response body stream is tied to the
        // abort signal, so aborting rejects an in-flight body read. Without
        // that link the stub would hang forever regardless of the fix, and the
        // test would be measuring the stub rather than the code.
        const signal = init?.signal;
        const stallingBody = new ReadableStream({
          start(controller) {
            signal?.addEventListener("abort", () => {
              controller.error(new Error("aborted"));
            });
            // Headers are already "sent"; the body never completes.
          },
        });
        return new Response(stallingBody, {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: FAKE_SHARED_SECRET,
      safeFetch,
      timeoutMs: 60,
    });

    const started = Date.now();
    const result = await provider.execute(baseRequest({ timeoutMs: 60 }));
    const elapsed = Date.now() - started;

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.category).toBe("timeout");
      expect(result.reason).toContain("agentos_timeout_after_60ms");
      expect(result.httpStatus).toBe(504);
    }
    // It must actually have returned promptly, not hung.
    expect(elapsed).toBeLessThan(5_000);
  });

  it("treats a non-200 (dependency unavailable) as a clear failure, never fabricating an answer", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => new Response("service unavailable", { status: 503 }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.category).toBe("provider_error");
      expect(result.httpStatus).toBe(502);
      expect(result.reason).toContain("agentos_sidecar_returned_HTTP_503");
    }
  });

  it("treats the sidecar's own 401/403 (its allowlist or auth refused us) as a dependency failure, not a retry trigger", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => new Response("forbidden", { status: 403 }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agentos_sidecar_refused_auth_or_allowlist");
    }
  });

  it("treats invalid JSON as malformed/failed, never guessing a completion", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () =>
        new Response("not json at all {{{", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.invalidOutput).toBe(true);
      expect(result.reason).toContain("agentos_non_json_body");
    }
  });

  it("treats a body missing 'status' as failed — ambiguous is never success", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => jsonResponse(200, { content: "looks fine but has no status" }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agentos_non_terminal_status");
    }
  });

  it("treats an explicit non-completed terminal status (e.g. 'error') as failed", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () =>
        jsonResponse(200, { status: "error", reason: "dependency_unavailable" }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agentos_non_terminal_status (error)");
    }
  });

  it("treats an in-progress-sounding status as failed, not as a success to poll later", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => jsonResponse(200, { status: "running" }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
  });

  it("treats status:completed with an empty/missing content as malformed, not an empty success", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => jsonResponse(200, { status: "completed" }),
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest());
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("agentos_malformed_completed_body");
    }
  });

  it("fails closed rather than call the sidecar when tenantId is null (defence in depth)", async () => {
    let called = false;
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => {
        called = true;
        return jsonResponse(200, { status: "completed", content: "should never happen" });
      },
    });
    const provider = createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: "s",
      safeFetch,
      timeoutMs: 5000,
    });

    const result = await provider.execute(baseRequest({ tenantId: null }));
    expect(result.status).toBe("failed");
    expect(called).toBe(false);
  });
});
