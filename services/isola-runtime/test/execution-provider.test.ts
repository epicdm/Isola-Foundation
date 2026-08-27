/**
 * `DirectModelExecutionProvider` — the adapter that MUST reproduce the
 * exact classification `app.ts` used to do inline before this seam existed.
 *
 * Test category mapping:
 *   12. Hermes unchanged / direct-model byte-for-byte regression proof.
 *       This file is the unit-level half of that proof; test/invoke.test.ts,
 *       test/inline.test.ts etc. (unmodified in their assertions, only in
 *       their fixtures' tenantId — see harness.ts) are the end-to-end half.
 */
import { describe, expect, it } from "vitest";

import { renderContext } from "../src/context.js";
import { ModelInvalidOutputError, ModelProviderError, ModelTimeoutError } from "../src/errors.js";
import { createDirectModelExecutionProvider } from "../src/execution-provider.js";
import type { ModelClient, ModelRequest, ModelResponse } from "../src/model.js";
import { findTemplate } from "../src/registry.js";

const TEMPLATE = findTemplate("isola-internal-manager@v1")!;

function baseRequest(overrides: Partial<Parameters<ReturnType<typeof createDirectModelExecutionProvider>["execute"]>[0]> = {}) {
  return {
    template: TEMPLATE,
    tenantId: null,
    exposure: "INTERNAL" as const,
    model: "some-model",
    systemPrompt: "system prompt text",
    renderedContext: renderContext({ hello: "world" }, 24 * 1024),
    correlationId: "corr-1",
    timeoutMs: 5000,
    ...overrides,
  };
}

class StubClient implements ModelClient {
  calls: ModelRequest[] = [];
  constructor(private readonly impl: (req: ModelRequest) => Promise<ModelResponse>) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    return this.impl(request);
  }
}

describe("createDirectModelExecutionProvider", () => {
  it("maps a successful completion to status:completed, passing model/messages through unchanged", async () => {
    const stub = new StubClient(async () => ({
      content: "the answer",
      model: "resolved-model",
      finishReason: "stop",
      usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 2 },
    }));
    const provider = createDirectModelExecutionProvider(stub);

    const result = await provider.execute(baseRequest());

    expect(result).toEqual({
      status: "completed",
      content: "the answer",
      model: "resolved-model",
      usage: { promptTokens: 10, completionTokens: 5, cachedPromptTokens: 2 },
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.model).toBe("some-model");
    expect(stub.calls[0]!.timeoutMs).toBe(5000);
    expect(stub.calls[0]!.messages).toEqual([
      { role: "system", content: "system prompt text" },
      { role: "user", content: expect.stringContaining("BEGIN RUN CONTEXT") },
    ]);
  });

  it("maps ModelTimeoutError to the exact original shape: timed_out semantics, 504, model_timeout category", async () => {
    const stub = new StubClient(async () => {
      throw new ModelTimeoutError(5000);
    });
    const provider = createDirectModelExecutionProvider(stub);

    const result = await provider.execute(baseRequest({ timeoutMs: 5000 }));

    expect(result).toEqual({
      status: "failed",
      category: "timeout",
      reason: "model_timeout_after_5000ms",
      httpStatus: 504,
      invalidOutput: false,
    });
  });

  it("maps ModelProviderError to provider_error / 502, invalidOutput false", async () => {
    const stub = new StubClient(async () => {
      throw new ModelProviderError("provider returned HTTP 500", 500);
    });
    const provider = createDirectModelExecutionProvider(stub);

    const result = await provider.execute(baseRequest());

    expect(result).toEqual({
      status: "failed",
      category: "provider_error",
      reason: "model provider error: provider returned HTTP 500",
      httpStatus: 502,
      invalidOutput: false,
    });
  });

  it("maps ModelInvalidOutputError to provider_error / 502, invalidOutput TRUE", async () => {
    const stub = new StubClient(async () => {
      throw new ModelInvalidOutputError("provider returned no usable completion content", 200);
    });
    const provider = createDirectModelExecutionProvider(stub);

    const result = await provider.execute(baseRequest());

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.category).toBe("provider_error");
      expect(result.httpStatus).toBe(502);
      expect(result.invalidOutput).toBe(true);
    }
  });

  it("maps an unrecognised thrown error to internal_error / 500", async () => {
    const stub = new StubClient(async () => {
      throw new TypeError("boom");
    });
    const provider = createDirectModelExecutionProvider(stub);

    const result = await provider.execute(baseRequest());

    expect(result).toEqual({
      status: "failed",
      category: "internal_error",
      reason: "internal_error (TypeError)",
      httpStatus: 500,
      invalidOutput: false,
    });
  });
});
