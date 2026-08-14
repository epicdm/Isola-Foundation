/**
 * Per-binding Chatwoot origin.
 *
 * WHY THIS EXISTS — AND WHAT IT IS NOT
 * ------------------------------------
 * It is NOT how Isola does multi-tenancy. The target is ONE Chatwoot instance
 * with many tenants as separate Chatwoot ACCOUNTS — Chatwoot's own model, and
 * what `chatwootAccountId` + `chatwootInboxId` already key on. An instance per
 * customer is not the design.
 *
 * It exists because the estate has TWO instances mid-migration. Without a
 * per-binding host a gateway serves exactly one, so moving inboxes between them
 * is all-or-nothing. With it, inboxes move one at a time, each rolls back
 * independently, and a moved inbox and an unmoved one are served side by side.
 *
 * The property that actually matters and is asserted below: an outbound call
 * for tenant A must go to tenant A's Chatwoot and never to tenant B's. Getting
 * that wrong would post one tenant's conversation into another tenant's
 * account, using a token that would very likely be accepted there.
 */
import { describe, expect, it } from "vitest";

import { parseBindings } from "../src/bindings.js";
import { createChatwootApi } from "../src/chatwoot.js";
import { bootWarnings, loadConfig } from "../src/config.js";
import {
  ACCOUNT_ID,
  BOT_ACCESS_TOKEN,
  BOT_SECRET,
  bindingsJson,
  BASE_ENV,
  INBOX_ID,
  makeBinding,
  recordingEgress,
  TEMPLATE_ID,
  TENANT_ID,
} from "./harness.js";

const TENANT_HOST = "inbox.tenant-b.example";
const TENANT_ORIGIN = `https://${TENANT_HOST}`;

function parseOne(overrides: Record<string, unknown>) {
  const base = {
    tenantId: TENANT_ID,
    chatwootAccountId: ACCOUNT_ID,
    chatwootInboxId: INBOX_ID,
    chatwootAgentBotId: 3,
    agentBotSecret: BOT_SECRET,
    agentBotAccessToken: BOT_ACCESS_TOKEN,
    paperclipCompanyId: "company-1",
    paperclipAgentId: "agent-1",
    templateId: TEMPLATE_ID,
    exposure: "PUBLIC",
    status: "active",
    lifecycle: "accepted",
  };
  const r = parseBindings(JSON.stringify([{ ...base, ...overrides }]));
  return {
    errors: r.ok ? [] : r.errors,
    bindings: r.ok ? r.bindings : [],
  };
}

describe("chatwootBaseUrl is validated hard at boot", () => {
  it("accepts an https origin and normalises a trailing slash away", () => {
    const result = parseOne({ chatwootBaseUrl: `${TENANT_ORIGIN}/` });
    expect(result.errors).toEqual([]);
    expect(result.bindings[0]!.chatwootBaseUrl).toBe(TENANT_ORIGIN);
  });

  it("is optional — an absent value leaves the binding on the gateway default", () => {
    const result = parseOne({});
    expect(result.errors).toEqual([]);
    expect(result.bindings[0]!.chatwootBaseUrl).toBeUndefined();
  });

  /**
   * Each of these is refused rather than normalised. The reasons differ and all
   * of them matter: this URL carries an AgentBot access token on every call.
   */
  it.each([
    ["plain http, which would send the access token in clear", "http://inbox.tenant-b.example"],
    ["credentials embedded in the URL", "https://user:pw@inbox.tenant-b.example"],
    ["a path, which would be concatenated with the API path", "https://inbox.tenant-b.example/app"],
    ["a query string", "https://inbox.tenant-b.example/?x=1"],
    ["a fragment", "https://inbox.tenant-b.example/#f"],
    ["a bare hostname with no scheme", "inbox.tenant-b.example"],
    ["an empty string", "   "],
    ["a non-string", 42],
  ])("refuses %s", (_label, value) => {
    const result = parseOne({ chatwootBaseUrl: value });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.join(" ")).toContain("chatwootBaseUrl");
  });

  it("names the binding index so an operator can find the bad row", () => {
    const result = parseOne({ chatwootBaseUrl: "http://nope.example" });
    expect(result.errors[0]).toContain("binding[0]");
  });
});

describe("outbound calls go to the binding's own Chatwoot", () => {
  it("uses the per-binding origin, not the gateway default", async () => {
    const egress = recordingEgress();
    const api = createChatwootApi({
      baseUrl: "https://default-chatwoot.example",
      safeFetch: egress.safeFetch,
    });

    await api.postMessage(
      {
        accountId: 7,
        conversationId: 99,
        accessToken: BOT_ACCESS_TOKEN,
        baseUrl: TENANT_ORIGIN,
      },
      "hello",
      false,
    );

    expect(egress.hosts).toEqual([TENANT_HOST]);
    // And the API path is still built correctly on top of the origin.
    expect(egress.urls[0]).toBe(
      `${TENANT_ORIGIN}/api/v1/accounts/7/conversations/99/messages`,
    );
  });

  it("falls back to the gateway default when the binding names none", async () => {
    const egress = recordingEgress();
    const api = createChatwootApi({
      baseUrl: "https://default-chatwoot.example",
      safeFetch: egress.safeFetch,
    });

    await api.postMessage(
      { accountId: 7, conversationId: 99, accessToken: BOT_ACCESS_TOKEN },
      "hello",
      false,
    );

    expect(egress.hosts).toEqual(["default-chatwoot.example"]);
  });

  /**
   * THE ISOLATION PROPERTY. Two tenants, two Chatwoots, one gateway process:
   * each call must land in its own tenant's host. A regression here posts one
   * tenant's conversation into another tenant's account.
   */
  it("keeps two tenants' traffic in two different Chatwoots", async () => {
    const egress = recordingEgress();
    const api = createChatwootApi({
      baseUrl: "https://default-chatwoot.example",
      safeFetch: egress.safeFetch,
    });

    await api.postMessage(
      { accountId: 3, conversationId: 1, accessToken: BOT_ACCESS_TOKEN, baseUrl: "https://a.example" },
      "for tenant a",
      false,
    );
    await api.postMessage(
      { accountId: 5, conversationId: 2, accessToken: BOT_ACCESS_TOKEN, baseUrl: "https://b.example" },
      "for tenant b",
      false,
    );

    expect(egress.hosts).toEqual(["a.example", "b.example"]);
  });
});

describe("an unallowlisted binding host is caught at boot, not at the first customer", () => {
  it("warns naming the tenant, the inbox and the host", () => {
    const config = loadConfig({
      ...BASE_ENV,
      EGRESS_ALLOWLIST: "chatwoot.example.test,isola_isola-runtime",
      GATEWAY_BINDINGS_JSON: bindingsJson([
        makeBinding({ chatwootBaseUrl: TENANT_ORIGIN }),
      ]),
    });
    const warnings = bootWarnings(config).join("\n");
    expect(warnings).toContain(TENANT_HOST);
    expect(warnings).toContain("EGRESS_ALLOWLIST");
    expect(warnings).toContain(TENANT_ID);
  });

  it("does NOT warn when the host is allowlisted", () => {
    const config = loadConfig({
      ...BASE_ENV,
      EGRESS_ALLOWLIST: `chatwoot.example.test,isola_isola-runtime,${TENANT_HOST}`,
      GATEWAY_BINDINGS_JSON: bindingsJson([
        makeBinding({ chatwootBaseUrl: TENANT_ORIGIN }),
      ]),
    });
    expect(bootWarnings(config).join("\n")).not.toContain("EGRESS_ALLOWLIST");
  });
});
