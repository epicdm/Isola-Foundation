import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import {
  createSafeFetch,
  hostOf,
  isAllowedHost,
  parseAllowlist,
} from "../src/egress.js";
import { EgressBlockedError } from "../src/errors.js";
import { chatCompletionsUrl, createOpenAiCompatibleClient } from "../src/model.js";
import { PaperclipRunRecorder, renderRecordPath } from "../src/recorder.js";
import { RecorderError } from "../src/errors.js";

const ALLOWED = ["api.deepseek.com", "paperclip.example.test"];

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("allowlist parsing", () => {
  it("splits, trims and lower-cases", () => {
    expect(parseAllowlist(" A.Example , b.example ,, ")).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(parseAllowlist(undefined)).toEqual([]);
    expect(parseAllowlist("")).toEqual([]);
  });

  it("derives the default allowlist from the model, Paperclip, and hosts a template declares", () => {
    const config = loadConfig({
      MODEL_BASE_URL: "https://api.deepseek.com/v1",
      PAPERCLIP_BASE_URL: "https://paperclip.example.test",
    });
    // A template that declares its own brain contributes its host, so the
    // declared runtime is reachable through safeFetch. Least privilege: exactly
    // the hosts in declared use, never a pattern.
    expect(config.egressAllowlist).toEqual([
      "api.deepseek.com",
      "paperclip.example.test",
      "hermes-tunnel",
    ]);
  });

  it("but an EXPLICIT allowlist is still authoritative and is NOT widened", () => {
    // An operator who sets EGRESS_ALLOWLIST means that list. Silently unioning a
    // template host into it would widen a security control behind their back; a
    // template whose host is absent simply fails closed at safeFetch, visibly.
    const config = loadConfig({
      MODEL_BASE_URL: "https://api.deepseek.com/v1",
      EGRESS_ALLOWLIST: "api.deepseek.com",
    });
    expect(config.egressAllowlist).toEqual(["api.deepseek.com"]);
    expect(config.egressAllowlist).not.toContain("hermes-tunnel");
  });

  it("lets EGRESS_ALLOWLIST replace the derived list entirely", () => {
    const config = loadConfig({
      MODEL_BASE_URL: "https://api.deepseek.com",
      PAPERCLIP_BASE_URL: "https://paperclip.example.test",
      EGRESS_ALLOWLIST: "only.this.host",
    });
    expect(config.egressAllowlist).toEqual(["only.this.host"]);
  });

  it("matches hostnames exactly — no suffix widening", () => {
    expect(isAllowedHost("api.deepseek.com", ALLOWED)).toBe(true);
    expect(isAllowedHost("API.DeepSeek.com", ALLOWED)).toBe(true);
    expect(isAllowedHost("evil-api.deepseek.com.attacker.test", ALLOWED)).toBe(false);
    expect(isAllowedHost("deepseek.com", ALLOWED)).toBe(false);
    expect(isAllowedHost("", ALLOWED)).toBe(false);
  });

  it("hostOf tolerates junk", () => {
    expect(hostOf("https://Example.COM/path")).toBe("example.com");
    expect(hostOf("not a url")).toBeNull();
    expect(hostOf(null)).toBeNull();
  });
});

describe("safeFetch", () => {
  it("permits an allowlisted host", async () => {
    let seen: string | null = null;
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async (input) => {
        seen = String(input);
        return okResponse({ ok: true });
      },
    });
    const res = await safeFetch("https://api.deepseek.com/v1/chat/completions");
    expect(res.status).toBe(200);
    expect(seen).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("throws EgressBlockedError for a foreign host and never calls the transport", async () => {
    let called = false;
    const safeFetch = createSafeFetch({
      allowlist: ALLOWED,
      transport: async () => {
        called = true;
        return okResponse({});
      },
    });

    await expect(safeFetch("https://attacker.example/steal")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(safeFetch("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(safeFetch("https://deepseek.com/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    expect(called).toBe(false);
  });

  it("blocks non-http schemes outright", async () => {
    const safeFetch = createSafeFetch({
      allowlist: [...ALLOWED, "localhost"],
      transport: async () => okResponse({}),
    });
    await expect(safeFetch("file:///etc/passwd")).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(safeFetch("ftp://api.deepseek.com/x")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(safeFetch("not-a-url")).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("blocks everything when the allowlist is empty", async () => {
    const safeFetch = createSafeFetch({ allowlist: [], transport: async () => okResponse({}) });
    await expect(safeFetch("https://api.deepseek.com/")).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
  });
});

describe("model client goes through safeFetch", () => {
  it("is blocked when MODEL_BASE_URL is not on the allowlist", async () => {
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://exfiltration.example",
      apiKey: "k",
      safeFetch: createSafeFetch({
        allowlist: ALLOWED,
        transport: async () => okResponse({}),
      }),
    });
    await expect(
      client.complete({ model: "m", messages: [], timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it("does not double the /v1 segment", () => {
    expect(chatCompletionsUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/v1")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1/chat/completions",
    );
  });

  it("parses a well-formed completion and sends no stray fields", async () => {
    let body: Record<string, unknown> = {};
    const client = createOpenAiCompatibleClient({
      baseUrl: "https://api.deepseek.com",
      apiKey: "k",
      safeFetch: createSafeFetch({
        allowlist: ALLOWED,
        transport: async (_input, init) => {
          body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return okResponse({
            model: "deepseek-chat",
            choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          });
        },
      }),
    });
    const result = await client.complete({
      model: "deepseek-chat",
      messages: [{ role: "system", content: "s" }],
      timeoutMs: 1000,
    });
    expect(result.content).toBe("hi");
    expect(result.usage).toEqual({
      promptTokens: 5,
      completionTokens: 2,
      cachedPromptTokens: null,
    });
    expect(Object.keys(body).sort()).toEqual(["messages", "model", "stream"]);
    // No tool/function surface is ever offered to the provider.
    expect(body["tools"]).toBeUndefined();
    expect(body["functions"]).toBeUndefined();
  });
});

describe("Paperclip recorder goes through safeFetch", () => {
  const outcome = {
    correlationId: "c1",
    agentId: "a1",
    runId: "r1",
    issueId: "i1",
    templateId: "epic-staff-operations-coordinator@v1",
    templateVersion: "v1",
    exposure: "INTERNAL" as const,
    status: "succeeded" as const,
    durationMs: 12,
    content: "answer",
    failureCategory: null,
    contextTruncated: false,
  };

  it("substitutes the path template", () => {
    expect(
      renderRecordPath("/api/issues/{issueId}/comments", {
        issueId: "ISSUE-1",
        agentId: null,
        runId: null,
      }),
    ).toBe("/api/issues/ISSUE-1/comments");

    expect(
      renderRecordPath("api/agents/{agentId}/runs/{runId}/activity", {
        issueId: null,
        agentId: "a 1",
        runId: "r/1",
      }),
    ).toBe("/api/agents/a%201/runs/r%2F1/activity");
  });

  it("fails loudly rather than POSTing a half-substituted path", () => {
    expect(() =>
      renderRecordPath("/api/issues/{issueId}/comments", {
        issueId: null,
        agentId: "a",
        runId: "r",
      }),
    ).toThrow(RecorderError);
  });

  it("is blocked when PAPERCLIP_BASE_URL is not on the allowlist", async () => {
    const recorder = new PaperclipRunRecorder({
      baseUrl: "https://not-allowed.example",
      apiKey: "k",
      pathTemplate: "/api/issues/{issueId}/comments",
      safeFetch: createSafeFetch({
        allowlist: ALLOWED,
        transport: async () => okResponse({}),
      }),
    });
    await expect(recorder.record(outcome)).rejects.toBeInstanceOf(RecorderError);
    await expect(recorder.record(outcome)).rejects.toThrow(/egress allowlist/);
  });

  it("POSTs the rendered body to the allowlisted host with a bearer", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> = {};
    let seenAuth = "";
    const recorder = new PaperclipRunRecorder({
      baseUrl: "https://paperclip.example.test/",
      apiKey: "pk",
      pathTemplate: "/api/issues/{issueId}/comments",
      safeFetch: createSafeFetch({
        allowlist: ALLOWED,
        transport: async (input, init) => {
          seenUrl = String(input);
          seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          seenAuth = String((init?.headers as Record<string, string>)["authorization"]);
          return okResponse({ id: 1 });
        },
      }),
    });
    await recorder.record(outcome);
    expect(seenUrl).toBe("https://paperclip.example.test/api/issues/i1/comments");
    expect(seenAuth).toBe("Bearer pk");
    expect(String(seenBody["body"])).toContain("answer");
  });

  it("raises RecorderError on a non-2xx write-back", async () => {
    const recorder = new PaperclipRunRecorder({
      baseUrl: "https://paperclip.example.test",
      apiKey: "pk",
      pathTemplate: "/api/issues/{issueId}/comments",
      safeFetch: createSafeFetch({
        allowlist: ALLOWED,
        transport: async () => new Response("nope", { status: 502 }),
      }),
    });
    await expect(recorder.record(outcome)).rejects.toThrow(/HTTP 502/);
  });
});
