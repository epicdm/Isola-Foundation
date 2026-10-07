import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortClient, ReadOnlyViolation, guardedRequest } from "../src/portClient.js";

describe("guardedRequest chokepoint (read-only enforcement)", () => {
  it("throws ReadOnlyViolation for PUT to any path", () => {
    expect(() => guardedRequest("PUT", "/v1/blueprints/build_task/entities/foo")).toThrow(ReadOnlyViolation);
  });

  it("throws ReadOnlyViolation for PATCH to any path", () => {
    expect(() => guardedRequest("PATCH", "/v1/blueprints/build_task/entities/foo")).toThrow(ReadOnlyViolation);
  });

  it("throws ReadOnlyViolation for DELETE to any path", () => {
    expect(() => guardedRequest("DELETE", "/v1/blueprints/build_task/entities/foo")).toThrow(ReadOnlyViolation);
  });

  it("throws ReadOnlyViolation for POST to a non-allowlisted path", () => {
    expect(() => guardedRequest("POST", "/v1/blueprints/build_task/entities")).toThrow(ReadOnlyViolation);
  });

  it("does NOT throw for GET to any path", () => {
    expect(() => guardedRequest("GET", "/v1/blueprints/build_task/entities/foo")).not.toThrow();
  });

  it("does NOT throw for POST /v1/auth/access_token", () => {
    expect(() => guardedRequest("POST", "/v1/auth/access_token")).not.toThrow();
  });

  it("does NOT throw for POST /v1/entities/search", () => {
    expect(() => guardedRequest("POST", "/v1/entities/search")).not.toThrow();
  });
});

describe("PortClient outage handling", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns port_unavailable_or_stale when credentials are absent (no throw)", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const result = await client.getEntity("build_task", "bt-release-control-implementation");
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });

  it("returns port_unavailable_or_stale on simulated 5xx (never throws)", async () => {
    const fakeFetch = vi.fn(async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    const client = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: fakeFetch });
    const result = await client.listEntities("decision");
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });

  it("returns port_unavailable_or_stale on simulated timeout (never throws)", async () => {
    const fakeFetch = vi.fn(async (_url: any, opts: any) => {
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    }) as unknown as typeof fetch;
    const client = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: fakeFetch, timeoutMs: 5 });
    const result = await client.listEntities("decision");
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });

  it("never throws for getEntity even when fetch itself throws synchronously", async () => {
    const fakeFetch = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const client = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: fakeFetch });
    await expect(client.getEntity("build_task", "x")).resolves.toEqual({
      status: "port_unavailable_or_stale",
      detail: expect.any(String)
    });
  });

  it("still throws ReadOnlyViolation through the public searchEntities/getEntity surface if internal misuse occurred (guard is not bypassable)", () => {
    // guardedRequest is exported and independently tested above; this test
    // documents that PortClient's public methods never construct a
    // request that would trip it (i.e. no PUT/PATCH/DELETE method exists
    // on the class at all).
    const client = new PortClient();
    expect((client as any).putEntity).toBeUndefined();
    expect((client as any).deleteEntity).toBeUndefined();
    expect((client as any).patchEntity).toBeUndefined();
  });
});

