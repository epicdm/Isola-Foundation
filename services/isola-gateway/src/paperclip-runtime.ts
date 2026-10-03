/**
 * The Paperclip-governed execution path — a credential-agnostic CLIENT SEAM.
 *
 * PIVOT PACKET ISOLA-PIVOT-20261002-01, commit B. Tested ONLY against a local STUB
 * Paperclip (test/paperclip-stub.ts); the stub is NOT evidence of installed
 * behaviour (Law 5).
 *
 * WHAT THIS IS
 *   An `AgentRuntime`, i.e. a drop-in for `HttpAgentRuntime` (isola-runtime
 *   /v1/invoke). The pipeline, the ledger, the ownership gate, the in-flight
 *   recheck and the escalation path are all REUSED unchanged: this class only
 *   changes who executes the turn. When it handles a message the old runtime is
 *   NOT also called (`RoutingAgentRuntime`): ONE execution owner.
 *
 *   Flow: create a Paperclip issue (assigneeAgentId = the employee, stable
 *   idempotencyKey = the ledger key) -> Paperclip's own assignment wakeup runs the
 *   employee -> the gateway POLLS the issue's comments, with a hard deadline, for
 *   the employee's final disposition -> that becomes an `AgentRuntimeResult`.
 *
 * SOURCE / UNVERIFIED (every Paperclip endpoint and field this file touches)
 *   SOURCE (Workspace lane OBSERVED in the installed Paperclip 0.3.1, relayed by
 *   Lane A, 2026-10-02): POST /api/companies/:companyId/issues accepts
 *   `idempotencyKey` (1-255), `externalRef`, `assigneeAgentId`; creating with an
 *   assignee queues an `issue_assigned` wakeup; GET /issues/:id/comments takes
 *   `after`/`afterCommentId`/`limit`/`order`; POST /heartbeat-runs/:runId/cancel.
 *   UNVERIFIED: the `/api` prefix on the comments route; the create response shape
 *   (`id`, `executionRunId`); the comment list shape and its `id`/`body`/
 *   `authorAgentId` fields; that replay by the same idempotencyKey returns the
 *   original issue (schema text only); that the run id is discoverable from the
 *   created issue; that cancel reaches Hermes mid-run.
 *
 * WHAT THE EMPLOYEE RECEIVES, AND HOW (flagged for review, not hidden)
 *   Paperclip stores the issue title and description. They carry: correlation ids
 *   (account / inbox / conversation / message / delivery), the SERVER-RESOLVED
 *   customer scope ids (customerId, serviceIds) and the CURRENT customer message
 *   text, which the employee must have in order to answer. Nothing else from the
 *   run context goes to Paperclip: no history, no custom attributes, no contact
 *   phone, no Lite/Magnus/Odoo ids. Prior-turn history is NOT carried in this slice.
 *
 * THE RESULT CONVENTION IS A MODEL CONVENTION, NOT A CONTRACT
 *   The employee's final comment is a JSON object
 *   `{"isola":1,"disposition":"reply","text":"..."}` or
 *   `{"isola":1,"disposition":"request_human","reason":"<code>","text":"..."}`.
 *   Paperclip does not enforce it. Anything else — chatter, malformed JSON, an
 *   unknown disposition, empty text, a comment by someone other than the assigned
 *   employee — is not a result, and at the deadline the turn FAILS CLOSED: no
 *   customer message, the existing escalation path (Law 12).
 *
 * LAW 10 (a retry that changes the request is a different request)
 *   `X-Paperclip-Run-Id` is NEVER sent, dropped or invented here. A 401/403 —
 *   including the literal "Task bridge key cannot use this API action" — is a
 *   CONFIG DEFECT: one request, no retry, no customer message.
 */
import { createHash } from "node:crypto";

import type { LedgerIdentity } from "./deliveryref.js";
import type { SafeFetch } from "./egress.js";
import { EgressBlockedError } from "./errors.js";
import {
  isAgentEscalationReason,
  type AgentRuntime,
  type AgentRuntimeRequest,
  type AgentRuntimeResult,
} from "./runtime.js";

/** Credential-agnostic: a task_bridge agent key, a routine-trigger signature or anything else plugs in here. */
export interface PaperclipAuth {
  headers(): Record<string, string>;
}

/**
 * Where the created issue id is remembered so a replayed delivery REUSES it and
 * makes no second create call. In production this belongs on the ledger row (a
 * reviewed migration, UAT only: see the DDL in the commit-B report); the in-memory
 * store below is the default and is LOST on restart, after which recovery rests on
 * the server honouring `idempotencyKey` (UNVERIFIED).
 */
export interface IssueStore {
  get(key: string): Promise<string | null>;
  put(key: string, issueId: string): Promise<void>;
  /** An earlier create for this key had an unknown outcome and no issue id is on record. */
  isUncertain(key: string): Promise<boolean>;
  markUncertain(key: string): Promise<void>;
}

export function inMemoryIssueStore(): IssueStore {
  const ids = new Map<string, string>();
  const uncertain = new Set<string>();
  return {
    get: async (key) => ids.get(key) ?? null,
    put: async (key, id) => void ids.set(key, id),
    isUncertain: async (key) => uncertain.has(key),
    markUncertain: async (key) => void uncertain.add(key),
  };
}

export const PAPERCLIP_OUTCOMES = {
  /** 401/403/other 4xx, or a request this client refuses to send: configuration, not weather. */
  configDefect: "paperclip_config_defect",
  /** The create's outcome is unknown and no issue id is on record: NEVER re-created. */
  createUncertain: "paperclip_create_uncertain",
  /** The poll ended with no conforming result. */
  noResult: "paperclip_no_result",
  /** The conversation stopped being ours mid-run. */
  ownershipLost: "paperclip_ownership_lost",
  /** The poll deadline passed: the existing runtime vocabulary. */
  timeout: "model_timeout",
} as const;

/**
 * A run id is ISSUED by Paperclip when it wakes an agent. A gateway that is not that
 * agent must never present one (Law 10: a retry that changes the request is a
 * different request; an invented or stale id is a 500, a missing one a 401). A
 * credential whose headers carry one is therefore a CONFIG DEFECT and nothing is sent.
 */
const FORBIDDEN_AUTH_HEADER = "x-paperclip-run-id";

/** Paperclip's documented ceiling for `idempotencyKey` (SOURCE: Lane A relay: 1-255). */
const MAX_IDEMPOTENCY_KEY = 255;
/**
 * The customer message is cut to at most this many UTF-16 code units, and never in the
 * middle of a surrogate pair (Codex R6: an emoji at the boundary left a lone surrogate).
 */
const MAX_MESSAGE_CHARS = 4000;

/**
 * Hard ceiling on ANY Paperclip response body the gateway will buffer (Codex R4: a
 * 16 MiB body was accepted "ok" with a 1 ms timeout, and nothing capped the read). A
 * declared Content-Length over it is refused before a byte is read; an undeclared or
 * lying body is cut off the moment the running total passes it. 1 MiB is far above a
 * create response or a 50-comment page and far below anything that could pressure
 * the process.
 */
export const MAX_PAPERCLIP_RESPONSE_BYTES = 1024 * 1024;

class ResponseTooLargeError extends Error {
  constructor() {
    super("paperclip: the response body exceeds the byte cap");
    this.name = "ResponseTooLargeError";
  }
}

/** At most `max` UTF-16 code units, never splitting a surrogate pair. */
export function truncateKeepingPairs(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose pair would be cut
  return text.slice(0, end);
}

/**
 * Resolves with the value, or "deadline" when the absolute turn deadline passes first.
 * A rejection is returned as `false` for a boolean probe by the caller's choice via
 * `onReject`: for the ownership read that means "could not find out" = not ours.
 */
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

/**
 * Read the body as text, never past `cap` bytes and never past the abort signal, even
 * when the body itself ignores the signal (a stalled stream is raced against it).
 */
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
    onAbort = () => reject(new Error("paperclip: aborted while reading the body"));
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

/**
 * The stable idempotency key: the ledger key `(tenant, binding, account, inbox,
 * event id, action)`. Replays, sweeper retries and worker retries all compute the
 * same value. Over 255 characters it is replaced by a sha256 of itself, which is
 * still deterministic and still unique per ledger key.
 */
export function paperclipIdempotencyKey(identity: LedgerIdentity, mode: string): string {
  const raw = [
    `isolagw:${identity.tenantId}`,
    identity.bindingId,
    String(identity.chatwootAccountId),
    String(identity.chatwootInboxId),
    identity.eventId,
    mode,
  ].join("|");
  if (raw.length <= MAX_IDEMPOTENCY_KEY) return raw;
  return `isolagw:sha256:${createHash("sha256").update(raw).digest("hex")}`;
}

export interface PaperclipRuntimeOptions {
  baseUrl: string;
  companyId: string;
  auth: PaperclipAuth;
  safeFetch: SafeFetch;
  issueStore: IssueStore;
  /**
   * ABSOLUTE ceiling on the WHOLE turn: the create, every poll and every response
   * body read all run under it (Codex D1/D2). Validated at boot against the ledger
   * lease and the runtime timeout.
   */
  pollDeadlineMs: number;
  pollIntervalMs: number;
  /** Per-HTTP-request timeout, covering the response BODY read too; each request is also capped to the time left on the turn. */
  requestTimeoutMs: number;
}

/** One finished HTTP exchange; `json` is undefined when no body was read or it did not parse. */
interface Exchange {
  status: number;
  json: unknown;
}

type CreateResult =
  | { kind: "created"; issueId: string; runId: string | null }
  | { kind: "config_defect"; detail: string }
  | { kind: "uncertain"; detail: string };

type Envelope =
  | { kind: "reply"; text: string }
  | { kind: "request_human"; text: string; reason: string | null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function failure(runId: string, outcome: string): AgentRuntimeResult {
  return {
    text: null,
    action: null,
    actionUnrecognised: false,
    actionReason: null,
    outcome,
    correlationId: runId,
    completionState: null,
    contractVersion: null,
  };
}

/** Parse ONE comment body into the result envelope, or null when it is not one. */
export function parseEnvelope(body: string): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (!isRecord(parsed) || parsed["isola"] !== 1) return null;
  const text = typeof parsed["text"] === "string" ? parsed["text"] : null;
  if (parsed["disposition"] === "reply") {
    return text !== null && text.trim().length > 0 ? { kind: "reply", text } : null;
  }
  if (parsed["disposition"] === "request_human") {
    if (text === null || text.trim().length === 0) return null;
    const reason = isAgentEscalationReason(parsed["reason"]) ? (parsed["reason"] as string) : null;
    return { kind: "request_human", text, reason };
  }
  return null;
}

function describeContext(request: AgentRuntimeRequest): { title: string; description: string } {
  const ctx = isRecord(request.context) ? request.context : {};
  const chatwoot = isRecord(ctx["chatwoot"]) ? ctx["chatwoot"] : {};
  const message = isRecord(ctx["message"]) ? ctx["message"] : {};
  const scope = isRecord(ctx["customerScope"]) ? ctx["customerScope"] : null;

  const ids = `account=${String(chatwoot["accountId"] ?? "?")} inbox=${String(chatwoot["inboxId"] ?? "?")} conversation=${String(chatwoot["conversationDisplayId"] ?? "?")} message=${String(chatwoot["messageId"] ?? "?")}`;
  let scopeLines: string;
  if (scope === null) scopeLines = "- not resolved (no customer-scope resolver configured)";
  else if (scope["kind"] === "verified") {
    const serviceIds = Array.isArray(scope["serviceIds"]) ? (scope["serviceIds"] as unknown[]).map(String).join(",") : "";
    scopeLines = `- customerId=${String(scope["customerId"])}\n- serviceIds=${serviceIds}`;
  } else scopeLines = `- ${String(scope["kind"])}`;

  const text = typeof message["content"] === "string" ? truncateKeepingPairs(message["content"], MAX_MESSAGE_CHARS) : "";
  return {
    title: `Chatwoot ${ids.replace(/ /g, " ")} (${request.runId})`,
    description: [
      "Chatwoot correlation:",
      `- ${ids}`,
      `- delivery=${request.runId}`,
      "",
      "Verified customer scope (server-resolved; use ONLY these ids for business lookups):",
      scopeLines,
      "",
      "Customer message (the only customer content sent here):",
      text,
      "",
      'Finish by leaving ONE comment whose entire body is a JSON object: {"isola":1,"disposition":"reply","text":"<the reply>"} or {"isola":1,"disposition":"request_human","reason":"<code>","text":"<handover message>"}. Any other final comment is treated as no answer.',
    ].join("\n"),
  };
}

export class PaperclipAgentRuntime implements AgentRuntime {
  private readonly runIds = new Map<string, string>();

  constructor(private readonly options: PaperclipRuntimeOptions) {}

  async invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    const key = request.idempotencyKey;
    if (typeof key !== "string" || key.length === 0 || key.length > MAX_IDEMPOTENCY_KEY) {
      // Refused before any network call: a Paperclip turn without the stable key
      // could not be replayed safely.
      return failure(request.runId, PAPERCLIP_OUTCOMES.configDefect);
    }
    // The turn must be FOR the company this runtime is configured for (Codex D3). The
    // pipeline stamps the binding's own paperclipCompanyId into the context; a turn
    // for another company, or one that does not say, is refused before anything is
    // sent: customer scope must never land in a company it was not bound to.
    const ctx = isRecord(request.context) ? request.context : {};
    const turnCompany = str(ctx["companyId"]);
    if (turnCompany === null || turnCompany !== this.options.companyId) {
      return failure(request.runId, PAPERCLIP_OUTCOMES.configDefect);
    }
    const store = this.options.issueStore;
    // ONE absolute deadline for the whole turn (create + polls + body reads). The
    // ledger lease is sized against it at boot; nothing here may outlive it.
    const deadlineAt = Date.now() + this.options.pollDeadlineMs;

    let issueId = await store.get(key);
    if (issueId === null) {
      // NEVER re-create an uncertain create. The issue may well exist.
      if (await store.isUncertain(key)) return failure(request.runId, PAPERCLIP_OUTCOMES.createUncertain);
      const created = await this.createIssue(request, key, deadlineAt);
      if (created.kind === "config_defect") return failure(request.runId, PAPERCLIP_OUTCOMES.configDefect);
      if (created.kind === "uncertain") {
        await store.markUncertain(key);
        return failure(request.runId, PAPERCLIP_OUTCOMES.createUncertain);
      }
      issueId = created.issueId;
      await store.put(key, issueId);
      if (created.runId !== null) this.runIds.set(issueId, created.runId);
    }

    return this.pollForResult(request, issueId, deadlineAt);
  }

  // ---- create ---------------------------------------------------------------

  private async createIssue(request: AgentRuntimeRequest, key: string, deadlineAt: number): Promise<CreateResult> {
    const { title, description } = describeContext(request);
    const url = `${this.base()}/api/companies/${encodeURIComponent(this.options.companyId)}/issues`;
    // A base URL with userinfo can never be fetched: it throws BEFORE a byte is sent,
    // so it is a configuration defect with nothing sent, not an uncertain create (Codex R5).
    if (!this.baseIsSendable()) return { kind: "config_defect", detail: "the base url cannot be used (userinfo, query, fragment or unparseable)" };
    const auth = this.authHeaders();
    if (auth === null) return { kind: "config_defect", detail: "the credential supplies a run id header" };
    let response: Exchange;
    try {
      response = await this.exchange(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...auth },
          body: JSON.stringify({ title, description, assigneeAgentId: request.agentId, idempotencyKey: key }),
        },
        deadlineAt,
        true,
      );
    } catch (err) {
      // The egress guard refused BEFORE a socket was opened: nothing was sent, so
      // this is a configuration defect, not an uncertain create (Codex D6).
      if (err instanceof EgressBlockedError) return { kind: "config_defect", detail: "create blocked by egress" };
      // Includes the deadline / request timeout firing while the BODY was still being
      // read: the issue may exist and we never learned its id, so this is an
      // UNCERTAIN create (never re-created), not a failure we can retry.
      return { kind: "uncertain", detail: "create failed in transport" };
    }
    if (response.status === 401 || response.status === 403) {
      return { kind: "config_defect", detail: `create refused (${response.status})` };
    }
    if (response.status >= 500) return { kind: "uncertain", detail: `create ${response.status}` };
    if (response.status < 200 || response.status >= 300) {
      return { kind: "config_defect", detail: `create rejected (${response.status})` };
    }
    const body: unknown = response.json ?? null;
    const issueId = isRecord(body) ? str(body["id"]) : null;
    if (issueId === null) return { kind: "uncertain", detail: "create 2xx without an issue id" };
    const runId = isRecord(body) ? (str(body["executionRunId"]) ?? str(body["runId"])) : null;
    return { kind: "created", issueId, runId };
  }

  // ---- poll -----------------------------------------------------------------

  private async pollForResult(
    request: AgentRuntimeRequest,
    issueId: string,
    deadline: number,
  ): Promise<AgentRuntimeResult> {
    let after: string | null = null;
    for (;;) {
      if (Date.now() >= deadline) return failure(request.runId, PAPERCLIP_OUTCOMES.timeout);
      if (request.isStillOwned !== undefined) {
        // The ownership read runs under the SAME absolute turn deadline (Codex R4): a
        // pending read must not hold the turn open. A rejection is "I could not find
        // out who holds this", which is never "nobody does".
        const owned = await raceDeadline(
          Promise.resolve().then(() => request.isStillOwned?.() ?? true),
          deadline,
          false,
        );
        if (owned === "deadline") return failure(request.runId, PAPERCLIP_OUTCOMES.timeout);
        if (!owned) {
          await this.cancelRun(issueId, deadline);
          return failure(request.runId, PAPERCLIP_OUTCOMES.ownershipLost);
        }
      }

      const polled = await this.fetchComments(issueId, after, deadline);
      if (polled.kind === "config_defect") return failure(request.runId, PAPERCLIP_OUTCOMES.configDefect);
      // A response that arrived AFTER the deadline is not a result, however well-formed
      // (Codex D2: a 30 ms deadline accepted a comment returned at 100 ms).
      if (Date.now() > deadline) return failure(request.runId, PAPERCLIP_OUTCOMES.timeout);
      if (polled.kind === "ok") {
        for (const comment of polled.comments) {
          after = comment.id;
          // Only the ASSIGNED employee's comment can be a result: a customer who
          // types an envelope as their message must not be able to answer for it.
          if (comment.authorAgentId !== request.agentId) continue;
          const envelope = parseEnvelope(comment.body);
          if (envelope === null) continue;
          return {
            text: envelope.text,
            action: envelope.kind === "reply" ? "reply" : "request_human",
            actionUnrecognised: false,
            actionReason: envelope.kind === "request_human" ? envelope.reason : null,
            outcome: "ok",
            correlationId: `paperclip:${issueId}`,
            completionState: "completed",
            contractVersion: 2,
          };
        }
      }
      // A transient poll failure (network, 5xx, unreadable list) is not a result and
      // not a reason to stop early: the deadline decides.

      const remaining = deadline - Date.now();
      if (remaining <= 0) return failure(request.runId, PAPERCLIP_OUTCOMES.timeout);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.min(this.options.pollIntervalMs, remaining));
        if (typeof t.unref === "function") t.unref();
      });
    }
  }

  private async fetchComments(
    issueId: string,
    after: string | null,
    deadlineAt: number,
  ): Promise<
    | { kind: "ok"; comments: Array<{ id: string; body: string; authorAgentId: string | null }> }
    | { kind: "config_defect" }
    | { kind: "transient" }
  > {
    const query = new URLSearchParams({ order: "asc", limit: "50" });
    if (after !== null) query.set("after", after);
    const url = `${this.base()}/api/issues/${encodeURIComponent(issueId)}/comments?${query.toString()}`;
    const auth = this.authHeaders();
    if (auth === null) return { kind: "config_defect" };
    let response: Exchange;
    try {
      response = await this.exchange(
        url,
        { method: "GET", headers: { accept: "application/json", ...auth } },
        deadlineAt,
        true,
      );
    } catch (err) {
      if (err instanceof EgressBlockedError) return { kind: "config_defect" };
      // An oversized page is anomalous, not weather: re-reading the same page until the
      // deadline would just repeat it (Codex R4). One request, then a config defect.
      if (err instanceof ResponseTooLargeError) return { kind: "config_defect" };
      return { kind: "transient" };
    }
    // EVERY 4xx is a configuration defect (401/403 refused credential, 400/404/422
    // wrong route or shape, 429 a limit we must not hammer): one request, no retry,
    // no customer message (Codex D4). Only transport errors and 5xx are weather.
    if (response.status >= 400 && response.status < 500) return { kind: "config_defect" };
    if (response.status < 200 || response.status >= 300) return { kind: "transient" };
    if (response.json === undefined) return { kind: "transient" };
    const body: unknown = response.json;
    const list = Array.isArray(body)
      ? body
      : isRecord(body)
        ? ((body["comments"] ?? body["items"]) as unknown)
        : null;
    if (!Array.isArray(list)) return { kind: "transient" };
    const comments: Array<{ id: string; body: string; authorAgentId: string | null }> = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;
      const id = entry["id"] === undefined || entry["id"] === null ? null : String(entry["id"]);
      const text = typeof entry["body"] === "string" ? entry["body"] : typeof entry["content"] === "string" ? entry["content"] : null;
      if (id === null || text === null) continue;
      comments.push({ id, body: text, authorAgentId: str(entry["authorAgentId"]) });
    }
    return { kind: "ok", comments };
  }

  // ---- cancel ---------------------------------------------------------------

  /**
   * Best effort, and ONLY with a run id the server told us. A failed cancel never
   * changes the outcome: the takeover is already enforced by the ownership gate.
   * Whether Paperclip's cancel reaches Hermes mid-run is UNVERIFIED.
   */
  private async cancelRun(issueId: string, deadlineAt: number): Promise<void> {
    const runId = this.runIds.get(issueId);
    if (runId === undefined) return;
    const auth = this.authHeaders();
    if (auth === null) return; // never send a run id header, not even to cancel
    try {
      // The SAME absolute turn deadline (Codex R4: a fresh request-timeout budget let a
      // 20 ms turn run ~98 ms). When the turn has no time left the cancel is skipped:
      // takeover safety never rests on the cancel (the send fence and the post-run
      // ownership recheck enforce it), and whether it reaches Hermes is UNVERIFIED.
      await this.exchange(
        `${this.base()}/api/heartbeat-runs/${encodeURIComponent(runId)}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", ...auth },
          body: "{}",
        },
        deadlineAt,
        false,
      );
    } catch {
      /* best effort */
    }
  }

  // ---- plumbing -------------------------------------------------------------

  private base(): string {
    return this.options.baseUrl.replace(/\/+$/, "");
  }

  /**
   * False when a request to this base can never be built correctly: unparseable, userinfo
   * (fetch throws before sending), or a query/fragment (the route is appended to the
   * string and would become query/fragment text, Codex R3 F7).
   */
  private baseIsSendable(): boolean {
    try {
      const u = new URL(this.options.baseUrl);
      if (this.options.baseUrl.includes("?") || this.options.baseUrl.includes("#")) return false;
      return u.username === "" && u.password === "" && u.search === "" && u.hash === "";
    } catch {
      return false;
    }
  }

  /** The credential's headers, or null when they would carry a run id (or cannot be produced): REFUSED, nothing is sent. */
  private authHeaders(): Record<string, string> | null {
    let headers: Record<string, string>;
    try {
      headers = this.options.auth.headers();
    } catch {
      return null;
    }
    for (const name of Object.keys(headers)) {
      if (name.trim().toLowerCase() === FORBIDDEN_AUTH_HEADER) return null;
    }
    return headers;
  }

  /**
   * ONE bounded HTTP exchange: the request AND, for a 2xx, the response BODY read
   * both run under the same AbortSignal, capped to the time left on the turn
   * (Codex D1: the timer used to be cleared as soon as the headers arrived, so a
   * body that never completed could hold a turn open past the ledger lease).
   * Non-2xx and body-less exchanges never read their body; it is cancelled so the
   * socket is released. Throws on abort / transport failure / an exhausted deadline.
   */
  private async exchange(url: string, init: RequestInit, deadlineAt: number, readBody: boolean): Promise<Exchange> {
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) throw new Error("paperclip: the turn deadline is exhausted before the request");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.options.requestTimeoutMs, remaining));
    if (typeof timer.unref === "function") timer.unref();
    try {
      const response = await this.options.safeFetch(url, { ...init, signal: controller.signal });
      const ok = response.status >= 200 && response.status < 300;
      if (!ok || !readBody) {
        try {
          void response.body?.cancel().catch(() => undefined);
        } catch {
          /* nothing to release */
        }
        return { status: response.status, json: undefined };
      }
      // under the SAME signal and timer, and never past the byte cap (Codex R4)
      const text = await readCappedText(response, controller.signal, MAX_PAPERCLIP_RESPONSE_BYTES);
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * ONE execution owner: a message whose employee is enabled for Paperclip goes to
 * Paperclip and ONLY to Paperclip; every other message keeps the existing runtime.
 * With an empty set (the default) the behaviour is exactly what it was.
 */
export class RoutingAgentRuntime implements AgentRuntime {
  constructor(
    private readonly fallback: AgentRuntime,
    private readonly paperclip: AgentRuntime,
    private readonly paperclipAgentIds: ReadonlySet<string>,
  ) {}

  invoke(request: AgentRuntimeRequest): Promise<AgentRuntimeResult> {
    return this.paperclipAgentIds.has(request.agentId)
      ? this.paperclip.invoke(request)
      : this.fallback.invoke(request);
  }
}
