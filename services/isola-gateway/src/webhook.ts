/**
 * The inbound Chatwoot payload: parsing, and the routing predicate that decides
 * between answering, handing over to a human, and doing nothing at all.
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
   * One sanitised `file_type` per attachment, in payload order.
   *
   * THIS IS THE ONLY THING THIS SERVICE EVER READS OUT OF AN ATTACHMENT. The
   * parser never reads `data_url`, `thumb_url`, `file_name` or any other
   * attachment field, so no filename and no URL can exist anywhere downstream —
   * not in a note, not in a log line, and not as something that could be
   * fetched. Every value is mapped onto `KNOWN_ATTACHMENT_TYPES` or onto
   * `UNKNOWN_ATTACHMENT_TYPE`, so it is a closed vocabulary rather than
   * attacker-controlled text.
   */
  attachmentTypes: string[];
  /**
   * The message `content_type`, mapped onto a closed vocabulary. `null` when
   * absent. Anything other than `"text"` is content this gateway cannot read.
   */
  contentType: string | null;
  /**
   * `true` for a private note, `null` when the field was absent or not a
   * boolean. `null` is treated as private by the suppression predicate — see
   * `evaluateSuppression`.
   */
  private: boolean | null;
  senderType: string | null;
  /** E.164-ish, as Chatwoot supplies it. Used ONLY by the INTERNAL allowlist. */
  senderPhone: string | null;
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
 * Chatwoot's `Attachment#file_type` enum, in ordinal order. Like
 * `message_type`, it has shipped both as a string and as the ordinal.
 */
const ATTACHMENT_TYPE_BY_ORDINAL: readonly string[] = [
  "image",
  "audio",
  "video",
  "file",
  "location",
  "fallback",
  "share",
  "story_mention",
  "contact",
  "ig_reel",
];

export const KNOWN_ATTACHMENT_TYPES: readonly string[] = ATTACHMENT_TYPE_BY_ORDINAL;

/** Anything outside the known enum. Deliberately not the raw value. */
export const UNKNOWN_ATTACHMENT_TYPE = "other";

/**
 * Map an attachment's `file_type` onto the closed vocabulary above.
 *
 * A value that is not a known type becomes `"other"` rather than being carried
 * through. That is what makes it safe to put an attachment type into a private
 * note and into a log line: it can never be a filename, a URL or any other
 * caller-controlled string.
 */
export function readAttachmentType(value: unknown): string {
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    return ATTACHMENT_TYPE_BY_ORDINAL.includes(lowered) ? lowered : UNKNOWN_ATTACHMENT_TYPE;
  }
  if (typeof value === "number" && Number.isInteger(value)) {
    return ATTACHMENT_TYPE_BY_ORDINAL[value] ?? UNKNOWN_ATTACHMENT_TYPE;
  }
  return UNKNOWN_ATTACHMENT_TYPE;
}

/** Chatwoot's `Message#content_type` enum. Only `"text"` carries readable text. */
const KNOWN_CONTENT_TYPES: readonly string[] = [
  "text",
  "input_text",
  "input_textarea",
  "input_email",
  "input_select",
  "input_csat",
  "cards",
  "form",
  "article",
  "incoming_email",
  "integrations",
  "location",
  "contact",
  "sticker",
  "voice",
];

/** Same closed-vocabulary treatment as `readAttachmentType`. */
export function readContentType(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.trim().toLowerCase();
  if (lowered.length === 0) return null;
  return KNOWN_CONTENT_TYPES.includes(lowered) ? lowered : UNKNOWN_ATTACHMENT_TYPE;
}

/**
 * Read the attachment TYPES, and nothing else.
 *
 * Note what is absent: this never touches `data_url` or `thumb_url`. The
 * gateway does not fetch attachments, so it does not carry their locations
 * around either. `test/handoff.test.ts` proves no attachment host is ever
 * contacted, and that no URL survives parsing.
 */
export function readAttachmentTypes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) =>
    readAttachmentType(isRecord(entry) ? entry["file_type"] : entry),
  );
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
    attachmentTypes: readAttachmentTypes(parsed["attachments"]),
    contentType: readContentType(parsed["content_type"]),
    private: typeof privateRaw === "boolean" ? privateRaw : null,
    senderType: sender === null ? null : readString(sender["type"]),
    // `phone_number` is what a WhatsApp contact carries; `identifier` is the
    // fallback Chatwoot uses for some channels. Neither is trusted for anything
    // but the allowlist comparison, and a missing value means "unidentified",
    // which checkSender refuses on an INTERNAL line.
    senderPhone:
      sender === null
        ? null
        : (readString(sender["phone_number"]) ?? readString(sender["identifier"])),
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
  | "human_assigned";

/**
 * Why a verified incoming message cannot be answered by the model.
 *
 * These are NOT suppression reasons. A message that reaches one of them is a
 * real customer who is owed an answer from somebody, so it triggers the human
 * handoff in `src/handoff.ts` — it is never dropped.
 */
export type HandoffReason = "attachment_or_unsupported_content" | "empty_message";

export interface NoTextClassification {
  reason: HandoffReason;
  attachmentCount: number;
  /**
   * The closed-vocabulary attachment types, in payload order. Safe to print in
   * a note and in a log line — see `readAttachmentType`.
   */
  attachmentTypes: string[];
  /** The closed-vocabulary `content_type`, or null when absent. */
  contentType: string | null;
}

export type SuppressionVerdict =
  /** Invoke the model and answer the customer. */
  | { action: "reply" }
  /** Do NOT invoke the model. Hand the conversation to a human and say so. */
  | { action: "handoff"; classification: NoTextClassification }
  /** Acknowledge and do nothing at all. */
  | { action: "suppress"; reason: SuppressionReason };

export const REPLYABLE_EVENT = "message_created";

/** Text the model could actually work with. Whitespace is not text. */
export function hasUsableText(payload: WebhookPayload): boolean {
  return payload.content !== null && payload.content.trim().length > 0;
}

/**
 * Classify a verified incoming message that carries no usable text.
 *
 * Pure, and deliberately callable without HTTP: this is the decision the two
 * verbatim customer strings hang off, so it is unit-tested directly.
 *
 * `attachment_or_unsupported_content` covers both halves of the owner's Case A:
 * attachments present, OR a `content_type` this gateway cannot read. Both get
 * the same wording, because both are "something arrived that I cannot read".
 */
export function classifyNoText(payload: WebhookPayload): NoTextClassification {
  const attachmentTypes = [...payload.attachmentTypes];
  const carriesUnreadableContent =
    attachmentTypes.length > 0 ||
    (payload.contentType !== null && payload.contentType !== "text");
  return {
    reason: carriesUnreadableContent ? "attachment_or_unsupported_content" : "empty_message",
    attachmentCount: attachmentTypes.length,
    attachmentTypes,
    contentType: payload.contentType,
  };
}

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
 * One addition beyond the five, fail-closed and logged distinctly:
 *  - `private_flag_absent`: a payload with no boolean `private` is treated as
 *    private. Guessing "public" on a malformed payload risks answering a
 *    private note in the customer's channel.
 *
 * A message that passes EVERY check above but carries no usable text is not
 * suppressed. It used to be (`empty_content`), and that was the documented gap:
 * the customer waited for a human nobody had summoned. It now returns
 * `{action: "handoff"}` — the model is still not invoked, but the conversation
 * is opened, assigned and acknowledged. See `src/handoff.ts`.
 *
 * The ORDER matters and is unchanged: `status_not_pending` and `human_assigned`
 * are still evaluated first, so once a handoff has opened and assigned the
 * conversation, a second attachment on the same conversation is suppressed by
 * the existing predicate rather than handed off again. That is why there is no
 * second suppression mechanism for the AI after a handoff.
 */
export function evaluateSuppression(payload: WebhookPayload): SuppressionVerdict {
  if (payload.event !== REPLYABLE_EVENT) {
    return { action: "suppress", reason: "not_message_created" };
  }
  if (payload.conversationDisplayId === null) {
    return { action: "suppress", reason: "no_conversation_id" };
  }
  if (payload.messageType !== "incoming") {
    return { action: "suppress", reason: "message_type_not_incoming" };
  }
  if (payload.private === true) {
    return { action: "suppress", reason: "private_note" };
  }
  if (payload.private === null) {
    return { action: "suppress", reason: "private_flag_absent" };
  }
  if (payload.senderType === "agent_bot") {
    return { action: "suppress", reason: "sender_is_agent_bot" };
  }
  if (payload.conversationStatus !== "pending") {
    return { action: "suppress", reason: "status_not_pending" };
  }
  if (hasAssignee(payload.assignee)) {
    return { action: "suppress", reason: "human_assigned" };
  }
  if (!hasUsableText(payload)) {
    return { action: "handoff", classification: classifyNoText(payload) };
  }
  return { action: "reply" };
}
