/**
 * The versioned response contract for `POST /v1/invoke`.
 *
 * WHY THIS EXISTS
 * ---------------
 * Paperclip's `http` adapter discards this service's response body, so the
 * original contract carried status metadata only: the answer reached the
 * employee's run through the Paperclip write-back and nowhere else.
 *
 * The Isola gateway has a different need. It replies to a customer in Chatwoot
 * and must send the SAME text that was persisted — not a regeneration, not a
 * summary, not a re-render. `responseMode: "inline"` returns that exact string
 * in the response body, and the model is still called exactly once.
 *
 * WHAT THIS MODULE ENFORCES STRUCTURALLY
 * --------------------------------------
 *  - A failure body physically cannot carry an answer: `inlineFailureBody`
 *    hardcodes `answerText: null` and accepts no answer argument at all. There
 *    is no code path through which a fabricated or partial answer can reach a
 *    failure response.
 *  - A success body cannot be built without an answer string, and the caller
 *    may only reach `completionState: "completed"` after Paperclip has accepted
 *    the write-back.
 *  - An unrecognised `responseMode` is rejected, never degraded. A future mode
 *    must never silently collapse to "no answer" against an old runtime.
 *
 * This module is pure: no I/O, no clock, no logging. `answerText` never passes
 * through a logger from here, and no caller may log it either.
 */

/**
 * Bumped whenever the shape of an inline body changes in a way a client could
 * observe. Carried on every inline response so the gateway can assert on it.
 *
 * v2 (dec-ai1b-inline-agent-answer-may-return-without-recorder-2026-08-27):
 * the success body gained a `persistence` field, and its `recorded` flag is no
 * longer hardcoded `true` — it is now derived from `persistence`, so a body
 * can never claim an answer was written when nothing was.
 */
export const RESPONSE_CONTRACT_VERSION = 2;

export const RESPONSE_MODES = ["none", "inline"] as const;
export type ResponseMode = (typeof RESPONSE_MODES)[number];

/**
 * The truthful end state of a run, from the caller's point of view.
 *
 *  - `completed`           the model answered AND Paperclip accepted the
 *                          write-back. Only this state carries an answer.
 *  - `timeout`             the provider did not answer inside the deadline.
 *  - `provider_error`      the provider was reachable but errored.
 *  - `invalid_output`      the provider answered with no usable assistant text.
 *  - `persistence_failed`  the model answered but Paperclip would not accept
 *                          the write-back. NOT a success: the answer was not
 *                          persisted, so it is not returned.
 *  - `budget_exhausted`    rejected before the provider was called.
 *  - `internal_error`      an unexpected fault inside this runtime.
 *  - `duplicate_in_flight` a duplicate of a run that is still executing. The
 *                          original run owns the answer; this one has none yet.
 *  - `rejected`            refused before the model was called for a reason
 *                          that is not budget (unknown template, exposure
 *                          mismatch, no credential, undelivered-spend gate).
 */
export const COMPLETION_STATES = [
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
export type CompletionState = (typeof COMPLETION_STATES)[number];

export function isCompletionState(value: unknown): value is CompletionState {
  return (
    typeof value === "string" && (COMPLETION_STATES as readonly string[]).includes(value)
  );
}

/**
 * WHETHER THE ANSWER WAS WRITTEN DOWN — a dimension ORTHOGONAL to
 * `CompletionState`, and deliberately separate from it.
 *
 * Until 2026-08-27 these were conflated: `recorded = recorder.kind !== "null"`
 * meant a deliberately-unconfigured recorder and a recorder that ATTEMPTED a
 * write and FAILED both produced `persistence_failed`. Those are different
 * facts about different things — one is a deployment property, the other is a
 * runtime fault — and only the second is a reason to withhold an answer.
 *
 *  - `recorded`             a write was attempted and accepted.
 *  - `skipped_unconfigured` NO write was attempted, because no recorder is
 *                           configured. Not a failure; nothing went wrong.
 *                           The answer still exists and is still truthful —
 *                           it simply is not persisted anywhere, and any
 *                           surface carrying it must say so.
 *  - `failed`               a CONFIGURED recorder attempted a write and it did
 *                           not succeed. This remains fail-closed everywhere:
 *                           the answer is withheld, exactly as before.
 *
 * Per dec-ai1b-inline-agent-answer-may-return-without-recorder-2026-08-27.
 */
export const PERSISTENCE_STATES = ["recorded", "skipped_unconfigured", "failed"] as const;
export type PersistenceState = (typeof PERSISTENCE_STATES)[number];

/** The two persistence states a completed run may carry. `failed` cannot complete. */
export type CompletedPersistenceState = Exclude<PersistenceState, "failed">;

export type ResponseModeDecision =
  | { kind: "ok"; mode: ResponseMode }
  | { kind: "unrecognised" };

/**
 * Parse the request's `responseMode`.
 *
 * Absent (`undefined`/`null`) is the only thing that means "today's behaviour".
 * Everything else must be an exact, known token: an empty string, a
 * differently-cased spelling and an unknown future mode are all rejected with
 * 400 rather than silently downgraded to `none`, because a silent downgrade
 * would hand the gateway a 200 with no answer and no way to tell why.
 */
export function parseResponseMode(value: unknown): ResponseModeDecision {
  if (value === undefined || value === null) return { kind: "ok", mode: "none" };
  if (typeof value !== "string") return { kind: "unrecognised" };
  if ((RESPONSE_MODES as readonly string[]).includes(value)) {
    return { kind: "ok", mode: value as ResponseMode };
  }
  return { kind: "unrecognised" };
}

/**
 * Safe usage metadata. Every field is either a number this service measured or
 * a name it already holds. Nothing here is estimated: when the provider
 * reported no usage the token counts are `null`, never zero-by-assumption.
 */
export interface InlineUsage {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  /** Resolved model name, or null when the run never reached a template. */
  model: string | null;
  provider: string;
  /** How long the run itself took, in milliseconds. */
  durationMs: number;
}

export interface InlineSuccessArgs {
  runId: string | null;
  /**
   * The exact string handed to the recorder. The caller must pass the same
   * variable it gave the write-back; it must never re-render or re-derive it.
   */
  answerText: string;
  /**
   * Whether the answer was actually written down. `failed` is not accepted
   * here by TYPE: a run whose configured recorder failed cannot reach a
   * success body at all, which is the fail-closed guarantee made structural.
   */
  persistence: CompletedPersistenceState;
  /**
   * Widened from `null` in v2. A `skipped_unconfigured` run carries the
   * reason it was not written ("no recorder configured"), because a success
   * body that silently omitted it would read as though it HAD been written.
   */
  recorderError: string | null;
  transitioned: boolean;
  issueStatus: string | null;
  replay: boolean;
  usage: InlineUsage;
}

export interface InlineFailureArgs {
  /** The existing `outcome` vocabulary. Unchanged for every pre-existing case. */
  outcome: string;
  completionState: Exclude<CompletionState, "completed">;
  /** A category string built by this service. Never a secret, never a payload. */
  failureCategory: string;
  runId: string | null;
  recorded: boolean;
  recorderError: string | null;
  transitioned: boolean;
  issueStatus: string | null;
  replay: boolean;
  usage: InlineUsage;
  /** Extra top-level fields the existing non-inline body also carried. */
  extra?: Record<string, unknown>;
}

function usageFields(usage: InlineUsage): Record<string, unknown> {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    outputTokens: usage.outputTokens,
    model: usage.model,
    provider: usage.provider,
    durationMs: usage.durationMs,
  };
}

/**
 * The success body. Reachable only with an answer in hand, and only when the
 * write-back was accepted OR was never attempted because no recorder is
 * configured — `completionState` is hardcoded to `"completed"`.
 *
 * `recorded` is DERIVED from `persistence`, never passed in. Until v2 it was
 * hardcoded `true`, which made this body assert a write had happened even on
 * the path where nothing had been written. A field that cannot be set
 * independently cannot drift from the fact it describes.
 */
export function inlineSuccessBody(args: InlineSuccessArgs): Record<string, unknown> {
  return {
    ok: true,
    outcome: "ok",
    responseMode: "inline",
    contractVersion: RESPONSE_CONTRACT_VERSION,
    completionState: "completed",
    runId: args.runId,
    answerText: args.answerText,
    failureCategory: null,
    // NEVER hardcoded. `skipped_unconfigured` => false, and there is no
    // argument through which a caller could claim otherwise.
    recorded: args.persistence === "recorded",
    persistence: args.persistence,
    recorderError: args.recorderError,
    transitioned: args.transitioned,
    issueStatus: args.issueStatus,
    replay: args.replay,
    ...usageFields(args.usage),
  };
}

/**
 * The failure body. `answerText` is hardcoded `null` and there is no parameter
 * through which an answer could be supplied — a fabricated or partial answer
 * cannot be returned by construction, not merely by convention.
 */
export function inlineFailureBody(args: InlineFailureArgs): Record<string, unknown> {
  return {
    // `extra` is spread FIRST so a contract field can never be overridden by
    // it — in particular `answerText`, which must stay null on every failure
    // path no matter what a future caller passes through here.
    ...(args.extra ?? {}),
    ok: false,
    outcome: args.outcome,
    responseMode: "inline",
    contractVersion: RESPONSE_CONTRACT_VERSION,
    completionState: args.completionState,
    runId: args.runId,
    answerText: null,
    failureCategory: args.failureCategory,
    error: args.failureCategory,
    recorded: args.recorded,
    recorderError: args.recorderError,
    transitioned: args.transitioned,
    issueStatus: args.issueStatus,
    replay: args.replay,
    ...usageFields(args.usage),
  };
}

/**
 * HTTP status for an inline response.
 *
 * The pre-existing statuses are preserved exactly (504 timeout, 502 provider,
 * 402 budget, …) — `recordedHttpStatus` is the status the non-inline path
 * computed. Only the two states that did not exist before get a status of their
 * own: a model answer that Paperclip refused, and an answer with no usable
 * text, are both 502 rather than the 200 the non-inline contract returns.
 */
export function inlineHttpStatus(
  completionState: CompletionState,
  recordedHttpStatus: number,
): number {
  switch (completionState) {
    case "completed":
      return 200;
    case "persistence_failed":
    case "invalid_output":
      return 502;
    default:
      return recordedHttpStatus;
  }
}

/**
 * Best-effort completion state for an idempotency record written before this
 * contract existed. Only reachable across an upgrade with a surviving store.
 */
export function completionStateForOutcome(outcome: string): CompletionState {
  switch (outcome) {
    case "ok":
      return "completed";
    case "model_timeout":
      return "timeout";
    case "provider_error":
      return "provider_error";
    case "budget_exhausted":
      return "budget_exhausted";
    case "internal_error":
      return "internal_error";
    case "persistence_failed":
      return "persistence_failed";
    default:
      return "rejected";
  }
}
