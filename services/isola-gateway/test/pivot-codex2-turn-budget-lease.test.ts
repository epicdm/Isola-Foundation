/**
 * CODEX FIX ROUND 2 (review of 9799a84): R2 — nothing bounded the delivery inside the
 * ledger lease, so worker A could still be writing after its lease expired while
 * worker B resumed the same delivery.   ALL TESTS HERE ARE SOCKET-FREE.
 *
 * Codex's accepted configuration: Paperclip deadline 75000, request timeout 1000,
 * runtime timeout 80000, ledger lease 90000, Chatwoot timeout 600000 -> bootErrors()
 * returned []. The old rule only summed Paperclip's own two numbers; the reply that
 * follows is a CHATWOOT request (its own timeout), Chatwoot cleared its timer before
 * the body was read, history/ownership/ledger work sat outside every budget, nothing
 * renewed the heartbeat, and completion was not fenced.
 *
 * THE DESIGN (option ii, the smallest that makes the property provable): ONE hard
 * end-to-end TURN BUDGET per delivery, `startedAt + turnBudgetMs`, with
 * `turnBudgetMs + a safety margin <= the ledger lease` enforced at boot. Then:
 *   - every Chatwoot request, body read included, is aborted at the turn deadline;
 *   - the runtime call and the ownership read are raced against it;
 *   - the write fence (called before EVERY wire write) refuses at/after it;
 *   - the delivery row is NOT completed after it (A's late completion is rejected: the
 *     row stays open for the sweeper, i.e. for worker B).
 * Since the recovery sweeper takes a delivery only after its lease has EXPIRED, and the
 * lease outlives A's budget by the margin, A performs no write and no completion at any
 * time B may be active. No heartbeat is needed because no turn is allowed to run longer
 * than the lease; the cost is that a turn which needs longer fails closed to a retry.
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi, type ChatwootTarget } from "../src/chatwoot.js";
import { bootErrors, loadConfig, TURN_LEASE_MARGIN_MS } from "../src/config.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import type { ConversationRef, OwnershipView } from "../src/ownership.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import type { AgentRuntimeResult } from "../src/runtime.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  BASE_ENV,
  BOT_ACCESS_TOKEN,
  CONVERSATION_DISPLAY_ID,
  CapturingLogger,
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

const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const enabledEnv = {
  GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
  GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
  GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
  GATEWAY_PAPERCLIP_BEARER: BEARER,
};
const cfg = (extra: Record<string, string> = {}) => loadConfig({ ...BASE_ENV, ...enabledEnv, ...extra });

describe("R2 (boot): the turn budget must fit inside the ledger lease, and every timeout inside the budget", () => {
  it("CONTROL: the defaults boot cleanly, and the budget is the lease minus the safety margin", () => {
    const config = cfg();
    expect(bootErrors(config)).toEqual([]);
    expect(config.turnBudgetMs).toBe(config.ledgerLeaseMs - TURN_LEASE_MARGIN_MS);
  });

  it("REFUSES Codex's accepted configuration (deadline 75000 / request 1000 / runtime 80000 / lease 90000 / Chatwoot 600000: bootErrors() was [])", () => {
    const errors = bootErrors(
      cfg({
        GATEWAY_PAPERCLIP_POLL_DEADLINE_MS: "75000",
        GATEWAY_PAPERCLIP_REQUEST_TIMEOUT_MS: "1000",
        GATEWAY_RUNTIME_TIMEOUT_MS: "80000",
        GATEWAY_LEDGER_LEASE_MS: "90000",
        GATEWAY_CHATWOOT_TIMEOUT_MS: "600000",
      }),
    );
    expect(errors.length).toBeGreaterThanOrEqual(1);
    const joined = errors.join(" ");
    expect(joined).toContain("GATEWAY_CHATWOOT_TIMEOUT_MS");
    expect(joined).not.toContain(BEARER);
  });

  it("REFUSES a Chatwoot timeout that is not inside the turn budget (the reply and every annotation are Chatwoot requests)", () => {
    const errors = bootErrors(cfg({ GATEWAY_CHATWOOT_TIMEOUT_MS: "600000" }));
    expect(errors.join(" ")).toContain("GATEWAY_CHATWOOT_TIMEOUT_MS");
  });

  it("REFUSES a runtime timeout that is not inside the turn budget", () => {
    const errors = bootErrors(cfg({ GATEWAY_LEDGER_LEASE_MS: "100000", GATEWAY_RUNTIME_TIMEOUT_MS: "90000" }));
    expect(errors.join(" ")).toContain("GATEWAY_RUNTIME_TIMEOUT_MS");
  });

  it("REFUSES an explicit turn budget that leaves less than the safety margin before the lease expires", () => {
    const tooLong = String(300_000 - TURN_LEASE_MARGIN_MS + 1);
    const errors = bootErrors(cfg({ GATEWAY_TURN_BUDGET_MS: tooLong }));
    expect(errors.join(" ")).toContain("GATEWAY_TURN_BUDGET_MS");
  });

  it("CONTROL: an explicit budget that DOES leave the margin boots (the rule is not 'refuse every explicit budget')", () => {
    const ok = String(300_000 - TURN_LEASE_MARGIN_MS);
    expect(bootErrors(cfg({ GATEWAY_TURN_BUDGET_MS: ok }))).toEqual([]);
    expect(bootErrors(cfg({ GATEWAY_TURN_BUDGET_MS: "120000" }))).toEqual([]);
  });

  it("REFUSES a lease that is not longer than the safety margin (no budget can exist)", () => {
    // Paperclip is OFF here on purpose: its own deadline rules also mention the lease and
    // would make this pass for the wrong reason (Law 23).
    expect(bootErrors(loadConfig({ ...BASE_ENV }))).toEqual([]);
    const errors = bootErrors(loadConfig({ ...BASE_ENV, GATEWAY_LEDGER_LEASE_MS: String(TURN_LEASE_MARGIN_MS) }));
    expect(errors.join(" ")).toContain("GATEWAY_LEDGER_LEASE_MS");
  });
});

interface Captured {
  url: string;
}
const TARGET: ChatwootTarget = { accountId: 1, conversationId: 42, accessToken: BOT_ACCESS_TOKEN };

/** Never wait longer than `guardMs`: a call that never settles is "HUNG" (a clean RED). */
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

describe("R2 (Chatwoot client): every request, body read included, ends at the request timeout AND at the turn deadline", () => {
  const api = (fetchImpl: (url: string, init: RequestInit) => Promise<Response>, timeoutMs: number) =>
    new HttpChatwootApi({
      baseUrl: "https://chatwoot.example.test",
      safeFetch: async (input, init) => fetchImpl(String(input), init ?? {}),
      timeoutMs,
    });
  const hangUntilAbort = (init: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });

  it("a 2xx whose BODY never completes is cut at the request timeout (Codex: the timer was cleared after the headers; still unsettled after 60 ms)", async () => {
    // Headers arrive at once; the body then stalls and does NOT listen to the abort signal.
    const stalled = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const client = api(async () => new Response(stalled, { status: 200 }), 40);
    const settled = await settle(client.postMessage(TARGET, "hello", false), 600);
    expect(settled).not.toBe("HUNG");
  });

  it("CONTROL: a normal 2xx with a JSON body returns its message id", async () => {
    const client = api(async () => new Response(JSON.stringify({ id: 77 }), { status: 200 }), 1_000);
    expect(await client.postMessage(TARGET, "hello", false)).toBe(77);
  });

  it("a request is aborted at the TURN deadline even when the per-request timeout is 600000 ms", async () => {
    const calls: Captured[] = [];
    const client = api(async (url, init) => {
      calls.push({ url });
      return hangUntilAbort(init);
    }, 600_000);
    const target: ChatwootTarget = { ...TARGET, remainingMs: () => 60 };
    const started = Date.now();
    const settled = await settle(client.postMessage(target, "hello", false), 2_000);
    expect(settled).not.toBe("HUNG");
    expect("err" in (settled as object)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(calls).toHaveLength(1);
  });

  it("with NO turn time left nothing is SENT at all", async () => {
    const calls: Captured[] = [];
    const client = api(async (url) => {
      calls.push({ url });
      return new Response("{}", { status: 200 });
    }, 1_000);
    const settled = await settle(client.postMessage({ ...TARGET, remainingMs: () => 0 }, "hello", false), 500);
    expect("err" in (settled as object)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("CONTROL: with ample turn time the request is sent normally", async () => {
    const calls: Captured[] = [];
    const client = api(async (url) => {
      calls.push({ url });
      return new Response(JSON.stringify({ id: 5 }), { status: 200 });
    }, 1_000);
    expect(await client.postMessage({ ...TARGET, remainingMs: () => 10_000 }, "hello", false)).toBe(5);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// The pipeline: A's late work is rejected; B resumes only after the lease expires.
// ---------------------------------------------------------------------------

const REF: ConversationRef = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
};
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

function makeJob(startedAtMs: number, resumed = false): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-lease",
    deliveryId: "delivery-lease-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:lease-1",
    },
    digest: "digest-lease-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs,
    ...(resumed ? { resumed: true } : {}),
    mode: "answer",
    classification: null,
  };
}

/** A controllable clock: the pipeline's `now()` is the only time source it uses for the budget. */
function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v), advance: (ms: number) => void (t += ms) };
}

function setup(configEnv: Record<string, string> = {}, overrides: Partial<PipelineDeps> = {}) {
  const chatwoot = (overrides.chatwoot as StubChatwootApi | undefined) ?? new StubChatwootApi();
  const ledger = new FakeLedger();
  const time = clock(0);
  const capture = new CapturingLogger();
  const deps: PipelineDeps = {
    config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000", ...configEnv }),
    chatwoot,
    runtime: StubAgentRuntime.answering(REPLY.text as string),
    logger: capture.logger,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: time.now,
    ...overrides,
  };
  return { deps, chatwoot, ledger, time, capture };
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

const deliveryState = (ledger: FakeLedger): string => {
  const rows = [...ledger.rows.entries()].filter(([key]) => key.endsWith("|delivery"));
  return rows.length === 1 ? (rows[0]?.[1].state ?? "none") : `rows=${rows.length}`;
};

describe("R2 (pipeline): worker A past its budget writes nothing and completes nothing; worker B resumes only after the lease expires", () => {
  it("CONTROL: a turn inside the budget replies once and CLOSES the delivery row", async () => {
    const { deps, chatwoot, ledger } = setup();
    const job = makeJob(0);
    await reserve(ledger, job);
    const result = await processDelivery(deps, job);
    expect(result.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(deliveryState(ledger)).toBe("completed");
  });

  it("worker B cannot take (or act on) a delivery while worker A's lease is live, and CAN once it has expired", async () => {
    const { deps, ledger, chatwoot } = setup();
    const job = makeJob(0);
    await reserve(ledger, job);
    let duringA: string | null = null;
    let dueDuringA = -1;
    deps.runtime = new StubAgentRuntime(async () => {
      // worker B tries while A is mid-turn
      dueDuringA = (await ledger.dueForRecovery(10)).length;
      const attempt = await ledger.reserve({
        identity: job.identity,
        digest: job.digest,
        correlationId: job.correlationId,
        conversationId: job.conversationId,
        messageId: job.payload.messageId,
        mode: "answer",
        leaseMs: 300_000,
      });
      duringA = attempt.kind;
      return REPLY;
    });
    await processDelivery(deps, job);
    expect(dueDuringA).toBe(0);
    expect(duringA).toBe("duplicate");
    expect(chatwoot.customerMessages).toHaveLength(1);

    // POSITIVE CONTROL: the same B attempt succeeds once the lease has expired.
    const { ledger: l2 } = setup();
    await reserve(l2, job);
    l2.expireAllLeases();
    const after = await l2.reserve({
      identity: job.identity,
      digest: job.digest,
      correlationId: job.correlationId,
      conversationId: job.conversationId,
      messageId: job.payload.messageId,
      mode: "answer",
      leaseMs: 300_000,
    });
    expect(after.kind).toBe("resumed");
  });

  it("A's turn runs past its budget: NO reply is written, the row is NOT completed, the result asks for a retry; B then replies exactly once", async () => {
    const { deps, chatwoot, ledger, time } = setup();
    const job = makeJob(0);
    await reserve(ledger, job);
    // The runtime takes longer than the budget (270000 ms) and then returns an answer.
    deps.runtime = new StubAgentRuntime(async () => {
      time.set(deps.config.turnBudgetMs + 1_000);
      return REPLY;
    });

    const a = await processDelivery(deps, job);

    expect(chatwoot.customerMessages, "A talked after its budget (and after B may have taken over)").toHaveLength(0);
    expect(chatwoot.calls.filter((c) => c.kind === "message" || c.kind === "labels_write" || c.kind === "attributes_write")).toEqual([]);
    expect(deliveryState(ledger), "A's late completion closed a row B has to resume").not.toBe("completed");
    expect(a.needsRetry).toBe(true);

    // B: the lease expires, the sweeper resumes the delivery on a fresh clock.
    ledger.expireAllLeases();
    expect((await ledger.dueForRecovery(10)).length).toBe(1);
    time.set(1_000_000);
    deps.runtime = StubAgentRuntime.answering(REPLY.text as string);
    const b = await processDelivery(deps, makeJob(1_000_000, true));

    expect(b.outcome).toBe("replied");
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(deliveryState(ledger)).toBe("completed");
  });

  it("A replied inside the budget, then the budget passed: A's late annotations and A's completion are REJECTED; B finds the reply already sent and sends nothing", async () => {
    const chatwoot = new (class extends StubChatwootApi {
      advanceAfterReply: (() => void) | null = null;
      override async postMessage(
        target: ChatwootTarget,
        content: string,
        isPrivate: boolean,
        deliveryRef?: string,
      ): Promise<number | null> {
        const id = await super.postMessage(target, content, isPrivate, deliveryRef);
        if (!isPrivate) this.advanceAfterReply?.();
        return id;
      }
    })();
    const { deps, ledger, time } = setup({}, { chatwoot });
    const job = makeJob(0);
    await reserve(ledger, job);
    chatwoot.advanceAfterReply = () => time.set(deps.config.turnBudgetMs + 1_000);

    await processDelivery(deps, job);

    expect(chatwoot.customerMessages).toHaveLength(1); // the reply landed inside the budget
    expect(chatwoot.labelWrites, "late label write by A").toHaveLength(0);
    expect(chatwoot.attributeWrites, "late attribute write by A").toHaveLength(0);
    expect(deliveryState(ledger), "A closed the row after its budget").not.toBe("completed");

    // B resumes after the lease expires: the reply row is complete, so nothing is re-sent.
    chatwoot.advanceAfterReply = null;
    ledger.expireAllLeases();
    time.set(1_000_000);
    const b = await processDelivery(deps, makeJob(1_000_000, true));
    expect(chatwoot.customerMessages).toHaveLength(1);
    expect(b.customerMessageSent).toBe(false);
    expect(deliveryState(ledger)).toBe("completed");
  });

  it("a runtime that NEVER returns is cut at the budget: the delivery ends (needs retry), nothing is written, the row stays open", async () => {
    const { deps, chatwoot, ledger } = setup(
      { GATEWAY_TURN_BUDGET_MS: "150" },
      { now: () => Date.now(), runtime: new StubAgentRuntime(() => new Promise<AgentRuntimeResult>(() => undefined)) },
    );
    const job = makeJob(Date.now());
    await reserve(ledger, job);

    const settled = await settle(processDelivery(deps, job), 2_000);

    expect(settled, "the turn outlived its budget").not.toBe("HUNG");
    const result = (settled as { ok: Awaited<ReturnType<typeof processDelivery>> }).ok;
    expect(result.needsRetry).toBe(true);
    expect(chatwoot.calls.filter((c) => c.kind === "message")).toEqual([]);
    expect(deliveryState(ledger)).not.toBe("completed");
  });

  it("an ownership read that never returns cannot hold the turn open past the budget (fail closed: no write)", async () => {
    let reads = 0;
    class HangingOwnership extends InMemoryOwnershipGate {
      override async read(ref: ConversationRef): Promise<OwnershipView> {
        reads += 1;
        if (reads === 1) return super.read(ref); // the pre-run gate answers; every later read hangs
        return new Promise<OwnershipView>(() => undefined);
      }
    }
    const { deps, chatwoot, ledger } = setup({ GATEWAY_TURN_BUDGET_MS: "150" }, { now: () => Date.now(), ownership: new HangingOwnership() });
    const job = makeJob(Date.now());
    await reserve(ledger, job);

    const settled = await settle(processDelivery(deps, job), 2_000);

    expect(settled, "a hanging ownership read held the turn open").not.toBe("HUNG");
    expect(chatwoot.calls.filter((c) => c.kind === "message")).toEqual([]);
    expect(deliveryState(ledger)).not.toBe("completed");
  });
});
