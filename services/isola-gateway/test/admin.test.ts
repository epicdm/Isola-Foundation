/**
 * `GET /healthz` and `GET /v1/bindings`.
 */
import { describe, expect, it } from "vitest";

import {
  ADMIN_TOKEN,
  BOT_ACCESS_TOKEN,
  BOT_SECRET,
  bindingsJson,
  envConfig,
  get,
  makeBinding,
  placeholder,
  startServer,
} from "./harness.js";

describe("GET /healthz", () => {
  it("answers without auth and reports the binding count and the allowlist", async () => {
    const server = await startServer();
    try {
      const res = await get(server.url, "/healthz");
      expect(res.status).toBe(200);
      expect(res.json["status"]).toBe("ok");
      expect(res.json["bindings"]).toEqual({ total: 1, active: 1, retired: 0 });
      expect(res.json["egressAllowlist"]).toEqual([
        "chatwoot.example.test",
        "isola_isola-runtime",
      ]);
    } finally {
      await server.close();
    }
  });

  it("leaks no secret material", async () => {
    const server = await startServer();
    try {
      const res = await get(server.url, "/healthz");
      expect(res.text).not.toContain(BOT_SECRET);
      expect(res.text).not.toContain(BOT_ACCESS_TOKEN);
      expect(res.text).not.toContain(ADMIN_TOKEN);
      // Internal hostnames stay off the unauthenticated endpoint.
      expect(res.text).not.toContain("isola-runtime:3000");
    } finally {
      await server.close();
    }
  });

  it("counts retired bindings separately", async () => {
    const config = envConfig({
      GATEWAY_BINDINGS_JSON: bindingsJson([
        makeBinding(),
        makeBinding({ chatwootInboxId: 8, tenantId: "t2", status: "retired" }),
      ]),
    });
    const server = await startServer({ config });
    try {
      const res = await get(server.url, "/healthz");
      expect(res.json["bindings"]).toEqual({ total: 2, active: 1, retired: 1 });
    } finally {
      await server.close();
    }
  });
});

describe("GET /v1/bindings", () => {
  it("requires the admin bearer", async () => {
    const server = await startServer();
    try {
      expect((await get(server.url, "/v1/bindings")).status).toBe(401);
      expect((await get(server.url, "/v1/bindings", placeholder("wrong"))).status).toBe(401);
    } finally {
      await server.close();
    }
  });

  it("returns binding metadata with every secret redacted", async () => {
    const server = await startServer();
    try {
      const res = await get(server.url, "/v1/bindings", ADMIN_TOKEN);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain(BOT_SECRET);
      expect(res.text).not.toContain(BOT_ACCESS_TOKEN);
      const bindings = res.json["bindings"] as Array<Record<string, unknown>>;
      expect(bindings).toHaveLength(1);
      expect(bindings[0]?.["tenantId"]).toBe("tenant-acme");
      expect(bindings[0]?.["agentBotSecret"]).toBe("[redacted]");
      expect(bindings[0]?.["agentBotAccessTokenConfigured"]).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("fails closed with 503 when no admin token is configured", async () => {
    const config = envConfig({ GATEWAY_ADMIN_TOKEN: "" });
    const server = await startServer({ config });
    try {
      const res = await get(server.url, "/v1/bindings", ADMIN_TOKEN);
      expect(res.status).toBe(503);
      expect(res.json["outcome"]).toBe("no_admin_token_configured");
    } finally {
      await server.close();
    }
  });

  it("405s a POST", async () => {
    const server = await startServer();
    try {
      const res = await fetch(`${server.url}/v1/bindings`, { method: "POST" });
      expect(res.status).toBe(405);
    } finally {
      await server.close();
    }
  });
});
