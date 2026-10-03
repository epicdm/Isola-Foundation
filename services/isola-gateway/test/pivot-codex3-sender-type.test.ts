/**
 * CODEX ROUND 3 (review of 1eb7ba3): F6 — the contact comparison was REQUIRED only when
 * `senderType === "contact"`.   ALL TESTS HERE ARE SOCKET-FREE.
 *
 * `coherentChannelSubject` compared the sender id with `contact_inbox.contact_id` only
 * inside `if (senderType === "contact")`. Suppression lets an incoming message through
 * with a missing or other sender type, so a signed payload whose `sender.type` was
 * null, "Contact" or "user" skipped the comparison altogether: with fixture scope on,
 * a known subject and a matching inbox but an ABSENT `contact_inbox.contact_id` reached
 * the runtime. (Codex: a fail-closed validation gap, not a proven live WhatsApp
 * impersonation exploit.)
 *
 * The contract pinned here: the supported sender type is `contact` (compared
 * case-insensitively after trimming, because it is a closed vocabulary and not free
 * text); ANY other value, or none, cannot be a channel-bound customer and fails closed;
 * and for a contact sender both ids are required and must match.
 *
 * Every refusal has its positive twin in the same harness.
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

describe("coherentChannelSubject: the sender type is part of the gate", () => {
  const ok = {
    channelSubject: SUBJECT,
    senderType: "contact" as string | null,
    senderId: SENDER_ID as number | null,
    contactInboxContactId: SENDER_ID as number | null,
    contactInboxInboxId: INBOX_ID,
    routedInboxId: INBOX_ID,
  };

  it("CONTROL: the supported sender type with both ids present and matching returns the subject", () => {
    expect(coherentChannelSubject(ok)).toBe(SUBJECT);
  });

  it("CONTROL (normalisation): ' Contact ' and 'CONTACT' are the same closed-vocabulary value and are still compared", () => {
    expect(coherentChannelSubject({ ...ok, senderType: " Contact " })).toBe(SUBJECT);
    expect(coherentChannelSubject({ ...ok, senderType: "CONTACT" })).toBe(SUBJECT);
    // ... and still compared: a mismatch is refused under the normalised type too.
    expect(coherentChannelSubject({ ...ok, senderType: "Contact", contactInboxContactId: 66 })).toBeNull();
  });

  it.each([[null], ["Contact"], ["user"], ["agent_bot"], [""], ["contactx"]])(
    "sender type %j with the contact_id ABSENT is refused (Codex: it reached the runtime)",
    (senderType) => {
      expect(coherentChannelSubject({ ...ok, senderType, contactInboxContactId: null })).toBeNull();
    },
  );

  it.each([[null], ["user"], ["agent_bot"], [""], ["contactx"]])(
    "sender type %j is not a customer even when both ids are present and match",
    (senderType) => {
      expect(coherentChannelSubject({ ...ok, senderType })).toBeNull();
    },
  );

  it("CONTROL (multi-gate): the sender type is a different field from the compared ids, and the harness varies them independently", () => {
    expect(typeof ok.senderType).toBe("string");
    expect(typeof ok.senderId).toBe("number");
    expect(ok.senderId).not.toBe(ok.contactInboxInboxId);
  });
});

function makeJob(sender: Record<string, unknown>, contactInbox: Record<string, unknown>): DeliveryJob {
  const binding = makeBinding();
  const payload = messageCreatedPayload({
    content: "what is my balance?",
    sender,
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: "pending",
      meta: { assignee: null },
      contact_inbox: contactInbox,
      custom_attributes: {},
    },
  });
  return {
    correlationId: "corr-st",
    deliveryId: "delivery-st-1",
    identity: {
      tenantId: TENANT_ID,
      bindingId: bindingIdentity(binding),
      chatwootAccountId: ACCOUNT_ID,
      chatwootInboxId: INBOX_ID,
      eventId: "delivery:st-1",
    },
    digest: "digest-st-1",
    binding,
    payload: parseWebhookPayload(Buffer.from(JSON.stringify(payload)))!,
    conversationId: CONVERSATION_DISPLAY_ID,
    startedAtMs: 0,
    mode: "answer",
    classification: null,
  };
}

async function run(sender: Record<string, unknown>, contactInbox: Record<string, unknown>) {
  const chatwoot = new StubChatwootApi();
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const deps: PipelineDeps = {
    config: envConfig(),
    chatwoot,
    runtime,
    logger: new CapturingLogger().logger,
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
  const result = await processDelivery(deps, makeJob(sender, contactInbox));
  return { result, runtimeCalls: runtime.requests.length, customerMessages: chatwoot.customerMessages.length };
}

const withType = (type: unknown): Record<string, unknown> => {
  const sender: Record<string, unknown> = { id: SENDER_ID, phone_number: `+${SUBJECT}` };
  if (type !== undefined) sender["type"] = type;
  return sender;
};
// A contact_inbox that names the right subject and inbox but OMITS contact_id: the payload Codex built.
const noContactId = { id: 9, inbox_id: INBOX_ID, source_id: SUBJECT };
const full = { id: 9, contact_id: SENDER_ID, inbox_id: INBOX_ID, source_id: SUBJECT };

describe("through the pipeline (CONTROLLED FIXTURE): a non-contact sender type with the contact_id omitted does not reach the runtime", () => {
  it("CONTROL: a lowercase 'contact' with a full, coherent contact_inbox IS answered", async () => {
    const out = await run(withType("contact"), full);
    expect(out.runtimeCalls).toBe(1);
    expect(out.customerMessages).toBe(1);
  });

  it("CONTROL: 'Contact' (normalised) with a full, coherent contact_inbox IS answered too", async () => {
    const out = await run(withType("Contact"), full);
    expect(out.runtimeCalls).toBe(1);
  });

  it.each([[undefined], ["Contact"], ["user"], [null]])(
    "sender type %j + contact_inbox without contact_id: the model is NOT called and nothing is said to the customer",
    async (type) => {
      const out = await run(withType(type), noContactId);
      expect(out.runtimeCalls, "Codex demonstrated this reached the runtime").toBe(0);
      expect(out.customerMessages).toBe(0);
      expect(out.result.outcome).toBe("customer_scope_unresolved");
    },
  );

  it.each([[undefined], ["user"]])(
    "sender type %j is refused even with a full, coherent contact_inbox (it is not a customer)",
    async (type) => {
      const out = await run(withType(type), full);
      expect(out.runtimeCalls).toBe(0);
      expect(out.result.outcome).toBe("customer_scope_unresolved");
    },
  );
});
