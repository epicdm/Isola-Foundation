/**
 * agno-client.ts's own contract, in isolation from the template-selection
 * concerns model-menu.test.ts covers. Every branch measured against the real
 * `agno` package source on host03 (router.ts's create_agent_run, RunOutput.
 * to_dict()) rather than assumed — see agno-client.ts's own header for the
 * citations.
 */
import { describe, expect, it, vi } from "vitest";

import { createAgnoClient } from "../src/agno-client.js";
import { ModelInvalidOutputError, ModelProviderError, ModelTimeoutError } from "../src/errors.js";

const BASE_URL = "http://isola-agno-s1-agentos:3000";

function client(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  apiKey: string | null = "test-key",
) {
  return createAgnoClient({ baseUrl: BASE_URL, apiKey, safeFetch: handler as never });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  model: "isola-agno-proof-worker",
  timeoutMs: 5000,
  messages: [
    { role: "system" as const, content: "you are a floor prompt" },
    { role: "user" as const, content: "what is the status?" },
  ],
  sessionId: "issue-1",
  userId: "agent-1",
  ...overrides,
});

const completed = (body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

describe("request shape", () => {
  it("POSTs form-encoded to /agents/{componentId}/runs, sending only the user message", async () => {
    const f = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${BASE_URL}/agents/isola-agno-proof-worker/runs`);
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>)["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer test-key");
      const form = new URLSearchParams(init.body as string);
      // The system message is deliberately NOT forwarded — see the file
      // header: Agno's own component already carries its instructions.
      expect(form.get("message")).toBe("what is the status?");
      expect(form.get("stream")).toBe("false");
      expect(form.get("session_id")).toBe("issue-1");
      expect(form.get("user_id")).toBe("agent-1");
      return completed({ status: "COMPLETED", content: "ok", run_id: "r1" });
    });
    const res = await client(f).complete(request());
    expect(res.content).toBe("ok");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("sends the LAST user message when several are present", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const form = new URLSearchParams(init.body as string);
      expect(form.get("message")).toBe("second question");
      return completed({ status: "COMPLETED", content: "ok" });
    });
    await client(f).complete(
      request({
        messages: [
          { role: "system", content: "floor" },
          { role: "user", content: "first question" },
          { role: "user", content: "second question" },
        ],
      }),
    );
  });
});

describe("fail closed before any network call", () => {
  it("no apiKey configured", async () => {
    const f = vi.fn();
    await expect(client(f, null).complete(request())).rejects.toThrow(ModelProviderError);
    expect(f).not.toHaveBeenCalled();
  });

  it("no user message in the request", async () => {
    const f = vi.fn();
    await expect(
      client(f).complete(request({ messages: [{ role: "system", content: "floor only" }] })),
    ).rejects.toThrow(ModelProviderError);
    expect(f).not.toHaveBeenCalled();
  });

  it.each([
    ["missing sessionId", { sessionId: undefined }],
    ["missing userId", { userId: undefined }],
    ["empty sessionId", { sessionId: "" }],
    ["empty userId", { userId: "" }],
  ])("%s — an unscoped run is refused, never sent as a smaller one", async (_label, overrides) => {
    const f = vi.fn();
    await expect(client(f).complete(request(overrides))).rejects.toThrow(ModelProviderError);
    expect(f).not.toHaveBeenCalled();
  });
});

describe("response handling", () => {
  it("a non-COMPLETED status is refused, even with content present", async () => {
    const f = vi.fn(async () => completed({ status: "PAUSED", content: "partial" }));
    await expect(client(f).complete(request())).rejects.toThrow(ModelInvalidOutputError);
  });

  it("empty content is refused even when status is COMPLETED", async () => {
    const f = vi.fn(async () => completed({ status: "COMPLETED", content: "   " }));
    await expect(client(f).complete(request())).rejects.toThrow(ModelInvalidOutputError);
  });

  it("a non-2xx HTTP status is refused without reading the body into the error", async () => {
    const f = vi.fn(
      async () => new Response("possibly-sensitive-body", { status: 500 }),
    );
    try {
      await client(f).complete(request());
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(ModelProviderError);
      expect((err as Error).message).not.toContain("possibly-sensitive-body");
    }
  });

  it("times out and aborts rather than hanging", async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("AbortError")));
      });
    });
    await expect(client(f).complete(request({ timeoutMs: 5 }))).rejects.toThrow(
      ModelTimeoutError,
    );
  });
});

describe("usage — measured against the real agno response shape, not guessed", () => {
  it("maps metrics.input_tokens/output_tokens/cache_read_tokens onto ModelUsage", async () => {
    const f = vi.fn(async () =>
      completed({
        status: "COMPLETED",
        content: "ok",
        metrics: { input_tokens: 4381, output_tokens: 589, cache_read_tokens: 2944, total_tokens: 4970 },
      }),
    );
    const res = await client(f).complete(request());
    expect(res.usage).toEqual({
      promptTokens: 4381,
      completionTokens: 589,
      cachedPromptTokens: 2944,
    });
  });

  it("no metrics field at all: usage is null, never zero-coerced", async () => {
    const f = vi.fn(async () => completed({ status: "COMPLETED", content: "ok" }));
    const res = await client(f).complete(request());
    expect(res.usage).toBeNull();
  });

  it("metrics present but empty: still null, not an all-zero object that would look like a free real call", async () => {
    const f = vi.fn(async () => completed({ status: "COMPLETED", content: "ok", metrics: {} }));
    const res = await client(f).complete(request());
    expect(res.usage).toBeNull();
  });

  it("a genuinely zero token count (e.g. a fully cached call) is real and kept, not treated as absent", async () => {
    const f = vi.fn(async () =>
      completed({
        status: "COMPLETED",
        content: "ok",
        metrics: { input_tokens: 0, output_tokens: 12, cache_read_tokens: 0 },
      }),
    );
    const res = await client(f).complete(request());
    expect(res.usage).toEqual({ promptTokens: 0, completionTokens: 12, cachedPromptTokens: 0 });
  });
});
