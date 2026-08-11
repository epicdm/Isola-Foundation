import { describe, expect, it } from "vitest";

import { idempotencyKey } from "../src/idempotency.js";

describe("idempotencyKey", () => {
  it("prefers the delivery header", () => {
    expect(
      idempotencyKey({
        deliveryId: "abc",
        accountId: 1,
        conversationId: 42,
        messageId: 9001,
        event: "message_created",
      }),
    ).toBe("delivery:abc");
  });

  it("falls back to (account, conversation, message, event)", () => {
    expect(
      idempotencyKey({
        deliveryId: null,
        accountId: 1,
        conversationId: 42,
        messageId: 9001,
        event: "message_created",
      }),
    ).toBe("msg:1:42:9001:message_created");
  });

  it("returns null when neither key can be formed", () => {
    expect(
      idempotencyKey({
        deliveryId: null,
        accountId: 1,
        conversationId: null,
        messageId: 9001,
        event: "message_created",
      }),
    ).toBeNull();
  });
});
