/**
 * The inbound Chatwoot payload: parsing, and the suppression predicate.
 *
 * Both are pure functions over an already-verified body so they can be unit
 * tested without HTTP.
 *
 * CHATWOOT DOES NOT SUPPRESS FOR YOU. `app/listeners/agent_bot_listener.rb`
 * (lines 65-77 in 4.16.1) checks neither conversation status nor assignee
 * before dispatching `message_created` to the bot, and delivery provably
 * continues after a human has taken the conversation over. If this gateway did
 * not implement the predicate below, the bot would talk over a live human agent.
 */

export type MessageType = "incoming" | "outgoing" | "activity" | "template" | "unknown";

export interface WebhookPayload {
  event: string | null;
  messageId: number | null;
  /** Customer text. NEVER logged. */
  content: string | null;
  messageType: MessageType;
  /**
   * `true` for a private note, `null` when the field was absent or not a
   * boolean. `null` is treated as private by the suppression predicate — see
   * `evaluateSuppression`.
   */
  private: boolean | null;
  senderType: string | null;
  accountId: number | null;
  inboxId: number | null;
  /**
   * `conversation.id` in the webhook payload IS the conversation `display_id`,
   * which is the value the conversation API paths expect. It is NOT the
   * database primary key. Using the pk here would 404 on every reply.
   */
  conversationDisplayId: number | null;
  conversationStatus: string | null;
  /** The raw `conversation.meta.assignee` node, unmodified. */
  assignee: unknown;
  customAttributes: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readInt(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function child(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key];
  return isRecord(value) ? value : null;
}

/**
 * Chatwoot has shipped `message_type` both as a string and as the underlying
 * enum ordinal. Accept both rather than mis-classifying an outgoing message as
 * "unknown" and then treating "unknown" as safe.
 */
const MESSAGE_TYPE_BY_ORDINAL: readonly MessageType[] = [
  "incoming",
  "outgoing",
  "activity",
  "template",
];

export function readMessageType(value: unknown): MessageType {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (
      lowered === "incoming" ||
      lowered === "outgoing" ||
      lowered === "activity" ||
      lowered === "template"
    ) {
      return lowered;
    }
    return "unknown";
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return MESSAGE_TYPE_BY_ORDINAL[value] ?? "unknown";
  }
  return "unknown";
}

/**
 * Extract only the routing identifiers, without validating anything else.
 *
 * This runs on an UNVERIFIED body, purely to select which AgentBot secret to
 * check the signature against. Nothing here is trusted for any other purpose.
 */
export function parseRouting(raw: Buffer): { accountId: number | null; inboxId: number | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return { accountId: null, inboxId: null };
  }
  if (!isRecord(parsed)) return { accountId: null, inboxId: null };
  const account = child(parsed, "account");
  const inbox = child(parsed, "inbox");
  return {
    accountId: account === null ? null : readInt(account["id"]),
    inboxId: inbox === null ? null : readInt(inbox["id"]),
  };
}

/** Full parse of a verified body. Returns null when the body is not a JSON object. */
export function parseWebhookPayload(raw: Buffer): WebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const account = child(parsed, "account");
  const inbox = child(parsed, "inbox");
  const conversation = child(parsed, "conversation");
  const meta = conversation === null ? null : child(conversation, "meta");
  const sender = child(parsed, "sender");
  const attributes =
    conversation === null ? null : child(conversation, "custom_attributes");

  const privateRaw = parsed["private"];

  return {
    event: readString(parsed["event"]),
    messageId: readInt(parsed["id"]),
    content: readString(parsed["content"]),
    messageType: readMessageType(parsed["message_type"]),
    private: typeof privateRaw === "boolean" ? privateRaw : null,
    senderType: sender === null ? null : readString(sender["type"]),
    accountId: account === null ? null : readInt(account["id"]),
    inboxId: inbox === null ? null : readInt(inbox["id"]),
    conversationDisplayId: conversation === null ? null : readInt(conversation["id"]),
    conversationStatus: conversation === null ? null : readString(conversation["status"]),
    assignee: meta === null ? null : (meta["assignee"] ?? null),
    customAttributes: attributes ?? {},
  };
}

/**
 * An assignee counts as present only when it is an object carrying an id.
 * Chatwoot sends `null` for an unassigned conversation, and has been observed
 * sending `{}` — neither is a human holding the conversation.
 */
export function hasAssignee(assignee: unknown): boolean {
  if (!isRecord(assignee)) return false;
  return readInt(assignee["id"]) !== null;
}

// ---------------------------------------------------------------------------
// The suppression predicate
// ---------------------------------------------------------------------------

export type SuppressionReason =
  | "not_message_created"
  | "no_conversation_id"
  | "message_type_not_incoming"
  | "private_note"
  | "private_flag_absent"
  | "sender_is_agent_bot"
  | "status_not_pending"
  | "human_assigned"
  | "empty_content";

export type SuppressionVerdict =
  | { reply: true }
  | { reply: false; reason: SuppressionReason };

export const REPLYABLE_EVENT = "message_created";

/**
 * Reply only when ALL of these hold:
 *
 *   conversation.status === "pending"
 *   conversation.meta.assignee is null
 *   message_type === "incoming"
 *   private === false
 *   sender.type !== "agent_bot"
 *
 * Anything else: 200, send nothing, log the reason.
 *
 * Two additions beyond the five, both fail-closed and both logged distinctly:
 *  - `private_flag_absent`: a payload with no boolean `private` is treated as
 *    private. Guessing "public" on a malformed payload risks answering a
 *    private note in the customer's channel.
 *  - `empty_content`: there is nothing to answer, so the model is not called.
 *    An attachment-only message lands here (see README §6, known gap).
 */
export function evaluateSuppression(payload: WebhookPayload): SuppressionVerdict {
  if (payload.event !== REPLYABLE_EVENT) {
    return { reply: false, reason: "not_message_created" };
  }
  if (payload.conversationDisplayId === null) {
    return { reply: false, reason: "no_conversation_id" };
  }
  if (payload.messageType !== "incoming") {
    return { reply: false, reason: "message_type_not_incoming" };
  }
  if (payload.private === true) {
    return { reply: false, reason: "private_note" };
  }
  if (payload.private === null) {
    return { reply: false, reason: "private_flag_absent" };
  }
  if (payload.senderType === "agent_bot") {
    return { reply: false, reason: "sender_is_agent_bot" };
  }
  if (payload.conversationStatus !== "pending") {
    return { reply: false, reason: "status_not_pending" };
  }
  if (hasAssignee(payload.assignee)) {
    return { reply: false, reason: "human_assigned" };
  }
  if (payload.content === null || payload.content.trim().length === 0) {
    return { reply: false, reason: "empty_content" };
  }
  return { reply: true };
}
