/**
 * CODEX FIX ROUND 1 (review of 92ddc6c): the two items Codex marked SUSPECTED, not
 * established, both cheap:
 *
 *   1. `contact_inbox.contact_id` was never checked against the sender and
 *      `contact_inbox.inbox_id` never against the routed inbox. A `contact_inbox`
 *      that is not the sender's, or not this inbox's, is not a channel-bound subject
 *      for THIS conversation: the scope fails closed (unresolved), same as an absent
 *      one. A `contact_inbox` that does not carry those ids cannot be cross-checked
 *      and is still used (a stated limit: we refuse a MISMATCH, not an absence).
 *   2. The fixture resolver ignored tenant / account / inbox: a fixture account would
 *      verify on ANY inbox. A fixture can now be bound to one (tenant, account, inbox);
 *      the env wiring (the only production-reachable one) REQUIRES the binding.
 *
 * THIS IS A CONTROLLED FIXTURE. These tests prove which payload nodes the gateway
 * cross-checks, not that any identifier was authenticated by a channel.
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28), and
 * the compared fields carry DIFFERENT values in the harness (Law 20 multi-gate rule).
 */
import { describe, expect, it } from "vitest";

import {
  createFixtureCustomerScopeResolver,
  customerScopeFromEnv,
  type CustomerScopeQuery,
} from "../src/customer-scope.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  ACCOUNT_ID,
  CONVERSATION_DISPLAY_ID,
  INBOX_ID,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
  TENANT_ID,
} from "./harness.js";

const FIXTURE_ID = "17675550101";
const FIXTURE_BASE = {
  senderPhone: `+${FIXTURE_ID}`,
  customerId: "fixture-owner-test-account",
  serviceIds: ["fixture-line-1"],
};
const SENDER_CONTACT_ID = 55;
const OTHER_CONTACT_ID = 66;
const OTHER_INBOX_ID = 9;

function body(contactInbox: Record<string, unknown>): Record<string, unknown> {
  return messageCreatedPayload({
    content: "what is my balance?",
    sender: { type: "contact", id: SENDER_CONTACT_ID, phone_number: `+${FIXTURE_ID}` },
    conversation: {
      id: CONVERSATION_DISPLAY_ID,
      status: "pending",
      meta: { assignee: null },
      contact_inbox: contactInbox,
      custom_attributes: {},
    },
  });
}

async function run(payload: Record<string, unknown>): Promise<{ runtimeCalls: number; customerMessages: number; privateNotes: number }> {
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const server = await startServer({
    runtime,
    customerScope: createFixtureCustomerScopeResolver([FIXTURE_BASE]),
  });
  try {
    const res = await postWebhook(server.url, signRequest({ rawBody: JSON.stringify(payload) }));
    expect(res.status).toBe(200);
    await server.gateway.drain();
    return {
      runtimeCalls: runtime.requests.length,
      customerMessages: server.chatwoot.customerMessages.length,
      privateNotes: server.chatwoot.privateNotes.length,
    };
  } finally {
    await server.close();
  }
}

describe("contact_inbox cross-check, through the route (CONTROLLED FIXTURE)", () => {
  it("CONTROL (multi-gate): the sender, the other contact and the two inbox ids are all DIFFERENT values in this harness", () => {
    expect(SENDER_CONTACT_ID).not.toBe(OTHER_CONTACT_ID);
    expect(OTHER_INBOX_ID).not.toBe(INBOX_ID);
  });

  it("CONTROL 1 (parser): the gateway reads sender.id, contact_inbox.contact_id and contact_inbox.inbox_id into SEPARATE fields", () => {
    const parsed = parseWebhookPayload(
      Buffer.from(
        JSON.stringify(
          body({ id: 9, contact_id: OTHER_CONTACT_ID, inbox_id: OTHER_INBOX_ID, source_id: FIXTURE_ID }),
        ),
      ),
    ) as any;
    expect(parsed.senderId ?? parsed.payload?.senderId).toBe(SENDER_CONTACT_ID);
    expect(parsed.contactInboxContactId ?? parsed.payload?.contactInboxContactId).toBe(OTHER_CONTACT_ID);
    expect(parsed.contactInboxInboxId ?? parsed.payload?.contactInboxInboxId).toBe(OTHER_INBOX_ID);
  });

  it("CONTROL 2: a coherent contact_inbox (its contact is the sender, its inbox is the routed inbox) IS answered", async () => {
    const out = await run(body({ id: 9, contact_id: SENDER_CONTACT_ID, inbox_id: INBOX_ID, source_id: FIXTURE_ID }));
    expect(out.runtimeCalls).toBe(1);
    expect(out.customerMessages).toBe(1);
  });

  it("a contact_inbox that belongs to ANOTHER contact than the sender fails closed: the model is not called, a human is shown the conversation", async () => {
    const out = await run(body({ id: 9, contact_id: OTHER_CONTACT_ID, inbox_id: INBOX_ID, source_id: FIXTURE_ID }));
    expect(out.runtimeCalls).toBe(0);
    expect(out.customerMessages).toBe(0);
    expect(out.privateNotes).toBeGreaterThanOrEqual(1);
  });

  it("a contact_inbox that belongs to ANOTHER inbox than the routed one fails closed", async () => {
    const out = await run(body({ id: 9, contact_id: SENDER_CONTACT_ID, inbox_id: OTHER_INBOX_ID, source_id: FIXTURE_ID }));
    expect(out.runtimeCalls).toBe(0);
    expect(out.customerMessages).toBe(0);
    expect(out.privateNotes).toBeGreaterThanOrEqual(1);
  });

  it("STATED LIMIT (control): a contact_inbox that carries neither id cannot be cross-checked and is still used", async () => {
    const out = await run(body({ id: 9, source_id: FIXTURE_ID }));
    expect(out.runtimeCalls).toBe(1);
    expect(out.customerMessages).toBe(1);
  });
});

const QUERY: CustomerScopeQuery = {
  tenantId: TENANT_ID,
  chatwootAccountId: ACCOUNT_ID,
  chatwootInboxId: INBOX_ID,
  chatwootConversationId: CONVERSATION_DISPLAY_ID,
  channelSubject: `+${FIXTURE_ID}`,
};

describe("the fixture resolver is bound to ONE (tenant, account, inbox) when it says so", () => {
  const BOUND = { ...FIXTURE_BASE, tenantId: TENANT_ID, chatwootAccountId: ACCOUNT_ID, chatwootInboxId: INBOX_ID };

  it("CONTROL: the fixture verifies on the inbox it is bound to", async () => {
    const resolver = createFixtureCustomerScopeResolver([BOUND]);
    expect((await resolver.resolve(QUERY)).kind).toBe("verified");
  });

  it.each([
    ["another inbox", { chatwootInboxId: INBOX_ID + 1 }],
    ["another account", { chatwootAccountId: ACCOUNT_ID + 1 }],
    ["another tenant", { tenantId: `${TENANT_ID}-other` }],
  ])("the same sender on %s is UNRESOLVED, not verified", async (_name, override) => {
    const resolver = createFixtureCustomerScopeResolver([BOUND]);
    expect((await resolver.resolve({ ...QUERY, ...override })).kind).toBe("unresolved");
  });

  it("the env wiring REQUIRES the binding: a fixture without tenantId / chatwootAccountId / chatwootInboxId is refused", () => {
    const out = customerScopeFromEnv({
      GATEWAY_CUSTOMER_SCOPE_MODE: "fixture",
      GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([FIXTURE_BASE]),
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error).toContain("chatwootInboxId");
      expect(out.error).not.toContain("fixture-owner-test-account");
    }
  });

  it("CONTROL: the env wiring with the binding builds a resolver that verifies there and nowhere else", async () => {
    const out = customerScopeFromEnv({
      GATEWAY_CUSTOMER_SCOPE_MODE: "fixture",
      GATEWAY_CUSTOMER_SCOPE_FIXTURES_JSON: JSON.stringify([BOUND]),
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((await out.resolver!.resolve(QUERY)).kind).toBe("verified");
      expect((await out.resolver!.resolve({ ...QUERY, chatwootInboxId: INBOX_ID + 1 })).kind).toBe("unresolved");
    }
  });
});
