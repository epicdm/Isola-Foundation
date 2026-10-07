import { describe, it, expect, vi, beforeEach } from "vitest";
import { PortClient } from "../src/portClient.js";
import { getEntity, listDecisions, searchPort, listOpenBlockers, type ToolContext } from "../src/tools.js";
import type { AuditLogger } from "../src/audit.js";

function makeNoopAudit(): AuditLogger {
  return { record: vi.fn(async () => {}) };
}

describe("get_entity - invalid input handling", () => {
  it("returns a safe error object (not a crash) for a non-allowlisted blueprint", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await getEntity(ctx, "some-id", "customer_pii_record");
    expect(result).toEqual({ error: expect.stringContaining("not in the allowlist") });
  });

  it("returns a safe error object for an empty/invalid entity id", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await getEntity(ctx, "", "build_task");
    expect(result).toEqual({ error: expect.stringContaining("Invalid entity id") });
  });

  it("returns port_unavailable_or_stale (not a throw) when Port is unreachable for a valid id/blueprint", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await getEntity(ctx, "bt-release-control-implementation", "build_task");
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });
});

describe("pagination caps at the tool layer", () => {
  it("list_decisions never returns more rows than the clamped max of 100 even if caller asks for 500", async () => {
    const fakeEntities = Array.from({ length: 150 }, (_, i) => ({
      blueprint: "decision",
      identifier: `decision-${i}`,
      $updatedAt: new Date(2026, 0, i + 1).toISOString(),
      properties: {}
    }));
    const fakeFetch = vi.fn(async () => new Response(JSON.stringify({ entities: fakeEntities }), { status: 200 })) as unknown as typeof fetch;
    const client = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: fakeFetch });
    // Force a token so ensureToken short-circuits — simulate by monkey-patching rawRequest indirectly via fetch responses.
    const tokenFetch = vi.fn(async (url: string) => {
      if (String(url).includes("access_token")) {
        return new Response(JSON.stringify({ accessToken: "tok", expiresIn: 3600 }), { status: 200 });
      }
      return new Response(JSON.stringify({ entities: fakeEntities }), { status: 200 });
    }) as unknown as typeof fetch;
    const client2 = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: tokenFetch });
    const ctx: ToolContext = { client: client2, audit: makeNoopAudit(), callerRef: "test" };
    const result: any = await listDecisions(ctx, { limit: 500 });
    expect(result.rows.length).toBeLessThanOrEqual(100);
  });
});

describe("search_port outage graceful handling", () => {
  it("returns port_unavailable_or_stale on a simulated 5xx from /v1/entities/search", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (String(url).includes("access_token")) {
        return new Response(JSON.stringify({ accessToken: "tok", expiresIn: 3600 }), { status: 200 });
      }
      return new Response(null, { status: 502 });
    }) as unknown as typeof fetch;
    const client = new PortClient({ clientId: "id", clientSecret: "secret", fetchImpl: fakeFetch });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await searchPort(ctx, "consent");
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });

  it("returns a validation error object (not a crash) for an empty query", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await searchPort(ctx, "");
    expect(result).toEqual({ error: expect.any(String) });
  });
});

describe("list_open_blockers outage handling", () => {
  it("returns port_unavailable_or_stale when both defect and build_task lookups fail", async () => {
    const client = new PortClient({ clientId: undefined, clientSecret: undefined });
    const ctx: ToolContext = { client, audit: makeNoopAudit(), callerRef: "test" };
    const result = await listOpenBlockers(ctx);
    expect(result).toEqual({ status: "port_unavailable_or_stale", detail: expect.any(String) });
  });
});

