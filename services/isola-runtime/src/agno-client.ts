/**
 * Agno AgentOS client — a SECOND ModelClient implementation, additive
 * alongside the OpenAI-compatible one in model.ts.
 *
 * WHY A SEPARATE FILE, NOT A BRANCH IN model.ts. Agno's `/agents/{id}/runs`
 * contract is not OpenAI-compatible: form-encoded, not JSON; a single
 * `message` string, not a `messages` array; `session_id`/`user_id` govern
 * conversation and identity scoping instead of being implied by the request
 * shape; the response carries `status`/`content` at the top level, not
 * `choices[0].message.content`. Reusing createOpenAiCompatibleClient's own
 * request/response shape here would mean coercing one contract into another
 * that does not fit it — this is the honest shape instead.
 *
 * WHY THE SYSTEM PROMPT MESSAGE IS NOT SENT. Agno's own component (authored
 * server-side, on Agno) already carries its instructions — that is the whole
 * point of registering it as a component rather than sending a prompt per
 * call (registry.ts's own header: "nothing behaviour-bearing may arrive in
 * the request"). Forwarding this template's `system` message too would be a
 * second, possibly conflicting, instruction source. Only the `user` message
 * is sent as Agno's `message` field.
 *
 * WHAT THIS FIRST INCREMENT DELIBERATELY DOES NOT DO: pin a component
 * version, send `dependencies` for a mode switch, or verify the executed
 * version came back.
 *
 * USAGE. Measured directly against the installed `agno` package on host03
 * (not inferred from bff-v2's own consumption of a different Agno surface):
 * `agno/run/agent.py`'s `RunOutput.to_dict()` includes `metrics` whenever
 * present, and `agno/os/routers/agents/router.py`'s `create_agent_run` —
 * specifically its `stream=False` branch, the one this client always
 * requests — returns exactly `run_response.to_dict()` as the HTTP body. So
 * `metrics.input_tokens` / `.output_tokens` / `.cache_read_tokens` are real,
 * measured fields on this response, not a hopeful guess. Confirmed against a
 * real stored run too (`ai.agno_runs.run_data->'metrics'` on host03), not
 * only the source. Mapped straight onto ModelUsage below — no estimating.
 */
import type { SafeFetch } from "./egress.js";
import {
  EgressBlockedError,
  ModelInvalidOutputError,
  ModelProviderError,
  ModelTimeoutError,
} from "./errors.js";
import type { ModelClient, ModelRequest, ModelResponse } from "./model.js";

export interface AgnoClientOptions {
  baseUrl: string;
  apiKey: string | null;
  safeFetch: SafeFetch;
}

function runsUrl(baseUrl: string, componentId: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  return `${base}/agents/${encodeURIComponent(componentId)}/runs`;
}

/** The last `user` message's content — see the file header for why `system` is dropped. */
function lastUserMessage(request: ModelRequest): string | null {
  for (let i = request.messages.length - 1; i >= 0; i -= 1) {
    const m = request.messages[i];
    if (m !== undefined && m.role === "user") return m.content;
  }
  return null;
}

/**
 * `RunOutput.metrics` (`agno/metrics.py`, RunMetrics.to_dict()) — top-level
 * `input_tokens`/`output_tokens`/`cache_read_tokens` are the run's own
 * totals; the nested `details.model[]` breakdown is per-model-call detail
 * this runtime has no use for. A number present as 0 is real (a genuinely
 * free or cached-only call); a number ABSENT is unmeasured — never coerced
 * to 0, matching ModelUsage's own null-means-unknown contract.
 */
function extractAgnoUsage(body: Record<string, unknown>): ModelResponse["usage"] {
  const metrics = body["metrics"];
  if (typeof metrics !== "object" || metrics === null) return null;
  const m = metrics as Record<string, unknown>;
  const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
  const usage = {
    promptTokens: num(m["input_tokens"]),
    completionTokens: num(m["output_tokens"]),
    cachedPromptTokens: num(m["cache_read_tokens"]),
  };
  // All three absent is indistinguishable from "no metrics at all" downstream
  // (usageIsEmpty treats it the same either way) — returning null here rather
  // than an all-null object keeps that equivalence explicit at this boundary.
  if (usage.promptTokens === null && usage.completionTokens === null) return null;
  return usage;
}

function extractAgnoContent(
  payload: unknown,
): { content: string; runId: string | null; usage: ModelResponse["usage"] } | null {
  if (typeof payload !== "object" || payload === null) return null;
  const body = payload as Record<string, unknown>;
  const status = typeof body["status"] === "string" ? body["status"].toUpperCase() : "";
  if (status !== "COMPLETED") return null;
  const content = body["content"];
  if (typeof content !== "string" || content.trim().length === 0) return null;
  const runId = typeof body["run_id"] === "string" ? body["run_id"] : null;
  return { content, runId, usage: extractAgnoUsage(body) };
}

export function createAgnoClient(options: AgnoClientOptions): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      if (options.apiKey === null) {
        throw new ModelProviderError("AGENTOS_SERVICE_TOKEN is not configured");
      }
      const message = lastUserMessage(request);
      if (message === null) {
        throw new ModelProviderError("no user message to send to Agno");
      }
      // Fail closed rather than guess a scope: Agno's own contract requires
      // both, and a run addressed to nobody's session is not a smaller
      // version of a real call, it is a different, unscoped one.
      if (!request.sessionId || !request.userId) {
        throw new ModelProviderError(
          "agno run requires sessionId and userId; neither may be inferred here",
        );
      }

      const url = runsUrl(options.baseUrl, request.model);
      const form = new URLSearchParams({
        message,
        stream: "false",
        session_id: request.sessionId,
        user_id: request.userId,
      });

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, request.timeoutMs);
      if (typeof timer.unref === "function") timer.unref();

      let response: Response;
      try {
        response = await options.safeFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            accept: "application/json",
            authorization: `Bearer ${options.apiKey}`,
          },
          body: form.toString(),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) throw new ModelTimeoutError(request.timeoutMs);
        if (err instanceof EgressBlockedError) throw err;
        if (err instanceof Error && err.name === "AbortError") {
          throw new ModelTimeoutError(request.timeoutMs);
        }
        const name = err instanceof Error ? err.name : "unknown";
        throw new ModelProviderError(`transport failure (${name})`);
      } finally {
        clearTimeout(timer);
      }

      if (!response.ok) {
        // The body is deliberately NOT read into the error — same reasoning
        // as the OpenAI-compatible client: it can echo the prompt or a token.
        throw new ModelProviderError(
          `agno returned HTTP ${response.status}`,
          response.status,
        );
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        if (timedOut) throw new ModelTimeoutError(request.timeoutMs);
        throw new ModelProviderError("agno returned a non-JSON body", response.status);
      }

      const parsed = extractAgnoContent(payload);
      if (parsed === null) {
        throw new ModelInvalidOutputError(
          "agno returned no usable completed run",
          response.status,
        );
      }

      return {
        content: parsed.content,
        // Not the OpenAI-shaped "model" field Agno does not return; the
        // component id this request addressed is the honest label here.
        model: request.model,
        finishReason: null,
        usage: parsed.usage,
      };
    },
  };
}
