/**
 * Reconciliation against what an AgentBot can actually read.
 *
 * The first implementation of this scanned `GET .../conversations/{id}/messages`
 * and was wrong on the deployed stack: from
 * `AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS` in v4.16.1, a bot may only
 * `create` on that controller, so the index answers
 * `401 {"error":"Access to this endpoint is not authorized for bots"}`.
 * Confirmed live before this was rewritten.
 *
 * What a bot CAN read is `conversations#show`, whose partial exposes exactly
 * two messages: `messages` (the single newest, possibly an activity line) and
 * `last_non_activity_message` (the newest real one). Both carry
 * `content_attributes`, so both can carry the delivery ref.
 *
 * A negative is sound only because message ids are monotonic within a
 * conversation: if the newest real message is at or before the inbound message
 * being answered, no reply for this delivery can exist.
 */
import { describe, expect, it } from "vitest";

import { HttpChatwootApi, readVisibleMessages } from "../src/chatwoot.js";
import { DELIVERY_REF_ATTRIBUTE } from "../src/deliveryref.js";
import { createSafeFetch } from "../src/egress.js";

const TARGET = { accountId: 3, conversationId: 12, accessToken: "bot-token" };
const REF = "isola-795be49e760a1099f93bb6ffa89c7a34";
const INBOUND_ID = 62;

/** Shaped from the real payload observed on the deployed stack. */
function record(options: {
  newest?: Record<string, unknown> | null;
  lastReal?: Record<string, unknown> | null;
}): Record<string, unknown> {
  return {
    id: 12,
    status: "pending",
    meta: { assignee: null },
    custom_attributes: {},
    messages: options.newest === null ? [] : [options.newest],
    ...(options.lastReal === undefined
      ? {}
      : { last_non_activity_message: options.lastReal }),
  };
}

const inbound = {
  id: INBOUND_ID,
  message_type: 0,
  private: false,
  created_at: 1_786_459_610,
  content_attributes: {},
};

const ourReply = {
  id: 63,
  message_type: 1,
  private: false,
  created_at: 1_786_459_618,
  content_attributes: { [DELIVERY_REF_ATTRIBUTE]: REF },
};

const activity = {
  id: 64,
  message_type: 2,
  private: false,
  created_at: 1_786_459_618,
  content_attributes: {},
};

const someoneElsesReply = {
  id: 70,
  message_type: 1,
  private: false,
  created_at: 1_786_459_900,
  content_attributes: {},
};

function api(respond: (path: string) => unknown, status = 200): HttpChatwootApi {
  return new HttpChatwootApi({
    baseUrl: "https://chatwoot.example.test",
    safeFetch: createSafeFetch({
      allowlist: ["chatwoot.example.test"],
      transport: async (input) => {
        const path = new URL(String(input)).pathname;
        return new Response(JSON.stringify(respond(path)), {
          status,
          headers: { "content-type": "application/json" },
        });
      },
    }),
  });
}

describe("readVisibleMessages", () => {
  it("reads both bot-visible fields and de-duplicates them", () => {
    const seen = readVisibleMessages(record({ newest: activity, lastReal: ourReply }));
    expect(seen.map((m) => m.id).sort()).toEqual([63, 64]);
    expect(seen.find((m) => m.id === 63)?.deliveryRef).toBe(REF);
    expect(seen.find((m) => m.id === 64)?.isActivity).toBe(true);
    expect(seen.find((m) => m.id === 63)?.isActivity).toBe(false);
  });

  it("does not double-count when both fields are the same message", () => {
    const seen = readVisibleMessages(record({ newest: ourReply, lastReal: ourReply }));
    expect(seen).toHaveLength(1);
  });

  it("reads no message content", () => {
    const withContent = { ...ourReply, content: "the customer's private words" };
    const seen = readVisibleMessages(record({ newest: withContent, lastReal: withContent }));
    expect(JSON.stringify(seen)).not.toContain("private words");
  });
});

describe("reconcileDeliveryRef", () => {
  it("uses conversations#show, NOT the bot-forbidden messages index", async () => {
    const paths: string[] = [];
    const client = api((path) => {
      paths.push(path);
      return record({ newest: activity, lastReal: ourReply });
    });
    await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(paths).toEqual(["/api/v1/accounts/3/conversations/12"]);
    expect(paths.some((p) => p.endsWith("/messages"))).toBe(false);
  });

  it("finds our reply behind a newer activity line", async () => {
    const client = api(() => record({ newest: activity, lastReal: ourReply }));
    expect(await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID)).toEqual({
      kind: "found",
      messageId: 63,
    });
  });

  it("proves absence when the newest real message is the one being answered", async () => {
    const client = api(() => record({ newest: inbound, lastReal: inbound }));
    expect(await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID)).toEqual({
      kind: "absent",
    });
  });

  it("refuses to claim absence when a newer message exists that is not ours", async () => {
    // Ours could be sitting behind that newer message where we cannot see it.
    const client = api(() =>
      record({ newest: someoneElsesReply, lastReal: someoneElsesReply }),
    );
    const result = await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(result.kind).toBe("inconclusive");
  });

  it("refuses to claim absence with no pivot to reason from", async () => {
    const client = api(() => record({ newest: inbound, lastReal: inbound }));
    const result = await client.reconcileDeliveryRef(TARGET, REF, null);
    expect(result.kind).toBe("inconclusive");
  });

  it("is inconclusive, never absent, when the read itself fails", async () => {
    const client = api(() => ({ error: "boom" }), 500);
    const result = await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID);
    expect(result.kind).toBe("inconclusive");
  });

  it("treats a conversation with no real message at all as absent", async () => {
    const client = api(() => record({ newest: null, lastReal: null }));
    expect(await client.reconcileDeliveryRef(TARGET, REF, INBOUND_ID)).toEqual({
      kind: "absent",
    });
  });
});
