import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  isAuthorized,
  extractBearerToken,
  RateLimiter,
  clampPagination,
  capResponseSize,
  MAX_RESPONSE_BYTES,
  MAX_PAGE_LIMIT,
  DEFAULT_PAGE_LIMIT
} from "../src/auth.js";

describe("bearer auth", () => {
  const ORIGINAL = process.env.MCP_BEARER_TOKEN;

  beforeEach(() => {
    process.env.MCP_BEARER_TOKEN = "test-token-abc123";
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_BEARER_TOKEN;
    else process.env.MCP_BEARER_TOKEN = ORIGINAL;
  });

  it("returns 401-equivalent (isAuthorized=false) with no Authorization header", () => {
    expect(isAuthorized(null)).toBe(false);
    expect(isAuthorized(undefined)).toBe(false);
  });

  it("rejects a malformed Authorization header", () => {
    expect(isAuthorized("NotBearer sometoken")).toBe(false);
  });

  it("rejects an incorrect bearer token", () => {
    expect(isAuthorized("Bearer wrong-token")).toBe(false);
  });

  it("passes with the correct bearer token", () => {
    expect(isAuthorized("Bearer test-token-abc123")).toBe(true);
  });

  it("fails closed (rejects everything) when MCP_BEARER_TOKEN is unset", () => {
    delete process.env.MCP_BEARER_TOKEN;
    expect(isAuthorized("Bearer anything")).toBe(false);
  });

  it("extractBearerToken parses the token out of the header", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken(null)).toBeNull();
  });
});

describe("rate limiter", () => {
  it("allows up to the limit within a window, then trips", () => {
    let now = 0;
    const limiter = new RateLimiter(60, 60_000, () => now);
    for (let i = 0; i < 60; i++) {
      expect(limiter.tryConsume("caller-a")).toBe(true);
    }
    expect(limiter.tryConsume("caller-a")).toBe(false);
  });

  it("resets after the window elapses", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 1000, () => now);
    for (let i = 0; i < 5; i++) expect(limiter.tryConsume("x")).toBe(true);
    expect(limiter.tryConsume("x")).toBe(false);
    now += 1001;
    expect(limiter.tryConsume("x")).toBe(true);
  });

  it("tracks separate callers independently", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(true);
    expect(limiter.tryConsume("a")).toBe(false);
    expect(limiter.tryConsume("b")).toBe(true);
  });
});

describe("pagination clamping", () => {
  it("defaults to 25 when no limit given", () => {
    expect(clampPagination(undefined).limit).toBe(DEFAULT_PAGE_LIMIT);
  });

  it("clamps at 100 even when caller requests more", () => {
    expect(clampPagination({ limit: 5000 }).limit).toBe(MAX_PAGE_LIMIT);
    expect(clampPagination({ limit: 101 }).limit).toBe(100);
  });

  it("passes through a valid limit under the cap", () => {
    expect(clampPagination({ limit: 10 }).limit).toBe(10);
  });

  it("passes cursor/offset through untouched", () => {
    const result = clampPagination({ limit: 10, cursor: "abc", offset: 40 });
    expect(result.cursor).toBe("abc");
    expect(result.offset).toBe(40);
  });
});

describe("response size capping", () => {
  it("does not truncate a small payload", () => {
    const result = capResponseSize({ rows: [1, 2, 3] });
    expect(result.truncated).toBe(false);
  });

  it("truncates and flags an oversized payload (>200KB)", () => {
    const bigString = "x".repeat(MAX_RESPONSE_BYTES + 1000);
    const result = capResponseSize({ data: bigString });
    expect(result.truncated).toBe(true);
    const parsed = JSON.parse(result.body);
    expect(parsed.truncated).toBe(true);
    expect(typeof parsed.note).toBe("string");
  });
});

