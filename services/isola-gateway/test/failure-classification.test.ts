/**
 * Failure classification comes from the runtime's BODY, not from its status.
 *
 * The defect this closes: isola-runtime returns 502 for three different end
 * states — `provider_error`, `persistence_failed` and `invalid_output` — so
 * mapping status onto outcome reported a Paperclip write-back refusal as a
 * model-provider failure. Safety was never affected (both escalate) but it lied
 * to the operator about the cause, and cost a real diagnostic step live.
 */
import { describe, expect, it } from "vitest";

import {
  outcomeForCompletionState,
  outcomeForStatus,
  readCompletionState,
  HttpAgentRuntime,
} from "../src/runtime.js";
import { FAILURE_EXPLANATIONS } from "../src/pipeline.js";
import { createSafeFetch } from "../src/egress.js";
import {
  CapturingLogger,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
} from "./harness.js";

const REQUEST = {
  templateId: "t@v1",
  exposure: "PUBLIC" as const,
  agentId: "a-1",
  runId: "run-1",
  context: {},
};

function client(respond: () => Response): HttpAgentRuntime {
  return new HttpAgentRuntime({
    baseUrl: "http://isola_isola-runtime:3000",
    invokePath: "/v1/invoke",
    bearer: "bearer",
    safeFetch: createSafeFetch({
      allowlist: ["isola_isola-runtime"],
      transport: async () => respond(),
    }),
    timeoutMs: 1000,
  });
}

function body(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("completionState is preferred over the HTTP status", () => {
  it("reports persistence_failed as persistence_failed, NOT provider_error", async () => {
    // The exact live case: the model answered, Paperclip refused the
    // write-back, the runtime answered 502 with completionState.
    const runtime = client(() =>
      body(
        {
          ok: false,
          outcome: "provider_error",
          completionState: "persistence_failed",
          contractVersion: 1,
          answerText: null,
          recorded: false,
        },
        502,
      ),
    );
    const result = await runtime.invoke(REQUEST);

    expect(result.completionState).toBe("persistence_failed");
    expect(result.outcome).toBe("persistence_failed");
    expect(result.outcome).not.toBe("provider_error");
    // A failure body can never carry an answer.
    expect(result.text).toBeNull();
  });

  it("still reports a genuine provider_error as provider_error", async () => {
    const runtime = client(() =>
      body(
        { ok: false, outcome: "provider_error", completionState: "provider_error", contractVersion: 1 },
        502,
      ),
    );
    expect((await runtime.invoke(REQUEST)).outcome).toBe("provider_error");
  });

  it("still reports a genuine timeout as model_timeout", async () => {
    const runtime = client(() =>
      body({ ok: false, outcome: "model_timeout", completionState: "timeout", contractVersion: 1 }, 504),
    );
    const result = await runtime.invoke(REQUEST);
    expect(result.outcome).toBe("model_timeout");
    expect(result.completionState).toBe("timeout");
  });

  it("distinguishes invalid_output from both of them", async () => {
    const runtime = client(() =>
      body({ ok: false, outcome: "provider_error", completionState: "invalid_output" }, 502),
    );
    expect((await runtime.invoke(REQUEST)).outcome).toBe("invalid_output");
  });

  it("falls back to the status when the body carries no completion state", async () => {
    const runtime = client(() => body({ ok: false, outcome: "provider_error" }, 502));
    const result = await runtime.invoke(REQUEST);
    expect(result.outcome).toBe("provider_error");
    expect(result.completionState).toBeNull();
  });

  it("treats a 200 with a non-completed state as a failure, never as an answer", async () => {
    const runtime = client(() =>
      body(
        {
          ok: true,
          outcome: "ok",
          completionState: "duplicate_in_flight",
          answerText: "this belongs to the original run",
        },
        200,
      ),
    );
    const result = await runtime.invoke(REQUEST);
    expect(result.outcome).toBe("duplicate_in_flight");
    expect(result.text).toBeNull();
  });

  it("ignores an unrecognised completionState rather than trusting it", () => {
    expect(readCompletionState({ completionState: "made_up" })).toBeNull();
    expect(readCompletionState({ completionState: 7 })).toBeNull();
    expect(readCompletionState(null)).toBeNull();
  });

  it("maps every known state to a distinct, truthful outcome", () => {
    expect(outcomeForCompletionState("timeout")).toBe("model_timeout");
    expect(outcomeForCompletionState("provider_error")).toBe("provider_error");
    expect(outcomeForCompletionState("persistence_failed")).toBe("persistence_failed");
    expect(outcomeForCompletionState("invalid_output")).toBe("invalid_output");
    expect(outcomeForCompletionState("budget_exhausted")).toBe("budget_exhausted");
    // The three 502 states must not collide.
    const of502 = new Set([
      outcomeForCompletionState("provider_error"),
      outcomeForCompletionState("persistence_failed"),
      outcomeForCompletionState("invalid_output"),
    ]);
    expect(of502.size).toBe(3);
    expect(outcomeForStatus(502)).toBe("provider_error");
  });
});

describe("what the operator and the customer each see", () => {
  it("logs persistence_failed and explains it distinctly in the private note", async () => {
    const logger = new CapturingLogger();
    const server = await startServer({
      logger: logger.logger,
      runtime: StubAgentRuntime.failingWithState("persistence_failed", "persistence_failed"),
    });
    try {
      await postWebhook(server.url, signRequest({ deliveryId: "d-persist" }));
      await server.gateway.drain();

      const line = logger.withOutcome("persistence_failed")[0];
      expect(line).toBeDefined();
      expect(line?.["runtimeCompletionState"]).toBe("persistence_failed");

      // No invented reply on any failure path.
      expect(server.chatwoot.customerMessages).toHaveLength(0);

      const note = server.chatwoot.privateNotes[0]?.content ?? "";
      expect(note).toContain("persistence_failed");
      expect(note).toContain("Paperclip would not accept the write-back");
      expect(note).not.toContain("the model provider returned an error");
    } finally {
      await server.close();
    }
  });

  it("has a distinct explanation for every failure it can name", () => {
    expect(FAILURE_EXPLANATIONS["persistence_failed"]).not.toBe(
      FAILURE_EXPLANATIONS["provider_error"],
    );
    expect(FAILURE_EXPLANATIONS["invalid_output"]).not.toBe(
      FAILURE_EXPLANATIONS["provider_error"],
    );
    const wordings = Object.values(FAILURE_EXPLANATIONS);
    expect(new Set(wordings).size).toBe(wordings.length);
  });
});
