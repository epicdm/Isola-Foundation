import { describe, expect, it } from "vitest";

import { idempotencyKey, MemoryIdempotencyStore } from "../src/idempotency.js";

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

describe("MemoryIdempotencyStore", () => {
  it("claims a key once", () => {
    const store = new MemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 10 });
    expect(store.claim("a", 0)).toBe(true);
    expect(store.claim("a", 1)).toBe(false);
    expect(store.claim("b", 1)).toBe(true);
  });

  it("forgets a key after the ttl", () => {
    const store = new MemoryIdempotencyStore({ ttlMs: 1000, maxEntries: 10 });
    expect(store.claim("a", 0)).toBe(true);
    expect(store.claim("a", 999)).toBe(false);
    expect(store.claim("a", 1001)).toBe(true);
  });

  it("evicts the oldest entries past the cap rather than growing forever", () => {
    const store = new MemoryIdempotencyStore({ ttlMs: 100_000, maxEntries: 3 });
    for (const key of ["a", "b", "c", "d"]) store.claim(key, 1);
    expect(store.size()).toBe(3);
    // "a" was evicted, so it can be claimed again; "d" is still held.
    expect(store.claim("a", 2)).toBe(true);
    expect(store.claim("d", 2)).toBe(false);
  });

  it("prunes expired entries as time moves on", () => {
    const store = new MemoryIdempotencyStore({ ttlMs: 10, maxEntries: 100 });
    store.claim("a", 0);
    store.claim("b", 1);
    store.claim("c", 100);
    expect(store.size()).toBe(1);
  });
});
