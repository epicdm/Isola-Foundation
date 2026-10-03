/**
 * The outbound Chatwoot Application API client.
 *
 * Every call goes through the injected `SafeFetch`, so the Chatwoot host has to
 * be on the egress allowlist like any other. Nothing here calls the platform
 * network primitive directly.
 *
 * VERIFIED CONTRACTS — Chatwoot 4.16.1, authenticated AS THE BOT with
 * `api_access_token: <agent_bot access_token>` (not a user token, not a bearer):
 *
 *   reply       POST /api/v1/accounts/{a}/conversations/{c}/messages
 *               {content, message_type: "outgoing", private: false}
 *   note        same route, {private: true}
 *   escalate    POST /api/v1/accounts/{a}/conversations/{c}/toggle_status
 *               {status: "open"}
 *   assign      POST /api/v1/accounts/{a}/conversations/{c}/assignments
 *               {team_id} or {assignee_id}
 *   labels      POST /api/v1/accounts/{a}/conversations/{c}/labels
 *               {labels: [...]}          <- FULL REPLACEMENT
 *   attributes  POST /api/v1/accounts/{a}/conversations/{c}/custom_attributes
 *               {custom_attributes: {...}}   <- FULL REPLACEMENT
 *
 * `{c}` is the conversation **display_id** — the `conversation.id` field of the
 * webhook payload — not the database primary key.
 *
 * Labels and custom attributes are full replacements, so both are written
 * read-modify-write. If the read fails, the write is SKIPPED: clobbering a
 * human's labels is worse than not adding ours.
 */
import type { SafeFetch } from "./egress.js";
import { ChatwootApiError, EgressBlockedError } from "./errors.js";
import { DELIVERY_REF_ATTRIBUTE } from "./deliveryref.js";

export interface ChatwootTarget {
  accountId: number;
  /** conversation display_id */
  conversationId: number;
  /** The AgentBot's `access_token`. */
  accessToken: string;
  /**
   * The Chatwoot origin this target lives in, from the resolved binding.
   *
   * Absent means the gateway's configured default. Present means THIS tenant
   * is in a different Chatwoot, which is the ordinary case on a multi-tenant
   * platform rather than an exception.
   */
  baseUrl?: string;
  /**
   * Milliseconds left in the delivery's TURN BUDGET (Codex R2). Every request made
   * for this target is capped to it, so no Chatwoot call can outlive the budget that
   * is sized to fit inside the ledger lease. Absent = only the per-request timeout.
   */
  remainingMs?: () => number;
}

/**
 * The outcome of reconciling a deterministic delivery ref against Chatwoot.
 *
 *  - `found`        the message is already in Chatwoot. Never send it again.
 *  - `absent`       PROVEN absent: the newest non-activity message in the
 *                   conversation is at or before the inbound message this
 *                   delivery is answering, so an outgoing message from this
 *                   delivery cannot exist. Message ids are monotonic within a
 *                   conversation, which is what makes this sound.
 *  - `inconclusive` neither could be established. The caller must FAIL CLOSED —
 *                   an unproven absence is not an absence.
 */
export type ReconcileResult =
  | { kind: "found"; messageId: number }
  | { kind: "absent" }
  | { kind: "inconclusive"; detail: string };

export interface ChatwootApi {
  /**
   * Returns the created message id when Chatwoot reports one. `deliveryRef`,
   * when supplied, is stamped into `content_attributes` — never into `content`.
   */
  postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
    deliveryRef?: string,
  ): Promise<number | null>;
  /**
   * Look for a message carrying `deliveryRef` in this conversation.
   *
   * `pivotMessageId` is the INBOUND message this delivery is answering. It is
   * what makes a negative answer sound rather than merely unobserved — see
   * `HttpChatwootApi.reconcileDeliveryRef`.
   */
  reconcileDeliveryRef(
    target: ChatwootTarget,
    deliveryRef: string,
    pivotMessageId: number | null,
  ): Promise<ReconcileResult>;
  /**
   * The whole conversation record, verbatim. Used by restart recovery for the top-level
   * `status` and `meta.assignee` (is a person holding this conversation?), and by
   * reconciliation for the visible messages. Recovery no longer rebuilds the inbound
   * message from it (Codex R5): it escalates a delivery it cannot prove complete.
   */
  getConversationRecord(target: ChatwootTarget): Promise<unknown>;
  openConversation(target: ChatwootTarget): Promise<void>;
  /** Hand the conversation back to the bot. See the implementation for why
   * `pending` and not a new label or status. */
  pendConversation(target: ChatwootTarget): Promise<void>;
  assignTeam(target: ChatwootTarget, teamId: number): Promise<void>;
  getLabels(target: ChatwootTarget): Promise<string[]>;
  setLabels(target: ChatwootTarget, labels: string[]): Promise<void>;
  getCustomAttributes(target: ChatwootTarget): Promise<Record<string, unknown>>;
  setCustomAttributes(target: ChatwootTarget, attributes: Record<string, unknown>): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure merge helpers — the read-modify-write half, unit testable without HTTP
// ---------------------------------------------------------------------------

/** Existing labels first, in their original order, then the new ones. No duplicates. */
export function mergeLabels(
  existing: readonly string[],
  additions: readonly string[],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const label of [...existing, ...additions]) {
    const trimmed = label.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}

/**
 * Only labels this service is approved to apply may be added. Existing labels
 * are preserved by `mergeLabels` regardless — this filter constrains what the
 * gateway itself may introduce.
 */
export function filterApprovedLabels(
  additions: readonly string[],
  approved: readonly string[],
): string[] {
  const allowed = new Set(approved.map((l) => l.trim().toLowerCase()).filter((l) => l.length > 0));
  return additions.filter((l) => allowed.has(l.trim().toLowerCase()));
}

/**
 * The only custom-attribute keys this gateway will ever write. Anything the
 * pipeline tries to set outside this list is dropped, so a future change cannot
 * quietly start overwriting a tenant's own attributes.
 */
export const APPROVED_CUSTOM_ATTRIBUTE_KEYS: readonly string[] = [
  "isola_tenant_id",
  "isola_agent_id",
  "isola_last_outcome",
  "isola_last_correlation_id",
  "isola_last_run_at",
];

export function filterApprovedAttributes(
  additions: Record<string, unknown>,
  approved: readonly string[] = APPROVED_CUSTOM_ATTRIBUTE_KEYS,
): Record<string, unknown> {
  const allowed = new Set(approved);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(additions)) {
    if (allowed.has(key)) out[key] = value;
  }
  return out;
}

/** Existing values are preserved; only the approved keys are overwritten. */
export function mergeCustomAttributes(
  existing: Record<string, unknown>,
  additions: Record<string, unknown>,
): Record<string, unknown> {
  return { ...existing, ...additions };
}

// ---------------------------------------------------------------------------
// HTTP client
// ---------------------------------------------------------------------------

export interface HttpChatwootApiOptions {
  baseUrl: string;
  safeFetch: SafeFetch;
  timeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A Chatwoot message id: a POSITIVE SAFE INTEGER, and a number (the API gives numbers, so a
 * digit string is unreadable too). `Number.isFinite` accepted -1, 0, 0.5 and -0.5, which let
 * a malformed record read as "well formed, nothing of ours in it" and authorised a second
 * copy of a committed reply (Codex R5 G5-3).
 */
function isMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function readMessageId(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const id = payload["id"];
  return isMessageId(id) ? id : null;
}

export interface ScannedMessage {
  id: number;
  createdAt: number | null;
  deliveryRef: string | null;
  /** Chatwoot `message_type` 2 is `activity` — a system line, not a real message. */
  isActivity: boolean;
}

const ACTIVITY_MESSAGE_TYPE = 2;
const INCOMING_MESSAGE_TYPE = 0;

/**
 * One prior turn, as the model should see it.
 *
 * `role` is the CUSTOMER's or OURS. Chatwoot `message_type` 0 is incoming (the
 * customer), 1 is outgoing (us — the bot or a human agent, indistinguishable
 * here and deliberately so: from the customer's side both are "the business").
 */
export interface HistoryTurn {
  role: "customer" | "business";
  content: string;
}

export interface ConversationHistory {
  turns: HistoryTurn[];
  /** The Chatwoot message id of each turn, same order (Codex DH3). Never part of `context.history`. */
  messageIds?: number[];
  /** True when older turns were dropped to fit the window. */
  truncated: boolean;
}

/** Newest-first scan, oldest dropped first. See `readConversationHistory`. */
export const HISTORY_MAX_TURNS = 20;
export const HISTORY_MAX_CHARS = 8000;

/**
 * Prior turns for the model, from the SAME conversation record that
 * `reconcileDeliveryRef` already reads — no new endpoint, no new permission.
 * (An agent bot cannot list `/messages` — 401 — but conversations#show carries
 * them, which is why reconciliation works today.)
 *
 * THREE THINGS ARE EXCLUDED, AND THE FIRST IS A SAFETY PROPERTY:
 *
 *   1. PRIVATE NOTES. `private: true` is staff-only — the handoff note names
 *      what a colleague should pick up and may quote internal context. Sending
 *      it to the model would put internal notes one paraphrase away from the
 *      customer. Excluded by construction here, not by a caller remembering.
 *   2. ACTIVITY LINES. "Conversation was marked open by system…" is Chatwoot
 *      talking to staff, not a turn.
 *   3. EMPTY CONTENT. Attachments arrive with no text; a blank turn teaches the
 *      model nothing and wastes the window.
 *
 * BOUNDED, and the boundary is stated rather than discovered: at most
 * HISTORY_MAX_TURNS turns and HISTORY_MAX_CHARS characters. When the window is
 * exceeded the OLDEST turns are dropped — recent context is what a front desk
 * needs — and `truncated` says so. No marker is injected into the text: a
 * marker is content the model can echo to a customer.
 */
export function readConversationHistory(record: unknown): ConversationHistory {
  if (!isRecord(record)) return { turns: [], truncated: false };
  const list = record["messages"];
  if (!Array.isArray(list)) return { turns: [], truncated: false };

  const all: HistoryTurn[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    if (entry["message_type"] === ACTIVITY_MESSAGE_TYPE) continue;
    // FAIL CLOSED ON `private`, exactly as webhook.ts does.
    // Only an EXPLICIT boolean false is public. A missing, null, or string
    // flag is treated as private, because the cost of guessing wrong is a
    // staff-only handover note reaching the model and, one paraphrase later,
    // the customer. Found by review 2026-08-17: `=== true` let every malformed
    // shape through while the claim in the doc comment said "by construction".
    if (entry["private"] !== false) continue;
    const content = entry["content"];
    if (typeof content !== "string") continue;
    const text = content.trim();
    if (text.length === 0) continue;
    all.push({
      role: entry["message_type"] === INCOMING_MESSAGE_TYPE ? "customer" : "business",
      content: text,
    });
  }

  let truncated = false;
  let turns = all;
  if (turns.length > HISTORY_MAX_TURNS) {
    turns = turns.slice(turns.length - HISTORY_MAX_TURNS);
    truncated = true;
  }
  let total = turns.reduce((n, t) => n + t.content.length, 0);
  while (total > HISTORY_MAX_CHARS && turns.length > 1) {
    total -= turns[0]!.content.length;
    turns = turns.slice(1);
    truncated = true;
  }
  return { turns, truncated };
}


function readScannedMessage(entry: unknown): ScannedMessage | null {
  if (!isRecord(entry)) return null;
  const id = entry["id"];
  if (!isMessageId(id)) return null;
  const createdAt = entry["created_at"];
  const attributes = entry["content_attributes"];
  const ref = isRecord(attributes) ? attributes[DELIVERY_REF_ATTRIBUTE] : undefined;
  return {
    id,
    createdAt: typeof createdAt === "number" ? createdAt : null,
    deliveryRef: typeof ref === "string" && ref.length > 0 ? ref : null,
    isActivity: entry["message_type"] === ACTIVITY_MESSAGE_TYPE,
  };
}

/**
 * The messages an AgentBot can actually see on a conversation record: the single
 * newest message (`messages`, which the partial builds from
 * `conversation.messages.last`, so it may be an activity line) and
 * `last_non_activity_message` (the newest real message).
 *
 * Deliberately reads id, created_at, message_type and the delivery ref only —
 * message content never enters this path.
 */
export function readVisibleMessages(record: unknown): ScannedMessage[] {
  if (!isRecord(record)) return [];
  const out: ScannedMessage[] = [];
  const seen = new Set<number>();

  const push = (entry: unknown): void => {
    const parsed = readScannedMessage(entry);
    if (parsed === null || seen.has(parsed.id)) return;
    seen.add(parsed.id);
    out.push(parsed);
  };

  const list = record["messages"];
  if (Array.isArray(list)) for (const entry of list) push(entry);
  push(record["last_non_activity_message"]);

  return out;
}

/**
 * Why a `conversations#show` body cannot be trusted to PROVE a message absent, or null when
 * it is well formed. Well formed means: an object whose `messages` is an array and which
 * carries the `last_non_activity_message` field (null is legitimate: a conversation with no
 * real message yet), every message in either place has a POSITIVE SAFE INTEGER `id`, and
 * the visibility fields AGREE with each other (Codex R5 G5-3):
 *   - `last_non_activity_message` is not an activity line;
 *   - if the newest message in `messages` is a real (non-activity) one, `last_non_activity_message`
 *     is that same message (it cannot be null, and it cannot be older);
 *   - the newest message overall is never older than `last_non_activity_message`.
 * Contradictory metadata is evidence of nothing, so it is unreadable, never "no real message".
 *
 * The presence of `last_non_activity_message` is UNVERIFIED against the installed 4.18
 * build (the 4.16.1 partial was read, and always emitted it). If 4.18 omits it, every
 * reconciliation becomes inconclusive: loud (a human is asked), never a duplicate.
 */
function unreadableConversationRecord(record: unknown): string | null {
  if (!isRecord(record)) return "not an object";
  const messages = record["messages"];
  if (!Array.isArray(messages)) return "messages is not a list";
  if (!("last_non_activity_message" in record)) return "last_non_activity_message is missing";
  for (const entry of messages) {
    if (readScannedMessage(entry) === null) return "a message has no readable id";
  }
  const last = record["last_non_activity_message"];
  if (last !== null && readScannedMessage(last) === null) return "last_non_activity_message has no readable id";

  // ONE ID NAMES ONE MESSAGE (Codex R6 G6-1). Validate representation consistency BEFORE any
  // de-duplication: `readVisibleMessages` keeps the first representation of an id, so an id that
  // is an activity line in one place and a real message in another would silently lose its real
  // representation, leave no real message, and read as ABSENT -- a second copy of a message that
  // may be committed. An id with conflicting representations is evidence of nothing.
  const representation = new Map<number, boolean>();
  for (const entry of [...messages, ...(last === null ? [] : [last])]) {
    const parsed = readScannedMessage(entry);
    if (parsed === null) continue;
    const seen = representation.get(parsed.id);
    if (seen !== undefined && seen !== parsed.isActivity) {
      return `message ${parsed.id} is represented both as an activity line and as a real message`;
    }
    representation.set(parsed.id, parsed.isActivity);
  }

  const lastMessage = last === null ? null : readScannedMessage(last);
  if (lastMessage !== null && lastMessage.isActivity) {
    return "last_non_activity_message is an activity line";
  }
  const listed = messages.map((entry) => readScannedMessage(entry)).filter((m): m is ScannedMessage => m !== null);
  if (listed.length > 0) {
    const newest = listed.reduce((a, b) => (b.id > a.id ? b : a));
    if (!newest.isActivity) {
      if (lastMessage === null) return "the newest message is a real one but last_non_activity_message is null";
      if (lastMessage.id < newest.id) return "last_non_activity_message is older than the newest message, which is a real one";
    }
    if (lastMessage !== null && newest.id < lastMessage.id) {
      return "the newest message is older than last_non_activity_message";
    }
  }
  return null;
}

/**
 * The reconciliation DECISION, as a pure function of the conversation record an AgentBot can
 * see (Codex R5: extracted so the test double makes the SAME decision from the SAME visibility
 * window the production client has, instead of searching a map no bot can see).
 *
 * FOUND needs our reference on a message that is visible. ABSENT needs a well-formed record
 * whose newest real message is at or before the pivot. Anything else is INCONCLUSIVE, and an
 * inconclusive means nothing is re-sent.
 */
export function reconcileFromRecord(
  payload: unknown,
  deliveryRef: string,
  pivotMessageId: number | null,
): ReconcileResult {
  const visible = readVisibleMessages(payload);
  for (const message of visible) {
    if (message.deliveryRef === deliveryRef) {
      return { kind: "found", messageId: message.id };
    }
  }

  // ONLY A WELL-FORMED RECORD CAN PROVE ABSENCE (Codex R4 G4-3). `request()` returns
  // `null` for a 2xx whose body is empty or not JSON, and a lenient reader turns every
  // unreadable shape into "no visible messages" -- which the code below would call
  // ABSENT, and the caller would then send a second copy of a message that may well be
  // there. An instrument that could not read is not a negative finding (Laws 11, 23).
  const unreadable = unreadableConversationRecord(payload);
  if (unreadable !== null) {
    return {
      kind: "inconclusive",
      detail: `the conversation record could not be read as a conversation (${unreadable}); absence cannot be proven`,
    };
  }

  if (pivotMessageId === null) {
    return {
      kind: "inconclusive",
      detail: "no inbound message id to pivot on, so absence cannot be proven",
    };
  }

  const newestReal = visible
    .filter((m) => !m.isActivity)
    .reduce<number | null>((max, m) => (max === null || m.id > max ? m.id : max), null);

  if (newestReal === null) {
    // No real message at all, so ours certainly is not there.
    return { kind: "absent" };
  }
  if (newestReal <= pivotMessageId) {
    return { kind: "absent" };
  }
  return {
    kind: "inconclusive",
    detail: `a newer message (${newestReal}) exists that is not ours; absence cannot be proven`,
  };
}

export class HttpChatwootApi implements ChatwootApi {
  private readonly baseUrl: string;
  private readonly safeFetch: SafeFetch;
  private readonly timeoutMs: number;

  constructor(options: HttpChatwootApiOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.safeFetch = options.safeFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  private conversationPath(target: ChatwootTarget, suffix: string): string {
    return `/api/v1/accounts/${encodeURIComponent(String(target.accountId))}/conversations/${encodeURIComponent(
      String(target.conversationId),
    )}${suffix}`;
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    accessToken: string,
    /** Per-binding Chatwoot origin. Absent falls back to the configured default. */
    baseUrl?: string,
    /** Milliseconds left in the delivery's turn budget (Codex R2). Absent = only the per-request timeout. */
    remainingMs?: () => number,
  ): Promise<unknown> {
    // The request ends at the per-request timeout OR at the end of the turn budget,
    // whichever is sooner, and a request is never even sent once the budget is spent.
    const left = remainingMs?.();
    if (left !== undefined && left <= 0) throw new ChatwootApiError("turn budget exhausted", null);
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, left === undefined ? this.timeoutMs : Math.min(this.timeoutMs, left));
    if (typeof timer.unref === "function") timer.unref();
    // The timer stays armed through the BODY read and is cleared once, in `finally`
    // (Codex R2: it used to be cleared as soon as the headers arrived, so a stalled body
    // outlived every budget), and the body read is also raced against the abort signal
    // because a body that ignores the signal must still end the request.
    try {

    const headers: Record<string, string> = {
      accept: "application/json",
      // Chatwoot's Application API authenticates the bot with this header.
      // It is NOT an Authorization bearer.
      api_access_token: accessToken,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      // The tenant's own Chatwoot when the binding names one, otherwise the
      // gateway default. Either way the host must be on the egress allowlist —
      // src/egress.ts refuses anything else, and that refusal is what stops a
      // crafted or mistyped binding turning into an outbound call to an
      // arbitrary host carrying an access token.
      const origin = (baseUrl ?? this.baseUrl).replace(/\/+$/, "");
      response = await this.safeFetch(`${origin}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
    } catch (err) {
      if (timedOut) throw new ChatwootApiError("call timed out", null);
      if (err instanceof EgressBlockedError) {
        throw new ChatwootApiError("chatwoot host is not on the egress allowlist", null);
      }
      const name = err instanceof Error ? err.name : "unknown";
      throw new ChatwootApiError(`transport failure (${name})`, null);
    }

    if (!response.ok) {
      // Status class only. The body echoes conversation content.
      throw new ChatwootApiError(`returned HTTP ${response.status}`, response.status);
    }

    let onAbort: (() => void) | null = null;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("aborted while reading the body"));
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
      return await Promise.race([response.json(), aborted]);
    } catch {
      // The budget ended while the body was still arriving: a timeout, not an empty
      // body (an unread GET must not look like an empty list).
      if (timedOut) throw new ChatwootApiError("call timed out", null);
      // A 2xx with an empty or non-JSON body is fine for the write calls.
      return null;
    } finally {
      if (onAbort !== null) controller.signal.removeEventListener("abort", onAbort);
    }
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `content_attributes` is passed through verbatim by Chatwoot's
   * `Messages::MessageBuilder` (`content_attributes: content_attributes.presence`),
   * and `ContentAttributeValidator` constrains only `items` for the
   * `input_select` / `cards` / `form` / `article` content types — so an extra
   * top-level key on a plain text message is accepted and preserved. Verified
   * against the deployed v4.16.1 source.
   *
   * `source_id` is NOT used: it is accepted by the builder but its index is not
   * unique and no model validation enforces uniqueness, so it buys no
   * idempotency — and on a real channel it belongs to the provider's message id.
   */
  async postMessage(
    target: ChatwootTarget,
    content: string,
    isPrivate: boolean,
    deliveryRef?: string,
  ): Promise<number | null> {
    const payload = await this.request(
      "POST",
      this.conversationPath(target, "/messages"),
      {
        content,
        message_type: "outgoing",
        private: isPrivate,
        ...(deliveryRef === undefined
          ? {}
          : { content_attributes: { [DELIVERY_REF_ATTRIBUTE]: deliveryRef } }),
      },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
    return readMessageId(payload);
  }

  /**
   * WHY THIS READS `conversations#show` AND NOT THE MESSAGES INDEX.
   *
   * An AgentBot token cannot list messages. From the deployed v4.16.1 source,
   * `AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS`:
   *
   *   'api/v1/accounts/conversations'          => show, toggle_status,
   *                                               toggle_typing_status,
   *                                               toggle_priority, create,
   *                                               update, custom_attributes
   *   'api/v1/accounts/conversations/messages' => ['create']      <-- create ONLY
   *   'api/v1/accounts/conversations/assignments' => ['create']
   *   'api/v1/accounts/conversations/labels'   => index, create
   *
   * `GET .../messages` answers `401 {"error":"Access to this endpoint is not
   * authorized for bots"}`. Verified live, not just read.
   *
   * `conversations#show` is allowed, and its partial exposes exactly two
   * messages: `messages` (the single newest message, which may be an activity)
   * and `last_non_activity_message` (the newest real message). Both carry
   * `content_attributes`, so both can carry our delivery ref.
   *
   * SOUNDNESS OF A NEGATIVE. Message ids are monotonically increasing within a
   * conversation. If the newest non-activity message is the inbound message we
   * are answering — or older — then no outgoing message from this delivery can
   * exist, and `absent` is proven rather than merely unobserved. If something
   * newer exists that is not ours, we cannot rule out that ours is behind it,
   * and the answer is `inconclusive` so the caller fails closed.
   */
  async reconcileDeliveryRef(
    target: ChatwootTarget,
    deliveryRef: string,
    pivotMessageId: number | null,
  ): Promise<ReconcileResult> {
    let payload: unknown;
    try {
      payload = await this.getConversationRecord(target);
    } catch (err) {
      return {
        kind: "inconclusive",
        detail: err instanceof Error ? err.message : "conversation read failed",
      };
    }
    return reconcileFromRecord(payload, deliveryRef, pivotMessageId);
  }

  async getConversationRecord(target: ChatwootTarget): Promise<unknown> {
    return this.request("GET", this.conversationPath(target, ""), undefined, target.accessToken, target.baseUrl, target.remainingMs);
  }

  async openConversation(target: ChatwootTarget): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/toggle_status"),
      { status: "open" },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
  }

  /**
   * The inverse of `openConversation`, and the only Chatwoot-side half of a
   * handback. `pending` is Chatwoot's own word for "the bot owns this": the
   * gateway already suppresses on `status_not_pending`, and Chatwoot's
   * bot-handoff banner moves pending -> open when a human takes over. Setting
   * it back is that gesture in reverse, so both guards agree without inventing
   * a new meaning for an existing control.
   */
  async pendConversation(target: ChatwootTarget): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/toggle_status"),
      { status: "pending" },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
  }

  async assignTeam(target: ChatwootTarget, teamId: number): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/assignments"),
      { team_id: teamId },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
  }

  async getLabels(target: ChatwootTarget): Promise<string[]> {
    const payload = await this.request(
      "GET",
      this.conversationPath(target, "/labels"),
      undefined,
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
    const list = isRecord(payload) ? payload["payload"] : payload;
    if (!Array.isArray(list)) return [];
    return list.filter((v): v is string => typeof v === "string");
  }

  async setLabels(target: ChatwootTarget, labels: string[]): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/labels"),
      { labels },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
  }

  async getCustomAttributes(target: ChatwootTarget): Promise<Record<string, unknown>> {
    const payload = await this.request(
      "GET",
      this.conversationPath(target, ""),
      undefined,
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
    if (!isRecord(payload)) return {};
    const attributes = payload["custom_attributes"];
    return isRecord(attributes) ? attributes : {};
  }

  async setCustomAttributes(
    target: ChatwootTarget,
    attributes: Record<string, unknown>,
  ): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/custom_attributes"),
      { custom_attributes: attributes },
      target.accessToken,
      target.baseUrl,
      target.remainingMs,
    );
  }
}

export function createChatwootApi(args: {
  baseUrl: string;
  safeFetch: SafeFetch;
  timeoutMs?: number;
}): ChatwootApi {
  return new HttpChatwootApi({
    baseUrl: args.baseUrl,
    safeFetch: args.safeFetch,
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: args.timeoutMs }),
  });
}
