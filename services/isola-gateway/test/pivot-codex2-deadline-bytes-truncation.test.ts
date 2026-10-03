/**
 * CODEX FIX ROUND 2 (review of 9799a84): R4 + R6.   ALL TESTS HERE ARE SOCKET-FREE
 * (an injected safeFetch, no listener), so a sandbox that cannot bind a loopback
 * port can run them.
 *
 *   R4 (P2)  the "whole-turn" deadline still had gaps:
 *            a) a pending `isStillOwned()` left a 20 ms turn unsettled after 100 ms;
 *            b) the takeover cancel got a FRESH request-timeout budget (a 20 ms turn
 *               returned ownership-lost after ~98 ms);
 *            c) there was NO byte cap: a 16 MiB body finished "ok" with a 1 ms timeout.
 *            Now isStillOwned and the cancel sit under the SAME absolute turn deadline,
 *            and a response body is capped (declared length and streamed bytes) and
 *            read under the abort signal.
 *   R6 (P3)  the customer message was truncated by UTF-16 unit, so an emoji at the
 *            boundary left a lone surrogate in the outbound JSON. It is now cut so that
 *            a surrogate pair is never split.
 *
 * Tested ONLY against an injected fake of Paperclip: it proves nothing about the
 * installed build. Every refusal has its positive twin in the same harness (Laws 11,
 * 19, 23, 28): the healthy fake IS answered.
 */
import { describe, expect, it } from "vitest";

import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import type { SafeFetch } from "../src/egress.js";
import type { AgentRuntimeRequest, AgentRuntimeResult } from "../src/runtime.js";

const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const ANSWER = { isola: 1, disposition: "reply", text: "The 600 minute plan is 600 minutes." };

interface Call {
  method: string;
  url: string;
  body: string | null;
}

function request(overrides: Partial<AgentRuntimeRequest> = {}, content = "What does the plan cost?"): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "emp-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      companyId: "company-1",
      customerScope: { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
      message: { role: "customer", content },
    },
    ...overrides,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const created = (): Response => json({ id: "iss-1", executionRunId: "run-1" }, 201);
const answered = (): Response => json([{ id: "c1", body: JSON.stringify(ANSWER), authorAgentId: "emp-1" }]);

/** Resolves never, but REJECTS when the request is aborted (what a real fetch does). */
function hangUntilAbort(init: RequestInit | undefined): Promise<Response> {
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
}

function makeRuntime(
  handler: (call: Call, init: RequestInit | undefined) => Promise<Response> | Response,
  options: { deadlineMs: number; requestTimeoutMs: number; intervalMs?: number },
) {
  const calls: Call[] = [];
  const store = inMemoryIssueStore();
  const safeFetch: SafeFetch = async (input, init) => {
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: String(input),
      body: typeof init?.body === "string" ? init.body : null,
    };
    calls.push(call);
    return handler(call, init);
  };
  const runtime = new PaperclipAgentRuntime({
    baseUrl: "https://paperclip.example.test",
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch,
    issueStore: store,
    pollDeadlineMs: options.deadlineMs,
    pollIntervalMs: options.intervalMs ?? 10,
    requestTimeoutMs: options.requestTimeoutMs,
  });
  return { runtime, store, calls };
}

/** Never wait longer than `guardMs`: a runtime that never settles is "HUNG" (a clean RED), not a suite timeout. */
async function settle(promise: Promise<AgentRuntimeResult>, guardMs: number): Promise<AgentRuntimeResult | "HUNG"> {
  return Promise.race([
    promise,
    new Promise<"HUNG">((resolve) => {
      const t = setTimeout(() => resolve("HUNG"), guardMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

const isCreate = (c: Call): boolean => c.method === "POST" && c.url.endsWith("/issues");
const isComments = (c: Call): boolean => c.method === "GET" && c.url.includes("/comments");
const isCancel = (c: Call): boolean => c.method === "POST" && c.url.includes("/heartbeat-runs/") && c.url.endsWith("/cancel");

describe("R4a: isStillOwned() is under the SAME absolute turn deadline", () => {
  it("a PENDING ownership read cannot hold a 20 ms turn open past its deadline (Codex: unsettled after 100 ms)", async () => {
    const { runtime } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 20,
      requestTimeoutMs: 80,
    });
    const result = await settle(
      runtime.invoke(request({ isStillOwned: () => new Promise<boolean>(() => undefined) })),
      400,
    );
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
    expect((result as AgentRuntimeResult).text).toBeNull();
  });

  it("CONTROL: a prompt ownership read does not disturb a normal turn (the answer is returned)", async () => {
    const { runtime } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 2_000,
      requestTimeoutMs: 1_000,
    });
    const result = await settle(runtime.invoke(request({ isStillOwned: async () => true })), 3_000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe("ok");
  });

  it("CONTROL: an ownership read that REJECTS is still 'could not find out' = lost (never 'nobody holds it')", async () => {
    const { runtime } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 2_000,
      requestTimeoutMs: 1_000,
    });
    const result = await settle(
      runtime.invoke(request({ isStillOwned: async () => Promise.reject(new Error("db down")) })),
      3_000,
    );
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
  });
});

describe("R4b: the takeover cancel runs under the remaining turn budget, not a fresh request timeout", () => {
  it("a hanging cancel cannot stretch a 50 ms turn to the 400 ms request timeout (Codex: 20 ms turn took ~98 ms)", async () => {
    const { runtime, calls } = makeRuntime(
      (call, init) => {
        if (isCreate(call)) return created();
        if (isCancel(call)) return hangUntilAbort(init);
        return answered();
      },
      { deadlineMs: 50, requestTimeoutMs: 400 },
    );
    const started = Date.now();
    const result = await settle(runtime.invoke(request({ isStillOwned: async () => false })), 2_000);
    const elapsed = Date.now() - started;
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(calls.some(isCancel)).toBe(true); // it WAS attempted, just bounded
    expect(elapsed).toBeLessThan(250);
  });

  it("CONTROL: with budget left the cancel IS sent to the run the server named, and the outcome is the same", async () => {
    const { runtime, calls } = makeRuntime(
      (call) => {
        if (isCreate(call)) return created();
        if (isCancel(call)) return json({ ok: true });
        return answered();
      },
      { deadlineMs: 2_000, requestTimeoutMs: 1_000 },
    );
    const result = await settle(runtime.invoke(request({ isStillOwned: async () => false })), 3_000);
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    const cancels = calls.filter(isCancel);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.url).toContain("/heartbeat-runs/run-1/cancel");
  });
});

const MiB = 1024 * 1024;

describe("R4c: response bytes are capped (declared length and streamed) and read under the abort signal", () => {
  it("a 16 MiB create response is NOT accepted as ok (Codex: finished ok in ~152 ms with a 1 ms timeout): the create is UNCERTAIN, never re-created", async () => {
    const huge = `{"id":"iss-1","pad":"${"x".repeat(16 * MiB)}"}`;
    const { runtime, store, calls } = makeRuntime(
      (call) => (isCreate(call) ? new Response(huge, { status: 201 }) : answered()),
      { deadlineMs: 5_000, requestTimeoutMs: 5_000 },
    );
    const result = await settle(runtime.invoke(request()), 10_000);
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(true);
    expect(calls.filter(isCreate)).toHaveLength(1);
    expect(calls.some(isComments)).toBe(false);
  });

  it("a DECLARED content-length over the cap is refused BEFORE any body byte is read", async () => {
    let pulls = 0;
    // Finite on purpose (16 MiB then closed): an unbounded stream would turn a missing
    // cap into an out-of-memory crash of the test worker instead of a clean RED.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls >= 64) controller.close();
      },
    });
    const { runtime, store } = makeRuntime(
      (call) =>
        isCreate(call)
          ? new Response(body, { status: 201, headers: { "content-length": String(16 * MiB) } })
          : answered(),
      { deadlineMs: 5_000, requestTimeoutMs: 5_000 },
    );
    const result = await settle(runtime.invoke(request()), 10_000);
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(true);
    // A ReadableStream pulls ONCE by itself on construction (its own prefetch); what must
    // not happen is the gateway consuming the body: unfixed, it reads all 64 chunks.
    expect(pulls).toBeLessThanOrEqual(1);
  });

  it("a STREAMING body that exceeds the cap with no declared length stops reading at the cap", async () => {
    let pulls = 0;
    // 64 MiB in 256 KiB chunks, then closed (finite, so a missing cap is a clean RED and
    // not an out-of-memory crash of the worker). The cap must stop the read long before.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(256 * 1024));
        if (pulls >= 256) controller.close();
      },
    });
    const { runtime } = makeRuntime((call) => (isCreate(call) ? new Response(body, { status: 201 }) : answered()), {
      deadlineMs: 5_000,
      requestTimeoutMs: 5_000,
    });
    const result = await settle(runtime.invoke(request()), 10_000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(pulls).toBeLessThan(64); // a 1 MiB cap is ~4-5 pulls of 256 KiB, never the unbounded stream
  });

  it("an oversized COMMENTS page is a config defect after ONE request (no hammering the same page)", async () => {
    const pad = "x".repeat(2 * MiB);
    const { runtime, calls } = makeRuntime(
      (call) => (isCreate(call) ? created() : json([{ id: "c0", body: pad, authorAgentId: "emp-1" }])),
      { deadlineMs: 5_000, requestTimeoutMs: 5_000 },
    );
    const result = await settle(runtime.invoke(request()), 10_000);
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(calls.filter(isComments)).toHaveLength(1);
  });

  it("CONTROL: a 200 KB comments page UNDER the cap is read and the employee's answer is returned", async () => {
    const pad = "x".repeat(200 * 1024);
    const { runtime } = makeRuntime(
      (call) =>
        isCreate(call)
          ? created()
          : json([
              { id: "c0", body: pad, authorAgentId: "someone-else" },
              { id: "c1", body: JSON.stringify(ANSWER), authorAgentId: "emp-1" },
            ]),
      { deadlineMs: 5_000, requestTimeoutMs: 5_000 },
    );
    const result = await settle(runtime.invoke(request()), 10_000);
    expect((result as AgentRuntimeResult).outcome).toBe("ok");
    expect((result as AgentRuntimeResult).text).toBe(ANSWER.text);
  });

  it("a body that never completes is aborted at the request timeout even when the body ignores the signal", async () => {
    // A body whose stream never produces a chunk and does NOT listen to the abort signal.
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const { runtime, store } = makeRuntime(
      (call) => (isCreate(call) ? new Response(stalled, { status: 201 }) : answered()),
      { deadlineMs: 5_000, requestTimeoutMs: 40 },
    );
    const result = await settle(runtime.invoke(request()), 1_000);
    expect(result).not.toBe("HUNG");
    expect((result as AgentRuntimeResult).outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(true);
  });
});

/** A lone UTF-16 surrogate is the corruption Codex demonstrated at the truncation boundary. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function createdDescription(calls: Call[]): string {
  const create = calls.find(isCreate);
  expect(create?.body).not.toBeNull();
  const parsed = JSON.parse(create?.body ?? "{}") as { description?: string };
  return parsed.description ?? "";
}

describe("R6: truncation never splits a surrogate pair", () => {
  it("3,999 ASCII characters then an emoji: the outbound JSON has NO lone surrogate (Codex: a lone \\ud83d escape)", async () => {
    const content = `${"a".repeat(3_999)}\u{1F600}`;
    const { runtime, calls } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 2_000,
      requestTimeoutMs: 1_000,
    });
    await settle(runtime.invoke(request({}, content)), 3_000);
    const description = createdDescription(calls);
    expect(description).toContain("a".repeat(3_999));
    expect(LONE_SURROGATE.test(description)).toBe(false);
    expect(description).not.toContain("\u{1F600}"); // the pair would not fit, so it is dropped whole
  });

  it("CONTROL: an emoji that FITS exactly (3,998 characters + a 2-unit pair = 4,000 units) is kept intact", async () => {
    const content = `${"a".repeat(3_998)}\u{1F600}`;
    const { runtime, calls } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 2_000,
      requestTimeoutMs: 1_000,
    });
    await settle(runtime.invoke(request({}, content)), 3_000);
    const description = createdDescription(calls);
    expect(description).toContain(`${"a".repeat(3_998)}\u{1F600}`);
    expect(LONE_SURROGATE.test(description)).toBe(false);
  });

  it("CONTROL: the harness CAN detect a lone surrogate (the detector is not vacuous)", () => {
    expect(LONE_SURROGATE.test(`${"a".repeat(3_999)}\u{1F600}`.slice(0, 4_000))).toBe(true);
    expect(LONE_SURROGATE.test("a\u{1F600}b")).toBe(false);
  });

  it("CONTROL: text under the limit is untouched", async () => {
    const content = "short message \u{1F600} with an emoji";
    const { runtime, calls } = makeRuntime((call) => (isCreate(call) ? created() : answered()), {
      deadlineMs: 2_000,
      requestTimeoutMs: 1_000,
    });
    await settle(runtime.invoke(request({}, content)), 3_000);
    expect(createdDescription(calls)).toContain(content);
  });
});
