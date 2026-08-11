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
 * The outcome of a reconciliation scan for a deterministic delivery ref.
 *
 *  - `found`        the message is already in Chatwoot. Never send it again.
 *  - `absent`       PROVEN absent: the scan reached back past the moment the
 *                   delivery was reserved without finding the ref, so the
 *                   message cannot have been sent by this delivery.
 *  - `inconclusive` the scan ran out of pages before it could prove absence, or
 *                   the read itself failed. The caller must FAIL CLOSED — an
 *                   unproven absence is not an absence.
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
   * Look for a message carrying `deliveryRef` in this conversation, scanning
   * back until the scan is older than `reservedAtEpochSec` or the page budget
   * is spent.
   */
  reconcileDeliveryRef(
    target: ChatwootTarget,
    deliveryRef: string,
    reservedAtEpochSec: number,
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

/**
 * How far back a reconciliation scan will page before giving up. Reaching this
 * limit is `inconclusive`, never `absent`: the caller then fails closed rather
 * than risking a duplicate customer message.
 */
export const RECONCILE_PAGE_BUDGET = 3;

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
}

/**
 * Pull `(id, created_at, content_attributes.isola_delivery_ref)` out of a
 * messages page. Deliberately reads nothing else — message content never enters
 * this path.
 */
export function readMessageList(payload: unknown): ScannedMessage[] {
  const list = isRecord(payload) ? payload["payload"] : payload;
  if (!Array.isArray(list)) return [];
  const out: ScannedMessage[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = entry["id"];
    if (typeof id !== "number" || !Number.isFinite(id)) continue;
    const createdAt = entry["created_at"];
    const attributes = entry["content_attributes"];
    const ref = isRecord(attributes) ? attributes[DELIVERY_REF_ATTRIBUTE] : undefined;
    out.push({
      id,
      createdAt: typeof createdAt === "number" ? createdAt : null,
      deliveryRef: typeof ref === "string" && ref.length > 0 ? ref : null,
    });
  }
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

  async reconcileDeliveryRef(
    target: ChatwootTarget,
    deliveryRef: string,
    reservedAtEpochSec: number,
  ): Promise<ReconcileResult> {
    let before: number | null = null;
    for (let page = 0; page < RECONCILE_PAGE_BUDGET; page += 1) {
      let payload: unknown;
      try {
        payload = await this.request(
          "GET",
          this.conversationPath(
            target,
            `/messages${before === null ? "" : `?before=${encodeURIComponent(String(before))}`}`,
          ),
          undefined,
          target.accessToken,
        );
      } catch (err) {
        return {
          kind: "inconclusive",
          detail: err instanceof Error ? err.message : "message read failed",
        };
      }

      const messages = readMessageList(payload);
      if (messages.length === 0) {
        // No more history. Nothing older exists, so absence is proven.
        return { kind: "absent" };
      }

      for (const message of messages) {
        if (message.deliveryRef === deliveryRef) {
          return { kind: "found", messageId: message.id };
        }
      }

      const oldest = messages.reduce(
        (min, m) => (m.createdAt !== null && m.createdAt < min ? m.createdAt : min),
        Number.POSITIVE_INFINITY,
      );
      // The scan has reached back past the moment this delivery was reserved,
      // so a message from this delivery cannot be hiding further back.
      if (Number.isFinite(oldest) && oldest < reservedAtEpochSec) {
        return { kind: "absent" };
      }

      const lowestId = messages.reduce((min, m) => (m.id < min ? m.id : min), Infinity);
      if (!Number.isFinite(lowestId)) return { kind: "absent" };
      before = lowestId;
    }

    return {
      kind: "inconclusive",
      detail: `scanned ${RECONCILE_PAGE_BUDGET} pages without reaching the reservation time`,
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
