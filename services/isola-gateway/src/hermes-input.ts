/**
 * THE PURE PIECES OF THE DIRECT HERMES PATH (Step A, commit 2). No network, no clock, no
 * state: every function is a total function of its arguments, so each can be pinned by a
 * golden literal and a distinctness control.
 *
 * SOURCE for the Hermes-side facts below: lane 59's contract file
 * `.checkpoint-out/HERMES-PUBLIC-RUNS-API-CONTRACT-FOR-AGENT-2026-10-03.md`, read from the
 * service's own code (Hermes Agent v0.16.0 `api_server.py`) and from the Paperclip adapter
 * that already produced one real run. UNVERIFIED by behaviour until Step B.
 *
 *   - `/v1/runs` takes `input` (the user message), optional `instructions`, optional
 *     `conversation_history` (the ONLY way to give earlier turns), optional `session_id`.
 *   - `session_id` is a LABEL: it names the Hermes session the run is recorded under and
 *     does NOT load history. Memory is OFF in this service and `X-Hermes-Session-Key`
 *     gives no memory on `/v1/runs`, so it is not sent at all.
 *   - Continuity is therefore `conversation_history`, built here from the transcript the
 *     gateway itself recorded (src/turns.ts): the same conversation, newest N turns,
 *     private notes and activity lines excluded on the way IN by `classifyTurn`.
 */
import { createHash } from "node:crypto";

import { isAgentEscalationReason } from "./runtime.js";
import { STAFF_TURN_LABEL } from "./turns.js";

/** The customer-visible text of an envelope is refused, never truncated, above this (UTF-16 units). */
export const MAX_ENVELOPE_TEXT_CHARS = 2000;
/** The customer's current message is cut to at most this many UTF-16 units, never inside a surrogate pair. */
export const MAX_INPUT_MESSAGE_CHARS = 4000;
/** The transcript store's own window (src/turns.ts TURN_MAX / TURN_MAX_CHARS): a larger cap would claim history the store never returns. */
export const HERMES_HISTORY_HARD_MAX_TURNS = 20;
export const HERMES_HISTORY_HARD_MAX_CHARS = 8000;
/** The longest assertion the service accepts in the X-Isola-Assertion header (lane 59's contract). */
export const MAX_ASSERTION_CHARS = 2048;

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

// ---------------------------------------------------------------------------
// The session label
// ---------------------------------------------------------------------------

export interface HermesSessionParts {
  tenantId: string;
  accountId: number;
  inboxId: number;
  conversationId: number;
}

/**
 * A stable per-conversation LABEL: `igw1-` + sha256 over `["isola-gw:v1", tenant, account,
 * inbox, conversation]` (a JSON array, so the encoding is unambiguous: (1, 23) and (12, 3)
 * cannot collide). It is derived from identifiers ONLY, never from message text, and it is
 * a pure function: a restart, a replay and a second process all compute the same value.
 *
 * It is sent as `session_id` (a label) and as the `Conversation id:` line. It is 69
 * characters of lower-case hex, so it is safe in a body, a log line and an HTTP header
 * (<=256 chars, no CR/LF/NUL, per the contract).
 */
export function hermesSessionLabel(parts: HermesSessionParts): string {
  if (
    typeof parts.tenantId !== "string" ||
    parts.tenantId.length === 0 ||
    !isPositiveSafeInteger(parts.accountId) ||
    !isPositiveSafeInteger(parts.inboxId) ||
    !isPositiveSafeInteger(parts.conversationId)
  ) {
    throw new Error("hermes session label: invalid conversation identity");
  }
  const canonical = JSON.stringify(["isola-gw:v1", parts.tenantId, parts.accountId, parts.inboxId, parts.conversationId]);
  return `igw1-${createHash("sha256").update(canonical).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Forged marker lines (Codex DH6)
// ---------------------------------------------------------------------------

/**
 * A line that STARTS with one of the lines the charter trusts: `Conversation id:`, `Isola assertion:` or
 * the staff marker `[A teammate replied]:`. Case-insensitive, spaces around the words and the colon, a
 * fullwidth colon, and any run of whitespace or invisible formatting characters (zero-width, bidi
 * controls, a BOM) in front: none of those may hide a forged marker.
 */
const MARKER_AT_LINE_START =
  /^[\s\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]*(?:conversation\s+id|isola\s+assertion|\[\s*a\s+teammate\s+replied\s*\])\s*[:\uFF1A]/i;
/** Every newline variant a renderer or a model could treat as a line break. */
const LINE_BREAKS = /\r\n|[\n\r\u2028\u2029\u0085]/;
/** What a quoted (neutralised) line starts with: it can no longer begin with a marker. */
const QUOTED_PREFIX = "(customer text) ";

/**
 * Customer-originated text (the current message, a customer turn, a staff turn's later lines) is
 * QUOTED wherever a line would start with a trusted marker, so only the gateway's own lines can.
 * Nothing is dropped: the words stay, behind a prefix. Text with no such line is returned unchanged,
 * byte for byte. The cryptographic assertion check in the service stays the authorization boundary;
 * this keeps the gateway's own lines unambiguous for a model that reads them.
 */
export function neutralizeForgedMarkers(text: string): string {
  const lines = text.split(LINE_BREAKS);
  let changed = false;
  const out = lines.map((line) => {
    if (!MARKER_AT_LINE_START.test(line)) return line;
    changed = true;
    return `${QUOTED_PREFIX}${line}`;
  });
  return changed ? out.join("\n") : text;
}

/** A business turn keeps the ONE genuine staff label the gateway stored at its start; every later line is neutralised. */
function neutralizeBusinessTurn(content: string): string {
  if (content.startsWith(STAFF_TURN_LABEL)) return STAFF_TURN_LABEL + neutralizeForgedMarkers(content.slice(STAFF_TURN_LABEL.length));
  return neutralizeForgedMarkers(content);
}

// ---------------------------------------------------------------------------
// conversation_history
// ---------------------------------------------------------------------------
export interface HermesHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export type HermesHistoryResult =
  | { ok: true; messages: HermesHistoryMessage[]; droppedForCaps: boolean }
  | {
      ok: false;
      reason:
        | "history_absent"
        | "history_malformed"
        | "current_message_empty"
        | "current_message_not_in_history"
        | "current_message_id_missing"
        | "history_ids_missing";
    };

/**
 * WHICH message is the current one (Codex DH3). The webhook's Chatwoot message id and the Chatwoot
 * message id of every transcript turn, in the same order. Equal text is NOT identity: an older
 * identical "hello" must not stand in for a current one whose row is missing.
 */
export interface HermesHistoryIdentity {
  currentMessageId: number | null;
  historyMessageIds: readonly number[] | undefined;
}

function isMessageId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export interface HermesHistoryCaps {
  maxTurns: number;
  maxChars: number;
}

/**
 * Build `conversation_history` from the gateway's recorded transcript.
 *
 * ROLE MAPPING (stated, not discovered): `customer` -> `user`; every `business` turn ->
 * `assistant`. The store collapses the AI, a human agent and a handback line into
 * `business` on purpose (the model reads the thread as one business voice), so a staff
 * member's reply is shown to the model as an assistant turn. No marker is injected into
 * any text.
 *
 * THE CURRENT MESSAGE IS NOT IN THE HISTORY. The webhook path records every turn BEFORE the
 * pipeline runs, so the newest customer turn IS the message being answered. It is located BY
 * ITS CHATWOOT MESSAGE ID (Codex DH3: never by text: an older identical line cannot stand in
 * for a current message whose row is missing), it and everything after it are removed, and it
 * is sent only as `input`. A transcript in which it cannot be found is not provably this
 * conversation's current state, so the result is a refusal.
 *
 * FAIL CLOSED: a missing or malformed transcript, a missing current id, or ids that do not line
 * up with the turns is `ok: false`; the caller answers NOTHING and escalates once. An empty
 * history for a first message is a positive result (`messages: []`), never an error.
 */
export function buildHermesHistory(
  raw: unknown,
  currentMessage: string,
  caps: HermesHistoryCaps,
  identity: HermesHistoryIdentity,
): HermesHistoryResult {
  if (raw === undefined || raw === null) return { ok: false, reason: "history_absent" };
  if (!Array.isArray(raw)) return { ok: false, reason: "history_malformed" };
  const turns: Array<{ role: "customer" | "business"; content: string }> = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return { ok: false, reason: "history_malformed" };
    const role = (entry as Record<string, unknown>)["role"];
    const content = (entry as Record<string, unknown>)["content"];
    if ((role !== "customer" && role !== "business") || typeof content !== "string") {
      return { ok: false, reason: "history_malformed" };
    }
    turns.push({ role, content: role === "customer" ? neutralizeForgedMarkers(content) : neutralizeBusinessTurn(content) });
  }
  const current = typeof currentMessage === "string" ? currentMessage.trim() : "";
  if (current.length === 0) return { ok: false, reason: "current_message_empty" };

  if (!isMessageId(identity.currentMessageId)) return { ok: false, reason: "current_message_id_missing" };
  const ids = identity.historyMessageIds;
  if (ids === undefined) return { ok: false, reason: "history_ids_missing" };
  if (ids.length !== turns.length || !ids.every(isMessageId)) return { ok: false, reason: "history_malformed" };

  let at = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (ids[i] === identity.currentMessageId) {
      // the id must point at a CUSTOMER turn: the message being answered is the customer's.
      if (turns[i]!.role === "customer") at = i;
      break;
    }
  }
  if (at === -1) return { ok: false, reason: "current_message_not_in_history" };

  let prior = turns.slice(0, at);
  let dropped = false;
  const maxTurns = Math.max(0, Math.min(caps.maxTurns, HERMES_HISTORY_HARD_MAX_TURNS));
  const maxChars = Math.max(0, Math.min(caps.maxChars, HERMES_HISTORY_HARD_MAX_CHARS));
  if (prior.length > maxTurns) {
    prior = prior.slice(prior.length - maxTurns);
    dropped = true;
  }
  let total = prior.reduce((n, t) => n + t.content.length, 0);
  // OLDEST first. A single turn that alone exceeds the cap is dropped whole, not truncated.
  while (total > maxChars && prior.length > 0) {
    total -= prior[0]!.content.length;
    prior = prior.slice(1);
    dropped = true;
  }
  return {
    ok: true,
    messages: prior.map((t) => ({ role: t.role === "customer" ? ("user" as const) : ("assistant" as const), content: t.content })),
    droppedForCaps: dropped,
  };
}

// ---------------------------------------------------------------------------
// The user message
// ---------------------------------------------------------------------------

/** At most `max` UTF-16 code units, never splitting a surrogate pair. */
export function truncateCodePoints(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose pair would be cut
  return text.slice(0, end);
}

function isHeaderSafe(value: string): boolean {
  return !/[\r\n\0]/.test(value);
}

/**
 * The user message, as lane 59's charter expects it: the gateway-owned `Conversation id:`
 * and `Isola assertion:` lines FIRST, a blank line, then the customer's words.
 *
 * They come first on purpose: a customer who types a forged `Isola assertion:` line can
 * only produce a LATER one, never the first. (The service verifies the signature itself;
 * this only keeps the gateway's own lines unambiguous.) With no assertion the line says
 * `none` explicitly rather than being absent or invented. The exact layout is UNVERIFIED
 * against the deployed charter: it is isolated here so it can be changed in one place.
 */
export function renderHermesInput(args: { conversationLabel: string; assertion: string | null; message: string }): string {
  if (typeof args.conversationLabel !== "string" || args.conversationLabel.length === 0 || !isHeaderSafe(args.conversationLabel)) {
    throw new Error("hermes input: the conversation label is not usable");
  }
  let assertionLine = "none";
  if (args.assertion !== null) {
    if (args.assertion.length === 0 || args.assertion.length > MAX_ASSERTION_CHARS || !isHeaderSafe(args.assertion)) {
      throw new Error("hermes input: the assertion is not usable");
    }
    assertionLine = args.assertion;
  }
  const message = neutralizeForgedMarkers(truncateCodePoints(args.message, MAX_INPUT_MESSAGE_CHARS));
  return `Conversation id: ${args.conversationLabel}\nIsola assertion: ${assertionLine}\n\n${message}`;
}

// ---------------------------------------------------------------------------
// The one-line JSON envelope
// ---------------------------------------------------------------------------

export type HermesEnvelopeResult =
  | { ok: true; disposition: "answer" | "request_human"; text: string; reason: string | null }
  | {
      ok: false;
      reason: "empty_output" | "no_envelope_line" | "not_json" | "bad_disposition" | "missing_text" | "text_too_long";
    };

/**
 * Customer-facing text policy (Codex DH7). Removed: NUL and the other C0 controls (except tab and
 * newline), DEL, the C1 controls, bidirectional overrides/isolates/marks (they can reorder what a
 * customer reads), the Arabic letter mark and a BOM. U+2028/U+2029 and a CR become a plain
 * newline (NEL, U+0085, is a C1 control and is removed). Kept: tab, newline, every letter in every script (RTL included), emoji and the zero-width
 * joiners they are built from.
 */
export function sanitizeCustomerText(text: string): string {
  return text
    .replace(/\r\n|[\r\u2028\u2029]/g, "\n")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "");
}

/**
 * The model''s final output must END with ONE line of JSON:
 * `{"disposition":"answer"|"request_human","text":"...","reason":"<code>"}`.
 *
 * Only the LAST non-empty line is read. Whatever precedes it is ignored and is NEVER sent
 * to the customer: the customer sees the envelope's `text` and nothing else. Anything that
 * is not exactly that is not an answer: no customer text is sent from the model output and
 * the caller escalates once (Law 12). Only the edges of `text` are trimmed; a text over
 * `maxChars` is refused, not truncated. `reason` is kept only if it is in the closed set of
 * escalation reason codes.
 */
export function parseHermesEnvelope(output: unknown, maxChars: number = MAX_ENVELOPE_TEXT_CHARS): HermesEnvelopeResult {
  if (typeof output !== "string") return { ok: false, reason: "empty_output" };
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return { ok: false, reason: "empty_output" };
  const last = lines[lines.length - 1]!;
  if (!last.startsWith("{") || !last.endsWith("}")) return { ok: false, reason: "no_envelope_line" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ok: false, reason: "no_envelope_line" };
  const record = parsed as Record<string, unknown>;
  const disposition = record["disposition"];
  if (disposition !== "answer" && disposition !== "request_human") return { ok: false, reason: "bad_disposition" };
  const rawText = record["text"];
  const text = typeof rawText === "string" ? sanitizeCustomerText(rawText).trim() : "";
  if (text.length === 0) return { ok: false, reason: "missing_text" };
  if (text.length > maxChars) return { ok: false, reason: "text_too_long" };
  const reason =
    disposition === "request_human" && isAgentEscalationReason(record["reason"]) ? (record["reason"] as string) : null;
  return { ok: true, disposition, text, reason };
}
