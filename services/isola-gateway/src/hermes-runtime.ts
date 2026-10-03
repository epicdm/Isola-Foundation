/**
 * THE DIRECT HERMES RUNTIME (Step A, commit 3): an `AgentRuntime` that runs a customer
 * turn through the long-lived `isola_hermes-public` service via POST /v1/runs, with NO
 * Paperclip in the loop. The pipeline, the ledger, the ownership gate, the post-run
 * recheck and the escalation path are REUSED unchanged: this class only changes who
 * executes the turn (ONE execution owner).
 *
 * SOURCE (Hermes side): lane 59's contract file
 * `.checkpoint-out/HERMES-PUBLIC-RUNS-API-CONTRACT-FOR-AGENT-2026-10-03.md`, read from the
 * service's code AND VERIFIED by Step B on 2026-10-03 06:10-06:12Z (9 model-bound requests):
 *   - POST /v1/runs -> 202 {"run_id","status":"started"}; body `input`, `instructions`,
 *     `conversation_history`, `session_id`; 429 "Too many concurrent runs (max 10)".
 *   - GET /v1/runs/{id} -> status queued|running|stopping|completed(output,usage)|
 *     failed(error)|cancelled; 404 once the service forgot the run (restart / 1 h).
 *   - GET /v1/runs/{id}/events -> SSE `data: {json}\n\n`, `: keepalive`, message.delta,
 *     reasoning.available, run.completed{output,usage}, run.failed, run.cancelled, then the
 *     stream closes itself with `: stream closed`.
 *   - POST /v1/runs/{id}/stop -> 200 {"run_id","status":"stopping"}; it STOPS MODEL EXECUTION;
 *     404 for a run that already finished.
 *   - /v1/runs IGNORES Idempotency-Key (two keys = two runs, two provider calls).
 *   - A run counts against the cap of 10 until its stream is READ TO THE END.
 *   - `session_id` is a label that loads NOTHING; memory is OFF; X-Hermes-Session-Key gives no
 *     memory. Continuity is `conversation_history` built here from the gateway's own transcript.
 *   - Timing: warm 2.9-3.3 s; first run after ~65 min idle 10.2 s; while a run starts the API
 *     server answers nothing for ~1 s warm / ~6 s post-idle, so requests need generous timeouts.
 * STILL UNVERIFIED: run-state loss on a Hermes restart (modelled as a 404), the poll-only 429
 * (irrelevant here: every stream is read), and the exact layout of the lines the charter expects.
 *
 * RULES THIS FILE ENFORCES (each pinned by tests, with a sabotage):
 *   1. NEVER POST /v1/runs twice for one ledger key: the header is ignored by the service, so the
 *      guard is HERE (and the ledger's, before this is reached). No Idempotency-Key is sent.
 *   2. EVERY run's event stream is read to the end, under the same absolute deadline and a byte cap.
 *   3. On a takeover or a spent turn the run is STOPPED and its id is remembered as CANCELLED; any
 *      output of a cancelled run, or of a run that is not the one this turn created, is DISCARDED.
 *      A 404 on /stop means "maybe finished": the output is still discarded.
 *   4. ONE absolute deadline covers the create, every poll, the stream and every body read; a
 *      response body is capped; a redirect is a config defect (the egress guard refuses it).
 *   5. Anything that is not a conforming end is NO model text and one outcome (Law 12): failed /
 *      cancelled / lost (404) / stream closed without a terminal event / no or bad envelope.
 *
 * DELIBERATE DEVIATION, flagged for review: AgentRuntimeRequest.signal says a runtime MUST start no
 * request once it fires. This runtime sends ONE best-effort POST /stop after it, because a stop is a
 * cancellation (it removes work), not a dispatch, and the alternative is a model call that keeps
 * running after its turn is spent. It starts no create, poll or stream after the signal.
 */
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError } from "./errors.js";
import {
  buildHermesHistory,
  HERMES_HISTORY_HARD_MAX_CHARS,
  HERMES_HISTORY_HARD_MAX_TURNS,
  hermesSessionLabel,
  parseHermesEnvelope,
  renderHermesInput,
} from "./hermes-input.js";
import type { Logger } from "./log.js";
import type { AgentRuntime, AgentRuntimeRequest, AgentRuntimeResult } from "./runtime.js";

export const HERMES_OUTCOMES = {
  /** 401/403/404/other 4xx, or a request this client refuses to send: configuration, not weather. */
  configDefect: "hermes_config_defect",
  /** The create's outcome is unknown and no run id is on record: NEVER re-created. */
  createUncertain: "hermes_create_uncertain",
  /** This ledger key already started a run (or tried to): never a second POST. */
  duplicateInvoke: "hermes_duplicate_invoke",
  rateLimited: "hermes_rate_limited",
  /** No slot (per conversation or global) inside the deadline: nothing was sent. */
  busy: "hermes_busy",
  historyUnavailable: "hermes_history_unavailable",
  runFailed: "hermes_run_failed",
  runCancelled: "hermes_run_cancelled",
  /** 404 on the run: the service forgot it (restart / TTL). Never re-created. */
  runLost: "hermes_run_lost",
  /** A status object or response for a run that is not the one this turn created. */
  runMismatch: "hermes_run_mismatch",
  streamClosedEarly: "hermes_stream_closed_early",
  responseTooLarge: "hermes_response_too_large",
  envelopeInvalid: "hermes_envelope_invalid",
  envelopeTextTooLong: "hermes_envelope_text_too_long",
  ownershipLost: "hermes_ownership_lost",
  timeout: "model_timeout",
} as const;

/** What the gateway asks the (optional, default-none) assertion minter for. The minter is OUT OF SCOPE here. */
export interface HermesAssertionInput {
  tenantId: string;
  accountId: number;
  inboxId: number;
  conversationId: number;
  messageId: number | null;
}
export interface HermesAssertionProvider {
  assertionFor(input: HermesAssertionInput): Promise<string | null>;
}
/** The default: no assertion is ever produced, so the line says `none` and the business tools refuse. */
export const NO_ASSERTIONS: HermesAssertionProvider = { assertionFor: async () => null };

export interface HermesRuntimeOptions {
  /** e.g. http://isola_hermes-public:8642 . An origin plus an optional path prefix. */
  baseUrl: string;
  /** The service API key VALUE. Never logged, never in a URL or a body. */
  bearer: string;
  safeFetch: SafeFetch;
  /**
   * ABSOLUTE ceiling on the WHOLE turn after the slots are won: the create, every poll, the
   * stream and every body read run under it. Validated at boot against the ledger lease and
   * the runtime timeout.
   */
  runDeadlineMs: number;
  pollIntervalMs: number;
  /** Per-request timeout. Measured: the API server answers nothing for up to ~6 s while a run starts, so keep it >= 15 s in production. */
  requestTimeoutMs: number;
  /** Global in-flight runs (a run counts until its stream is drained). Must stay below Hermes' own cap of 10. */
  maxInflight: number;
  /** Wait before the ONE retry of a 429. Default 1000 ms. */
  rateLimitBackoffMs?: number;
  historyMaxTurns?: number;
  historyMaxChars?: number;
  /** How long to wait for a finished run's stream to close before giving up on it. Default min(requestTimeoutMs, 2000). */
  streamDrainGraceMs?: number;
  assertions?: HermesAssertionProvider;
  logger?: Logger;
}

export interface HermesStats {
  turns: number;
  answers: number;
  requestHuman: number;
  envelopeParseFailures: number;
  failuresByOutcome: Record<string, number>;
}

/**
 * The ephemeral system prompt added on top of SOUL.md and the skills. UNVERIFIED against the
 * deployed charter (whether it conflicts with it is a Step-B-style question); kept in one place.
 */
export const HERMES_ENVELOPE_INSTRUCTIONS = [
  "Answer the customer in the language they wrote in.",
  "End your final answer with exactly ONE line of JSON and nothing after it:",
  '{"disposition":"answer","text":"<the message to send to the customer>"}',
  "or, when a colleague must take over:",
  '{"disposition":"request_human","text":"<what to tell the customer>","reason":"<explicit_human_request|low_confidence|policy_boundary|approval_required|tool_failure|complaint_sensitive|unsupported_request>"}',
  "Only the text field is shown to the customer.",
].join("\n");

const MAX_IDEMPOTENCY_KEY = 255;
const MAX_STARTED_KEYS = 10_000;
/** Hard ceiling on any buffered response body or event stream (create, status, stop, SSE). */
export const MAX_HERMES_RESPONSE_BYTES = 1024 * 1024;
const MAX_DELTA_CHARS = 256 * 1024;

class ResponseTooLargeError extends Error {
  constructor() {
    super("hermes: the response body exceeds the byte cap");
    this.name = "ResponseTooLargeError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function spent(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Resolves with the value, "deadline" when `deadlineAt` passes first, or `onReject` when the promise rejects. */
function raceDeadline<T>(promise: Promise<T>, deadlineAt: number, onReject: T): Promise<T | "deadline"> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) return Promise.resolve("deadline");
  return new Promise<T | "deadline">((resolve) => {
    const timer = setTimeout(() => resolve("deadline"), remaining);
    if (typeof timer.unref === "function") timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onReject);
      },
    );
  });
}

/** Read the body as text, never past `cap` bytes and never past the abort signal, even if the body ignores the signal. */
async function readCappedText(response: Response, signal: AbortSignal, cap: number): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) {
    try {
      void response.body?.cancel().catch(() => undefined);
    } catch {
      /* nothing to release */
    }
    throw new ResponseTooLargeError();
  }
  const stream = response.body;
  if (stream === null) return "";
  const reader = stream.getReader();
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("hermes: aborted while reading the body"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      total += value.byteLength;
      if (total > cap) throw new ResponseTooLargeError();
      chunks.push(value);
    }
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    if (onAbort !== null) signal.removeEventListener("abort", onAbort);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/** A counting semaphore whose waits are bounded by an absolute deadline and an abort signal. */
class Semaphore {
  private active = 0;
  private readonly queue: Array<(release: (() => void) | null) => void> = [];
  constructor(private readonly max: number) {}

  get inflight(): number {
    return this.active;
  }
  get idle(): boolean {
    return this.active === 0 && this.queue.length === 0;
  }

  private makeRelease(): () => void {
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next !== undefined) next(this.makeRelease());
      else this.active -= 1;
    };
  }

  acquire(deadlineAt: number, signal?: AbortSignal): Promise<(() => void) | null> {
    if (spent(signal)) return Promise.resolve(null);
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve(this.makeRelease());
    }
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) return Promise.resolve(null);
    return new Promise((resolve) => {
      let settled = false;
      const grant = (release: (() => void) | null): void => {
        if (settled) {
          release?.();
          return;
        }
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(release);
      };
      const leave = (): void => {
        const at = this.queue.indexOf(grant);
        if (at >= 0) this.queue.splice(at, 1);
        grant(null);
      };
      const timer = setTimeout(leave, remaining);
      if (typeof timer.unref === "function") timer.unref();
      const onAbort = (): void => leave();
      signal?.addEventListener("abort", onAbort, { once: true });
      this.queue.push(grant);
    });
  }
}

/**
 * Wakes a sleeping poll loop (and ends a slow in-flight poll) the moment the event stream
 * learns something that matters: a terminal event, the end of the stream. Deltas do not wake it.
 */
class Notifier {
  private waiters = new Set<() => void>();
  notify(): void {
    const current = this.waiters;
    this.waiters = new Set();
    for (const w of current) w();
  }
  /** Resolves on the next notify(); cancel() removes the waiter so nothing is left behind. */
  subscribe(): { promise: Promise<void>; cancel: () => void } {
    let wake: () => void = () => undefined;
    const promise = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.waiters.add(wake);
    return { promise, cancel: () => void this.waiters.delete(wake) };
  }
  async wait(ms: number): Promise<void> {
    const sub = this.subscribe();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, Math.max(0, ms));
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      await Promise.race([sub.promise, timed]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      sub.cancel();
    }
  }
}

type Terminal =
  | { kind: "completed"; output: string | null }
  | { kind: "failed" }
  | { kind: "cancelled" };

interface RunState {
  runId: string;
  terminal: Terminal | null;
  eventOutput: string | null;
  deltas: string[];
  deltaChars: number;
  stream: "open" | "clean" | "broken" | "oversize";
  sawTerminalEvent: boolean;
  sawClosedComment: boolean;
  closedEarly: boolean;
  ignoredForeignEvents: number;
  polls: number;
}

interface Identity {
  tenantId: string;
  accountId: number;
  inboxId: number;
  conversationId: number;
  messageId: number | null;
  content: string;
  history: unknown;
  scopeVerified: boolean;
}

interface Exchange {
  status: number;
  headers: Headers;
  json: unknown;
}

type CreateResult =
  | { kind: "created"; runId: string }
  | { kind: "config_defect" }
  | { kind: "uncertain" }
  | { kind: "rate_limited" }
  | { kind: "timeout" };

type PollResult =
  | { kind: "ok" }
  | { kind: "lost" }
  | { kind: "mismatch" }
  | { kind: "config_defect" }
  | { kind: "too_large" }
  | { kind: "transient" }
  | { kind: "state_changed" };

export class HermesDirectRuntime implements AgentRuntime {
  private readonly started = new Set<string>();
  private readonly cancelled = new Set<string>();
  private readonly conversations = new Map<string, Semaphore>();
  private readonly global: Semaphore;
  private readonly counters = { turns: 0, answers: 0, requestHuman: 0, envelopeParseFailures: 0 };
  private readonly failures = new Map<string, number>();

  constructor(private readonly options: HermesRuntimeOptions) {
    this.global = new Semaphore(Math.max(1, options.maxInflight));
  }

  stats(): HermesStats {
    return { ...this.counters, failuresByOutcome: Object.fromEntries(this.failures) };
  }

  /** Runs this adapter currently holds a slot for (a run is held until its stream is drained). */
  inflight(): number {
    return this.global.inflight;
  }

  /** True when this adapter stopped that run id (a takeover, a spent turn, a deadline): its output is never used. */
  isCancelled(runId: string): boolean {
    return this.cancelled.has(runId);
  }

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const startedAt = Date.now();
    this.counters.turns += 1;
    const info: Record<string, unknown> = {};
    const result = await this.turn(request, info);
    if (result.outcome === "ok") {
      if (result.action === "request_human") this.counters.requestHuman += 1;
      else this.counters.answers += 1;
    } else {
      this.failures.set(result.outcome, (this.failures.get(result.outcome) ?? 0) + 1);
    }
    this.log("hermes_turn", result.outcome === "ok" ? "info" : "warn", request, {
      outcome: result.outcome,
      durationMs: Date.now() - startedAt,
      ...info,
    });
    return result;
  }

  // ---- the turn --------------------------------------------------------------

  private async turn(request: AgentRuntimeRequest, info: Record<string, unknown>): Promise<AgentRuntimeResult> {
    const key = request.idempotencyKey;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY) {
      return this.fail(request, HERMES_OUTCOMES.configDefect);
    }
    const identity = this.readIdentity(request.context);
    if (identity === null) return this.fail(request, HERMES_OUTCOMES.configDefect);
    if (!this.baseIsSendable()) return this.fail(request, HERMES_OUTCOMES.configDefect);
    if (spent(request.signal)) return this.fail(request, HERMES_OUTCOMES.timeout);

    // RULE 1: one POST per ledger key, ever. The service ignores Idempotency-Key on /v1/runs, so
    // this is the guard. It is marked BEFORE anything can be awaited, so a concurrent twin is refused.
    if (this.started.has(key)) return this.fail(request, HERMES_OUTCOMES.duplicateInvoke);
    this.started.add(key);
    if (this.started.size > MAX_STARTED_KEYS) {
      const oldest = this.started.values().next().value;
      if (oldest !== undefined) this.started.delete(oldest);
    }

    const history = buildHermesHistory(
      identity.history,
      identity.content,
      {
        maxTurns: Math.min(this.options.historyMaxTurns ?? HERMES_HISTORY_HARD_MAX_TURNS, HERMES_HISTORY_HARD_MAX_TURNS),
        maxChars: Math.min(this.options.historyMaxChars ?? HERMES_HISTORY_HARD_MAX_CHARS, HERMES_HISTORY_HARD_MAX_CHARS),
      },
      // The current message is found by its Chatwoot message id (Codex DH3), never by its text.
      { currentMessageId: identity.messageId, historyMessageIds: request.historyMessageIds },
    );
    if (!history.ok) {
      info["historyReason"] = history.reason;
      return this.fail(request, HERMES_OUTCOMES.historyUnavailable);
    }
    info["historyTurns"] = history.messages.length;
    info["historyDropped"] = history.droppedForCaps;

    let label: string;
    let input: string;
    try {
      label = hermesSessionLabel({
        tenantId: identity.tenantId,
        accountId: identity.accountId,
        inboxId: identity.inboxId,
        conversationId: identity.conversationId,
      });
      const assertion = identity.scopeVerified
        ? await (this.options.assertions ?? NO_ASSERTIONS).assertionFor({
            tenantId: identity.tenantId,
            accountId: identity.accountId,
            inboxId: identity.inboxId,
            conversationId: identity.conversationId,
            messageId: identity.messageId,
          })
        : null;
      input = renderHermesInput({ conversationLabel: label, assertion, message: identity.content });
    } catch {
      return this.fail(request, HERMES_OUTCOMES.configDefect);
    }

    const deadlineAt = Date.now() + this.options.runDeadlineMs;
    const conversationSlot = this.conversationSemaphore(label);
    const releaseConversation = await conversationSlot.acquire(deadlineAt, request.signal);
    if (releaseConversation === null) {
      this.dropIdleConversation(label);
      return this.fail(request, spent(request.signal) ? HERMES_OUTCOMES.timeout : HERMES_OUTCOMES.busy);
    }
    try {
      const releaseGlobal = await this.global.acquire(deadlineAt, request.signal);
      if (releaseGlobal === null) return this.fail(request, spent(request.signal) ? HERMES_OUTCOMES.timeout : HERMES_OUTCOMES.busy);
      try {
        // Slots won after the deadline are worth nothing: nothing is sent.
        if (Date.now() >= deadlineAt) return this.fail(request, HERMES_OUTCOMES.busy);
        const body: Record<string, unknown> = {
          input,
          instructions: HERMES_ENVELOPE_INSTRUCTIONS,
          session_id: label,
          ...(history.messages.length > 0 ? { conversation_history: history.messages } : {}),
        };
        return await this.execute(request, body, deadlineAt, info);
      } finally {
        releaseGlobal();
      }
    } finally {
      releaseConversation();
      this.dropIdleConversation(label);
    }
  }

  private conversationSemaphore(label: string): Semaphore {
    let s = this.conversations.get(label);
    if (s === undefined) {
      s = new Semaphore(1);
      this.conversations.set(label, s);
    }
    return s;
  }

  private dropIdleConversation(label: string): void {
    const s = this.conversations.get(label);
    if (s !== undefined && s.idle) this.conversations.delete(label);
  }

  private async execute(
    request: AgentRuntimeRequest,
    body: Record<string, unknown>,
    deadlineAt: number,
    info: Record<string, unknown>,
  ): Promise<AgentRuntimeResult> {
    const created = await this.createRun(body, deadlineAt, request.signal);
    if (created.kind === "config_defect") return this.fail(request, HERMES_OUTCOMES.configDefect);
    if (created.kind === "uncertain") return this.fail(request, HERMES_OUTCOMES.createUncertain);
    if (created.kind === "rate_limited") return this.fail(request, HERMES_OUTCOMES.rateLimited);
    if (created.kind === "timeout") return this.fail(request, HERMES_OUTCOMES.timeout);

    const runId = created.runId;
    info["runId"] = runId;
    const state: RunState = {
      runId,
      terminal: null,
      eventOutput: null,
      deltas: [],
      deltaChars: 0,
      stream: "open",
      sawTerminalEvent: false,
      sawClosedComment: false,
      closedEarly: false,
      ignoredForeignEvents: 0,
      polls: 0,
    };
    const notifier = new Notifier();
    // RULE 2: this run's stream is read to the end. It is aborted by the turn signal, or when the
    // drain grace runs out; its lifetime is otherwise the run's.
    const streamCtl = new AbortController();
    const onTurnAbort = (): void => streamCtl.abort();
    request.signal?.addEventListener("abort", onTurnAbort, { once: true });
    const streamTask = this.readEvents(state, notifier, streamCtl.signal);
    let result: AgentRuntimeResult;
    try {
      result = await this.awaitEnd(request, state, notifier, streamTask, deadlineAt);
    } finally {
      request.signal?.removeEventListener("abort", onTurnAbort);
      await this.settleStream(state, streamTask, streamCtl, request);
      info["polls"] = state.polls;
      info["stream"] = state.stream;
    }
    return result;
  }

  // ---- create ------------------------------------------------------------------

  private async createRun(body: Record<string, unknown>, deadlineAt: number, turnSignal: AbortSignal | undefined): Promise<CreateResult> {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (spent(turnSignal) || Date.now() >= deadlineAt) return { kind: "timeout" };
      let response: Exchange;
      try {
        response = await this.exchange(
          `${this.base()}/v1/runs`,
          { method: "POST", headers: { ...this.authHeaders(), accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) },
          { deadlineAt, readBody: true, turnSignal },
        );
      } catch (err) {
        // The egress guard refused BEFORE a socket was opened (or answered a redirect it will not follow).
        if (err instanceof EgressBlockedError) return { kind: "config_defect" };
        // Anything else may have happened AFTER the request left: the run may exist. Never re-created.
        return { kind: "uncertain" };
      }
      if (response.status === 429) {
        if (attempt === 2) return { kind: "rate_limited" };
        const backoff = this.options.rateLimitBackoffMs ?? 1000;
        // A backoff that does not fit inside the deadline is not slept: the retry would be too late to matter.
        if (deadlineAt - Date.now() <= backoff) return { kind: "rate_limited" };
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, backoff);
          if (typeof t.unref === "function") t.unref();
        });
        continue; // the SAME body: a retry of the identical request, never a changed one
      }
      if (response.status >= 400 && response.status < 500) return { kind: "config_defect" };
      if (response.status >= 500 || response.status < 200 || response.status >= 300) return { kind: "uncertain" };
      const runId = isRecord(response.json) && typeof response.json["run_id"] === "string" && response.json["run_id"].length > 0 ? response.json["run_id"] : null;
      return runId === null ? { kind: "uncertain" } : { kind: "created", runId };
    }
    return { kind: "rate_limited" };
  }

  // ---- the event stream --------------------------------------------------------

  private async readEvents(state: RunState, notifier: Notifier, signal: AbortSignal): Promise<void> {
    try {
      const response = await this.options.safeFetch(`${this.base()}/v1/runs/${encodeURIComponent(state.runId)}/events`, {
        method: "GET",
        headers: { ...this.authHeaders(), accept: "text/event-stream" },
        signal,
      });
      if (response.status !== 200 || response.body === null) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* nothing to release */
        }
        state.stream = "broken";
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let total = 0;
      let onAbort: (() => void) | null = null;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error("hermes: stream aborted"));
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });
      aborted.catch(() => undefined);
      try {
        for (;;) {
          const { done, value } = await Promise.race([reader.read(), aborted]);
          if (done) break;
          total += value.byteLength;
          if (total > MAX_HERMES_RESPONSE_BYTES) {
            state.stream = "oversize";
            void reader.cancel().catch(() => undefined);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          let at = buffer.indexOf("\n\n");
          while (at >= 0) {
            this.onBlock(state, buffer.slice(0, at));
            buffer = buffer.slice(at + 2);
            at = buffer.indexOf("\n\n");
          }
          if (state.terminal !== null) notifier.notify();
        }
        buffer += decoder.decode();
        if (buffer.trim().length > 0) this.onBlock(state, buffer);
        state.stream = state.sawClosedComment ? "clean" : "broken";
        // The server always sends the terminal event BEFORE closing: a clean close without one is an anomaly.
        if (state.stream === "clean" && !state.sawTerminalEvent && state.terminal === null) state.closedEarly = true;
      } finally {
        if (onAbort !== null) signal.removeEventListener("abort", onAbort);
        void reader.cancel().catch(() => undefined);
      }
    } catch {
      if (state.stream === "open") state.stream = "broken";
    } finally {
      notifier.notify();
    }
  }

  private onBlock(state: RunState, block: string): void {
    if (block.startsWith(":")) {
      if (block.includes("stream closed")) state.sawClosedComment = true;
      return;
    }
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (data.length === 0) return;
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    // RULE 3: an event for a run that is not the one this turn created is never used.
    if (typeof event["run_id"] === "string" && event["run_id"] !== state.runId) {
      state.ignoredForeignEvents += 1;
      return;
    }
    switch (event["event"]) {
      case "message.delta":
        if (typeof event["delta"] === "string" && state.deltaChars < MAX_DELTA_CHARS) {
          state.deltas.push(event["delta"]);
          state.deltaChars += event["delta"].length;
        }
        break;
      case "run.completed":
        state.sawTerminalEvent = true;
        state.eventOutput = typeof event["output"] === "string" ? event["output"] : null;
        if (state.terminal === null) state.terminal = { kind: "completed", output: state.eventOutput };
        break;
      case "run.failed":
        state.sawTerminalEvent = true;
        if (state.terminal === null) state.terminal = { kind: "failed" };
        break;
      case "run.cancelled":
        state.sawTerminalEvent = true;
        if (state.terminal === null) state.terminal = { kind: "cancelled" };
        break;
      default:
        break;
    }
  }

  /** Wait (bounded) for the stream to finish; give up on it after the grace and say so. */
  private async settleStream(state: RunState, streamTask: Promise<void>, streamCtl: AbortController, request: AgentRuntimeRequest): Promise<void> {
    const grace = this.options.streamDrainGraceMs ?? Math.min(this.options.requestTimeoutMs, 2000);
    const finished = await raceDeadline<boolean>(streamTask.then(() => true), Date.now() + grace, false);
    if (finished === "deadline" || finished === false) {
      if (state.stream === "open") {
        this.log("hermes_stream_not_drained", "warn", request, { runId: state.runId });
      }
      streamCtl.abort();
      await raceDeadline<void>(streamTask, Date.now() + 50, undefined);
    }
  }

  // ---- waiting for the end of the run ------------------------------------------

  private async awaitEnd(
    request: AgentRuntimeRequest,
    state: RunState,
    notifier: Notifier,
    streamTask: Promise<void>,
    deadlineAt: number,
  ): Promise<AgentRuntimeResult> {
    for (;;) {
      if (spent(request.signal)) {
        await this.stopRun(state.runId, request.signal);
        return this.fail(request, HERMES_OUTCOMES.timeout, state.runId);
      }
      if (Date.now() >= deadlineAt) {
        await this.stopRun(state.runId, request.signal);
        return this.fail(request, HERMES_OUTCOMES.timeout, state.runId);
      }
      if (state.stream === "oversize") {
        await this.stopRun(state.runId, request.signal);
        return this.fail(request, HERMES_OUTCOMES.responseTooLarge, state.runId);
      }
      if (state.closedEarly && state.terminal === null) return this.fail(request, HERMES_OUTCOMES.streamClosedEarly, state.runId);

      // OWNERSHIP, before anything is accepted from the run. A rejection is "could not find out",
      // which is never "nobody holds it".
      const owned = await this.stillOwned(request, deadlineAt);
      if (owned === "deadline") {
        await this.stopRun(state.runId, request.signal);
        return this.fail(request, HERMES_OUTCOMES.timeout, state.runId);
      }
      if (!owned) {
        await this.stopRun(state.runId, request.signal);
        return this.fail(request, HERMES_OUTCOMES.ownershipLost, state.runId);
      }

      if (state.terminal !== null) return this.conclude(request, state, notifier, streamTask, deadlineAt);

      const polled = await this.pollStatus(state, notifier, deadlineAt, request.signal);
      switch (polled.kind) {
        case "lost":
          return this.fail(request, HERMES_OUTCOMES.runLost, state.runId);
        case "mismatch":
          await this.stopRun(state.runId, request.signal);
          return this.fail(request, HERMES_OUTCOMES.runMismatch, state.runId);
        case "config_defect":
          await this.stopRun(state.runId, request.signal);
          return this.fail(request, HERMES_OUTCOMES.configDefect, state.runId);
        case "too_large":
          await this.stopRun(state.runId, request.signal);
          return this.fail(request, HERMES_OUTCOMES.responseTooLarge, state.runId);
        default:
          break;
      }
      if (state.terminal !== null) continue;
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) continue;
      await notifier.wait(Math.min(this.options.pollIntervalMs, remaining));
    }
  }

  private async stillOwned(request: AgentRuntimeRequest, deadlineAt: number): Promise<boolean | "deadline"> {
    if (request.isStillOwned === undefined) return true;
    return raceDeadline(
      Promise.resolve().then(() => request.isStillOwned?.() ?? true),
      deadlineAt,
      false,
    );
  }

  private async conclude(
    request: AgentRuntimeRequest,
    state: RunState,
    notifier: Notifier,
    streamTask: Promise<void>,
    deadlineAt: number,
  ): Promise<AgentRuntimeResult> {
    const terminal = state.terminal as Terminal;
    if (terminal.kind === "failed") return this.fail(request, HERMES_OUTCOMES.runFailed, state.runId);
    if (terminal.kind === "cancelled") return this.fail(request, HERMES_OUTCOMES.runCancelled, state.runId);

    // RULE 3 is STRUCTURAL: every path that stops a run returns its failure on the spot, so a run that
    // was cancelled is never concluded here, whatever its status would later say.
    let output = terminal.output !== null && terminal.output.length > 0 ? terminal.output : null;
    if (output === null) {
      // The status carried no output: the event stream's final events are the next source.
      const grace = this.options.streamDrainGraceMs ?? Math.min(this.options.requestTimeoutMs, 2000);
      await raceDeadline<void>(streamTask, Math.min(deadlineAt, Date.now() + grace), undefined);
      output =state.eventOutput !== null && state.eventOutput.length > 0 ? state.eventOutput : null;
      if (output === null) {
        const joined = state.deltas.join("");
        output = joined.length > 0 ? joined : null;
      }
    }

    // The last ownership look before text leaves this adapter. (The pipeline rechecks again.)
    const owned = await this.stillOwned(request, deadlineAt);
    if (owned === "deadline") return this.fail(request, HERMES_OUTCOMES.timeout, state.runId);
    if (!owned) {
      await this.stopRun(state.runId, request.signal);
      return this.fail(request, HERMES_OUTCOMES.ownershipLost, state.runId);
    }

    const parsed = parseHermesEnvelope(output);
    if (!parsed.ok) {
      this.counters.envelopeParseFailures += 1;
      this.log("hermes_envelope_parse_failure", "warn", request, { reason: parsed.reason, runId: state.runId });
      return this.fail(
        request,
        parsed.reason === "text_too_long" ? HERMES_OUTCOMES.envelopeTextTooLong : HERMES_OUTCOMES.envelopeInvalid,
        state.runId,
      );
    }
    return {
      text: parsed.text,
      action: parsed.disposition === "answer" ? "reply" : "request_human",
      actionUnrecognised: false,
      actionReason: parsed.disposition === "request_human" ? parsed.reason : null,
      outcome: "ok",
      correlationId: `hermes:${state.runId}`,
      completionState: "completed",
      contractVersion: 2,
    };
  }

  // ---- poll ------------------------------------------------------------------------

  private async pollStatus(state: RunState, notifier: Notifier, deadlineAt: number, turnSignal: AbortSignal | undefined): Promise<PollResult> {
    state.polls += 1;
    const pollCtl = new AbortController();
    const onTurnAbort = (): void => pollCtl.abort();
    turnSignal?.addEventListener("abort", onTurnAbort, { once: true });
    // The stream learning something (a terminal event, its end) ends a slow in-flight poll early:
    // the server can take seconds to answer a status GET while a run starts, and the stream is primary.
    const subscription = notifier.subscribe();
    const exchange = this.exchange(
      `${this.base()}/v1/runs/${encodeURIComponent(state.runId)}`,
      { method: "GET", headers: { ...this.authHeaders(), accept: "application/json" } },
      { deadlineAt, readBody: true, turnSignal, extraSignal: pollCtl.signal },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      const first = await Promise.race([exchange, subscription.promise.then(() => "state" as const)]);
      if (first === "state") {
        pollCtl.abort();
        return { kind: "state_changed" };
      }
      if (!first.ok) {
        if (first.error instanceof EgressBlockedError) return { kind: "config_defect" };
        if (first.error instanceof ResponseTooLargeError) return { kind: "too_large" };
        return { kind: "transient" };
      }
      return this.readStatus(state, first.value);
    } finally {
      subscription.cancel();
      turnSignal?.removeEventListener("abort", onTurnAbort);
    }
  }

  private readStatus(state: RunState, response: Exchange): PollResult {
    if (response.status === 404) return { kind: "lost" };
    if (response.status >= 400 && response.status < 500) return { kind: "config_defect" };
    if (response.status < 200 || response.status >= 300) return { kind: "transient" };
    const body = response.json;
    if (!isRecord(body)) return { kind: "transient" };
    // RULE 3: the result is accepted only for the run id this turn created.
    if (typeof body["run_id"] === "string" && body["run_id"] !== state.runId) return { kind: "mismatch" };
    const status = typeof body["status"] === "string" ? body["status"].toLowerCase() : "";
    if (state.terminal === null) {
      if (status === "completed") state.terminal = { kind: "completed", output: typeof body["output"] === "string" ? body["output"] : null };
      else if (status === "failed" || status === "error") state.terminal = { kind: "failed" };
      else if (status === "cancelled" || status === "canceled" || status === "stopped" || status === "interrupted") state.terminal = { kind: "cancelled" };
    }
    return { kind: "ok" };
  }

  // ---- stop -------------------------------------------------------------------------

  /**
   * RULE 3. The run id is remembered as CANCELLED first, so nothing it later produces can be used,
   * then ONE best-effort POST /stop is sent. A 404 means "maybe finished": the output is discarded
   * anyway. A failed stop changes nothing. Bounded by its own short timeout, not by the run deadline.
   */
  private async stopRun(runId: string, turnSignal: AbortSignal | undefined): Promise<void> {
    this.cancelled.add(runId);
    if (this.cancelled.size > MAX_STARTED_KEYS) {
      const oldest = this.cancelled.values().next().value;
      if (oldest !== undefined) this.cancelled.delete(oldest);
    }
    const timeoutMs = spent(turnSignal) ? Math.min(this.options.requestTimeoutMs, 3000) : this.options.requestTimeoutMs;
    try {
      await this.exchange(
        `${this.base()}/v1/runs/${encodeURIComponent(runId)}/stop`,
        { method: "POST", headers: { ...this.authHeaders(), accept: "application/json" } },
        { deadlineAt: Date.now() + timeoutMs, readBody: false, turnSignal: undefined },
      );
    } catch {
      /* best effort */
    }
  }

  // ---- plumbing ---------------------------------------------------------------------

  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.options.bearer}` };
  }

  /** False when a request to this base can never be built correctly (unparseable, userinfo, query, fragment, non-http(s)). */
  private baseIsSendable(): boolean {
    try {
      const raw = this.options.baseUrl;
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") return false;
      if (raw.includes("?") || raw.includes("#")) return false;
      return u.username === "" && u.password === "" && u.search === "" && u.hash === "";
    } catch {
      return false;
    }
  }

  private readIdentity(context: unknown): Identity | null {
    if (!isRecord(context)) return null;
    const chatwoot = context["chatwoot"];
    const message = context["message"];
    if (!isRecord(chatwoot) || !isRecord(message)) return null;
    const tenantId = context["tenantId"];
    const accountId = chatwoot["accountId"];
    const inboxId = chatwoot["inboxId"];
    const conversationId = chatwoot["conversationDisplayId"];
    const messageId = chatwoot["messageId"];
    const content = message["content"];
    if (typeof tenantId !== "string" || tenantId.length === 0) return null;
    for (const n of [accountId, inboxId, conversationId]) {
      if (typeof n !== "number" || !Number.isSafeInteger(n) || n <= 0) return null;
    }
    if (typeof content !== "string") return null;
    const scope = context["customerScope"];
    return {
      tenantId,
      accountId: accountId as number,
      inboxId: inboxId as number,
      conversationId: conversationId as number,
      messageId: typeof messageId === "number" && Number.isSafeInteger(messageId) ? messageId : null,
      content,
      history: context["history"],
      scopeVerified: isRecord(scope) && scope["kind"] === "verified",
    };
  }

  /**
   * ONE bounded HTTP exchange: the request AND the response body read run under the same abort
   * signal, capped to the time left on the turn and to the per-request timeout. A body is never
   * read past MAX_HERMES_RESPONSE_BYTES. Throws on abort / transport failure / an exhausted deadline.
   */
  private async exchange(
    url: string,
    init: RequestInit,
    opts: { deadlineAt: number; readBody: boolean; turnSignal: AbortSignal | undefined; extraSignal?: AbortSignal },
  ): Promise<Exchange> {
    const remaining = opts.deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("hermes: the deadline is exhausted before the request");
    if (spent(opts.turnSignal)) throw new Error("hermes: the turn budget is spent before the request");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.options.requestTimeoutMs, remaining));
    if (typeof timer.unref === "function") timer.unref();
    const onAbort = (): void => controller.abort();
    opts.turnSignal?.addEventListener("abort", onAbort, { once: true });
    opts.extraSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await this.options.safeFetch(url, { ...init, signal: controller.signal });
      if (!opts.readBody) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* nothing to release */
        }
        return { status: response.status, headers: response.headers, json: undefined };
      }
      const ok = response.status >= 200 && response.status < 300;
      if (!ok) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* nothing to release */
        }
        return { status: response.status, headers: response.headers, json: undefined };
      }
      const text = await readCappedText(response, controller.signal, MAX_HERMES_RESPONSE_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, headers: response.headers, json };
    } finally {
      clearTimeout(timer);
      opts.turnSignal?.removeEventListener("abort", onAbort);
      opts.extraSignal?.removeEventListener("abort", onAbort);
    }
  }

  private fail(request: AgentRuntimeRequest, outcome: string, runId?: string): AgentRuntimeResult {
    return {
      text: null,
      action: null,
      actionUnrecognised: false,
      actionReason: null,
      outcome,
      correlationId: runId === undefined ? request.runId : `hermes:${runId}`,
      completionState: null,
      contractVersion: null,
    };
  }

  private log(event: string, level: "info" | "warn", request: AgentRuntimeRequest, fields: Record<string, unknown>): void {
    const logger = this.options.logger;
    if (logger === undefined) return;
    try {
      const ctx = isRecord(request.context) ? request.context : {};
      const chatwoot = isRecord(ctx["chatwoot"]) ? ctx["chatwoot"] : {};
      logger.log(level, {
        event,
        deliveryId: request.runId,
        tenantId: typeof ctx["tenantId"] === "string" ? ctx["tenantId"] : null,
        accountId: typeof chatwoot["accountId"] === "number" ? chatwoot["accountId"] : null,
        inboxId: typeof chatwoot["inboxId"] === "number" ? chatwoot["inboxId"] : null,
        conversationId: typeof chatwoot["conversationDisplayId"] === "number" ? chatwoot["conversationDisplayId"] : null,
        ...fields,
      });
    } catch {
      /* logging never costs a customer their turn */
    }
  }
}
