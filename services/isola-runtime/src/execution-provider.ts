/**
 * The runtime-neutral execution seam.
 *
 * Before this file, `app.ts` called `clientForTemplate(template).complete(...)`
 * directly: one model transport for every template. This introduces ONE
 * interface that both the existing direct-model path and the new private
 * AgentOS sidecar path satisfy, so the call site no longer knows or cares
 * which brain actually answered — it only knows whether the run completed or
 * failed.
 *
 * `DirectModelExecutionProvider` below is a pure adapter: it reproduces, field
 * for field, the exact classification `app.ts` used to do inline in its
 * try/catch around `ModelClient.complete()`. That reproduction is deliberate
 * and load-bearing — `isola-ai-sales-front-desk-agent@v1` and
 * `isola-internal-manager@v1` must behave byte-for-byte as they did before
 * this seam existed, and the way that is guaranteed is by NOT rewriting their
 * error handling, only relocating it.
 */
import { buildUserMessage, type RenderedContext } from "./context.js";
import { ModelInvalidOutputError, ModelProviderError, ModelTimeoutError } from "./errors.js";
import type { ChatMessage, ModelClient, ModelUsage } from "./model.js";
import type { Exposure, TemplateEntry } from "./registry.js";

export interface ExecutionRequest {
  readonly template: TemplateEntry;
  /**
   * `null` means the request carried no discoverable tenant — see
   * `extractTenantId` in conversation.ts. Providers must never treat `null`
   * as a wildcard; the AgentOS allowlist explicitly refuses it.
   */
  readonly tenantId: string | null;
  /** The EFFECTIVE exposure, after credential resolution — never the raw request field. */
  readonly exposure: Exposure;
  readonly model: string;
  readonly systemPrompt: string;
  readonly renderedContext: RenderedContext;
  readonly correlationId: string;
  readonly timeoutMs: number;
}

export type ExecutionFailureCategory = "timeout" | "provider_error" | "internal_error";

export type ExecutionResult =
  | {
      readonly status: "completed";
      readonly content: string;
      readonly usage: ModelUsage | null;
      readonly model: string | null;
    }
  | {
      /**
       * Every failure mode this seam can produce — a timeout, a dependency
       * failure, a malformed or ambiguous response — collapses to this ONE
       * shape. There is no other terminal state: a provider either completed
       * or it failed, and a failure is never silently retried through a
       * different provider by anything that reads this result.
       */
      readonly status: "failed";
      readonly category: ExecutionFailureCategory;
      readonly reason: string;
      readonly httpStatus: number;
      /** True only for a provider that answered but produced no usable content. */
      readonly invalidOutput: boolean;
    };

export interface ExecutionProvider {
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

function chatMessages(request: ExecutionRequest, userMessage: string): ChatMessage[] {
  return [
    { role: "system", content: request.systemPrompt },
    { role: "user", content: userMessage },
  ];
}

/**
 * Wraps the existing `ModelClient` (whatever `clientForTemplate` resolved —
 * the process-wide default, or a template's own declared brain) so the model
 * call site in `app.ts` can be provider-shaped without changing what actually
 * happens on the wire for any template that does not opt into AgentOS.
 */
export function createDirectModelExecutionProvider(client: ModelClient): ExecutionProvider {
  return {
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      // Deterministic, pure, and the exact function app.ts already called
      // before this seam existed: same envelope, same truncation marker.
      const userMessage = buildUserMessage(request.renderedContext);
      try {
        const result = await client.complete({
          model: request.model,
          timeoutMs: request.timeoutMs,
          messages: chatMessages(request, userMessage),
        });
        return {
          status: "completed",
          content: result.content,
          usage: result.usage,
          model: result.model,
        };
      } catch (err) {
        // This block is the ORIGINAL app.ts classification, moved verbatim.
        if (err instanceof ModelTimeoutError) {
          return {
            status: "failed",
            category: "timeout",
            reason: `model_timeout_after_${request.timeoutMs}ms`,
            httpStatus: 504,
            invalidOutput: false,
          };
        }
        if (err instanceof ModelProviderError) {
          return {
            status: "failed",
            category: "provider_error",
            reason: err.message,
            httpStatus: 502,
            invalidOutput: err instanceof ModelInvalidOutputError,
          };
        }
        return {
          status: "failed",
          category: "internal_error",
          reason: `internal_error (${err instanceof Error ? err.name : "unknown"})`,
          httpStatus: 500,
          invalidOutput: false,
        };
      }
    },
  };
}
