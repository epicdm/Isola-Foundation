/**
 * CODEX ROUND 4 (review of 103c353): G4-3 -- a 200 that is empty, non-JSON, `null`, `{}` or
 * carries malformed message ids was read as "no visible messages", reconciliation then
 * reported ABSENT and `sendGuardedMessage` sent a SECOND POST (two modelled commits).
 *
 * The rule under test: ONLY a well-formed conversation record can prove absence. Anything
 * the client cannot read as such is UNKNOWN (`inconclusive`), and an unknown means the
 * message is never re-sent (at-most-once; the owner-page recommendation).
 *
 * ALL TESTS HERE ARE SOCKET-FREE (an injected transport).
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28): a
 * well-formed empty record and a well-formed "inbound is the newest" record are still
 * ABSENT, and the second POST still happens there.
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi } from "../src/chatwoot.js";
import { DELIVERY_REF_ATTRIBUTE, deliveryRef } from "../src/deliveryref.js";
import { DISARMED } from "../src/failpoint.js";
import { createSafeFetch } from "../src/egress.js";
import { sendGuardedMessage, type WriteContext, type WriteDeps } from "../src/writes.js";
import { CapturingLogger, FakeLedger } from "./harness.js";

const TARGET = { accountId: 3, conversationId: 12, accessToken: "bot-token" };
const INBOUND_ID = 62;
const IDENTITY = {
  tenantId: "tenant-g43",
  bindingId: "binding-g43",
  chatwootAccountId: 3,
  chatwootInboxId: 9,
  eventId: "delivery:g43",
};
const REF = deliveryRef(IDENTITY, "reply");

const inbound = { id: INBOUND_ID, message_type: 0, private: false, created_at: 1_786_459_610, content_attributes: {} };
const ours = {
  id: 63,
  message_type: 1,
  private: false,
  created_at: 1_786_459_618,
  content_attributes: { [DELIVERY_REF_ATTRIBUTE]: REF },
};

type Body = { raw: string };
const json = (value: unknown): Body => ({ raw: JSON.stringify(value) });

function client(conversationBody: Body, posts: { n: number }): HttpChatwootApi {
  return new HttpChatwootApi({
    baseUrl: "https://chatwoot.example.test",
    safeFetch: createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async (_input, init) => {
        if (init?.method === "POST") {
          posts.n += 1;
          return new Response(JSON.stringify({ id: 9000 + posts.n }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(conversationBody.raw, { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
}

// Everything a 200 can be that is NOT a readable conversation record proving anything.
const UNREADABLE: Array<[string, Body]> = [
  ["an empty body", { raw: "" }],
  ["non-JSON text", { raw: "<html>bad gateway</html>" }],
  ["JSON null", { raw: "null" }],
  ["an empty object", { raw: "{}" }],
  ["a bare array", { raw: "[]" }],
  ["messages that is not an array", json({ messages: "nope", last_non_activity_message: null })],
  ["a record without the last_non_activity_message field", json({ messages: [] })],
  ["a message whose id is a string", json({ messages: [{ ...inbound, id: "62" }], last_non_activity_message: null })],
  ["a message with no id", json({ messages: [{ message_type: 0, private: false }], last_non_activity_message: null })],
  ["a message whose id is NaN-like (null)", json({ messages: [{ ...inbound, id: null }], last_non_activity_message: null })],
  ["a malformed last_non_activity_message", json({ messages: [inbound], last_non_activity_message: { id: "x" } })],
  ["a last_non_activity_message that is not an object", json({ messages: [inbound], last_non_activity_message: 62 })],
];

describe("G4-3 (the client): only a well-formed record proves absence", () => {
  for (const [label, body] of UNREADABLE) {
    it(`${label} => INCONCLUSIVE (never absent)`, async () => {
      const posts = { n: 0 };
      const result = await client(body, posts).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
      expect(result.kind).toBe("inconclusive");
      expect(posts.n).toBe(0);
    });
  }

  it("CONTROL: a well-formed EMPTY conversation (no messages, last_non_activity_message null) is still ABSENT", async () => {
    const posts = { n: 0 };
    const result = await client(json({ messages: [], last_non_activity_message: null }), posts).reconcileDeliveryRef(
      TARGET,
      REF,
      INBOUND_ID,
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("CONTROL: a well-formed record whose newest real message is the inbound one is still ABSENT", async () => {
    const posts = { n: 0 };
    const result = await client(json({ messages: [inbound], last_non_activity_message: inbound }), posts).reconcileDeliveryRef(
      TARGET,
      REF,
      INBOUND_ID,
    );
    expect(result).toEqual({ kind: "absent" });
  });

  it("CONTROL: our own message is still FOUND", async () => {
    const posts = { n: 0 };
    const result = await client(json({ messages: [ours], last_non_activity_message: ours }), posts).reconcileDeliveryRef(
      TARGET,
      REF,
      INBOUND_ID,
    );
    expect(result).toEqual({ kind: "found", messageId: 63 });
  });
});

// ---------------------------------------------------------------------------
// The PATH (Law 20): an ambiguous claim, then reconciliation against the real client.
// ---------------------------------------------------------------------------

async function ambiguousReply(conversationBody: Body) {
  const posts = { n: 0 };
  const ledger = new FakeLedger();
  const capture = new CapturingLogger();
  const deps: WriteDeps = {
    chatwoot: client(conversationBody, posts),
    ledger,
    logger: capture.logger,
    leaseMs: 300_000,
    failpoint: DISARMED,
  };
  const context: WriteContext = {
    identity: IDENTITY,
    digest: "digest-g43",
    correlationId: "corr-g43",
    pivotMessageId: INBOUND_ID,
    base: {},
  };
  // An earlier attempt claimed the reply and never recorded an outcome.
  await ledger.claimAction(IDENTITY, "reply", "digest-g43", "corr-g43", 300_000);
  const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);
  return { outcome, posts, ledger };
}

describe("G4-3 (the PATH): an unreadable reconciliation never authorises a second POST", () => {
  for (const [label, body] of UNREADABLE) {
    it(`${label}: the claimed reply is AMBIGUOUS, ZERO POSTs`, async () => {
      const { outcome, posts } = await ambiguousReply(body);
      expect(outcome.kind).toBe("ambiguous");
      expect(posts.n, "a second POST was issued on an unreadable response").toBe(0);
    });
  }

  it("CONTROL: a well-formed record proving absence DOES send, exactly once", async () => {
    const { outcome, posts } = await ambiguousReply(json({ messages: [inbound], last_non_activity_message: inbound }));
    expect(outcome.kind).toBe("sent");
    expect(posts.n).toBe(1);
  });

  it("CONTROL: a well-formed record that already holds our message settles it and sends nothing", async () => {
    const { outcome, posts } = await ambiguousReply(json({ messages: [ours], last_non_activity_message: ours }));
    expect(outcome.kind).toBe("already_present");
    expect(posts.n).toBe(0);
  });
});
