/**
 * CODEX ROUND 5: documentation/wording defects with a runtime face.
 *
 * The private note the gateway leaves for a colleague said "No message was sent to the customer"
 * for EVERY escalation, including the ordinary reply-then-escalate path (the agent asked for a
 * human, the reply WAS sent, then the conversation was opened). A colleague reading that note
 * would believe the customer had heard nothing and might answer the same question twice, or
 * apologise for silence that did not happen. A note is a claim about what happened: it must not
 * claim the opposite.
 *
 * SOCKET-FREE. Each refusal has its positive twin: a genuine failure (nothing was sent) still
 * says so.
 */
import { describe, expect, it } from "vitest";

import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { processDelivery, renderFailureNote, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
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
  messageCreatedPayload,
  StubAgentRuntime,
  StubChatwootApi,
  TENANT_ID,
} from "./harness.js";

function makeJob(): DeliveryJob {
  const binding = makeBinding();
  return {
    correlationId: "corr-wording",
    deliveryId: "delivery-wording",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:wording",
    },
    digest: "digest-wording",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(messageCreatedPayload())))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode: "answer",
    classification: null,
  };
}

async function run(runtime: StubAgentRuntime) {
  const chatwoot = new StubChatwootApi();
  const ledger = new FakeLedger();
  const capture = new CapturingLogger();
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger,
    ownership: new InMemoryOwnershipGate(),
    failpoint: DISARMED,
    now: () => 0,
  };
  const job = makeJob();
  await ledger.reserve({
    identity: job.identity,
    digest: job.digest,
    correlationId: job.correlationId,
    conversationId: job.conversationId,
    messageId: job.payload.messageId,
    mode: "answer",
    leaseMs: 300_000,
  });
  await processDelivery(deps, job);
  return chatwoot;
}

describe("the private note says what actually happened to the customer", () => {
  it("reply-then-escalate: the reply WAS sent, and the note must not say no message was sent", async () => {
    const chatwoot = await run(
      StubAgentRuntime.answeringWithAction("A colleague will follow up shortly.", "request_human", "explicit_human_request"),
    );

    expect(chatwoot.customerMessages, "premise: the customer WAS answered").toHaveLength(1);
    const note = chatwoot.privateNotes[0]?.content ?? "";
    expect(note, "a note that claims silence to a customer who WAS answered").not.toContain("No message was sent to the customer");
    expect(note).toContain("replied to the customer");
  });

  it("CONTROL: a genuine failure (the model failed, nothing was sent) still says so", async () => {
    const chatwoot = await run(StubAgentRuntime.failing("provider_error"));

    expect(chatwoot.customerMessages).toHaveLength(0);
    expect(chatwoot.privateNotes[0]?.content ?? "").toContain("No message was sent to the customer");
  });

  it("renderFailureNote itself: the answered form and the failure form are different texts", () => {
    const failure = renderFailureNote({ outcome: "provider_error", correlationId: "c", tenantId: "t" });
    const answered = renderFailureNote({ outcome: "explicit_human_request", correlationId: "c", tenantId: "t", customerAnswered: true });
    expect(failure).toContain("No message was sent to the customer");
    expect(answered).not.toContain("No message was sent to the customer");
    expect(answered).not.toBe(failure);
  });
});
