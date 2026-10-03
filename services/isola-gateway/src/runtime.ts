/**
 * The isola-runtime client — and the one place the open contract lives.
 *
 * ===========================================================================
 * isola-runtime implements `responseMode: "inline"` as of contract v1
 * (runtime v1.1.0). It returns the answer in `answerText`, byte-identical to
 * the text it persisted to Paperclip.
 * ===========================================================================
 *
 * isola-runtime posts the employee's output to Paperclip; it does NOT return
 * the assistant text to its caller. For the Chatwoot path we need that text, so
 * this client sends `responseMode: "inline"` and reads the answer out of the
 * response body:
 *
 *     data.answerText ?? data.text ?? data.content ?? data.message ?? null
 *
 * If a run reports success but carries no usable string, this gateway
 * classifies it as `runtime_no_text`: a CONTRACT VIOLATION. On that outcome the pipeline posts
 * no customer message at all and escalates to a human. It never invents a
 * reply, and it never re-uses the runtime's error strings as an answer.
 *
 * Verified isola-runtime contract (`POST /v1/invoke`):
 *   Authorization: Bearer <the runtime secret for THIS gateway's exposure class>
 *   body {templateId, exposure, agentId, runId, context, responseMode}
 *   200 -> {ok, outcome, correlationId, completionState, contractVersion, answerText}
 *   504 -> model_timeout
 *   502 -> provider_error OR persistence_failed OR invalid_output
 *   402 -> budget_exhausted
 *   403 -> exposure_mismatch
 *
 * NOTE THE 502. Three different end states share it, so the HTTP status alone
 * cannot classify a failure. `completionState` in the body is the authority and
 * this client prefers it; the status is the fallback for a body without one.
 */
import type { Exposure } from "./bindings.js";
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError } from "./errors.js";

export type RuntimeOutcome =
  | "ok"
  | "model_timeout"
  | "provider_error"
  | "persistence_failed"
  | "invalid_output"
  | "duplicate_in_flight"
  | "rejected"
  | "budget_exhausted"
  | "exposure_mismatch"
  | "unauthorized"
  | "runtime_unreachable"
  | "runtime_error";

export interface AgentRuntimeRequest {
  templateId: string;
  /**
   * THE BINDING'S exposure — never a constant.
   *
   * This was typed as the literal `"PUBLIC"` while PUBLIC was the only exposure
   * that existed. That looked like a safe narrowing and was the opposite: when
   * the first INTERNAL binding arrived, the type made the CORRECT value a
   * compile error, so the call site kept sending `"PUBLIC"` and the runtime
   * refused every internal invocation with `exposure_mismatch` (403). Measured
   * on 9043, 2026-08-18 — the line never answered once.
   *
   * The runtime treats this field as ADVISORY and the credential as the
   * authority: the body can only narrow, never widen. Sending the binding's own
   * exposure is therefore always safe, and sending a constant never is.
   */
  exposure: Exposure;
  agentId: string;
  runId: string;
  context: Record<string, unknown>;
  /**
   * The ledger key of this delivery `(tenant, binding, account, inbox, event id,
   * action)`, as the Paperclip path's stable idempotencyKey. The isola-runtime
   * client ignores it.
   */
  idempotencyKey?: string;
  /**
   * Whether the gateway STILL owns this conversation (the same predicate as the
   * post-run recheck). A long-running runtime may poll it and stop early on a
   * takeover; it rejects when ownership cannot be read, which means "unknown".
   * The isola-runtime client ignores it.
   */
  isStillOwned?: () => Promise<boolean>;
  /**
   * Aborted when the delivery's TURN BUDGET is spent (Codex R3 F1). Giving up on a
   * runtime call and discarding its result is not cancelling the work: a runtime that
   * went on polling under its own fresh deadline was still dispatching when another
   * worker had become eligible. So a runtime MUST start no request once this fires,
   * abort the one in flight, and stop polling.
   *
   * THE ONE ACCEPTED EXCEPTION (Lane A ruling, Step A+): a runtime that holds a remote run may
   * send ONE best-effort cancellation for THAT run after the signal fires (the direct Hermes
   * runtime sends a single `POST /v1/runs/{id}/stop`). A stop is a CANCELLATION, not a
   * DISPATCH: it removes work, and the alternative is a model call that keeps running after its
   * turn is spent (Step B measured that /stop halts model execution). It is sent once, never
   * retried, and its failure changes nothing. Everything else stays forbidden after the signal:
   * no create, no poll, no event stream, no second stop, and no write to the customer
   * (pinned by test/direct-hermes-post-signal.test.ts).
   */
  signal?: AbortSignal;
}

/**
 * The runtime's own truthful end state, contract v1. Read from the BODY.
 *
 * The HTTP status is lossy: the runtime returns 502 for both `provider_error`
 * (the provider errored) and `persistence_failed` (the model answered but
 * Paperclip refused the write-back). Mapping status→outcome therefore reported
 * a persistence failure as a provider failure, which is untrue and cost real
 * diagnostic time. `completionState` is the authority; the status is only the
 * fallback for a body that does not carry one.
 */
export const RUNTIME_COMPLETION_STATES = [
  "completed",
  "timeout",
  "provider_error",
  "invalid_output",
  "persistence_failed",
  "budget_exhausted",
  "internal_error",
  "duplicate_in_flight",
  "rejected",
] as const;
export type RuntimeCompletionState = (typeof RUNTIME_COMPLETION_STATES)[number];

export function isCompletionState(value: unknown): value is RuntimeCompletionState {
  return (
    typeof value === "string" &&
    (RUNTIME_COMPLETION_STATES as readonly string[]).includes(value)
  );
}

/**
 * Map the runtime's `completionState` onto this gateway's failure vocabulary.
 *
 * `completed` has no failure name — the caller must not reach here with it.
 * Every other state maps to a distinct, truthful outcome; nothing collapses
 * into `provider_error` any more.
 */
export function outcomeForCompletionState(state: RuntimeCompletionState): string {
  switch (state) {
    case "timeout":
      return "model_timeout";
    case "provider_error":
      return "provider_error";
    case "invalid_output":
      return "invalid_output";
    case "persistence_failed":
      return "persistence_failed";
    case "budget_exhausted":
      return "budget_exhausted";
    case "internal_error":
      return "runtime_error";
    case "duplicate_in_flight":
      return "duplicate_in_flight";
    case "rejected":
      return "rejected";
    default:
      return "runtime_error";
  }
}

/**
 * The structured action an agent turn may carry, contract v2.
 *
 * `null` means the runtime said NOTHING about escalation — an older build, or a
 * template that does not emit actions. That is deliberately distinct from
 * `"reply"`, which is a positive statement that no human is needed. The
 * pipeline needs the difference: on `null` it may fall back to the legacy
 * phrase heuristic, and on `"reply"` it must not.
 */
export const AGENT_ACTIONS = ["reply", "request_human"] as const;
export type AgentAction = (typeof AGENT_ACTIONS)[number];

export function isAgentAction(value: unknown): value is AgentAction {
  return typeof value === "string" && (AGENT_ACTIONS as readonly string[]).includes(value);
}

export interface AgentRuntimeResult {
  /** The assistant text, or null when the runtime did not return one. */
  text: string | null;
  outcome: string;
  correlationId: string;
  /**
   * What the agent asked for, or null when it said nothing. Only ever read from
   * a SUCCESS body: the runtime hardcodes `action: null` on every failure, so a
   * failed run structurally cannot ask for a handover.
   */
  action: AgentAction | null;
  /**
   * True when the body carried an `action` this build does not implement.
   * Distinct from `action: null`, which means the runtime said nothing at all —
   * the first must fail closed, the second falls back to the legacy heuristic.
   */
  actionUnrecognised: boolean;
  /** Bounded reason code for an escalation. Never prose, never an identifier. */
  actionReason: string | null;
  /**
   * The runtime's structured end state when it supplied one, else null. The
   * pipeline PREFERS this over `outcome` for classification.
   */
  completionState: RuntimeCompletionState | null;
  /** Contract version echoed by the runtime, when present. */
  contractVersion: number | null;
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
 * one of the agreed fields counts as an answer.
 *
 * `answerText` is the field isola-runtime actually returns (contract v1). The
 * other three were provisional names written before the runtime implemented the
 * contract; they are kept as a tolerant fallback but must never be preferred
 * over `answerText`.
 *
 * A failed inline run returns `answerText: null` with a truthful
 * `completionState`, so "no usable string here" is the runtime telling us it has
 * no answer — never a reason to substitute one.
 */
export const INLINE_TEXT_FIELDS = ["answerText", "text", "content", "message"] as const;

export function readInlineText(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of INLINE_TEXT_FIELDS) {
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

export function readCompletionState(payload: unknown): RuntimeCompletionState | null {
  if (!isRecord(payload)) return null;
  const value = payload["completionState"];
  return isCompletionState(value) ? value : null;
}

function readContractVersion(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const value = payload["contractVersion"];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Reading the action needs THREE outcomes, not two.
 *
 * Collapsing "the runtime said nothing" and "the runtime said something I do
 * not understand" into a single `null` loses the distinction that decides what
 * is safe to do:
 *
 *   absent      a pre-v2 runtime -> fall back to the legacy heuristic, which is
 *               exactly what this gateway did before the contract existed.
 *   known       authoritative.
 *   unrecognised the runtime asked for something this build cannot perform. It
 *               is NOT safe to send the reply and quietly do nothing: the reply
 *               may well describe the very thing that was requested ("I've
 *               arranged a callback"), so the customer would be told an action
 *               happened that did not. This fails closed instead.
 *
 * The runtime validates its own output and never emits an unknown verb today,
 * so this is defence against a future contract version meeting an old gateway —
 * which is precisely when a silent downgrade would be hardest to notice.
 */
export type AgentActionRead =
  | { kind: "absent" }
  | { kind: "known"; action: AgentAction }
  | { kind: "unrecognised" };

export function readAgentAction(payload: unknown): AgentActionRead {
  if (!isRecord(payload)) return { kind: "absent" };
  const value = payload["action"];
  if (value === undefined || value === null) return { kind: "absent" };
  return isAgentAction(value) ? { kind: "known", action: value } : { kind: "unrecognised" };
}

/**
 * The reason is validated against the CLOSED SET, not merely against a code
 * shape.
 *
 * A shape check alone accepts `card_4111111111111111`, which is code-shaped,
 * would pass `ownership.ts`'s pattern, and would be written verbatim to the
 * audit table. The runtime already enforces the closed list — but this value
 * crosses a service boundary before being persisted, and the component that
 * PERSISTS it is the one that has to guarantee what goes in. Anything else
 * becomes null and the escalation uses the default code.
 *
 * Adversarial review, 2026-08-25.
 */
export const AGENT_ESCALATION_REASON_CODES: readonly string[] = Object.freeze([
  "explicit_human_request",
  "low_confidence",
  "policy_boundary",
  "approval_required",
  "tool_failure",
  "complaint_sensitive",
  "unsupported_request",
]);

export function isAgentEscalationReason(value: unknown): value is string {
  return typeof value === "string" && AGENT_ESCALATION_REASON_CODES.includes(value);
}

export function readActionReason(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return isAgentEscalationReason(payload["actionReason"])
    ? (payload["actionReason"] as string)
    : null;
}

function runtimeTimeoutResult(runId: string): AgentRuntimeResult {
  return {
    text: null,
    action: null,
    actionUnrecognised: false,
    actionReason: null,
    outcome: "model_timeout",
    correlationId: runId,
    completionState: null,
    contractVersion: null,
  };
}

/** Rejects when `signal` aborts (never leaves an unhandled rejection behind). */
function whenAborted(signal: AbortSignal): Promise<never> {
  const promise = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) reject(new Error("aborted"));
    else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  promise.catch(() => undefined);
  return promise;
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
      return {
        text: null,
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome: "unauthorized",
        correlationId: request.runId,
        completionState: null,
        contractVersion: null,
      };
    }

    // A turn whose budget is already spent sends nothing (Codex R3 F1).
    if (request.signal?.aborted === true) return runtimeTimeoutResult(request.runId);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
    // The turn signal firing mid-request aborts it (and the body read below).
    const onTurnAbort = (): void => {
      timedOut = true;
      controller.abort();
    };
    request.signal?.addEventListener("abort", onTurnAbort, { once: true });
    const release = (): void => {
      clearTimeout(timer);
      request.signal?.removeEventListener("abort", onTurnAbort);
    };

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
      release();
      if (err instanceof EgressBlockedError) {
        return {
          text: null,
          action: null,
          actionUnrecognised: false,
          actionReason: null,
          outcome: "runtime_unreachable",
          correlationId: request.runId,
          completionState: null,
          contractVersion: null,
        };
      }
      return {
        text: null,
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome: timedOut ? "model_timeout" : "runtime_unreachable",
        correlationId: request.runId,
        completionState: null,
        contractVersion: null,
      };
    }

    // The timer stays armed through the BODY read (Codex R3 F1: it used to be cleared
    // once the headers arrived, so a body that never completed held the call open past
    // every budget), and the read is raced against the abort because a body may ignore
    // the signal.
    let payload: unknown = null;
    try {
      payload = await Promise.race([response.json(), whenAborted(controller.signal)]);
    } catch {
      payload = null;
    } finally {
      release();
    }
    if (timedOut) return runtimeTimeoutResult(request.runId);

    const correlationId = readCorrelationId(payload, request.runId);
    const statusOutcome = outcomeForStatus(response.status);
    const completionState = readCompletionState(payload);
    const contractVersion = readContractVersion(payload);

    if (statusOutcome !== "ok") {
      // A failure body may carry an error string in `message`. It is NOT an
      // answer, so text is pinned to null on every non-2xx.
      //
      // The BODY decides what to call the failure. 502 alone cannot tell
      // `provider_error` from `persistence_failed`; `completionState` can.
      const outcome =
        completionState !== null && completionState !== "completed"
          ? outcomeForCompletionState(completionState)
          : statusOutcome;
      return {
        text: null,
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome,
        correlationId,
        completionState,
        contractVersion,
      };
    }

    // A 200 that says `ok: false` is a failure regardless of its status code.
    const bodyOutcome =
      isRecord(payload) && typeof payload["outcome"] === "string"
        ? (payload["outcome"] as string)
        : "ok";
    if (bodyOutcome !== "ok") {
      const outcome =
        completionState !== null && completionState !== "completed"
          ? outcomeForCompletionState(completionState)
          : bodyOutcome;
      return {
        text: null,
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome,
        correlationId,
        completionState,
        contractVersion,
      };
    }

    // A 200 with `ok: true` but a non-`completed` state is still a failure —
    // the runtime is telling us it has no persisted answer.
    if (completionState !== null && completionState !== "completed") {
      return {
        text: null,
        action: null,
        actionUnrecognised: false,
        actionReason: null,
        outcome: outcomeForCompletionState(completionState),
        correlationId,
        completionState,
        contractVersion,
      };
    }

    // THE ONLY PATH THAT MAY CARRY AN ACTION. Every return above pins it to
    // null, so a run this client classified as a failure cannot ask the
    // pipeline to hand a customer to a person.
    const actionRead = readAgentAction(payload);
    return {
      text: readInlineText(payload),
      action: actionRead.kind === "known" ? actionRead.action : null,
      actionUnrecognised: actionRead.kind === "unrecognised",
      actionReason: readActionReason(payload),
      outcome: "ok",
      correlationId,
      completionState,
      contractVersion,
    };
  }
}

export function createAgentRuntime(options: HttpAgentRuntimeOptions): AgentRuntime {
  return new HttpAgentRuntime(options);
}
