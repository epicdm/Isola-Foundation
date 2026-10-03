/**
 * Shared support for the Codex round-6 recovery tests: the REAL sweeper against the stub Chatwoot in
 * its visibility-WINDOW model (what an AgentBot can really see), with the human-state evolution
 * (status, assignee) the window record now carries.
 *
 * Not a test file. Socket-free: nothing here listens or connects.
 */
import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import type { DeliveryJob, PipelineDeps } from "../src/pipeline.js";
import { createSweeper } from "../src/recovery.js";
import type { RecoveryAlert } from "../src/recovery-escalation.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  envConfig,
  FakeLedger,
  INBOX_ID,
  InMemoryOwnershipGate,
  makeBinding,
  MESSAGE_ID,
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

export const EVENT_ID = "delivery:g6";

/** Advances the shared clock the moment a named action has been CLAIMED. */
export class ClockAdvancingLedger extends FakeLedger {
  onClaim: ((action: string) => void) | null = null;
  override async claimAction(
    ...args: Parameters<FakeLedger["claimAction"]>
  ): ReturnType<FakeLedger["claimAction"]> {
    const result = await super.claimAction(...args);
    this.onClaim?.(args[1]);
    return result;
  }
}

export function clock(start = 0) {
  let t = start;
  return { now: () => t, set: (v: number) => void (t = v) };
}

export function makeJob(mode: "answer" | "handoff" = "answer"): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-g6",
    deliveryId: "delivery-g6",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: EVENT_ID,
    },
    digest: "digest-g6",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode,
    classification: null,
  };
}

export const refOf = (job: DeliveryJob) => ({
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
  chatwootInboxId: INBOX_ID,
  bindingId: job.identity.bindingId,
});

export interface RowInfo {
  state: string;
  failureCode: string | null;
}

export function row(ledger: FakeLedger, action: string): RowInfo | null {
  const found = [...ledger.rows.entries()].find(([key]) => key.endsWith(`|${action}`) && key.includes(EVENT_ID));
  if (found === undefined) return null;
  return { state: found[1].state, failureCode: found[1].failureCode ?? null };
}

export const stateOf = (ledger: FakeLedger, action: string): string => row(ledger, action)?.state ?? "absent";

/** Every action row beneath the delivery that is still in_progress (must be none under a closed delivery). */
export function inProgressActions(ledger: FakeLedger): string[] {
  return [...ledger.rows.entries()]
    .filter(([key, r]) => key.includes(EVENT_ID) && !key.endsWith("|delivery") && r.state === "in_progress")
    .map(([key]) => key.slice(key.lastIndexOf("|") + 1))
    .sort();
}

export async function reserve(ledger: FakeLedger, job: DeliveryJob): Promise<void> {
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

export function build(opts: { stallAt?: string; answer?: "reply" | "escalating_reply" } = {}) {
  const chatwoot = new StubChatwootApi();
  chatwoot.useVisibilityWindow(MESSAGE_ID);
  const ledger = new ClockAdvancingLedger();
  const time = clock(0);
  const capture = new CapturingLogger();
  const ownership = new InMemoryOwnershipGate();
  const deps: PipelineDeps = {
    config: envConfig({ GATEWAY_LEDGER_LEASE_MS: "300000" }),
    chatwoot,
    runtime:
      opts.answer === "reply"
        ? StubAgentRuntime.answering("Nine to five.")
        : StubAgentRuntime.answeringWithAction("A colleague will follow up shortly.", "request_human", "explicit_human_request"),
    logger: capture.logger,
    ledger,
    ownership,
    failpoint: DISARMED,
    now: time.now,
  };
  if (opts.stallAt !== undefined) {
    const at = opts.stallAt;
    ledger.onClaim = (action) => action === at && time.set(deps.config.turnBudgetMs + 1_000);
  }
  return { deps, chatwoot, ledger, ownership, capture };
}

/** The REAL sweeper, sharing the ownership store and Chatwoot (what a restart keeps), with the real clock. */
export function sweeperFor(
  deps: PipelineDeps,
  capture: CapturingLogger,
  extra: { alertSink?: { raise(alert: RecoveryAlert): void }; bindings?: () => ReturnType<typeof makeBinding>[] } = {},
) {
  const runtime = StubAgentRuntime.answering("must not be called");
  const sweeper = createSweeper({
    config: deps.config,
    ledger: deps.ledger,
    bindingStore: { list: extra.bindings ?? (() => [makeBinding()]) },
    chatwoot: deps.chatwoot,
    runtime,
    logger: capture.logger,
    ownership: deps.ownership,
    ...(extra.alertSink === undefined ? {} : { alertSink: extra.alertSink }),
    failpoint: DISARMED,
    now: () => Date.now(),
  });
  return { sweeper, runtime };
}

export function collectingSink() {
  const alerts: RecoveryAlert[] = [];
  return { alerts, sink: { raise: (a: RecoveryAlert) => void alerts.push(a) } };
}
