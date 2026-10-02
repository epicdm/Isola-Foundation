/**
 * CODEX FIX ROUND 2 (review of 9799a84): R1 + R5.   ALL TESTS HERE ARE SOCKET-FREE
 * (an injected transport, no listener), so a sandbox that cannot bind a loopback
 * port can run them.
 *
 *   R1 (P1, blocking)  the egress guard validated only the INITIAL url. A native
 *       fetch follows redirects on its own, so an allowed POST answered
 *       `307 Location: https://excluded.test/...` was re-sent to the excluded
 *       host WITH the customer-bearing body. The guard is now `redirect: "manual"`
 *       and ANY 3xx is a refusal (a config defect), never followed and never re-sent.
 *   R5 (P2)            `https://user:pass@host` passed boot validation but fetch throws
 *       before sending, and the runtime then reported an UNCERTAIN create. Boot now
 *       refuses userinfo, and the runtime classifies it as a config defect with
 *       nothing sent.
 *
 * Every refusal has its positive twin in the same harness (Laws 11, 19, 23, 28), and
 * the harness proves it CAN follow a redirect (the "follows when asked" control): a
 * test that only shows "nothing reached the excluded host" would also pass if the
 * harness could never reach it.
 */
import { describe, expect, it } from "vitest";

import { bootErrors, loadConfig } from "../src/config.js";
import { createSafeFetch, EgressBlockedError, type FetchLike } from "../src/egress.js";
import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { BASE_ENV } from "./harness.js";

const CUSTOMER_BODY = JSON.stringify({ customerId: "cust", text: "message" });
const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";

interface Seen {
  url: string;
  method: string;
  body: string | null;
}

/**
 * A transport that behaves like the platform fetch with respect to redirects:
 *   redirect "follow" (the default)  -> a 3xx with a Location is FOLLOWED, same method
 *       and body for 307/308, GET without a body for 301/302/303 on a POST (the spec),
 *       through THIS SAME transport (it does not pass back through the guard);
 *   redirect "manual"                -> the 3xx response is RETURNED.
 * Hosts in `redirects` answer with that 3xx; every other host answers 200.
 */
function followingTransport(redirects: Record<string, { status: number; location: string }>): {
  transport: FetchLike;
  seen: Seen[];
} {
  const seen: Seen[] = [];
  const transport: FetchLike = async (input, init) => {
    const url = String(input);
    const host = new URL(url).hostname;
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : null;
    seen.push({ url, method, body });
    const hop = redirects[host];
    if (hop === undefined) return new Response("{}", { status: 200 });
    const redirectMode = init?.redirect ?? "follow";
    if (redirectMode === "manual") {
      return new Response(null, { status: hop.status, headers: { location: hop.location } });
    }
    if (redirectMode === "error") throw new TypeError("redirect mode is set to error");
    const keepsBody = hop.status === 307 || hop.status === 308;
    const next = hop.location;
    seen.push({ url: next, method: keepsBody ? method : "GET", body: keepsBody ? body : null });
    return new Response("{}", { status: 200 });
  };
  return { transport, seen };
}

describe("R1: a redirect must never carry the customer body to a host the guard did not check", () => {
  it("HARNESS CONTROL: the redirect-following transport DOES re-send the body to the excluded host when nothing stops it", async () => {
    const { transport, seen } = followingTransport({
      "allowed.test": { status: 307, location: "https://excluded.test/collect" },
    });
    // Called DIRECTLY (no guard): this is what the platform fetch did to Codex's probe.
    await transport("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY });
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(["allowed.test", "excluded.test"]);
    expect(seen[1]?.body).toBe(CUSTOMER_BODY);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`REFUSES a ${status}: the excluded host is never contacted and the body is never re-sent`, async () => {
      const { transport, seen } = followingTransport({
        "allowed.test": { status, location: "https://excluded.test/collect" },
      });
      const safeFetch = createSafeFetch({ allowlist: ["allowed.test"], transport });
      await expect(
        safeFetch("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY }),
      ).rejects.toBeInstanceOf(EgressBlockedError);
      expect(seen.map((s) => new URL(s.url).hostname)).toEqual(["allowed.test"]);
      expect(seen.some((s) => s.url.includes("excluded.test"))).toBe(false);
    });
  }

  it("REFUSES a redirect to ANOTHER ALLOWED host too: a redirect is a config defect, never followed", async () => {
    const { transport, seen } = followingTransport({
      "allowed.test": { status: 307, location: "https://also-allowed.test/x" },
    });
    const safeFetch = createSafeFetch({ allowlist: ["allowed.test", "also-allowed.test"], transport });
    await expect(
      safeFetch("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("a caller that asks for redirect:'follow' is OVERRIDDEN: the guard owns the redirect mode", async () => {
    const { transport, seen } = followingTransport({
      "allowed.test": { status: 307, location: "https://excluded.test/collect" },
    });
    const safeFetch = createSafeFetch({ allowlist: ["allowed.test"], transport });
    await expect(
      safeFetch("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY, redirect: "follow" }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
    expect(seen).toHaveLength(1);
  });

  it("REFUSES an opaque-redirect response (the browser-style manual result, status 0)", async () => {
    const opaque = { type: "opaqueredirect", status: 0, ok: false } as unknown as Response;
    const safeFetch = createSafeFetch({ allowlist: ["allowed.test"], transport: async () => opaque });
    await expect(safeFetch("https://allowed.test/api", { method: "POST" })).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });

  it("the refusal message names the status and never a Location value or the body", async () => {
    const { transport } = followingTransport({
      "allowed.test": { status: 307, location: "https://excluded.test/collect?token=SECRET-IN-LOCATION" },
    });
    const safeFetch = createSafeFetch({ allowlist: ["allowed.test"], transport });
    const err = await safeFetch("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EgressBlockedError);
    const message = String((err as Error).message);
    expect(message).toContain("307");
    expect(message).not.toContain("SECRET-IN-LOCATION");
    expect(message).not.toContain("cust");
  });

  it("CONTROL: a plain 200 on an allowed host is returned, with redirect:'manual' requested", async () => {
    const seenInit: Array<RequestInit | undefined> = [];
    const safeFetch = createSafeFetch({
      allowlist: ["allowed.test"],
      transport: async (_url, init) => {
        seenInit.push(init);
        return new Response('{"ok":true}', { status: 200 });
      },
    });
    const response = await safeFetch("https://allowed.test/api", { method: "POST", body: CUSTOMER_BODY });
    expect(response.status).toBe(200);
    expect(seenInit[0]?.redirect).toBe("manual");
  });

  it("CONTROL: a non-redirect error status (404) is returned to the caller, not swallowed as an egress block", async () => {
    const safeFetch = createSafeFetch({
      allowlist: ["allowed.test"],
      transport: async () => new Response("nope", { status: 404 }),
    });
    const response = await safeFetch("https://allowed.test/api");
    expect(response.status).toBe(404);
  });
});

const enabledEnv = {
  GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
  GATEWAY_PAPERCLIP_BASE_URL: "https://paperclip.example.test",
  GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
  GATEWAY_PAPERCLIP_BEARER: BEARER,
};

describe("R5: a Paperclip base URL with userinfo REFUSES to boot", () => {
  it("CONTROL: the plain https URL boots clean", () => {
    expect(bootErrors(loadConfig({ ...BASE_ENV, ...enabledEnv }))).toEqual([]);
  });

  const SECRET_PW = "S3CR3TPW9";
  for (const url of [
    `https://user:${SECRET_PW}@paperclip.example.test`,
    "https://user@paperclip.example.test",
    `https://:${SECRET_PW}@paperclip.example.test`,
  ]) {
    it(`REFUSES ${url.replace(SECRET_PW, "PW")}: credentials come ONLY through the injected auth`, () => {
      const errors = bootErrors(loadConfig({ ...BASE_ENV, ...enabledEnv, GATEWAY_PAPERCLIP_BASE_URL: url }));
      expect(errors.length).toBeGreaterThanOrEqual(1);
      const joined = errors.join(" ");
      expect(joined).toContain("GATEWAY_PAPERCLIP_BASE_URL");
      expect(joined.toLowerCase()).toContain("userinfo");
      // the refusal must not echo the credential it refused
      expect(joined).not.toContain(SECRET_PW);
      expect(joined).not.toContain(BEARER);
    });
  }
});

function request(): AgentRuntimeRequest {
  return {
    templateId: "tpl@v1",
    exposure: "PUBLIC",
    agentId: "emp-1",
    runId: "delivery-1",
    idempotencyKey: KEY,
    context: {
      source: "chatwoot",
      companyId: "company-1",
      customerScope: { kind: "verified", customerId: "cust-a", serviceIds: ["svc-1"] },
      chatwoot: { accountId: 1, inboxId: 7, conversationDisplayId: 42, messageId: 9001 },
      message: { role: "customer", content: "hello" },
    },
  };
}

describe("R5 (runtime): userinfo in the base URL is a config defect with NOTHING sent, never an uncertain create", () => {
  it("userinfo base URL -> paperclip_config_defect, zero requests, not marked uncertain", async () => {
    const calls: string[] = [];
    const store = inMemoryIssueStore();
    const runtime = new PaperclipAgentRuntime({
      baseUrl: "https://user:S3CR3TPW9@paperclip.example.test",
      companyId: "company-1",
      auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
      // models fetch: a URL with userinfo throws BEFORE sending
      safeFetch: async (input) => {
        calls.push(String(input));
        throw new TypeError("Request cannot be constructed from a URL that includes credentials");
      },
      issueStore: store,
      pollDeadlineMs: 2_000,
      pollIntervalMs: 10,
      requestTimeoutMs: 1_000,
    });
    const result = await runtime.invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
    expect(calls).toEqual([]);
    expect(await store.isUncertain(KEY)).toBe(false);
  });

  it("CONTROL: a transport failure on a clean URL IS still an uncertain create (the classification was not simply turned off)", async () => {
    const store = inMemoryIssueStore();
    const runtime = new PaperclipAgentRuntime({
      baseUrl: "https://paperclip.example.test",
      companyId: "company-1",
      auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
      safeFetch: async () => {
        throw new TypeError("fetch failed");
      },
      issueStore: store,
      pollDeadlineMs: 2_000,
      pollIntervalMs: 10,
      requestTimeoutMs: 1_000,
    });
    const result = await runtime.invoke(request());
    expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.createUncertain);
    expect(await store.isUncertain(KEY)).toBe(true);
  });
});
