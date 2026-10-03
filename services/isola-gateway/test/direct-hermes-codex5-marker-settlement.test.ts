/**
 * CODEX N2 (direct Hermes path, short re-review of bd5b8f5) - P2, blocking.
 *
 * A failed settlement of the `model_run` marker was swallowed: the reply went out, the DELIVERY was
 * closed, the marker stayed `in_progress`, and recovery (which selects unfinished DELIVERY rows) never
 * saw it. Now the delivery is NOT closed while its marker is unsettled: the settlement is retried once
 * and bounded by the turn budget, and a delivery left open is escalated once by the real sweeper.
 *
 * SOCKET-FREE. Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { bootErrors } from "../src/config.js";
import { bindingIdentity, DELIVERY_ACTION } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { createSafeFetch } from "../src/egress.js";
import { HermesDirectRuntime } from "../src/hermes-runtime.js";
import { LedgerUnavailableError, type LedgerIdentity } from "../src/ledger.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { createSweeper } from "../src/recovery.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  CUSTOMER_MESSAGE,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  messageCreatedPayload,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";
import { FakeHermes } from "./hermes-fake.js";
import { answerEnvelope, completeWith, hermesEnv } from "./hermes-rig.js";
import { FakeTurnSql } from "./hermes-inproc.js";

const MODEL_RUN = "model_run";
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
/** A short, VALID turn: the Hermes run deadline (300 ms) < runtime timeout < turn budget. */
const SHORT_TURN_ENV: Record<string, string> = {
  GATEWAY_HERMES_RUN_DEADLINE_MS: "300",
  GATEWAY_HERMES_REQUEST_TIMEOUT_MS: "200",
  GATEWAY_RUNTIME_TIMEOUT_MS: "400",
  GATEWAY_CHATWOOT_TIMEOUT_MS: "500",
  GATEWAY_TURN_BUDGET_MS: "1200",
};

/** Never waits forever: a hang is reported as a failure instead of a vitest timeout. */
async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  const guard = new Promise<never>((_resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`HUNG: ${what} did not finish within ${ms} ms`)), ms);
    if (typeof t.unref === "function") t.unref();
  });
  return Promise.race([promise, guard]);
}

/** A ledger whose `model_run` SETTLEMENT fails (or stalls), so the reply is sent but the marker stays in progress. */
class MarkerSettlementLedger extends FakeLedger {
  mode: "ok" | "fail" | "fail_once" | "stall" = "ok";
  settlementAttempts = 0;
  override async complete(identity: LedgerIdentity, action: string, chatwootMessageId: number | null): Promise<void> {
    if (action === MODEL_RUN) {
      this.settlementAttempts += 1;
      if (this.mode === "fail") throw new LedgerUnavailableError("simulated: the marker settlement was lost");
      if (this.mode === "fail_once" && this.settlementAttempts === 1) throw new LedgerUnavailableError("simulated: a transient settlement failure");
      if (this.mode === "stall") return never<void>();
    }
    return super.complete(identity, action, chatwootMessageId);
  }
}

function pipelineRig(ledger: FakeLedger, env: Record<string, string> = {}) {
  const fake = new FakeHermes();
  completeWith(fake, answerEnvelope("THE ANSWER"));
  const config = envConfig(hermesEnv(env));
  expect(bootErrors(config)).toEqual([]);
  const chatwoot = new StubChatwootApi();
  const ownership = new InMemoryOwnershipGate();
  const capture = new CapturingLogger();
  const runtime = new HermesDirectRuntime({
    baseUrl: "http://hermes.test:8642",
    bearer: fake.bearer,
    safeFetch: createSafeFetch({ allowlist: config.egressAllowlist, transport: fake.fetch }),
    runDeadlineMs: 3000,
    pollIntervalMs: 10,
    requestTimeoutMs: 1000,
    maxInflight: 4,
    streamDrainGraceMs: 100,
    requireDurableDispatch: true,
  });
  const binding = makeBinding();
  const payload = parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!;
  const turns = new FakeTurnSql();
  turns.rows.push({ tenant: TENANT_ID, account: ACCOUNT_ID, conversation: CONVERSATION_DISPLAY_ID, message: payload.messageId, role: "customer", author: "customer", content: CUSTOMER_MESSAGE });
  const deps: PipelineDeps = { config, chatwoot, runtime, logger: capture.logger, ledger, ownership, turnStore: turns, failpoint: DISARMED, now: () => Date.now() };
  const job: DeliveryJob = {
    correlationId: "corr-n2",
    deliveryId: "delivery-n2",
    identity: { tenantId: TENANT_ID, bindingId: bindingIdentity(binding), chatwootAccountId: ACCOUNT_ID, chatwootInboxId: INBOX_ID, eventId: "delivery:n2" },
    digest: "digest-n2",
    binding,
    payload,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: Date.now(),
    mode: "answer",
    classification: null,
  };
  const sweeper = () =>
    createSweeper({
      config,
      ledger,
      bindingStore: { list: () => [binding] },
      chatwoot,
      runtime,
      logger: capture.logger,
      ownership,
      failpoint: DISARMED,
      now: () => Date.now(),
    });
  return { fake, chatwoot, capture, deps, job, sweeper, ledger };
}

const rowState = (ledger: FakeLedger, action: string): string | undefined => {
  const k = [...ledger.rows.keys()].find((key) => key.endsWith(`|${action}`));
  return k === undefined ? undefined : ledger.rows.get(k)!.state;
};

describe("N2 a failed marker settlement leaves the delivery recoverable (never COMPLETED with an in-progress marker)", () => {
  it("CONTROL: settlement succeeds -> the delivery is COMPLETED, every row completed, the sweeper finds nothing and escalates nothing", async () => {
    const ledger = new MarkerSettlementLedger();
    const t = pipelineRig(ledger);
    await ledger.reserve({ identity: t.job.identity, digest: t.job.digest, correlationId: t.job.correlationId, conversationId: t.job.conversationId, messageId: t.job.payload.messageId, mode: "answer", leaseMs: 300_000 });
    await processDelivery(t.deps, t.job);
    expect(t.chatwoot.customerMessages).toHaveLength(1);
    expect(rowState(ledger, DELIVERY_ACTION)).toBe("completed");
    expect(rowState(ledger, MODEL_RUN)).toBe("completed");
    ledger.expireAllLeases();
    await t.sweeper().sweep();
    expect(t.chatwoot.privateNotes).toHaveLength(0);
    expect(t.fake.creates).toHaveLength(1);
  });

  it("NEGATIVE (Codex's probe): the marker settlement is rejected -> the reply is sent but the DELIVERY IS NOT COMPLETED and the failure is logged", async () => {
    const ledger = new MarkerSettlementLedger();
    ledger.mode = "fail";
    const t = pipelineRig(ledger);
    await ledger.reserve({ identity: t.job.identity, digest: t.job.digest, correlationId: t.job.correlationId, conversationId: t.job.conversationId, messageId: t.job.payload.messageId, mode: "answer", leaseMs: 300_000 });
    await processDelivery(t.deps, t.job);
    expect(t.chatwoot.customerMessages, "the answer itself is still delivered once").toHaveLength(1);
    expect(rowState(ledger, MODEL_RUN)).toBe("in_progress");
    expect(rowState(ledger, DELIVERY_ACTION), "the delivery was COMPLETED with an in-progress marker under it").not.toBe("completed");
    expect(t.capture.lines.some((l) => l["alertCode"] === "model_run_marker_unsettled")).toBe(true);
  });

  it("NEGATIVE through the REAL sweeper: the unsettled marker is found and ESCALATED ONCE; no second run, no second customer message, nothing left in progress", async () => {
    const ledger = new MarkerSettlementLedger();
    ledger.mode = "fail";
    const t = pipelineRig(ledger);
    await ledger.reserve({ identity: t.job.identity, digest: t.job.digest, correlationId: t.job.correlationId, conversationId: t.job.conversationId, messageId: t.job.payload.messageId, mode: "answer", leaseMs: 300_000 });
    await processDelivery(t.deps, t.job);
    ledger.mode = "ok"; // the ledger is healthy again when recovery runs
    ledger.expireAllLeases();
    await t.sweeper().sweep();
    await t.sweeper().sweep(); // a second sweep finds nothing left to do
    expect(t.fake.creates, "recovery must never re-POST a run").toHaveLength(1);
    expect(t.chatwoot.customerMessages, "recovery must not send a second customer message").toHaveLength(1);
    expect(t.chatwoot.privateNotes, "ONE recorded escalation").toHaveLength(1);
    expect([...ledger.rows.values()].filter((row) => row.state === "in_progress"), "nothing may stay in progress").toEqual([]);
    expect(rowState(ledger, DELIVERY_ACTION)).toBe("completed");
  });

  it("a TRANSIENT settlement failure is retried once at closure: the delivery completes and nothing is escalated", async () => {
    const ledger = new MarkerSettlementLedger();
    ledger.mode = "fail_once";
    const t = pipelineRig(ledger);
    await ledger.reserve({ identity: t.job.identity, digest: t.job.digest, correlationId: t.job.correlationId, conversationId: t.job.conversationId, messageId: t.job.payload.messageId, mode: "answer", leaseMs: 300_000 });
    await processDelivery(t.deps, t.job);
    expect(ledger.settlementAttempts).toBe(2);
    expect(rowState(ledger, MODEL_RUN)).toBe("completed");
    expect(rowState(ledger, DELIVERY_ACTION)).toBe("completed");
    ledger.expireAllLeases();
    await t.sweeper().sweep();
    expect(t.chatwoot.privateNotes).toHaveLength(0);
  });

  it("NEGATIVE: a settlement that STALLS is bounded by the turn budget: processDelivery returns, the delivery is left open", async () => {
    const ledger = new MarkerSettlementLedger();
    ledger.mode = "stall";
    const t = pipelineRig(ledger, SHORT_TURN_ENV);
    await ledger.reserve({ identity: t.job.identity, digest: t.job.digest, correlationId: t.job.correlationId, conversationId: t.job.conversationId, messageId: t.job.payload.messageId, mode: "answer", leaseMs: 300_000 });
    const started = Date.now();
    await within(processDelivery(t.deps, t.job), 4000, "processDelivery with a stalled marker settlement");
    expect(Date.now() - started, "the stalled settlement held the turn open past its budget").toBeLessThan(3000);
    expect(rowState(ledger, DELIVERY_ACTION)).not.toBe("completed");
  });

  it("the comment promising recovery for this path is TRUE now (a source pin: the settlement is no longer swallowed silently)", () => {
    const src = readFileSync(new URL("../src/pipeline.ts", import.meta.url), "utf8");
    expect(src).toContain("model_run_marker_unsettled");
    expect(src).not.toMatch(/Best effort: a marker left unsettled is read by\s*\r?\n\s*\/\/ recovery/);
  });
});
