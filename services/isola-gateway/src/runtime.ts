/**
 * The isola-runtime client — and the one place the open contract lives.
 *
 * ===========================================================================
 * DEPENDENCY: `responseMode: "inline"` IS NOT IMPLEMENTED IN isola-runtime YET
 * ===========================================================================
 *
 * isola-runtime posts the employee's output to Paperclip; it does NOT return
 * the assistant text to its caller. For the Chatwoot path we need that text, so
 * this client sends `responseMode: "inline"` and reads the answer out of the
 * response body:
 *
 *     data.text ?? data.content ?? data.message ?? null
 *
 * Until isola-runtime honours `responseMode`, every successful invocation will
 * come back with `text === null`, which this gateway classifies as
 * `runtime_no_text`: a CONTRACT VIOLATION. On that outcome the pipeline posts
 * no customer message at all and escalates to a human. It never invents a
 * reply, and it never re-uses the runtime's error strings as an answer.
 *
 * Verified isola-runtime contract (`POST /v1/invoke`):
 *   Authorization: Bearer <RUNTIME_SECRET_PUBLIC>
 *   body {templateId, exposure: "PUBLIC", agentId, runId, context}
 *   200 -> {ok, outcome, correlationId}
 *   504 -> model_timeout
 *   502 -> provider_error
 *   402 -> budget_exhausted
 *   403 -> exposure_mismatch
 */
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError } from "./errors.js";

export type RuntimeOutcome =
  | "ok"
  | "model_timeout"
  | "provider_error"
  | "budget_exhausted"
  | "exposure_mismatch"
  | "unauthorized"
  | "runtime_unreachable"
  | "runtime_error";

export interface AgentRuntimeRequest {
  templateId: string;
  exposure: "PUBLIC";
  agentId: string;
  runId: string;
  context: Record<string, unknown>;
}

export interface AgentRuntimeResult {
  /** The assistant text, or null when the runtime did not return one. */
  text: string | null;
  outcome: string;
  correlationId: string;
}

export interface AgentRuntime {
  invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult>;
}

/** Map an isola-runtime HTTP status onto this gateway's outcome vocabulary. */
export function outcomeForStatus(status: number): RuntimeOutcome {
  if (status >= 200 && status < 300) return "ok";
  switch (status) {
    case 401:
      return "unauthorized";
    case 402:
      return "budget_exhausted";
    case 403:
      return "exposure_mismatch";
    case 502:
      return "provider_error";
    case 504:
      return "model_timeout";
    default:
      return "runtime_error";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The inline-response reader. Deliberately narrow: only a non-empty string in
 * one of the three agreed fields counts as an answer.
 */
export function readInlineText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ["text", "content", "message"]) {
    const value = payload[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function readCorrelationId(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    const value = payload["correlationId"];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return fallback;
}

export interface HttpAgentRuntimeOptions {
  baseUrl: string;
  invokePath: string;
  bearer: string | null;
  safeFetch: SafeFetch;
  timeoutMs: number;
}

export class HttpAgentRuntime implements AgentRuntime {
  private readonly url: string;
  private readonly bearer: string | null;
  private readonly safeFetch: SafeFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpAgentRuntimeOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, "")}${options.invokePath}`;
    this.bearer = options.bearer;
    this.safeFetch = options.safeFetch;
    this.timeoutMs = options.timeoutMs;
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    if (this.bearer === null) {
      // Fail closed rather than sending an unauthenticated invocation.
      return { text: null, outcome: "unauthorized", correlationId: request.runId };
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    let response: Response;
    try {
      response = await this.safeFetch(this.url, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: `Bearer ${this.bearer}`,
        },
        body: JSON.stringify({
          templateId: request.templateId,
          exposure: request.exposure,
          agentId: request.agentId,
          runId: request.runId,
          context: request.context,
          // The open half of the contract. See the module doc comment.
          responseMode: "inline",
        }),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof EgressBlockedError) {
        return {
          text: null,
          outcome: "runtime_unreachable",
          correlationId: request.runId,
        };
      }
      return {
        text: null,
        outcome: timedOut ? "model_timeout" : "runtime_unreachable",
        correlationId: request.runId,
      };
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    const correlationId = readCorrelationId(payload, request.runId);
    const statusOutcome = outcomeForStatus(response.status);

    if (statusOutcome !== "ok") {
      // A failure body may carry an error string in `message`. It is NOT an
      // answer, so text is pinned to null on every non-2xx.
      return { text: null, outcome: statusOutcome, correlationId };
    }

    // A 200 that says `ok: false` is a failure regardless of its status code.
    const bodyOutcome =
      isRecord(payload) && typeof payload["outcome"] === "string"
        ? (payload["outcome"] as string)
        : "ok";
    if (bodyOutcome !== "ok") {
      return { text: null, outcome: bodyOutcome, correlationId };
    }

    return { text: readInlineText(payload), outcome: "ok", correlationId };
  }
}

export function createAgentRuntime(options: HttpAgentRuntimeOptions): AgentRuntime {
  return new HttpAgentRuntime(options);
}
