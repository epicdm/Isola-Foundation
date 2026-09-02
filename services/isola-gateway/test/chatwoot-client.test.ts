/**
 * The Chatwoot Application API client: the exact routes, the exact auth header,
 * and the merge helpers behind the read-modify-write rule.
 */
import { describe, expect, it } from "vitest";

import {
  APPROVED_CUSTOM_ATTRIBUTE_KEYS,
  filterApprovedAttributes,
  filterApprovedLabels,
  HttpChatwootApi,
  mergeCustomAttributes,
  mergeLabels,
  type ChatwootTarget,
} from "../src/chatwoot.js";
import { createSafeFetch } from "../src/egress.js";
import { ChatwootApiError } from "../src/errors.js";
import { BOT_ACCESS_TOKEN } from "./harness.js";

const TARGET: ChatwootTarget = {
  accountId: 1,
  conversationId: 42,
  accessToken: BOT_ACCESS_TOKEN,
};

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function client(respond: () => Response): { api: HttpChatwootApi; captured: Captured[] } {
  const captured: Captured[] = [];
  const safeFetch = createSafeFetch({
    allowlist: ["chatwoot.example.test"],
    transport: async (url, init) => {
      captured.push({
        url: String(url),
        method: String(init?.method),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return respond();
    },
  });
  return {
    api: new HttpChatwootApi({ baseUrl: "https://chatwoot.example.test", safeFetch }),
    captured,
  };
}

const ok = (): Response =>
  new Response("{}", { status: 200, headers: { "content-type": "application/json" } });

describe("routes and auth", () => {
  it("posts a customer reply to the conversation display id", async () => {
    const { api, captured } = client(ok);
    await api.postMessage(TARGET, "hello", false);
    expect(captured[0]?.url).toBe(
      "https://chatwoot.example.test/api/v1/accounts/1/conversations/42/messages",
    );
    expect(captured[0]?.body).toEqual({
      content: "hello",
      message_type: "outgoing",
      private: false,
    });
  });

  it("posts a private note on the same route with private: true", async () => {
    const { api, captured } = client(ok);
    await api.postMessage(TARGET, "note", true);
    expect(captured[0]?.body).toMatchObject({ private: true, message_type: "outgoing" });
  });

  it("authenticates as the bot with api_access_token, not a bearer", async () => {
    const { api, captured } = client(ok);
    await api.postMessage(TARGET, "hello", false);
    expect(captured[0]?.headers["api_access_token"]).toBe(BOT_ACCESS_TOKEN);
    expect(captured[0]?.headers["authorization"]).toBeUndefined();
  });

  it("escalates with toggle_status open", async () => {
    const { api, captured } = client(ok);
    await api.openConversation(TARGET);
    expect(captured[0]?.url).toContain("/conversations/42/toggle_status");
    expect(captured[0]?.body).toEqual({ status: "open" });
  });

  it("assigns a team", async () => {
    const { api, captured } = client(ok);
    await api.assignTeam(TARGET, 5);
    expect(captured[0]?.url).toContain("/conversations/42/assignments");
    expect(captured[0]?.body).toEqual({ team_id: 5 });
  });

  it("writes labels as a full replacement", async () => {
    const { api, captured } = client(ok);
    await api.setLabels(TARGET, ["a", "b"]);
    expect(captured[0]?.url).toContain("/conversations/42/labels");
    expect(captured[0]?.body).toEqual({ labels: ["a", "b"] });
  });

  it("writes custom attributes as a full replacement", async () => {
    const { api, captured } = client(ok);
    await api.setCustomAttributes(TARGET, { a: 1 });
    expect(captured[0]?.url).toContain("/conversations/42/custom_attributes");
    expect(captured[0]?.body).toEqual({ custom_attributes: { a: 1 } });
  });

  it("reads labels out of the payload envelope", async () => {
    const { api } = client(
      () =>
        new Response(JSON.stringify({ payload: ["vip", 7, "billing"] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await api.getLabels(TARGET)).toEqual(["vip", "billing"]);
  });

  it("reads custom attributes off the conversation", async () => {
    const { api, captured } = client(
      () =>
        new Response(JSON.stringify({ id: 42, custom_attributes: { crm_id: "x" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(await api.getCustomAttributes(TARGET)).toEqual({ crm_id: "x" });
    expect(captured[0]?.url).toBe(
      "https://chatwoot.example.test/api/v1/accounts/1/conversations/42",
    );
  });
});

describe("failures never carry Chatwoot response bodies", () => {
  it("reports the status class only", async () => {
    const { api } = client(() => new Response("customer said something private", { status: 422 }));
    await expect(api.postMessage(TARGET, "x", false)).rejects.toThrowError(ChatwootApiError);
    await api.postMessage(TARGET, "x", false).catch((err: unknown) => {
      expect(err).toBeInstanceOf(ChatwootApiError);
      expect((err as ChatwootApiError).detail).toBe("returned HTTP 422");
      expect((err as ChatwootApiError).message).not.toContain("private");
    });
  });

  it("reports an egress block without leaking the host into a stack of retries", async () => {
    const safeFetch = createSafeFetch({ allowlist: [], transport: async () => ok() });
    const api = new HttpChatwootApi({ baseUrl: "https://chatwoot.example.test", safeFetch });
    await expect(api.postMessage(TARGET, "x", false)).rejects.toThrowError(
      /not on the egress allowlist/,
    );
  });
});

describe("merge helpers", () => {
  it("mergeLabels keeps existing labels first and de-duplicates case-insensitively", () => {
    expect(mergeLabels(["vip", "billing"], ["isola-ai-answered"])).toEqual([
      "vip",
      "billing",
      "isola-ai-answered",
    ]);
    expect(mergeLabels(["VIP"], ["vip"])).toEqual(["VIP"]);
    expect(mergeLabels([" a ", ""], ["b"])).toEqual(["a", "b"]);
  });

  it("filterApprovedLabels drops anything the gateway is not approved to apply", () => {
    expect(filterApprovedLabels(["isola-ai-answered", "delete-me"], ["isola-ai-answered"])).toEqual(
      ["isola-ai-answered"],
    );
  });

  it("filterApprovedAttributes drops keys outside the approved set", () => {
    const filtered = filterApprovedAttributes({
      isola_last_outcome: "replied",
      crm_id: "should not be written by us",
    });
    expect(filtered).toEqual({ isola_last_outcome: "replied" });
    expect(APPROVED_CUSTOM_ATTRIBUTE_KEYS).toContain("isola_tenant_id");
  });

  it("mergeCustomAttributes preserves everything it did not set", () => {
    expect(
      mergeCustomAttributes({ crm_id: "x", isola_last_outcome: "old" }, { isola_last_outcome: "new" }),
    ).toEqual({ crm_id: "x", isola_last_outcome: "new" });
  });
});
