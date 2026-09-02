/**
 * NODE TRANSMITS ITS DEADLINE TO THE SIDECAR — the Node half of
 * def-agentos-sidecar-ignores-caller-deadline-2026-08-27.
 *
 * The sidecar used to enforce only its OWN configured deadline, because the
 * envelope had no field to carry Node's. When Node's was the tighter one, Node
 * gave up while the sidecar kept executing and kept spending provider tokens
 * for a caller that was already gone. Node must therefore state its deadline
 * in the envelope — and state it in a form the sidecar can trust.
 *
 * Three properties are pinned here, and each of them is a way this could go
 * wrong rather than a restatement of the code:
 *
 *   1. SERVER-DERIVED. The value is `Math.min(request.timeoutMs,
 *      options.timeoutMs)` — the same deadline this provider already enforces
 *      locally, computed from the template's declared timeout, the operator's
 *      RUNTIME_MODEL_TIMEOUT_MS, and the operator's AGENTOS_TIMEOUT_MS. It is
 *      never read from the caller's request body. A browser-side caller that
 *      could name its own deadline could widen the effective policy ceiling of
 *      a process it is not allowed to configure.
 *   2. REMAINING MILLISECONDS, NOT AN ABSOLUTE TIMESTAMP. The two containers
 *      have no guaranteed clock sync; an epoch would silently misbehave under
 *      skew — arriving already expired, or arriving with hours of budget —
 *      and it would do so quietly, which is the dangerous kind (Law 12).
 *   3. AN INTEGER. It crosses a JSON boundary into a pydantic contract that
 *      rejects malformed values; sending a float or a NaN would be sending the
 *      sidecar a problem instead of a deadline.
 */
import { afterEach, describe, expect, it } from "vitest";

import { createAgentOsExecutionProvider } from "../src/agentos-execution-provider.js";
import { renderContext } from "../src/context.js";
import { createSafeFetch } from "../src/egress.js";
import { findTemplate } from "../src/registry.js";
import {
  INTERNAL_SECRET,
  INTERNAL_TEMPLATE,
  OVERDUE_FIXTURE,
  StubModelClient,
  envConfig,
  invoke,
  startServer,
  type TestServer,
} from "./harness.js";

const FAKE_SHARED_SECRET =
  ["not", "a", "real", "credential", "agentos"].join("-") + "-" + "0".repeat(16);

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
    correlationId: "corr-agentos-deadline",
    timeoutMs: 2000,
    ...overrides,
  };
}

/** Captures the envelope the provider actually put on the wire. */
function capturingProvider(optionsTimeoutMs: number) {
  const seen: { body: Record<string, unknown> } = { body: {} };
  const safeFetch = createSafeFetch({
    allowlist: ALLOWED,
    transport: async (_input, init) => {
      seen.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ status: "completed", content: "ok" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return {
    seen,
    provider: createAgentOsExecutionProvider({
      baseUrl: BASE_URL,
      sharedSecret: FAKE_SHARED_SECRET,
      safeFetch,
      timeoutMs: optionsTimeoutMs,
    }),
  };
}

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe("the deadline Node transmits to the sidecar", () => {
  it("is present in the envelope, as a positive integer number of REMAINING milliseconds", async () => {
    const { seen, provider } = capturingProvider(5000);
    await provider.execute(baseRequest({ timeoutMs: 2000 }));

    const deadline = seen.body["deadlineMs"];
    expect(typeof deadline).toBe("number");
    expect(Number.isInteger(deadline)).toBe(true);
    expect(deadline as number).toBeGreaterThan(0);
    expect(deadline).toBe(2000);
  });

  it("is NOT an absolute timestamp — the two containers have no guaranteed clock sync", async () => {
    const { seen, provider } = capturingProvider(5000);
    await provider.execute(baseRequest({ timeoutMs: 2000 }));

    const deadline = seen.body["deadlineMs"] as number;
    // An epoch-milliseconds value is ~1.7e12. A remaining-duration value is
    // bounded by the deadline itself. The gap between the two is enormous, so
    // this assertion cannot be satisfied by an accident of arithmetic.
    expect(deadline).toBeLessThan(Date.now() / 1000);
    expect(deadline).toBeLessThanOrEqual(2000);
  });

  it("carries the TIGHTER of the two deadlines when the operator ceiling is tighter", async () => {
    const { seen, provider } = capturingProvider(40);
    await provider.execute(baseRequest({ timeoutMs: 30_000 }));
    expect(seen.body["deadlineMs"]).toBe(40);
  });

  it("POSITIVE CONTROL: carries the per-run deadline when IT is the tighter one", async () => {
    // Without this twin, "the tighter wins" would be satisfied equally by a
    // provider that always transmitted the configured ceiling.
    const { seen, provider } = capturingProvider(30_000);
    await provider.execute(baseRequest({ timeoutMs: 40 }));
    expect(seen.body["deadlineMs"]).toBe(40);
  });

  it("transmits EXACTLY the deadline it enforces locally — one number, not two", async () => {
    /**
     * If the transmitted value and the locally-enforced value could drift
     * apart, the sidecar would be told one budget while Node abandoned the
     * call at another — the same "two readers of one setting disagree" shape
     * as the hardcoded container port. The timeout reason names the enforced
     * deadline, so this compares the two directly.
     */
    let sentDeadline: unknown = null;
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          sentDeadline = (JSON.parse(String(init?.body)) as Record<string, unknown>)["deadlineMs"];
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
      timeoutMs: 45,
    });

    const result = await provider.execute(baseRequest({ timeoutMs: 30_000 }));

    expect(sentDeadline).toBe(45);
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain(`agentos_timeout_after_${sentDeadline}ms`);
    }
  });

  it("cannot be poisoned by a non-finite AGENTOS_TIMEOUT_MS", async () => {
    // `Math.min(2000, NaN)` is NaN, and a NaN deadline is one the sidecar's
    // own finiteness guard would have to refuse — so this must never be
    // reachable from configuration. config.ts's `int()` already guards it;
    // this pins that the transmitted value inherits that guarantee.
    for (const raw of ["nan", "NaN", "Infinity", "not-a-number"]) {
      const cfg = envConfig({ AGENTOS_TIMEOUT_MS: raw });
      const { seen, provider } = capturingProvider(cfg.agentOsTimeoutMs);
      await provider.execute(baseRequest({ timeoutMs: 2000 }));
      expect(Number.isFinite(seen.body["deadlineMs"])).toBe(true);
      expect(seen.body["deadlineMs"] as number).toBeGreaterThan(0);
    }

    // POSITIVE CONTROL — a real value is still read and applied, so the loop
    // above is not passing against a parser that ignores the variable.
    const cfg = envConfig({ AGENTOS_TIMEOUT_MS: "150" });
    const { seen, provider } = capturingProvider(cfg.agentOsTimeoutMs);
    await provider.execute(baseRequest({ timeoutMs: 2000 }));
    expect(seen.body["deadlineMs"]).toBe(150);
  });

  it("is SERVER-DERIVED end to end: a hostile request body cannot widen it", async () => {
    /**
     * Test the PATH, not the pieces (Law 20). This goes through the real
     * POST /v1/invoke handler with a caller-controlled body that tries every
     * plausible spelling of "give me more time", both at the top level and
     * inside the free-form context object. The operator has configured
     * RUNTIME_MODEL_TIMEOUT_MS=1234, which is the tightest of the three, so
     * 1234 is the only correct answer no matter what the body says.
     */
    const capture: { deadlineMs: unknown } = { deadlineMs: null };
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async (_input, init) => {
        capture.deadlineMs = (JSON.parse(String(init?.body)) as Record<string, unknown>)[
          "deadlineMs"
        ];
        return new Response(JSON.stringify({ status: "completed", content: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    server = await startServer({
      config: envConfig({
        RUNTIME_MODEL_TIMEOUT_MS: "1234",
        AGENTOS_TIMEOUT_MS: "60000",
      }),
      modelClient: StubModelClient.returning("unused"),
      agentOsProvider: createAgentOsExecutionProvider({
        baseUrl: BASE_URL,
        sharedSecret: FAKE_SHARED_SECRET,
        safeFetch,
        timeoutMs: envConfig({ AGENTOS_TIMEOUT_MS: "60000" }).agentOsTimeoutMs,
      }),
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-hostile-deadline",
        // Every hostile spelling, top level...
        deadlineMs: 999_999_999,
        timeoutMs: 999_999_999,
        // ...and inside the free-form context the caller fully controls.
        context: { ...OVERDUE_FIXTURE, deadlineMs: 999_999_999, timeoutMs: 999_999_999 },
      },
    });

    expect(res.status).toBe(200);
    expect(capture.deadlineMs).toBe(1234);
  });

  it("POSITIVE CONTROL for the hostile-body test: the operator CAN change it", async () => {
    // Otherwise "the body cannot widen it" would pass equally against a
    // provider that hardcoded a constant and read no configuration at all.
    const capture: { deadlineMs: unknown } = { deadlineMs: null };
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async (_input, init) => {
        capture.deadlineMs = (JSON.parse(String(init?.body)) as Record<string, unknown>)[
          "deadlineMs"
        ];
        return new Response(JSON.stringify({ status: "completed", content: "ok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    server = await startServer({
      config: envConfig({ RUNTIME_MODEL_TIMEOUT_MS: "4321", AGENTOS_TIMEOUT_MS: "60000" }),
      modelClient: StubModelClient.returning("unused"),
      agentOsProvider: createAgentOsExecutionProvider({
        baseUrl: BASE_URL,
        sharedSecret: FAKE_SHARED_SECRET,
        safeFetch,
        timeoutMs: envConfig({ AGENTOS_TIMEOUT_MS: "60000" }).agentOsTimeoutMs,
      }),
    });

    const res = await invoke(server.url, {
      bearer: INTERNAL_SECRET,
      body: {
        templateId: INTERNAL_TEMPLATE,
        exposure: "INTERNAL",
        agentId: "agent-7",
        runId: "run-operator-deadline",
        context: OVERDUE_FIXTURE,
      },
    });

    expect(res.status).toBe(200);
    expect(capture.deadlineMs).toBe(4321);
  });
});
