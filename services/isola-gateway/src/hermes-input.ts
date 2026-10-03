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
      reason: "history_absent" | "history_malformed" | "current_message_empty" | "current_message_not_in_history";
    };

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
 * pipeline runs, so the newest customer turn IS the message being answered. It is located
 * (the LAST customer turn whose text equals the current message), it and everything after
 * it are removed, and it is sent only as `input`. A transcript in which it cannot be found
 * is not provably this conversation's current state, so the result is a refusal.
 *
 * FAIL CLOSED: a missing or malformed transcript is `ok: false`; the caller answers
 * NOTHING and escalates once. An empty history for a first message is a positive result
 * (`messages: []`), never an error.
 */
export function buildHermesHistory(raw: unknown, currentMessage: string, caps: HermesHistoryCaps): HermesHistoryResult {
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
    turns.push({ role, content });
  }
  const current = typeof currentMessage === "string" ? currentMessage.trim() : "";
  if (current.length === 0) return { ok: false, reason: "current_message_empty" };

  let at = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const t = turns[i]!;
    if (t.role === "customer" && t.content.trim() === current) {
      at = i;
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
  const message = truncateCodePoints(args.message, MAX_INPUT_MESSAGE_CHARS);
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
 * The model's final output must END with ONE line of JSON:
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
  const text = typeof rawText === "string" ? rawText.trim() : "";
  if (text.length === 0) return { ok: false, reason: "missing_text" };
  if (text.length > maxChars) return { ok: false, reason: "text_too_long" };
  const reason =
    disposition === "request_human" && isAgentEscalationReason(record["reason"]) ? (record["reason"] as string) : null;
  return { ok: true, disposition, text, reason };
}
