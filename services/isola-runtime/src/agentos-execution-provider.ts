/**
 * The AgentOS execution provider — the ONLY code in this service that talks to
 * the private Python sidecar.
 *
 * Per dec-agentos-private-python-service-behind-node-isola-runtime-2026-08-22
 * (Option A): this service remains the sole production caller, the sidecar has
 * no public path of its own, and there is no transparent fail-open or retry
 * from an ambiguous sidecar result into any other execution path (Hermes or
 * otherwise). Every non-`"completed"` outcome — a timeout, a non-200, a
 * malformed body, a body missing a required field, or an explicit
 * non-terminal/failed status — collapses to `ExecutionResult.status:"failed"`
 * with NO retry attempted here or anywhere downstream.
 *
 * The envelope sent to the sidecar is typed narrowly on purpose
 * (`AgentOsRunEnvelope`): correlationId, tenantId, templateId, exposure, and
 * the already redaction-safe, byte-capped rendered context. There is no field
 * for an Odoo/Chatwoot/host credential, a Codex/OpenAI credential, or any raw
 * DB handle — the type itself is the enforcement, not a convention two call
 * sites have to remember.
 */
import { buildUserMessage } from "./context.js";
import { EgressBlockedError } from "./errors.js";
import type { ExecutionProvider, ExecutionRequest, ExecutionResult } from "./execution-provider.js";
import type { SafeFetch } from "./egress.js";
import type { Exposure } from "./registry.js";

/**
 * THE ENTIRE WIRE CONTRACT to the sidecar. No other field may be added to this
 * type without a corresponding, deliberate widening of what a customer- or
 * staff-facing run can expose to a process outside this one.
 */
export interface AgentOsRunEnvelope {
  readonly correlationId: string;
  readonly tenantId: string;
  readonly templateId: string;
  readonly exposure: Exposure;
  /**
   * The SERVER-AUTHORITATIVE system instruction, resolved by Node. Kept as its
   * own field, never merged into `context`: the sidecar uses this as the
   * system-level instruction source and treats `context` strictly as
   * caller-supplied data, so the "context is data, not instruction" boundary
   * survives the hop.
   */
  readonly systemPrompt: string;
  readonly context: string;
  /**
   * THE DEADLINE THIS CALL IS ALREADY OPERATING UNDER, in REMAINING
   * MILLISECONDS, as an integer.
   *
   * Added 2026-08-27 to close
   * def-agentos-sidecar-ignores-caller-deadline-2026-08-27. The sidecar
   * enforced only its OWN configured `AGENTOS_REQUEST_TIMEOUT_S` because the
   * envelope gave Node's deadline nowhere to travel. Aborting the fetch here
   * does not stop the work behind it: when this deadline was the tighter one,
   * Node gave up and the sidecar kept executing — and kept spending provider
   * tokens — for a caller that was already gone.
   *
   * SERVER-DERIVED, NEVER CALLER-SUPPLIED. It is exactly the `deadlineMs`
   * computed below from `request.timeoutMs` (itself
   * `Math.min(template.timeoutMs, RUNTIME_MODEL_TIMEOUT_MS)`, computed in
   * app.ts) and the operator's `AGENTOS_TIMEOUT_MS`. `ExecutionRequest` has no
   * field a caller could put a deadline in, and that absence is the
   * enforcement: a caller able to name its own deadline could widen the
   * effective policy ceiling of a process it has no right to configure.
   *
   * A DURATION, NOT AN ABSOLUTE TIMESTAMP. The two containers have no
   * guaranteed clock sync, so an epoch value interpreted against the sidecar's
   * clock misbehaves silently under skew in both directions — arriving already
   * expired, or arriving with hours of budget. A duration means the same thing
   * on both sides of the hop with no shared reference at all.
   */
  readonly deadlineMs: number;
}

export interface AgentOsExecutionProviderOptions {
  /** Internal-network-only base URL. No default — see config.ts / bootErrors. */
  baseUrl: string;
  /** File-backed shared secret, read once at startup (see entrypoint.sh). */
  sharedSecret: string;
  safeFetch: SafeFetch;
  timeoutMs: number;
}

interface AgentOsRawUsage {
  promptTokens?: unknown;
  completionTokens?: unknown;
  cachedPromptTokens?: unknown;
}

function agentOsRunUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/agent-run`;
}

function extractUsage(raw: unknown): {
  promptTokens: number | null;
  completionTokens: number | null;
  cachedPromptTokens: number | null;
} | null {
  if (typeof raw !== "object" || raw === null) return null;
  const u = raw as AgentOsRawUsage;
  return {
    promptTokens: typeof u.promptTokens === "number" ? u.promptTokens : null,
    completionTokens: typeof u.completionTokens === "number" ? u.completionTokens : null,
    cachedPromptTokens: typeof u.cachedPromptTokens === "number" ? u.cachedPromptTokens : null,
  };
}

/**
 * Parses a body ALREADY KNOWN to carry `status === "completed"`. Returns
 * `null` on anything short of a fully-shaped success body — a missing or
 * empty `content` is malformed, never treated as an empty-but-valid answer.
 */
function parseCompletedBody(
  payload: Record<string, unknown>,
): { content: string; model: string | null; usage: ReturnType<typeof extractUsage> } | null {
  if (typeof payload.content !== "string" || payload.content.length === 0) return null;
  return {
    content: payload.content,
    model: typeof payload.model === "string" ? payload.model : null,
    usage: extractUsage(payload.usage),
  };
}

export function createAgentOsExecutionProvider(
  options: AgentOsExecutionProviderOptions,
): ExecutionProvider {
  const url = agentOsRunUrl(options.baseUrl);

  return {
    async execute(request: ExecutionRequest): Promise<ExecutionResult> {
      // Defence in depth: the allowlist gate in app.ts must never route a
      // null tenant here, but a provider must never trust its caller either.
      if (request.tenantId === null) {
        return {
          status: "failed",
          category: "internal_error",
          reason: "agentos_missing_tenant: refusing to call the sidecar with no tenant id",
          httpStatus: 500,
          invalidOutput: false,
        };
      }

      /**
       * THE TIGHTER OF THE TWO DEADLINES WINS.
       *
       * `request.timeoutMs` is the per-run deadline (the tighter of the
       * template's and RUNTIME_MODEL_TIMEOUT_MS, computed in app.ts);
       * `options.timeoutMs` is the operator's AGENTOS_TIMEOUT_MS ceiling for
       * this hop specifically. Until now only the first was ever read, so
       * AGENTOS_TIMEOUT_MS was configuration with no effect — a setting that
       * looks applied and is not (CLAUDE.md Law 24's corollary).
       *
       * Computed HERE, above the envelope, because the same number is now
       * both enforced locally (the abort timer below) and transmitted to the
       * sidecar (`deadlineMs`). One expression, read twice: if the two could
       * be computed separately they could drift, and the sidecar would be
       * told one budget while this side abandoned the call at another.
       */
      const deadlineMs = Math.min(request.timeoutMs, options.timeoutMs);

      const envelope: AgentOsRunEnvelope = {
        correlationId: request.correlationId,
        tenantId: request.tenantId,
        templateId: request.template.id,
        exposure: request.exposure,
        // SERVER-AUTHORITATIVE instructions. Resolved by Node (compiled-in
        // template prompt, or the Paperclip charter when this template is
        // bound in PAPERCLIP_INSTRUCTIONS_MAP) and carried explicitly, so the
        // sidecar runs the charter the operator actually resolved rather than
        // silently falling back to its own compiled-in copy. It is a SEPARATE
        // field from `context` on purpose: context is caller-supplied data and
        // must never be able to become the instruction source.
        systemPrompt: request.systemPrompt,
        context: buildUserMessage(request.renderedContext),
        // The SAME number the abort timer below is armed with — see the field
        // doc on AgentOsRunEnvelope for why it is a remaining duration and why
        // it can never come from the caller.
        deadlineMs,
      };

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, deadlineMs);
      if (typeof timer.unref === "function") timer.unref();

      const timedOutResult = (): ExecutionResult => ({
        status: "failed",
        category: "timeout",
        reason: `agentos_timeout_after_${deadlineMs}ms`,
        httpStatus: 504,
        invalidOutput: false,
      });

      // THE TIMER STAYS ARMED THROUGH BODY CONSUMPTION. It used to be cleared
      // in a `finally` that ran as soon as the headers arrived, so a sidecar
      // that returned headers and then stalled mid-body hung past the deadline
      // while still holding a budget reservation. Everything below runs inside
      // this try, and the timer is cleared once — in the outer finally.
      try {
      let response: Response;
      try {
        response = await options.safeFetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${options.sharedSecret}`,
          },
          body: JSON.stringify(envelope),
          signal: controller.signal,
        });
      } catch (err) {
        if (timedOut) return timedOutResult();
        if (err instanceof EgressBlockedError) {
          return {
            status: "failed",
            category: "provider_error",
            reason: "agentos_egress_blocked",
            httpStatus: 502,
            invalidOutput: false,
          };
        }
        if (err instanceof Error && err.name === "AbortError") return timedOutResult();
        const name = err instanceof Error ? err.name : "unknown";
        return {
          status: "failed",
          category: "provider_error",
          reason: `agentos_transport_failure (${name})`,
          httpStatus: 502,
          invalidOutput: false,
        };
      }

      if (response.status === 401 || response.status === 403) {
        // The sidecar rejected our own credential or its own allowlist check.
        // Never retried, never treated as "maybe it's fine" — a dependency
        // that refuses authentication is a dependency that is unavailable.
        return {
          status: "failed",
          category: "provider_error",
          reason: `agentos_sidecar_refused_auth_or_allowlist (HTTP ${response.status})`,
          httpStatus: 502,
          invalidOutput: false,
        };
      }

      if (!response.ok) {
        return {
          status: "failed",
          category: "provider_error",
          reason: `agentos_sidecar_returned_HTTP_${response.status}`,
          httpStatus: 502,
          invalidOutput: false,
        };
      }

      let payload: unknown;
      try {
        // The deadline is still armed here: a body that never finishes
        // arriving aborts and lands on the timeout branch below.
        payload = await response.json();
      } catch {
        if (timedOut) return timedOutResult();
        return {
          status: "failed",
          category: "provider_error",
          reason: "agentos_non_json_body",
          httpStatus: 502,
          invalidOutput: true,
        };
      }

      if (typeof payload !== "object" || payload === null) {
        return {
          status: "failed",
          category: "provider_error",
          reason: "agentos_malformed_body",
          httpStatus: 502,
          invalidOutput: true,
        };
      }

      const body = payload as Record<string, unknown>;
      // ONLY an exact "completed" is success. Anything else — a
      // known-in-progress status, an unrecognised string, a missing field —
      // is ambiguous, and an ambiguous result is a failed one. Never guess.
      if (body.status !== "completed") {
        const statusField = typeof body.status === "string" ? body.status : "missing";
        return {
          status: "failed",
          category: "provider_error",
          reason: `agentos_non_terminal_status (${statusField})`,
          httpStatus: 502,
          invalidOutput: true,
        };
      }

      const parsed = parseCompletedBody(body);
      if (parsed === null) {
        return {
          status: "failed",
          category: "provider_error",
          reason: "agentos_malformed_completed_body",
          httpStatus: 502,
          invalidOutput: true,
        };
      }

      return {
        status: "completed",
        content: parsed.content,
        model: parsed.model,
        usage: parsed.usage,
      };
      } finally {
        // Cleared exactly once, after the response body has been fully
        // consumed — never before, or a stalled body would outlive its deadline.
        clearTimeout(timer);
      }
    },
  };
}
