/**
 * CODEX ROUND 3 (review of 1eb7ba3): F7 — a Paperclip base URL with a QUERY or a
 * FRAGMENT passed boot validation.   ALL TESTS HERE ARE SOCKET-FREE (injected fetch).
 *
 * `https://allowed.test?x=1` and `https://allowed.test#fragment` parse, are on the
 * allowlist and use http(s), so boot said nothing. The runtime then appends
 * `/api/companies/<id>/issues` to the string: after `?x=1` or `#fragment` that is query
 * or fragment TEXT, the pathname stays `/`, and the request goes to the wrong route.
 *
 * Contract: a base URL is an origin plus an optional PATH PREFIX. A query or a fragment
 * (even an empty one) cannot be a prefix, so boot REFUSES it, and the runtime treats it
 * as a configuration defect with NOTHING sent (never an uncertain create).
 *
 * Every refusal has its positive twin in the same harness.
 */
import { describe, expect, it } from "vitest";

import { bootErrors, loadConfig } from "../src/config.js";
import { inMemoryIssueStore, PAPERCLIP_OUTCOMES, PaperclipAgentRuntime } from "../src/paperclip-runtime.js";
import type { AgentRuntimeRequest } from "../src/runtime.js";
import { BASE_ENV } from "./harness.js";

const BEARER = ["not", "a", "real", "credential", "paperclip", "0".repeat(16)].join("-");
const KEY = "isolagw:tenant-acme|binding-1|1|7|delivery:abc-123|answer";
const enabledEnv = (url: string) => ({
  GATEWAY_PAPERCLIP_AGENT_IDS: "agent-1",
  GATEWAY_PAPERCLIP_BASE_URL: url,
  GATEWAY_PAPERCLIP_COMPANY_ID: "company-1",
  GATEWAY_PAPERCLIP_BEARER: BEARER,
});
const boot = (url: string): string[] => bootErrors(loadConfig({ ...BASE_ENV, ...enabledEnv(url) }));

describe("F7 (boot): a Paperclip base URL is an origin plus an optional path prefix, never a query or a fragment", () => {
  it.each([["https://paperclip.example.test"], ["https://paperclip.example.test/"], ["https://paperclip.example.test/paperclip"]])(
    "CONTROL: %s boots clean",
    (url) => {
      expect(boot(url)).toEqual([]);
    },
  );

  it.each([
    ["https://paperclip.example.test?x=1"],
    ["https://paperclip.example.test#fragment"],
    ["https://paperclip.example.test/?"],
    ["https://paperclip.example.test/#"],
    ["https://paperclip.example.test/base?x=1#f"],
  ])("REFUSES %s", (url) => {
    const errors = boot(url);
    expect(errors.length, "boot accepted a base URL whose route would be swallowed").toBeGreaterThanOrEqual(1);
    const joined = errors.join(" ");
    expect(joined).toContain("GATEWAY_PAPERCLIP_BASE_URL");
    expect(joined.toLowerCase()).toMatch(/query|fragment/);
    expect(joined).not.toContain(BEARER);
  });
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

function runtimeFor(baseUrl: string, calls: string[], store = inMemoryIssueStore()) {
  return new PaperclipAgentRuntime({
    baseUrl,
    companyId: "company-1",
    auth: { headers: () => ({ authorization: `Bearer ${BEARER}` }) },
    safeFetch: async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ id: "iss-1" }), { status: 201 });
    },
    issueStore: store,
    pollDeadlineMs: 300,
    pollIntervalMs: 10,
    requestTimeoutMs: 200,
  });
}

describe("F7 (runtime): a base URL whose route would be swallowed is a config defect with NOTHING sent", () => {
  it.each([["https://paperclip.example.test?x=1"], ["https://paperclip.example.test#fragment"]])(
    "%s -> paperclip_config_defect, zero requests, not marked uncertain",
    async (url) => {
      const calls: string[] = [];
      const store = inMemoryIssueStore();
      const result = await runtimeFor(url, calls, store).invoke(request());
      expect(result.outcome).toBe(PAPERCLIP_OUTCOMES.configDefect);
      expect(calls, "a request was sent to a URL whose route is query/fragment text").toEqual([]);
      expect(await store.isUncertain(KEY)).toBe(false);
    },
  );

  it("CONTROL: a clean base URL sends the create to the intended route", async () => {
    const calls: string[] = [];
    await runtimeFor("https://paperclip.example.test", calls).invoke(request());
    expect(calls[0]).toBe("https://paperclip.example.test/api/companies/company-1/issues");
  });

  it("CONTROL: a path prefix is kept in front of the route", async () => {
    const calls: string[] = [];
    await runtimeFor("https://paperclip.example.test/paperclip/", calls).invoke(request());
    expect(calls[0]).toBe("https://paperclip.example.test/paperclip/api/companies/company-1/issues");
  });
});
