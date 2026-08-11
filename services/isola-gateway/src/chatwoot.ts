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
   * The whole conversation record, verbatim. Used only by restart recovery,
   * which must rebuild a delivery from the system that actually owns the
   * message rather than from a copy of it in the ledger.
   */
  getConversationRecord(target: ChatwootTarget): Promise<unknown>;
  openConversation(target: ChatwootTarget): Promise<void>;
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

function readMessageId(payload: unknown): number | null {
  if (!isRecord(payload)) return null;
  const id = payload["id"];
  return typeof id === "number" && Number.isFinite(id) ? id : null;
}

export interface ScannedMessage {
  id: number;
  createdAt: number | null;
  deliveryRef: string | null;
  /** Chatwoot `message_type` 2 is `activity` — a system line, not a real message. */
  isActivity: boolean;
}

const ACTIVITY_MESSAGE_TYPE = 2;

function readScannedMessage(entry: unknown): ScannedMessage | null {
  if (!isRecord(entry)) return null;
  const id = entry["id"];
  if (typeof id !== "number" || !Number.isFinite(id)) return null;
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
  ): Promise<unknown> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    const headers: Record<string, string> = {
      accept: "application/json",
      // Chatwoot's Application API authenticates the bot with this header.
      // It is NOT an Authorization bearer.
      api_access_token: accessToken,
    };
    if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await this.safeFetch(`${this.baseUrl}${path}`, {
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
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Status class only. The body echoes conversation content.
      throw new ChatwootApiError(`returned HTTP ${response.status}`, response.status);
    }

    try {
      return await response.json();
    } catch {
      // A 2xx with an empty or non-JSON body is fine for the write calls.
      return null;
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

    const visible = readVisibleMessages(payload);
    for (const message of visible) {
      if (message.deliveryRef === deliveryRef) {
        return { kind: "found", messageId: message.id };
      }
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

  async getConversationRecord(target: ChatwootTarget): Promise<unknown> {
    return this.request("GET", this.conversationPath(target, ""), undefined, target.accessToken);
  }

  async openConversation(target: ChatwootTarget): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/toggle_status"),
      { status: "open" },
      target.accessToken,
    );
  }

  async assignTeam(target: ChatwootTarget, teamId: number): Promise<void> {
    await this.request(
      "POST",
      this.conversationPath(target, "/assignments"),
      { team_id: teamId },
      target.accessToken,
    );
  }

  async getLabels(target: ChatwootTarget): Promise<string[]> {
    const payload = await this.request(
      "GET",
      this.conversationPath(target, "/labels"),
      undefined,
      target.accessToken,
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
    );
  }

  async getCustomAttributes(target: ChatwootTarget): Promise<Record<string, unknown>> {
    const payload = await this.request(
      "GET",
      this.conversationPath(target, ""),
      undefined,
      target.accessToken,
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
