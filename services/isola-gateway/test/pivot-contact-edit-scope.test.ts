/**
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, item (b)(2), the control promised at
 * checkpoint 2: an agent EDITING the Chatwoot contact's phone must not move the
 * verified customer scope.
 *
 * WHY THIS CONTROL EXISTS (Law 27: a field's name is a claim, its write-site is the truth)
 *   The signed webhook authenticates THAT CHATWOOT SENT THE EVENT. It does not make
 *   every value inside the event trustworthy. `sender.phone_number` is read off the
 *   Contact RECORD at delivery time, and an agent can edit a contact. The value the
 *   channel itself bound the conversation to is `conversation.contact_inbox.source_id`
 *   (for a WhatsApp inbox: the wa_id Meta authenticated when the contact_inbox was
 *   created; Chatwoot does not rewrite it when the contact's phone is edited).
 *
 *   Before this change the gateway keyed the scope on `sender.phone_number`, so:
 *     - an agent (or anyone able to edit a contact) who typed a customer's number into a
 *       stranger's contact record made the stranger resolve to that customer; and
 *     - editing the real customer's contact moved the scope away from them.
 *
 * SOURCE / UNVERIFIED (Law 5)
 *   That Chatwoot 4.18's `message_created` webhook carries `conversation.contact_inbox`
 *   is from Chatwoot's published payload shape and is UNVERIFIED against the installed
 *   build. The gateway therefore treats an ABSENT `contact_inbox.source_id` as "no
 *   channel-bound subject" and FAILS CLOSED (unresolved). If the installed build does
 *   not send it, every public sender escalates to a human until it does: loud, not wrong.
 *
 * THIS IS A CONTROLLED FIXTURE. On an API-channel TEST inbox the source_id is whatever
 * the conversation's creator supplied, so it is not channel-verified; these tests prove
 * which payload field the gateway trusts, not that any identifier was authenticated.
 *
 * CONTROLS (Laws 11, 19, 23, 28): the unchanged-sender case IS answered over the same
 * route, so the refusals cannot come from a gateway that refuses everything; and the two
 * fields carry DIFFERENT values in the harness (Law 20 multi-gate rule).
 */
import { describe, expect, it } from "vitest";

import { createFixtureCustomerScopeResolver } from "../src/customer-scope.js";
import { parseWebhookPayload } from "../src/webhook.js";
import {
  CapturingLogger,
  CONVERSATION_DISPLAY_ID,
  messageCreatedPayload,
  postWebhook,
  signRequest,
  startServer,
  StubAgentRuntime,
} from "./harness.js";

/** The owner's OWN test account, as a fixture. Not a customer. */
const FIXTURE_ID = "17675550101";
const FIXTURE = {
  senderPhone: `+${FIXTURE_ID}`,
  customerId: "fixture-owner-test-account",
  serviceIds: ["fixture-line-1"],
};
/** A different person, bound by the CHANNEL to a different identifier. */
const STRANGER_ID = "17675550199";
const STRANGER_PHONE = `+${STRANGER_ID}`;

/**
 * A message_created payload whose two identity-bearing nodes are set independently:
 * `channelSubject` is the channel-bound contact_inbox.source_id (null = node absent),
 * `contactPhone` is the mutable Contact record's phone.
 */
function body(args: { channelSubject: string | null; contactPhone: string }): Record<string, unknown> {
  const conversation: Record<string, unknown> = {
    id: CONVERSATION_DISPLAY_ID,
    status: "pending",
    meta: { assignee: null },
    custom_attributes: {},
  };
  if (args.channelSubject !== null) {
    conversation["contact_inbox"] = { id: 9, contact_id: 55, inbox_id: 3, source_id: args.channelSubject };
  }
  return messageCreatedPayload({
    content: "what is my balance?",
    sender: { type: "contact", id: 55, phone_number: args.contactPhone },
    conversation,
  });
}

async function run(
  payload: Record<string, unknown>,
): Promise<{ runtime: StubAgentRuntime; customerMessages: number; capture: CapturingLogger; privateNotes: number }> {
  const runtime = StubAgentRuntime.answering("Here is your answer.");
  const capture = new CapturingLogger();
  const server = await startServer({
    runtime,
    logger: capture.logger,
    customerScope: createFixtureCustomerScopeResolver([FIXTURE]),
  });
  try {
    const res = await postWebhook(server.url, signRequest({ rawBody: JSON.stringify(payload) }));
    expect(res.status).toBe(200);
    await server.gateway.drain();
    return {
      runtime,
      customerMessages: server.chatwoot.customerMessages.length,
      privateNotes: server.chatwoot.privateNotes.length,
      capture,
    };
  } finally {
    await server.close();
  }
}

describe("a mutable CONTACT field never moves the verified scope (CONTROLLED FIXTURE)", () => {
  it("CONTROL 2 (multi-gate, Law 20): in each scenario the channel-bound subject and the contact phone are DIFFERENT values", () => {
    const edited = body({ channelSubject: STRANGER_ID, contactPhone: FIXTURE.senderPhone }) as any;
    expect(edited.conversation.contact_inbox.source_id).toBe(STRANGER_ID);
    expect(edited.sender.phone_number).toBe(FIXTURE.senderPhone);
    expect(edited.conversation.contact_inbox.source_id).not.toBe(edited.sender.phone_number);

    const reverse = body({ channelSubject: FIXTURE_ID, contactPhone: STRANGER_PHONE }) as any;
    expect(reverse.conversation.contact_inbox.source_id).not.toBe(reverse.sender.phone_number);
  });

  it("CONTROL 1 (parser): the gateway reads BOTH nodes into different fields, so a test below cannot pass by reading the same variable", () => {
    const parsed = parseWebhookPayload(
      Buffer.from(JSON.stringify(body({ channelSubject: STRANGER_ID, contactPhone: FIXTURE.senderPhone }))),
    ) as any;
    expect(parsed.senderPhone).toBe(FIXTURE.senderPhone);
    expect(parsed.channelSubject, "the parser does not expose the channel-bound subject").toBe(STRANGER_ID);
  });

  it("POSITIVE CONTROL: the channel-bound subject IS the fixture and the contact phone is unchanged => the fixture is verified and answered", async () => {
    const r = await run(body({ channelSubject: FIXTURE_ID, contactPhone: FIXTURE.senderPhone }));
    expect(r.runtime.requests).toHaveLength(1);
    expect((r.runtime.requests[0]!.context as Record<string, any>)["customerScope"]).toMatchObject({
      kind: "verified",
      customerId: "fixture-owner-test-account",
    });
    expect(r.customerMessages).toBe(1);
  });

  it("CONTACT EDITED TO A CUSTOMER'S NUMBER: a stranger whose contact phone was edited to the fixture's number is NOT the fixture", async () => {
    const r = await run(body({ channelSubject: STRANGER_ID, contactPhone: FIXTURE.senderPhone }));
    expect(r.runtime.requests, "the model ran for a sender the channel bound to someone else").toHaveLength(0);
    expect(r.customerMessages).toBe(0);
    expect(r.capture.withOutcome("customer_scope_unresolved").length).toBeGreaterThanOrEqual(1);
    expect(r.privateNotes, "a human was not shown the conversation").toBeGreaterThanOrEqual(1);
  });

  it("CONTACT EDITED AWAY: the real fixture's contact phone changed to a stranger's number does NOT move the scope away from the fixture", async () => {
    const r = await run(body({ channelSubject: FIXTURE_ID, contactPhone: STRANGER_PHONE }));
    expect(r.runtime.requests).toHaveLength(1);
    expect((r.runtime.requests[0]!.context as Record<string, any>)["customerScope"]).toMatchObject({
      kind: "verified",
      customerId: "fixture-owner-test-account",
    });
    // and the stranger's number never reached the resolver's answer
    expect(JSON.stringify((r.runtime.requests[0]!.context as Record<string, any>)["customerScope"])).not.toContain(
      STRANGER_ID,
    );
  });

  it("NO CHANNEL-BOUND SUBJECT (contact_inbox absent): fail closed even though the contact phone matches a fixture", async () => {
    const r = await run(body({ channelSubject: null, contactPhone: FIXTURE.senderPhone }));
    expect(r.runtime.requests, "the model ran with no channel-bound subject").toHaveLength(0);
    expect(r.customerMessages).toBe(0);
    expect(r.capture.withOutcome("customer_scope_unresolved").length).toBeGreaterThanOrEqual(1);
  });
});
