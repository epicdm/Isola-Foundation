/**
 * CODEX ROUND 3 (review of 1eb7ba3): F1 — abandoning the runtime wait did not stop the
 * runtime, and a result that arrived after the deadline was still accepted.
 *   ALL TESTS HERE ARE SOCKET-FREE (injected fetch and the gateway's own fakes).
 *
 * What Codex demonstrated:
 *   - `processDelivery` raced the runtime call against the turn deadline but passed
 *     neither the deadline nor an abort signal INTO `invoke()`. The pipeline gave up and
 *     discarded the result; the Paperclip runtime went on polling under its OWN fresh
 *     deadline (default 300 s lease / 270 s budget: it still dispatched at 300, 301 and
 *     302 s). Discarding a result is not cancelling the work, and a second worker may
 *     already be eligible once the lease has expired.
 *   - `raceTurn` did not look at the clock when its promise RESOLVED: an ownership read
 *     that returned after the deadline still admitted the runtime.
 *
 * The contract pinned here: ONE abort signal, fired when the turn budget is spent, is
 * handed to `invoke()`; a runtime starts no request after it fires, aborts the one in
 * flight and stops polling; a result (or a read) that completes after the deadline is
 * discarded, however well-formed; and a stalled response BODY ends the call with an
 * error (never an empty answer).
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi, type ChatwootTarget } from "../src/chatwoot.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { ChatwootApiError } from "../src/errors.js";
import { DISARMED } from "../src/failpoint.js";
import type { ConversationRef, OwnershipView } from "../src/ownership.js";
import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { HttpAgentRuntime, type AgentRuntimeResult } from "../src/runtime.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  BOT_ACCESS_TOKEN,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function settle<T>(promise: Promise<T>, guardMs: number): Promise<{ ok: T } | { err: unknown } | "HUNG"> {
  return Promise.race([
    promise.then(
      (ok) => ({ ok }),
      (err: unknown) => ({ err }),
    ),
    new Promise<"HUNG">((resolve) => {
      const t = setTimeout(() => resolve("HUNG"), guardMs);
      if (typeof t.unref === "function") t.unref();
    }),
  ]);
}

function makeJob(startedAtMs: number): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-f1",
    deliveryId: "delivery-f1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:f1",
    },
    digest: "digest-f1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs,
    mode: "answer",
    classification: null,
  };
}

async function reserve(ledger: FakeLedger, job: DeliveryJob): Promise<void> {
  await ledger.reserve({
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    conversationId: job.conversationId,
    messageId: job.payload.messageId,
    mode: job.mode,
    leaseMs: 300_000,
  });
}

// ---------------------------------------------------------------------------
// A. The real Paperclip runtime, driven by the real pipeline, with a SHORT turn budget
//    and a LONG Paperclip deadline: the situation of Codex's 300/302 s probe, scaled.
// ---------------------------------------------------------------------------

interface PaperclipCall {
  url: string;
  at: number;
  kind: "create" | "poll";
  signal: AbortSignal | null;
}

function paperclipRuntime(opts: { pollDeadlineMs: number; reply?: boolean; hang?: boolean; runId?: string }) {
  const calls: PaperclipCall[] = [];
  const runtime = new PaperclipAgentRuntime({
    baseUrl: "https://paperclip.example.test",
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch: async (input, init) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const call: PaperclipCall = {
        url,
        at: Date.now(),
        kind: method === "POST" ? "create" : "poll",
        signal: init?.signal ?? null,
      };
      calls.push(call);
      if (opts.hang === true) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      }
      if (method === "POST" && url.endsWith("/issues")) {
        const created = opts.runId === undefined ? { id: "iss-1" } : { id: "iss-1", executionRunId: opts.runId };
        return new Response(JSON.stringify(created), { status: 201 });
      }
      const comments =
        opts.reply === true
          ? [{ id: "c1", body: JSON.stringify({ isola: 1, disposition: "reply", text: "ok" }), authorAgentId: "agent-1" }]
          : [];
      return new Response(JSON.stringify(comments), { status: 200 });
    },
    issueStore: inMemoryIssueStore(),
    pollDeadlineMs: opts.pollDeadlineMs,
    pollIntervalMs: 10,
    requestTimeoutMs: 1_000,
  });
  return { runtime, calls };
}

function deps(runtime: PipelineDeps["runtime"], extra: Partial<PipelineDeps> = {}) {
  const chatwoot = new StubChatwootApi();
  const ledger = new FakeLedger();
  const capture = new CapturingLogger();
  const d: PipelineDeps = {
    config: envConfig({ GATEWAY_TURN_BUDGET_MS: "150" }),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: () => Date.now(),
    ...extra,
  };
  return { deps: d, chatwoot, ledger };
}

describe("F1 (the PATH): once the turn budget is spent the Paperclip runtime starts NO further request", () => {
  it("a 5 s Paperclip poll deadline under a 150 ms turn budget: the poll STOPS at the budget (Codex: it kept dispatching long after)", async () => {
    const { runtime, calls } = paperclipRuntime({ pollDeadlineMs: 5_000 });
    const { deps: d, chatwoot, ledger } = deps(runtime);
    const job = makeJob(Date.now());
    await reserve(ledger, job);

    const settled = await settle(processDelivery(d, job), 2_000);
    expect(settled).not.toBe("HUNG");
    const result = (settled as { ok: Awaited<ReturnType<typeof processDelivery>> }).ok;
    expect(result.needsRetry).toBe(true);
    expect(chatwoot.customerMessages).toHaveLength(0);

    const atReturn = calls.length;
    expect(atReturn, "the harness never reached Paperclip, so this test proved nothing").toBeGreaterThanOrEqual(2);
    await sleep(250);
    expect(calls.length, "Paperclip kept being polled after the turn budget was spent").toBe(atReturn);
  });

  it("an in-flight Paperclip request is ABORTED at the budget (its signal fires)", async () => {
    const { runtime, calls } = paperclipRuntime({ pollDeadlineMs: 5_000, hang: true });
    const { deps: d, ledger } = deps(runtime);
    const job = makeJob(Date.now());
    await reserve(ledger, job);

    const settled = await settle(processDelivery(d, job), 2_000);
    expect(settled).not.toBe("HUNG");
    expect(calls).toHaveLength(1);
    await sleep(50);
    expect(calls[0]?.signal?.aborted, "the request that was in flight at the deadline was left running").toBe(true);
  });

  it("the runtime SETTLES promptly when the turn signal fires (it used to keep looping until its own 5 s deadline)", async () => {
    const { runtime } = paperclipRuntime({ pollDeadlineMs: 5_000 });
    const controller = new AbortController();
    const started = Date.now();
    const pending = settle(
      runtime.invoke({
        templateId: "tpl@v1",
        exposure: "PUBLIC",
        agentId: "agent-1",
        runId: "run-1",
        idempotencyKey: "k-1",
        context: {
          source: "chatwoot",
          companyId: "company-1",
          customerScope: { kind: "verified", customerId: "cust-a", serviceIds: [] },
          chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
          message: { role: "customer", content: "hi" },
        },
        signal: controller.signal,
      }),
      3_000,
    );
    await sleep(60);
    controller.abort();
    const settled = await pending;
    expect(settled).not.toBe("HUNG");
    expect(Date.now() - started, "the runtime outlived the turn signal").toBeLessThan(800);
    expect((settled as { ok: { outcome: string } }).ok.outcome).toBe(PAPERCLIP_OUTCOMES.timeout);
  });

  it("a takeover is seen AFTER the turn signal fired: the cancel request is NOT sent (nothing starts after the budget)", async () => {
    const { runtime, calls } = paperclipRuntime({ pollDeadlineMs: 5_000, runId: "run-9" });
    const controller = new AbortController();
    const settled = await settle(
      runtime.invoke({
        templateId: "tpl@v1",
        exposure: "PUBLIC",
        agentId: "agent-1",
        runId: "run-1",
        idempotencyKey: "k-cancel",
        context: {
          source: "chatwoot",
          companyId: "company-1",
          customerScope: { kind: "verified", customerId: "cust-a", serviceIds: [] },
          chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
          message: { role: "customer", content: "hi" },
        },
        // the budget ends while the ownership read is in flight, and the read then says "a person has it"
        isStillOwned: async () => {
          controller.abort();
          return false;
        },
        signal: controller.signal,
      }),
      2_000,
    );
    expect(settled).not.toBe("HUNG");
    expect(calls.some((c) => c.kind === "create")).toBe(true); // the harness reached Paperclip and knows the run id
    expect(calls.filter((c) => c.url.endsWith("/cancel")), "a cancel was started after the turn budget").toHaveLength(0);
  });

  it("CONTROL: the very same takeover with the signal STILL LIVE does send the cancel (so the test above can fail)", async () => {
    const { runtime, calls } = paperclipRuntime({ pollDeadlineMs: 5_000, runId: "run-9" });
    const result = await runtime.invoke({
      templateId: "tpl@v1",
      exposure: "PUBLIC",
      agentId: "agent-1",
      runId: "run-1",
      idempotencyKey: "k-cancel-2",
      context: {
        source: "chatwoot",
        companyId: "company-1",
        customerScope: { kind: "verified", customerId: "cust-a", serviceIds: [] },
        chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
        message: { role: "customer", content: "hi" },
      },
      isStillOwned: async () => false,
    });
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.ownershipLost);
    expect(calls.filter((c) => c.url.endsWith("/cancel"))).toHaveLength(1);
  });

  it("CONTROL: with ample budget the same runtime polls until the employee's result and the customer is answered once", async () => {
    const { runtime } = paperclipRuntime({ pollDeadlineMs: 5_000, reply: true });
    const { deps: d, chatwoot, ledger } = deps(runtime, { config: envConfig({ GATEWAY_TURN_BUDGET_MS: "5000" }) });
    const job = makeJob(Date.now());
    await reserve(ledger, job);

    const result = await processDelivery(d, job);

    expect(result.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// B. A read or a result that completes AFTER the deadline is not admitted.
// ---------------------------------------------------------------------------

function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

const REPLY: AgentRuntimeResult = {
  text: "Here is your answer.",
  action: null,
  actionUnrecognised: false,
  actionReason: null,
  outcome: "ok",
  correlationId: "runtime-correlation-id",
  completionState: "completed",
  contractVersion: 1,
};

describe("F1 (raceTurn): a promise that RESOLVES after the deadline is a timeout, not a value", () => {
  it("the ownership read before the runtime returns after the deadline: the runtime is NOT invoked (Codex: it was)", async () => {
    const time = clock(0);
    class LateOwnership extends InMemoryOwnershipGate {
      reads = 0;
      override async read(ref: ConversationRef): Promise<OwnershipView> {
        this.reads += 1;
        // read 1 = the gate at the start; read 2 = the fence before the runtime call
        // The clock moves while the read is IN FLIGHT (after the race has started), so the
        // answer resolves AFTER the deadline: the case raceTurn used to accept as a value.
        if (this.reads === 2) {
          await Promise.resolve();
          time.set(1_000_000);
        }
        return super.read(ref);
      }
    }
    const ownership = new LateOwnership();
    const runtime = StubAgentRuntime.answering(REPLY.text as string);
    const { deps: d, chatwoot, ledger } = deps(runtime, {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      ownership,
      now: time.now,
    });
    const job = makeJob(0);
    await reserve(ledger, job);

    const result = await processDelivery(d, job);

    expect(ownership.reads, "the late read never happened, so this test proved nothing").toBeGreaterThanOrEqual(2);
    expect(runtime.requests, "an ownership answer that arrived after the budget admitted the runtime").toHaveLength(0);
    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(result.needsRetry).toBe(true);
  });

  it("CONTROL: the same flow with the read inside the budget invokes the runtime exactly once", async () => {
    const time = clock(0);
    const runtime = StubAgentRuntime.answering(REPLY.text as string);
    const { deps: d, chatwoot, ledger } = deps(runtime, {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      now: time.now,
    });
    const job = makeJob(0);
    await reserve(ledger, job);

    const result = await processDelivery(d, job);

    expect(runtime.requests).toHaveLength(1);
    expect(result.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
  });

  it("a runtime result that completes after the deadline is DISCARDED as a timeout (however well-formed), and the signal is fired", async () => {
    const time = clock(0);
    let seenSignal: AbortSignal | undefined;
    const runtime = new StubAgentRuntime(async (request) => {
      seenSignal = request.signal;
      await Promise.resolve();
      time.set(1_000_000); // the runtime finishes after the budget (the race has already started)
      return REPLY;
    });
    const { deps: d, chatwoot, ledger } = deps(runtime, {
      config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
      now: time.now,
    });
    const job = makeJob(0);
    await reserve(ledger, job);

    const result = await processDelivery(d, job);

    expect(seenSignal, "invoke() was not handed an abort signal").toBeDefined();
    expect(result.runtimeOutcome).toBe("model_timeout");
    expect(result.needsRetry).toBe(true);
    expect(chatwoot.customerMessages).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// C. The isola-runtime client honours the same signal and does not leave the body unbounded.
// ---------------------------------------------------------------------------

function httpRuntime(safeFetch: ConstructorParameters<typeof HttpAgentRuntime>[0]["safeFetch"], timeoutMs: number) {
  return new HttpAgentRuntime({
    baseUrl: "http://isola-runtime.example.test:3000",
    invokePath: "/v1/invoke",
    bearer: BEARER,
    safeFetch,
    timeoutMs,
  });
}
const REQUEST = (signal?: AbortSignal) => ({
  templateId: "tpl@v1",
  exposure: "PUBLIC" as const,
  agentId: "agent-1",
  runId: "run-1",
  context: {},
  ...(signal === undefined ? {} : { signal }),
});

describe("F1 (isola-runtime client): the turn signal and a stalled body", () => {
  it("a signal that is ALREADY aborted sends nothing and reports a timeout", async () => {
    let sent = 0;
    const runtime = httpRuntime(async () => {
      sent += 1;
      return new Response("{}", { status: 200 });
    }, 1_000);
    const controller = new AbortController();
    controller.abort();
    const result = await runtime.invoke(REQUEST(controller.signal));
    expect(sent).toBe(0);
    expect(result.outcome).toBe("model_timeout");
  });

  it("the signal firing mid-request aborts the request and ends the call", async () => {
    let requestSignal: AbortSignal | undefined;
    const runtime = httpRuntime(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          requestSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
      5_000,
    );
    const controller = new AbortController();
    const pending = settle(runtime.invoke(REQUEST(controller.signal)), 1_000);
    await sleep(30);
    controller.abort();
    const settled = await pending;
    expect(settled).not.toBe("HUNG");
    expect(requestSignal?.aborted).toBe(true);
    expect((settled as { ok: { outcome: string } }).ok.outcome).toBe("model_timeout");
  });

  it("a 2xx whose BODY never completes is cut at the request timeout (it used to hold the turn open: the timer was cleared after the headers)", async () => {
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const runtime = httpRuntime(async () => new Response(stalled, { status: 200 }), 40);
    const settled = await settle(runtime.invoke(REQUEST()), 800);
    expect(settled, "a stalled response body held the call open").not.toBe("HUNG");
    expect((settled as { ok: { outcome: string } }).ok.outcome).toBe("model_timeout");
  });

  it("CONTROL: a normal 200 with a JSON body is read and returned as ok", async () => {
    const runtime = httpRuntime(async () => new Response(JSON.stringify({ outcome: "ok", text: "hello" }), { status: 200 }), 1_000);
    const result = await runtime.invoke(REQUEST());
    expect(result.outcome).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// D. Chatwoot: a stalled body is a REJECTION (Codex: swallowing the timeout as `null`
//    still passed all 18 turn-budget tests, because they asserted only "it settled").
// ---------------------------------------------------------------------------

const TARGET: ChatwootTarget = { accountId: 1, conversationId: 42, accessToken: BOT_ACCESS_TOKEN };
const chatwootApi = (fetchImpl: () => Promise<Response>, timeoutMs: number) =>
  new HttpChatwootApi({
    baseUrl: "https://chatwoot.example.test",
    safeFetch: async () => fetchImpl(),
    timeoutMs,
  });
const stalledBody = () => new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });

describe("F1 (Chatwoot): a response body that never completes REJECTS with a timeout; it is never read as an empty answer", () => {
  it("a POST whose body stalls rejects with ChatwootApiError 'timed out' (not null)", async () => {
    const client = chatwootApi(async () => new Response(stalledBody(), { status: 200 }), 40);
    const settled = await settle(client.postMessage(TARGET, "hello", false), 800);
    expect(settled).not.toBe("HUNG");
    expect("err" in (settled as object), "the stalled body resolved instead of rejecting").toBe(true);
    const err = (settled as { err: unknown }).err;
    expect(err).toBeInstanceOf(ChatwootApiError);
    expect(String((err as Error).message)).toContain("timed out");
  });

  it("a GET whose body stalls rejects: an unread GET must not look like an empty list", async () => {
    const client = chatwootApi(async () => new Response(stalledBody(), { status: 200 }), 40);
    const settled = await settle(client.getConversationRecord(TARGET), 800);
    expect(settled).not.toBe("HUNG");
    expect("err" in (settled as object)).toBe(true);
  });

  it("CONTROL: a 2xx with an EMPTY body on a write is fine (no id), so the rejection above is about the stall and not about every empty body", async () => {
    const client = chatwootApi(async () => new Response("", { status: 200 }), 1_000);
    expect(await client.postMessage(TARGET, "hello", false)).toBeNull();
  });
});
