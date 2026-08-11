/**
 * OpenAI-compatible Chat Completions client.
 *
 * All network access goes through the injected SafeFetch. This module never
 * calls the platform network primitive directly.
 */
import type { SafeFetch } from "./egress.js";
import {
  EgressBlockedError,
  ModelInvalidOutputError,
  ModelProviderError,
  ModelTimeoutError,
} from "./errors.js";

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export interface ModelRequest {
  model: string;
  messages: ChatMessage[];
  timeoutMs: number;
}

/**
 * Usage as the provider reported it. This is the ONLY source of billable
 * quantities in this service — nothing downstream is allowed to estimate one.
 *
 * `promptTokens` is the provider's TOTAL input count and includes any cached
 * tokens; `cachedPromptTokens` is the cached subset. Billing splits them,
 * because a cache hit is charged at a different rate (DeepSeek reports the
 * split as `prompt_cache_hit_tokens`, OpenAI as
 * `prompt_tokens_details.cached_tokens`).
 */
export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
}

export interface ModelResponse {
  content: string;
  model: string | null;
  finishReason: string | null;
  usage: ModelUsage | null;
}

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/**
 * Join a base URL with the chat-completions path, tolerating a base that
 * already ends in `/v1` so the path is never doubled.
 */
export function chatCompletionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return /\/v1$/i.test(base)
    ? `${base}/chat/completions`
    : `${base}/v1/chat/completions`;
}

export interface OpenAiCompatibleClientOptions {
  baseUrl: string;
  apiKey: string | null;
  safeFetch: SafeFetch;
}

function extractContent(payload: unknown): {
  content: string;
  model: string | null;
  finishReason: string | null;
  usage: ModelResponse["usage"];
} | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (typeof first !== "object" || first === null) return null;
  const message = (first as Record<string, unknown>)["message"];
  if (typeof message !== "object" || message === null) return null;
  const content = (message as Record<string, unknown>)["content"];
  if (typeof content !== "string" || content.trim().length === 0) return null;

  const finish = (first as Record<string, unknown>)["finish_reason"];
  const usageRaw = body["usage"];
  let usage: ModelResponse["usage"] = null;
  if (typeof usageRaw === "object" && usageRaw !== null) {
    const u = usageRaw as Record<string, unknown>;
    const details = u["prompt_tokens_details"];
    const detailCached =
      typeof details === "object" && details !== null
        ? (details as Record<string, unknown>)["cached_tokens"]
        : undefined;
    // DeepSeek reports the cache split directly; OpenAI nests it. Take
    // whichever the provider actually sent, and never synthesise one.
    const cached =
      typeof u["prompt_cache_hit_tokens"] === "number"
        ? u["prompt_cache_hit_tokens"]
        : typeof detailCached === "number"
          ? detailCached
          : null;
    usage = {
      promptTokens: typeof u["prompt_tokens"] === "number" ? u["prompt_tokens"] : null,
      completionTokens:
        typeof u["completion_tokens"] === "number" ? u["completion_tokens"] : null,
      cachedPromptTokens: cached,
    };
  }

  return {
    content,
    model: typeof body["model"] === "string" ? body["model"] : null,
    finishReason: typeof finish === "string" ? finish : null,
    usage,
  };
}

export function createOpenAiCompatibleClient(
  options: OpenAiCompatibleClientOptions,
): ModelClient {
  const url = chatCompletionsUrl(options.baseUrl);

  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (options.apiKey === null) {
        throw new ModelProviderError("MODEL_API_KEY is not configured");
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);
      // Never keep the process alive for a pending deadline.
      if (typeof timer.unref === "function") timer.unref();

      let response: Response;
      try {
        response = await options.safeFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify({
            model: request.model,
            messages: request.messages,
            stream: false,
          }),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new ModelTimeoutError(request.timeoutMs);
        if (err instanceof EgressBlockedError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new ModelTimeoutError(request.timeoutMs);
        }
        // Category only. The underlying error message may embed a URL with a
        // query string, so only the error class name is carried forward.
        const name = err instanceof Error ? err.name : "unknown";
        throw new ModelProviderError(`transport failure (${name})`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The provider body is deliberately NOT read into the error: it can echo
        // the prompt or the key. Status class only.
        throw new ModelProviderError(
          `provider returned HTTP ${response.status}`,
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        // The deadline can also fire while the body is still streaming.
        if (timedOut) throw new ModelTimeoutError(request.timeoutMs);
        throw new ModelProviderError("provider returned a non-JSON body", response.status);
      }

      const parsed = extractContent(payload);
      if (parsed === null) {
        // Same message, same status, same `provider_error` outcome as before —
        // the subclass only lets the inline contract say `invalid_output`.
        throw new ModelInvalidOutputError(
          "provider returned no usable completion content",
          response.status,
        );
      }

      return {
        content: parsed.content,
        model: parsed.model,
        finishReason: parsed.finishReason,
        usage: parsed.usage,
      };
    },
  };
}
