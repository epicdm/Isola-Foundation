/**
 * CODEX FIX ROUND 1 (review of 92ddc6c): D1 + D2 — ONE absolute deadline for the
 * whole Paperclip turn.
 *
 *   D1 (P1)  the HTTP response BODY read escaped the request timeout, so a create or
 *            a poll could outlive the ledger lease and the recovery sweeper could run
 *            a second handler for the same delivery.
 *   D2 (P1)  the "hard" poll deadline was not enforced: a response that arrived after
 *            it was still accepted, creation sat outside it, and boot accepted a
 *            600000 ms request timeout against a 300000 ms lease.
 *
 * Tested ONLY against the local STUB Paperclip (test/paperclip-stub.ts): it proves
 * nothing about the installed Paperclip. Every refusal has its positive twin in the
 * same harness (Laws 11, 19, 23, 28): the healthy stub IS answered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { bootErrors, loadConfig } from "../src/config.js";
import {
  inMemoryIssueStore,
  PAPERCLIP_OUTCOMES,
  PaperclipAgentRuntime,
  type IssueStore,
} from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";
import { BASE_ENV } from "./harness.js";
import { StubPaperclip } from "./paperclip-stub.js";

const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");

function request(): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "emp-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      customerScope: { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
      message: { role: "customer", content: "What does the 600 minute plan cost?" },
    },
  };
}

const ANSWER = { isola: 1, disposition: "reply", text: "The 600 minute plan is 600 minutes." };

let stub: StubPaperclip;
beforeEach(async () => {
  stub = new StubPaperclip();
  await stub.start();
});
afterEach(async () => {
  await stub.stop();
});

function makeRuntime(args: { deadlineMs: number; requestTimeoutMs: number; intervalMs?: number; store?: IssueStore }) {
  const store = args.store ?? inMemoryIssueStore();
  const runtime = new PaperclipAgentRuntime({
    baseUrl: stub.url,
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch: async (input, init) => fetch(input, init),
    issueStore: store,
    pollDeadlineMs: args.deadlineMs,
    pollIntervalMs: args.intervalMs ?? 15,
    requestTimeoutMs: args.requestTimeoutMs,
  });
  return { runtime, store };
}

/**
 * Run `invoke` but never wait longer than `guardMs`: a runtime that never settles
 * is reported as `"HUNG"` (a clean RED), not as a suite-level timeout.
 */
async function settle(
  work: Promise<AgentRuntimeResult>,
  guardMs: number,
): Promise<{ result: AgentRuntimeResult | "HUNG"; elapsedMs: number }> {
  const started = Date.now();
  const result = await Promise.race([
    work,
    new Promise<"HUNG">((resolve) => setTimeout(() => resolve("HUNG"), guardMs)),
  ]);
  return { result, elapsedMs: Date.now() - started };
}

describe("D1: the response BODY read is inside the same timeout as the request", () => {
  it("CONTROL: a healthy create + answer settles ok (the harness answers when it should)", async () => {
    stub.replyOnCreate(ANSWER);
    const { runtime } = makeRuntime({ deadlineMs: 1500, requestTimeoutMs: 300 });
    const { result } = await settle(runtime.invoke(request()), 3000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe("ok");
  });

  it("a create whose headers arrive but whose BODY never completes is bounded by the request timeout and becomes an UNCERTAIN create", async () => {
    stub.createMode = "stall_body";
    const { runtime, store } = makeRuntime({ deadlineMs: 5000, requestTimeoutMs: 150 });
    const { result, elapsedMs } = await settle(runtime.invoke(request()), 1500);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(elapsedMs).toBeLessThan(1000);
    // an uncertain create is remembered and NEVER re-created
    expect(await store.isUncertain(KEY)).toBe(true);
  });

  it("a poll whose headers arrive but whose BODY never completes cannot outlive the poll deadline", async () => {
    stub.replyOnCreate(ANSWER);
    stub.pollStallBody = true;
    const { runtime } = makeRuntime({ deadlineMs: 400, requestTimeoutMs: 150 });
    const { result, elapsedMs } = await settle(runtime.invoke(request()), 2000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect(elapsedMs).toBeLessThan(1200);
  });
});

describe("D2: one ABSOLUTE deadline covers create + poll + every body read", () => {
  it("CONTROL: the same slow poll (100 ms) is accepted when the deadline is generous", async () => {
    stub.replyOnCreate(ANSWER);
    stub.pollDelayMs = 100;
    const { runtime } = makeRuntime({ deadlineMs: 1500, requestTimeoutMs: 400 });
    const { result } = await settle(runtime.invoke(request()), 3000);
    expect((result as AgentRuntimeResult).outcome).toBe("ok");
  });

  it("a conforming comment that arrives AFTER the deadline (30 ms deadline, 100 ms response) is NOT accepted", async () => {
    stub.replyOnCreate(ANSWER);
    stub.pollDelayMs = 100;
    const { runtime } = makeRuntime({ deadlineMs: 30, requestTimeoutMs: 400 });
    const { result, elapsedMs } = await settle(runtime.invoke(request()), 3000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect((result as AgentRuntimeResult).text).toBeNull();
    // the request itself was capped to the time that remained, not left to run to 100 ms+
    expect(elapsedMs).toBeLessThan(400);
  });

  it("CONTROL: a create that takes 100 ms is fine under a generous deadline", async () => {
    stub.replyOnCreate(ANSWER);
    stub.createDelayMs = 100;
    const { runtime } = makeRuntime({ deadlineMs: 1500, requestTimeoutMs: 400 });
    const { result } = await settle(runtime.invoke(request()), 3000);
    expect((result as AgentRuntimeResult).outcome).toBe("ok");
  });

  it("CREATION is inside the deadline: a create that takes longer than the whole deadline is an UNCERTAIN create, never an answer", async () => {
    stub.replyOnCreate(ANSWER);
    stub.createDelayMs = 100;
    const { runtime, store } = makeRuntime({ deadlineMs: 40, requestTimeoutMs: 400 });
    const { result, elapsedMs } = await settle(runtime.invoke(request()), 3000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect((result as AgentRuntimeResult).text).toBeNull();
    expect(elapsedMs).toBeLessThan(400);
    expect(await store.isUncertain(KEY)).toBe(true);
  });
});

describe("D2 (boot): the execution budget must fit inside the ledger lease, or the gateway REFUSES to boot", () => {
  const enabledEnv = {
    GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
    GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
    GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
    GATEWAY_PAPERCLIP_BEARER: BEARER,
  };
  const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...enabledEnv, ...extra });

  it("CONTROL: the defaults (75 s deadline, 10 s request timeout, 300 s lease) boot cleanly", () => {
    expect(bootErrors(cfg())).toEqual([]);
  });

  it("REFUSES: a 600000 ms request timeout against the 300000 ms lease (Codex probe: bootErrors() was [])", () => {
    const errors = bootErrors(cfg({ GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS: "600000" }));
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors.join(" ")).toContain("GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS");
    expect(errors.join(" ")).not.toContain(BEARER);
  });

  it("REFUSES: deadline + one request timeout no longer fits in the lease, although each alone does", () => {
    // 75 s deadline < 120 s runtime timeout < ... but 75 + 70 = 145 s > the 140 s lease
    const errors = bootErrors(
      cfg({
        GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "75000",
        GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS: "70000",
        GATEWAY_RUNTIME_TIMEOUT_MS: "120000",
        GATEWAY_LEDGER_LEASE_MS: "140000",
      }),
    );
    expect(errors.join(" ")).toContain("GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS");
  });

  it("CONTROL for the budget rule: the same settings with a lease that DOES hold deadline + request timeout boot", () => {
    const errors = bootErrors(
      cfg({
        GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "75000",
        GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS: "70000",
        GATEWAY_RUNTIME_TIMEOUT_MS: "120000",
        GATEWAY_LEDGER_LEASE_MS: "200000",
      }),
    );
    expect(errors).toEqual([]);
  });
});
