/**
 * CODEX FIX ROUND 2 (review of 9799a84): the contact_inbox comparison ids are REQUIRED
 * once customer scope is on.   ALL TESTS HERE ARE SOCKET-FREE.
 *
 * Round 1 refused a MISMATCHING `contact_inbox.contact_id` / `inbox_id` but accepted an
 * ABSENT one ("a stated limit"). Codex (round 2): a signed payload that pairs ANOTHER
 * sender with a known fixture `source_id` still resolves that fixture when the
 * comparison ids are simply omitted, which defeats the cross-check for exactly the
 * payload an attacker would craft. DECISION: when scope resolution is enabled, an
 * absent comparison id cannot be cross-checked and is therefore UNRESOLVED (fail
 * closed), not a pass. The loud failure mode is the safe one: if Chatwoot does not send
 * these nodes, every sender escalates to a person, which is visible.
 *
 * Every refusal has its positive twin in the same harness, and the compared ids carry
 * DIFFERENT values (Law 20 multi-gate rule).
 */
import { describe, expect, it } from "vitest";

import { coherentChannelSubject, createFixtureCustomerScopeResolver } from "../src/customer-scope.js";
import { bindingIdentity } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { processDelivery, type DeliveryJob, type PipelineDeps } from "../src/pipeline.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
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

const SUBJECT = "17675550101";
const SENDER_ID = 55;
const OTHER_CONTACT_ID = 66;

describe("coherentChannelSubject: the comparison ids must be PRESENT and must match", () => {
  const ok = {
    channelSubject: SUBJECT,
    senderType: "contact",
    senderId: SENDER_ID,
    contactInboxContactId: SENDER_ID,
    contactInboxInboxId: INBOX_ID,
    routedInboxId: INBOX_ID,
  };

  it("CONTROL (multi-gate): the compared values are all different from each other in this harness", () => {
    expect(new Set([SENDER_ID, OTHER_CONTACT_ID, INBOX_ID]).size).toBe(3);
  });

  it("CONTROL: both ids present and matching -> the subject is returned", () => {
    expect(coherentChannelSubject(ok)).toBe(SUBJECT);
  });

  it("a MISSING contact_inbox.contact_id -> null (cannot be cross-checked against the sender)", () => {
    expect(coherentChannelSubject({ ...ok, contactInboxContactId: null })).toBeNull();
  });

  it("a MISSING contact_inbox.inbox_id -> null (cannot be cross-checked against the routed inbox)", () => {
    expect(coherentChannelSubject({ ...ok, contactInboxInboxId: null })).toBeNull();
  });

  it("a MISSING sender id on a contact sender -> null", () => {
    expect(coherentChannelSubject({ ...ok, senderId: null })).toBeNull();
  });

  it("both missing -> null (the payload Codex described)", () => {
    expect(coherentChannelSubject({ ...ok, contactInboxContactId: null, contactInboxInboxId: null })).toBeNull();
  });

  it("CONTROL: a MISMATCH is still refused (the round 1 behaviour is intact)", () => {
    expect(coherentChannelSubject({ ...ok, contactInboxContactId: OTHER_CONTACT_ID })).toBeNull();
    expect(coherentChannelSubject({ ...ok, contactInboxInboxId: INBOX_ID + 1 })).toBeNull();
  });

  it("no channel-bound subject at all stays null", () => {
    expect(coherentChannelSubject({ ...ok, channelSubject: null })).toBeNull();
  });
});

function makeJob(contactInbox: Record<string, unknown>): DeliveryJob {
  const binding = makeBinding();
  const payload = messageCreatedPayload({
    content: "what is my balance?",
    sender: { type: "contact", id: SENDER_ID, phone_number: `+${SUBJECT}` },
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: "pending",
      meta: { assignee: null },
      contact_inbox: contactInbox,
      custom_attributes: {},
    },
  });
  return {
    correlationId: "corr-ci",
    deliveryId: "delivery-ci-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:ci-1",
    },
    digest: "digest-ci-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(payload)))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode: "answer",
    classification: null,
  };
}

async function run(contactInbox: Record<string, unknown>) {
  const chatwoot = new StubChatwootApi();
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const capture = new CapturingLogger();
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: capture.logger,
    ledger: new FakeLedger(),
    ownership: new InMemoryOwnershipGate(),
    customerScope: createFixtureCustomerScopeResolver([
      {
        senderPhone: `+${SUBJECT}`,
        customerId: "fixture-owner-test-account",
        serviceIds: ["fixture-line-1"],
        tenantId: TENANT_ID,
        chatwootAccountId: ACCOUNT_ID,
        chatwootInboxId: INBOX_ID,
      },
    ]),
    failpoint: DISARMED,
    now: () => 0,
  };
  const result = await processDelivery(deps, makeJob(contactInbox));
  return { result, runtimeCalls: runtime.requests.length, customerMessages: chatwoot.customerMessages.length, privateNotes: chatwoot.privateNotes.length };
}

describe("through the pipeline (CONTROLLED FIXTURE): omitting the comparison ids no longer resolves a fixture", () => {
  it("CONTROL: a full, coherent contact_inbox IS answered", async () => {
    const out = await run({ id: 9, contact_id: SENDER_ID, inbox_id: INBOX_ID, source_id: SUBJECT });
    expect(out.runtimeCalls).toBe(1);
    expect(out.customerMessages).toBe(1);
  });

  it("a contact_inbox that carries NEITHER comparison id fails closed: the model is not called and a person is shown the conversation", async () => {
    const out = await run({ id: 9, source_id: SUBJECT });
    expect(out.runtimeCalls).toBe(0);
    expect(out.customerMessages).toBe(0);
    expect(out.privateNotes).toBeGreaterThanOrEqual(1);
    expect(out.result.outcome).toBe("customer_scope_unresolved");
  });

  it("a contact_inbox that carries only the inbox id (contact_id omitted) fails closed", async () => {
    const out = await run({ id: 9, inbox_id: INBOX_ID, source_id: SUBJECT });
    expect(out.runtimeCalls).toBe(0);
    expect(out.customerMessages).toBe(0);
  });

  it("a contact_inbox that carries only the contact id (inbox_id omitted) fails closed", async () => {
    const out = await run({ id: 9, contact_id: SENDER_ID, source_id: SUBJECT });
    expect(out.runtimeCalls).toBe(0);
    expect(out.customerMessages).toBe(0);
  });
});
