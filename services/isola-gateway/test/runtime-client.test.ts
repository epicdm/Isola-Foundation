/**
 * The isola-runtime client, including the open half of the contract.
 *
 * `responseMode: "inline"` is NOT implemented upstream yet. These tests pin
 * both halves: what we send, and what we do with the answer that today will not
 * come back.
 */
import { describe, expect, it } from "vitest";

import { createSafeFetch } from "../src/egress.js";
import {
  HttpAgentRuntime,
  outcomeForStatus,
  readInlineText,
  type AgentRuntimeRequest,
} from "../src/runtime.js";
import { placeholder } from "./harness.js";

const REQUEST: AgentRuntimeRequest = {
  templateId: "isola-ai-sales-front-desk-agent@v1",
  exposure: "PUBLIC",
  agentId: "agent-1",
  runId: "run-1",
  context: { hello: "world" },
};

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function client(
  respond: (captured: Captured) => Response,
  bearer: string | null = placeholder("runtime"),
): { runtime: HttpAgentRuntime; captured: Captured[] } {
  const captured: Captured[] = [];
  const safeFetch = createSafeFetch({
    allowlist: ["isola_isola-runtime"],
    transport: async (url, init) => {
      const entry = { url: String(url), init };
      captured.push(entry);
      return respond(entry);
    },
  });
  const runtime = new HttpAgentRuntime({
    baseUrl: "http://isola_isola-runtime:3000",
    invokePath: "/v1/invoke",
    bearer,
    safeFetch,
    timeoutMs: 5000,
  });
  return { runtime, captured };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("what the gateway sends", () => {
  it("POSTs the verified contract plus responseMode: inline", async () => {
    const { runtime, captured } = client(() => jsonResponse({ ok: true, outcome: "ok", text: "hi" }));
    await runtime.invoke(REQUEST);

    expect(captured[0]?.url).toBe("http://isola_isola-runtime:3000/v1/invoke");
    const init = captured[0]?.init;
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(/^Bearer /);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body["templateId"]).toBe(REQUEST.templateId);
    expect(body["exposure"]).toBe("PUBLIC");
    expect(body["agentId"]).toBe("agent-1");
    expect(body["runId"]).toBe("run-1");
    expect(body["responseMode"]).toBe("inline");
  });

  it("sends no principal key at all when the request carries none", async () => {
    const { runtime, captured } = client(() => jsonResponse({ ok: true, outcome: "ok", text: "hi" }));
    await runtime.invoke(REQUEST);
    const body = JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>;
    expect(Object.keys(body)).not.toContain("principal");
    // CONTROL: the body was captured and is the invoke body.
    expect(body["templateId"]).toBe(REQUEST.templateId);
  });

  it("sends a verified principal TOP-LEVEL, never inside the rendered context", async () => {
    const { runtime, captured } = client(() => jsonResponse({ ok: true, outcome: "ok", text: "hi" }));
    const principal = {
      channel: "whatsapp" as const,
      senderE164: "+17675550100",
      verifiedBy: "gateway-allowlist" as const,
      bindingKey: "2/10",
    };
    await runtime.invoke({ ...REQUEST, exposure: "INTERNAL", principal });
    const body = JSON.parse(String(captured[0]?.init?.body)) as Record<string, unknown>;
    expect(body["principal"]).toEqual(principal);
    expect(body["context"]).toEqual(REQUEST.context);
  });

  it("fails closed with no bearer, without opening a socket", async () => {
    const { runtime, captured } = client(() => jsonResponse({}), null);
    const result = await runtime.invoke(REQUEST);
    expect(result).toEqual({
      text: null,
      outcome: "unauthorized",
      correlationId: "run-1",
      completionState: null,
      contractVersion: null,
    });
    expect(captured).toHaveLength(0);
  });

  it("returns runtime_unreachable when the host is not on the allowlist", async () => {
    const safeFetch = createSafeFetch({ allowlist: [], transport: async () => jsonResponse({}) });
    const runtime = new HttpAgentRuntime({
      baseUrl: "http://isola_isola-runtime:3000",
      invokePath: "/v1/invoke",
      bearer: placeholder("runtime"),
      safeFetch,
      timeoutMs: 1000,
    });
    expect(await runtime.invoke(REQUEST)).toMatchObject({
      text: null,
      outcome: "runtime_unreachable",
    });
  });
});

describe("what the gateway reads back", () => {
  it("reads text, then content, then message", () => {
    expect(readInlineText({ text: "a", content: "b", message: "c" })).toBe("a");
    expect(readInlineText({ content: "b", message: "c" })).toBe("b");
    expect(readInlineText({ message: "c" })).toBe("c");
    expect(readInlineText({ ok: true, outcome: "ok" })).toBeNull();
    expect(readInlineText({ text: "   " })).toBeNull();
    expect(readInlineText(null)).toBeNull();
  });

  it("returns null text on a 200 that carries no answer and no completion state", async () => {
    // A pre-contract-v1 runtime: {ok, outcome, correlationId} and nothing else.
    // The gateway must still classify it as "no answer", never invent one.
    const { runtime } = client(() =>
      jsonResponse({ ok: true, outcome: "ok", correlationId: "runtime-corr" }),
    );
    expect(await runtime.invoke(REQUEST)).toEqual({
      text: null,
      outcome: "ok",
      correlationId: "runtime-corr",
      completionState: null,
      contractVersion: null,
    });
  });

  it("never treats an error body's `message` as an answer", async () => {
    const { runtime } = client(() =>
      jsonResponse({ ok: false, outcome: "provider_error", message: "upstream exploded" }, 502),
    );
    const result = await runtime.invoke(REQUEST);
    expect(result.text).toBeNull();
    expect(result.outcome).toBe("provider_error");
  });

  it("treats a 200 with ok:false as that body's failure outcome", async () => {
    const { runtime } = client(() =>
      jsonResponse({ ok: false, outcome: "duplicate_run_suppressed", text: "stale" }),
    );
    const result = await runtime.invoke(REQUEST);
    expect(result.text).toBeNull();
    expect(result.outcome).toBe("duplicate_run_suppressed");
  });

  it("maps the verified status codes", () => {
    expect(outcomeForStatus(200)).toBe("ok");
    expect(outcomeForStatus(402)).toBe("budget_exhausted");
    expect(outcomeForStatus(403)).toBe("exposure_mismatch");
    expect(outcomeForStatus(502)).toBe("provider_error");
    expect(outcomeForStatus(504)).toBe("model_timeout");
    expect(outcomeForStatus(401)).toBe("unauthorized");
    expect(outcomeForStatus(418)).toBe("runtime_error");
  });
});

/**
 * Regression: the gateway originally read `text`/`content`/`message`, but
 * isola-runtime returns the answer in `answerText`. Live, that mismatch made
 * every successful run look like a contract violation — the gateway escalated
 * to a human instead of replying. It failed safe, but it never answered.
 */
describe("inline text field — answerText is the real contract", () => {
  it("reads answerText, which is what isola-runtime actually returns", () => {
    expect(readInlineText({ answerText: "the answer" })).toBe("the answer");
  });

  it("prefers answerText over the provisional field names", () => {
    expect(
      readInlineText({ answerText: "correct", text: "stale", content: "stale", message: "stale" }),
    ).toBe("correct");
  });

  it("still tolerates the provisional names if answerText is absent", () => {
    expect(readInlineText({ text: "fallback" })).toBe("fallback");
    expect(readInlineText({ content: "fallback" })).toBe("fallback");
    expect(readInlineText({ message: "fallback" })).toBe("fallback");
  });

  it("treats a null or blank answerText as no answer — never substitutes one", () => {
    // This is the shape of EVERY failed inline run: answerText null plus a
    // truthful completionState. It must never become a customer reply.
    expect(readInlineText({ answerText: null, completionState: "timeout" })).toBeNull();
    expect(readInlineText({ answerText: "   ", completionState: "completed" })).toBeNull();
    expect(readInlineText({ completionState: "provider_error" })).toBeNull();
  });

  it("never mistakes an error string for an answer", () => {
    expect(readInlineText({ answerText: null, error: "model_timeout_after_60000ms" })).toBeNull();
  });
});
