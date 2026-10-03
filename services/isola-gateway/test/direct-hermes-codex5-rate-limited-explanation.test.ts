/**
 * CODEX (short re-review of bd5b8f5), non-blocking diagnostic defect: `hermes_rate_limited` can be emitted
 * BEFORE any retry (when the backoff does not fit inside the deadline), but its operator-facing
 * explanation claimed "still at it after one retry". An explanation that is only sometimes true sends an
 * operator looking for a retry that never happened.
 *
 * Two real paths produce the outcome, and BOTH are exercised below so the explanation is checked against
 * what actually happened, not against itself (Laws 11, 20). SOCKET-FREE.
 */
import { describe, expect, it } from "vitest";

import { HermesDirectRuntime, HERMES_OUTCOMES } from "../src/hermes-runtime.js";
import { explainFailure } from "../src/pipeline.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { FakeHermes } from "./hermes-fake.js";

function request(n: number): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "agent-1",
    runId: `delivery-rl-${n}`,
    idempotencyKey: `isolagw:tenant-acme|b1|1|7|delivery:rl-${n}|answer`,
    historyMessageIds: [9500 + n],
    context: {
      source: "chatwoot",
      tenantId: "tenant-acme",
      companyId: "company-1",
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 700 + n, conversationStatus: "pending", messageId: 9500 + n, customAttributes: {} },
      history: [{ role: "customer", content: "hello" }],
      historyTruncated: false,
      message: { role: "customer", content: "hello" },
    },
    claimDispatch: async () => true,
  };
}

function runtimeFor(fake: FakeHermes, over: { runDeadlineMs: number; rateLimitBackoffMs: number }): HermesDirectRuntime {
  return new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: fake.fetch,
    runDeadlineMs: over.runDeadlineMs,
    pollIntervalMs: 10,
    requestTimeoutMs: 400,
    maxInflight: 4,
    rateLimitBackoffMs: over.rateLimitBackoffMs,
    streamDrainGraceMs: 100,
    requireDurableDispatch: true,
  });
}

describe("hermes_rate_limited: the explanation is true for every path that produces the outcome", () => {
  it("PATH 1: a 429 and a backoff that does NOT fit inside the deadline -> the outcome is emitted with NO retry (one create attempt)", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [429, 429];
    const rt = runtimeFor(fake, { runDeadlineMs: 300, rateLimitBackoffMs: 5000 });
    const r = await rt.invoke(request(1));
    expect(r.outcome).toBe(HERMES_OUTCOMES.rateLimited);
    expect(fake.creates, "this path makes exactly one attempt: no retry happened").toHaveLength(1);
  });

  it("PATH 2: a 429 twice with a backoff that fits -> the outcome is emitted AFTER one retry (two create attempts)", async () => {
    const fake = new FakeHermes();
    fake.createPlan = [429, 429];
    const rt = runtimeFor(fake, { runDeadlineMs: 1500, rateLimitBackoffMs: 20 });
    const r = await rt.invoke(request(2));
    expect(r.outcome).toBe(HERMES_OUTCOMES.rateLimited);
    expect(fake.creates).toHaveLength(2);
  });

  it("the explanation does NOT claim a retry happened in every case, and still names the concurrency limit and the missing retry possibility", () => {
    const text = explainFailure(HERMES_OUTCOMES.rateLimited);
    expect(text).toMatch(/concurrency limit/i);
    expect(text, "claims a retry unconditionally").not.toMatch(/still at it after one retry/i);
    expect(text, "does not say that the retry may not have happened").toMatch(/backoff|did not fit|no retry|not retried|may not/i);
    expect(text).toMatch(/nothing was sent/i);
  });

  it("CONTROL: the other outcomes keep their explanations (the map entry changed alone)", () => {
    expect(explainFailure(HERMES_OUTCOMES.busy)).toMatch(/slot|deadline/i);
    expect(explainFailure("an_outcome_nobody_defined")).toBe("the AI runtime did not produce a usable answer");
  });
});
