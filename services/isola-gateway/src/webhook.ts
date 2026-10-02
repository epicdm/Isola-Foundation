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
  /**
   * E.164-ish, as Chatwoot supplies it. Used ONLY by the INTERNAL allowlist.
   * This is read off the Contact RECORD at delivery time, which an agent can edit:
   * it is NEVER the customer-scope subject (see `channelSubject`).
   */
  senderPhone: string | null;
  /**
   * The identifier the CHANNEL bound this conversation to: `conversation.contact_inbox
   * .source_id` (WhatsApp: the wa_id). Chatwoot does not rewrite it when a contact's
   * phone is edited, so it is the subject the customer scope is keyed on. `null` when
   * the node is absent: the scope then fails closed. That the installed Chatwoot sends
   * `contact_inbox` on `message_created` is UNVERIFIED (docs/payload shape only).
   */
  channelSubject: string | null;
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
 * The channel-bound subject: `conversation.contact_inbox.source_id`, only when it is a
 * non-empty string. A message payload nests it under `conversation`; a conversation-
 * shaped payload carries no message and is never scoped, so it reads `null`.
 */
function readChannelSubject(conversation: Record<string, unknown> | null): string | null {
  if (conversation === null) return null;
  const contactInbox = child(conversation, "contact_inbox");
  if (contactInbox === null) return null;
  const sourceId = readString(contactInbox["source_id"]);
  return sourceId !== null && sourceId.trim().length > 0 ? sourceId : null;
}

// ---------------------------------------------------------------------------
// TWO PAYLOAD SHAPES, ONE PARSER
// ---------------------------------------------------------------------------
//
// Chatwoot does not send one envelope. It sends the webhook_data of whichever
// MODEL the event is about, and those models nest differently. Read from the
// running 4.x source rather than inferred:
//
//   Message#webhook_data           -> { account: {...}, inbox: {...},
//                                       conversation: { id, status, meta, ... },
//                                       id: <MESSAGE pk>, ... }
//
//   Conversations::EventDataPresenter#webhook_data
//     (what `conversation_status_changed` sends, via
//      `conversation.webhook_data.merge(event:, changed_attributes:)`)
//                                  -> { account: {...},
//                                       id: <CONVERSATION display_id>,
//                                       inbox_id: <FLAT>, status: <FLAT>,
//                                       meta: { assignee, ... }, ... }
//
// The conversation shape has NO `inbox` node and NO `conversation` node. The
// parser used to read `inbox.id` only, so every conversation event resolved to
// `inboxId: null`, which `decideDelivery` refuses as `unparseable_body` BEFORE
// a secret is ever selected. That is the measured 422 `unroutable_event` in
// `docs/isola/REPRO-EXPLICIT-HANDBACK-UNREACHABLE-2026-08-24.md`, and it is why
// the explicit-handback signal never arrived.
//
// THE TRAP, stated because getting it wrong is worse than not fixing it at all:
// only compare the two forms where they MEAN THE SAME THING.
//
//     inbox_id  <-> inbox.id            same thing -> disagreement is ambiguous
//     account_id <-> account.id         same thing -> disagreement is ambiguous
//     status    <-> conversation.status same thing -> disagreement is ambiguous
//     id        <-> conversation.id     DIFFERENT THINGS
//
// Top-level `id` is the MESSAGE pk in a message event and the CONVERSATION
// display_id in a conversation event. They legitimately differ on every single
// message payload Chatwoot has ever sent. Comparing them and calling the
// difference "ambiguous" would refuse all normal traffic — a fix that breaks
// the working path to repair the broken one.

interface DualFormInt {
  value: number | null;
  /** Both forms were present and disagreed. The caller must refuse. */
  ambiguous: boolean;
}

/**
 * Read an identifier Chatwoot sends flat in one payload shape and nested in
 * another, refusing rather than guessing when the two disagree.
 *
 * Absent-in-both is `null`, not ambiguous: a missing identifier is the
 * caller's existing "cannot route" case and is already handled.
 */
function readDualFormInt(
  root: Record<string, unknown>,
  flatKey: string,
  nestedParent: string,
  nestedKey = "id",
): DualFormInt {
  const flat = readInt(root[flatKey]);
  const parent = child(root, nestedParent);
  const nested = parent === null ? null : readInt(parent[nestedKey]);
  if (flat !== null && nested !== null && flat !== nested) {
    return { value: null, ambiguous: true };
  }
  return { value: flat ?? nested, ambiguous: false };
}

/**
 * True when this body is a CONVERSATION-shaped payload rather than a
 * message-shaped one.
 *
 * The discriminator is the absence of a `conversation` node together with a
 * string `status` at the top level. Every message payload carries a
 * `conversation` node, so this cannot misfire on one — which matters, because
 * the single thing it controls is whether top-level `id` is read as a
 * conversation id or as a message id. Get that backwards and the gateway
 * records a conversation id as a message id, or vice versa.
 */
function isConversationShaped(root: Record<string, unknown>): boolean {
  return child(root, "conversation") === null && typeof root["status"] === "string";
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

export interface Routing {
  accountId: number | null;
  inboxId: number | null;
  /**
   * A routing identifier was present in BOTH forms and the two disagreed.
   *
   * This is a refusal, not a fallback, and it is deliberately decided here —
   * before a secret is chosen. Picking either value would mean verifying the
   * signature against one tenant's key while the body claims another's, which
   * is the one mistake this whole function exists to avoid.
   */
  ambiguous: boolean;
}

/**
 * Extract only the routing identifiers, without validating anything else.
 *
 * This runs on an UNVERIFIED body, purely to select which AgentBot secret to
 * check the signature against. Nothing here is trusted for any other purpose.
 *
 * Accepts both payload shapes — see the note above `readDualFormInt`. Reading
 * `inbox.id` alone is what made every `conversation_status_changed` delivery
 * unroutable.
 */
export function parseRouting(raw: Buffer): Routing {
  const none: Routing = { accountId: null, inboxId: null, ambiguous: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return none;
  }
  if (!isRecord(parsed)) return none;

  const account = readDualFormInt(parsed, "account_id", "account");
  const inbox = readDualFormInt(parsed, "inbox_id", "inbox");
  if (account.ambiguous || inbox.ambiguous) {
    return { accountId: null, inboxId: null, ambiguous: true };
  }
  return { accountId: account.value, inboxId: inbox.value, ambiguous: false };
}

/**
 * Full parse of a verified body.
 *
 * Returns null when the body is not a JSON object, AND when a dual-form
 * identifier is ambiguous — both are refusals, and `decideDelivery` maps null
 * to `bad_request`. Refusing an ambiguous body is the point: a payload that
 * claims two different inboxes has no single correct interpretation, and
 * picking one would route a customer's conversation by a guess.
 */
export function parseWebhookPayload(raw: Buffer): WebhookPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;

  const account = readDualFormInt(parsed, "account_id", "account");
  const inbox = readDualFormInt(parsed, "inbox_id", "inbox");
  if (account.ambiguous || inbox.ambiguous) return null;

  const conversation = child(parsed, "conversation");
  const conversationShaped = isConversationShaped(parsed);

  // `meta`, `custom_attributes` and `status` hang off the conversation node in
  // a message payload and off the ROOT in a conversation payload. Same fields,
  // same meaning, two homes.
  const metaHost = conversation ?? (conversationShaped ? parsed : null);
  const meta = metaHost === null ? null : child(metaHost, "meta");
  const attributes = metaHost === null ? null : child(metaHost, "custom_attributes");

  // Status: genuinely the same field in both shapes, so a disagreement is
  // ambiguous and refused.
  const nestedStatus = conversation === null ? null : readString(conversation["status"]);
  const flatStatus = readString(parsed["status"]);
  if (nestedStatus !== null && flatStatus !== null && nestedStatus !== flatStatus) {
    return null;
  }

  // Top-level `id`: the MESSAGE pk in a message payload, the CONVERSATION
  // display_id in a conversation payload. Never compared across shapes — see
  // the trap note above `readDualFormInt`.
  const rootId = readInt(parsed["id"]);

  const sender = child(parsed, "sender");
  const privateRaw = parsed["private"];

  return {
    event: readString(parsed["event"]),
    // A conversation event carries no message, so it must not report one.
    // Reading `id` here unconditionally would file a conversation display_id
    // as a message id and corrupt idempotency keyed on it.
    messageId: conversationShaped ? null : rootId,
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
    channelSubject: readChannelSubject(conversation),
    accountId: account.value,
    inboxId: inbox.value,
    conversationDisplayId:
      conversation !== null ? readInt(conversation["id"]) : (conversationShaped ? rootId : null),
    conversationStatus: nestedStatus ?? (conversationShaped ? flatStatus : null),
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

/**
 * Chatwoot's own status-change event.
 *
 * A SEPARATE AXIS from message delivery. `evaluateSuppression` below decides
 * whether the MODEL may answer a `message_created` delivery; this constant
 * marks the event that carries the opposite signal — a human explicitly
 * returning the conversation, which the model must never see as a prompt.
 */
export const STATUS_CHANGED_EVENT = "conversation_status_changed";

/**
 * True when this delivery is Chatwoot's own report that a human just pressed
 * "Mark as pending" — the exact gesture `evaluateSuppression`'s
 * `status_not_pending` guard already keys on, delivered as an EVENT instead of
 * needing a re-fetch through `conversations#show`.
 *
 * THAT RE-FETCH IS WHY THIS FUNCTION EXISTS. `conversations#show` returns 500
 * for an AgentBot token once a team has been assigned — and escalation is what
 * assigns the team, so the read the sweeper depended on breaks precisely when
 * a real escalation needs it (see `def-explicit-handback-unreachable-after-
 * team-assignment-2026-08-24`, and `handback.ts`'s own sweeper comment, which
 * already treats that fetch's failure as non-fatal rather than trusting it).
 * The webhook already tells us the status directly and it is signature-
 * verified by the same HMAC check every delivery goes through — so nothing
 * downstream needs a re-fetch to trust it.
 *
 * Deliberately narrow: only `pending` matters here. Every other status change
 * (open, resolved, snoozed) is not the handback gesture and is left alone —
 * `evaluateSuppression`'s ordinary predicate already governs what happens on
 * the next real message.
 */
export function isManualHandbackSignal(payload: WebhookPayload): boolean {
  return payload.event === STATUS_CHANGED_EVENT && payload.conversationStatus === "pending";
}

/**
 * True when a HUMAN AGENT has written into the conversation from the Chatwoot
 * dashboard — the takeover signal the ownership ledger never received.
 *
 * WHY THIS EXISTS. `confirmHumanOwnership` and `recordHumanReply` were written,
 * reviewed and correct, and had ZERO call sites in the deployed build
 * (`def-gateway-ownership-ledger-human-side-transitions-unwired-2026-08-24`).
 * Escalation could move a conversation to HUMAN_REQUESTED and nothing could
 * ever advance it to HUMAN_OWNED, because the one event that proves a person
 * actually took the conversation — that person writing in it — was being
 * dropped by `evaluateSuppression` as `message_type_not_incoming` and never
 * looked at again. Same failure shape as the handback edge: the transition
 * existed, the caller did not.
 *
 * WHO COUNTS. Chatwoot's `sender.type` is `contact` for the customer, `user`
 * for a human dashboard agent, and `agent_bot` for us. Only `user` is a person
 * taking over. `agent_bot` is this gateway's own reply coming back around and
 * must never be read as a human takeover — that would silence the AI in
 * response to its own message.
 *
 * PRIVATE NOTES COUNT, DELIBERATELY. A private note is not customer-visible, so
 * it is tempting to ignore it. But a human writing an internal note is a human
 * working the conversation, and the cost of the two mistakes is asymmetric:
 * treating it as takeover silences the AI while a person is present (safe, and
 * reversible by explicit handback), whereas ignoring it lets the AI talk over
 * somebody who is mid-investigation (the exact failure this ledger exists to
 * prevent). Fail closed — CLAUDE.md §2.12.
 */
export function isHumanAgentReply(payload: WebhookPayload): boolean {
  return (
    payload.event === REPLYABLE_EVENT &&
    payload.messageType === "outgoing" &&
    payload.senderType === "user" &&
    payload.conversationDisplayId !== null &&
    payload.messageId !== null
  );
}

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
