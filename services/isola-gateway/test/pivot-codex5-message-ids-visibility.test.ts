/**
 * CODEX ROUND 5 (review of e5dbea9): G5-3 -- `Number.isFinite` accepted -1, 0, 0.5 and -0.5 as
 * Chatwoot message ids, so a malformed conversation record read as "well formed, nothing
 * of ours in it" and reconciliation reported ABSENT; `sendGuardedMessage` then sent a SECOND
 * copy of a reply that was already committed (two modelled commits). A contradictory
 * `last_non_activity_message` (an activity line, or one that disagrees with the newest
 * message) produced the same false negative once the activity filter removed all the
 * real-message evidence.
 *
 * The rule under test: a message id is a POSITIVE SAFE INTEGER (a number: the API gives
 * numbers, so a digit STRING is unreadable too), and the visibility fields must agree with
 * each other. Anything else is UNKNOWN (`inconclusive`), and an unknown never authorises a
 * second POST (at-most-once).
 *
 * ALL TESTS HERE ARE SOCKET-FREE (an injected transport). Every refusal has its positive
 * twin in the same harness (Laws 11, 19, 23, 28): a well-formed record still proves absence,
 * and our own message is still found.
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi } from "../src/chatwoot.js";
import { DELIVERY_REF_ATTRIBUTE, deliveryRef } from "../src/deliveryref.js";
import { createSafeFetch } from "../src/egress.js";
import { DISARMED } from "../src/failpoint.js";
import { sendGuardedMessage, type WriteContext, type WriteDeps } from "../src/writes.js";
import { CapturingLogger, FakeLedger } from "./harness.js";

const TARGET = { accountId: 3, conversationId: 12, accessToken: "bot-token" };
const INBOUND_ID = 62;
const IDENTITY = {
  tenantId: "tenant-g53",
  bindingId: "binding-g53",
  chatwootAccountId: 3,
  chatwootInboxId: 9,
  eventId: "delivery:g53",
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
// A real message that is NOT ours (no delivery reference): evidence-free, so a malformed record around it
// must not be read as proof of anything. (A record that holds OUR reference is FOUND, which is the safe
// direction: found sends nothing.)
const other = { id: 64, message_type: 1, private: false, created_at: 1_786_459_620, content_attributes: {} };
const activity = { id: 70, message_type: 2, private: false, created_at: 1_786_459_700, content_attributes: {} };

type Body = { raw: string };
const json = (value: unknown): Body => ({ raw: JSON.stringify(value) });

function client(conversationBody: Body, posts: { n: number }, postedId: unknown = undefined): HttpChatwootApi {
  return new HttpChatwootApi({
    baseUrl: "https://chatwoot.example.test",
    safeFetch: createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async (_input, init) => {
        if (init?.method === "POST") {
          posts.n += 1;
          return new Response(JSON.stringify({ id: postedId === undefined ? 9000 + posts.n : postedId }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(conversationBody.raw, { status: 200, headers: { "content-type": "application/json" } });
      },
    }),
  });
}

// ---------------------------------------------------------------------------
// 1. Message ids: positive safe integers only
// ---------------------------------------------------------------------------

const BAD_IDS: Array<[string, unknown]> = [
  ["-1", -1],
  ["0", 0],
  ["0.5", 0.5],
  ["-0.5", -0.5],
  ["an unsafe integer (2^53)", 9007199254740992],
  ["a digit string (the API gives numbers)", "63"],
  ["null", null],
];

describe("G5-3 (the client): a message id is a positive safe integer, or the record is unreadable", () => {
  for (const [label, badId] of BAD_IDS) {
    it(`id ${label} in messages => INCONCLUSIVE`, async () => {
      const posts = { n: 0 };
      const result = await client(
        json({ messages: [{ ...other, id: badId }], last_non_activity_message: other }),
        posts,
      ).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
      expect(result.kind).toBe("inconclusive");
    });

    it(`id ${label} in last_non_activity_message => INCONCLUSIVE`, async () => {
      const posts = { n: 0 };
      const result = await client(
        json({ messages: [inbound], last_non_activity_message: { ...inbound, id: badId } }),
        posts,
      ).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
      expect(result.kind).toBe("inconclusive");
    });
  }

  it("a postMessage response carrying id -1 or 0 is not a message id (recorded as null, never as -1)", async () => {
    for (const bad of [-1, 0, 0.5]) {
      const posts = { n: 0 };
      const id = await client(json({ messages: [], last_non_activity_message: null }), posts, bad).postMessage(
        TARGET,
        "hello",
        false,
        REF,
      );
      expect(id, `postMessage accepted ${bad} as a message id`).toBeNull();
    }
  });

  it("CONTROL: positive safe-integer ids still read (our message is FOUND, an inbound-newest record is ABSENT)", async () => {
    const posts = { n: 0 };
    const found = await client(json({ messages: [ours], last_non_activity_message: ours }), posts).reconcileDeliveryRef(
      TARGET,
      REF,
      INBOUND_ID,
    );
    expect(found).toEqual({ kind: "found", messageId: 63 });
    const absent = await client(
      json({ messages: [inbound], last_non_activity_message: inbound }),
      posts,
    ).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(absent).toEqual({ kind: "absent" });
    const id = await client(json({ messages: [], last_non_activity_message: null }), posts, 77).postMessage(
      TARGET,
      "hello",
      false,
      REF,
    );
    expect(id).toBe(77);
  });
});

// ---------------------------------------------------------------------------
// 2. Visibility invariants: contradictory fields prove nothing
// ---------------------------------------------------------------------------

const CONTRADICTORY: Array<[string, Body]> = [
  [
    "last_non_activity_message that is itself an activity line (Codex's probe)",
    json({ messages: [activity], last_non_activity_message: activity }),
  ],
  [
    "the newest message is a real one but last_non_activity_message is null",
    json({ messages: [other], last_non_activity_message: null }),
  ],
  [
    "the newest message is a real one but last_non_activity_message is OLDER than it",
    json({ messages: [other], last_non_activity_message: inbound }),
  ],
  [
    "the newest message overall is OLDER than last_non_activity_message",
    json({ messages: [inbound], last_non_activity_message: other }),
  ],
];

describe("G5-3 (the client): contradictory visibility metadata is INCONCLUSIVE, never absent", () => {
  for (const [label, body] of CONTRADICTORY) {
    it(`${label}`, async () => {
      const posts = { n: 0 };
      const result = await client(body, posts).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
      expect(result.kind).toBe("inconclusive");
    });
  }

  it("CONTROL: an activity line NEWER than the last real message is legitimate (the real shape) and still ABSENT", async () => {
    const posts = { n: 0 };
    const result = await client(
      json({ messages: [activity], last_non_activity_message: inbound }),
      posts,
    ).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(result).toEqual({ kind: "absent" });
  });

  it("CONTROL: the newest message and last_non_activity_message agreeing on a real message is legitimate", async () => {
    const posts = { n: 0 };
    const result = await client(
      json({ messages: [inbound], last_non_activity_message: inbound }),
      posts,
    ).reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(result).toEqual({ kind: "absent" });
  });
});

// ---------------------------------------------------------------------------
// 3. The PATH (Law 20): Codex's duplicate, through sendGuardedMessage and the real client
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
    digest: "digest-g53",
    correlationId: "corr-g53",
    pivotMessageId: INBOUND_ID,
    base: {},
  };
  // An earlier attempt claimed the reply and never recorded an outcome.
  await ledger.claimAction(IDENTITY, "reply", "digest-g53", "corr-g53", 300_000);
  const outcome = await sendGuardedMessage(deps, context, "reply", TARGET, "hello", false);
  return { outcome, posts };
}

describe("G5-3 (the PATH): an already-committed reply is never sent a second time on malformed ids", () => {
  for (const [label, badId] of BAD_IDS) {
    it(`id ${label}: the committed reply is AMBIGUOUS, ZERO POSTs`, async () => {
      // The reply IS in the conversation (a committed message with our reference) but its
      // visibility metadata carries a malformed id: the record proves nothing.
      const { outcome, posts } = await ambiguousReply(
        json({ messages: [{ ...ours, id: badId }], last_non_activity_message: { ...ours, id: badId } }),
      );
      expect(outcome.kind, "the malformed id was read as ABSENT and a second copy was sent").toBe("ambiguous");
      expect(posts.n).toBe(0);
    });
  }

  for (const [label, body] of CONTRADICTORY) {
    it(`${label}: AMBIGUOUS, ZERO POSTs`, async () => {
      const { outcome, posts } = await ambiguousReply(body);
      expect(outcome.kind).toBe("ambiguous");
      expect(posts.n).toBe(0);
    });
  }

  it("CONTROL: a well-formed record proving absence DOES send, exactly once", async () => {
    const { outcome, posts } = await ambiguousReply(json({ messages: [inbound], last_non_activity_message: inbound }));
    expect(outcome.kind).toBe("sent");
    expect(posts.n).toBe(1);
  });
});
