/**
 * CONVERSATION MEMORY, ACCUMULATED BY THE GATEWAY ITSELF.
 *
 * WHY NOT READ IT FROM CHATWOOT — measured, twice, 2026-08-17:
 *   · `conversations#show` returns ONE message, not the thread. The first
 *     attempt at memory shipped, looked green, and fed the model a single turn
 *     for a whole live conversation. `historyMessageCount: 1` on every call.
 *   · the documented thread endpoint,
 *     `GET /api/v1/accounts/{a}/conversations/{c}/messages`, answers 401 to an
 *     AgentBot token — both documented modes (`?before=`, no params), with
 *     `conversations#show` succeeding in the same run as a positive control.
 *     Chatwoot's own `BOT_ACCESSIBLE_ENDPOINTS` does not include the messages
 *     index.
 *
 * So the thread is not readable with the credential we hold, and the gateway
 * does not need it to be: IT ALREADY SEES EVERY TURN. Every customer message
 * arrives as a `message_created` webhook, and every reply is one this service
 * posted. Recording them is free; fetching them is impossible.
 *
 * WHAT IS RECORDED, and the safety property first:
 *   · PRIVATE NOTES ARE NEVER RECORDED. The handoff note names what a colleague
 *     should pick up; feeding it to the model puts internal context one
 *     paraphrase from the customer. Excluded on the way IN, so no reader can
 *     forget to exclude it. Fail-closed: anything not explicitly `private=false`
 *     is treated as private and dropped.
 *   · HUMAN AGENT REPLIES ARE RECORDED. The gateway suppresses them from
 *     triggering a reply, but it still SEES them, and a bot resuming after a
 *     handback must know what the human already told the customer. This is the
 *     half Chatwoot could never have given us cheaply.
 *   · Activity lines ("Conversation was marked open by system…") are Chatwoot
 *     talking to staff, not a turn.
 */

import type { QueryResult, SqlClient } from "./ledger.js";

/**
 * WHO ACTUALLY SPOKE.
 *
 * `role` collapses the AI and a human agent into `business`, deliberately — the
 * model should read the thread as one business voice. But that collapse cost a
 * wrong diagnosis on 2026-08-17: a `business` turn reading "We offer residential
 * and commercial internet…" was reported as proof the AI had replied, and it was
 * an EPIC staff member answering from his phone. The AI had answered nothing.
 *
 * `author` keeps the distinction the webhook already carries (`sender.type`), so
 * "did the AI reply?" is answerable from the ledger instead of inferred.
 * `unknown` is a real value, not a placeholder: an outgoing message with no
 * sender type is genuinely unattributable and must not be guessed into `ai`.
 */
export type TurnAuthor = "customer" | "ai" | "human" | "unknown";

/** Newest-last, as the model should read it. */
export interface Turn {
  role: "customer" | "business";
  content: string;
}

export interface TurnHistory {
  turns: Turn[];
  /** True when older turns were dropped to fit the window. */
  truncated: boolean;
}

/** The window, stated rather than discovered. Ruled 2026-08-16. */
export const TURN_MAX = 20;
export const TURN_MAX_CHARS = 8000;

/**
 * One row per turn, keyed so a retried webhook cannot double-record.
 *
 * `chatwoot_message_id` is the natural idempotency key: Chatwoot ids are unique
 * per account and monotonic within a conversation, and Chatwoot retries the same
 * delivery. Without the constraint a retry would duplicate a customer's line and
 * the model would read it twice.
 */
export const TURN_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_turn (
  tenant_id            text        NOT NULL,
  chatwoot_account_id  integer     NOT NULL,
  chatwoot_conversation_id integer NOT NULL,
  chatwoot_message_id  bigint      NOT NULL,
  role                 text        NOT NULL,
  author               text        NOT NULL DEFAULT 'unknown',
  content              text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_turn_pkey
    PRIMARY KEY (chatwoot_account_id, chatwoot_message_id),
  CONSTRAINT conversation_turn_role_known
    CHECK (role IN ('customer','business'))
);

-- Added after the table shipped, so it must be additive: rows written before
-- attribution existed keep 'unknown', which is the truthful value for them.
ALTER TABLE conversation_turn
  ADD COLUMN IF NOT EXISTS author text NOT NULL DEFAULT 'unknown';

CREATE INDEX IF NOT EXISTS conversation_turn_thread_idx
  ON conversation_turn (chatwoot_account_id, chatwoot_conversation_id, chatwoot_message_id);
`;

export async function migrateTurnStore(exec: SqlClient): Promise<void> {
  await exec.query(TURN_SCHEMA_SQL);
}

export interface RecordTurnInput {
  tenantId: string;
  accountId: number;
  conversationId: number;
  messageId: number;
  role: "customer" | "business";
  author: TurnAuthor;
  content: string;
}

/**
 * Record one turn. Idempotent by primary key: a retried delivery is a no-op
 * rather than a duplicate line in the model's context.
 *
 * Returns true when a row was inserted, false when it already existed — the
 * caller logs the distinction so a silent double-record could not hide.
 */
export async function recordTurn(
  exec: SqlClient,
  input: RecordTurnInput,
): Promise<boolean> {
  const text = input.content.trim();
  if (text.length === 0) return false;
  const res: QueryResult<Record<string, unknown>> = await exec.query(
    `INSERT INTO conversation_turn
       (tenant_id, chatwoot_account_id, chatwoot_conversation_id, chatwoot_message_id, role, author, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chatwoot_account_id, chatwoot_message_id) DO NOTHING`,
    [input.tenantId, input.accountId, input.conversationId, input.messageId, input.role, input.author, text],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * The thread for the model: oldest first, newest last, bounded.
 *
 * Reads the newest TURN_MAX rows and then reverses, so the window is the most
 * RECENT turns — a front desk needs what was just said, not the opening of a
 * conversation from last week. Over the character cap, the OLDEST kept turns are
 * dropped first for the same reason. No marker is injected into the text: a
 * marker is content, and content can be echoed to a customer.
 */
export async function readTurnHistory(
  exec: SqlClient,
  accountId: number,
  conversationId: number,
): Promise<TurnHistory> {
  const res: QueryResult<Record<string, unknown>> = await exec.query(
    `SELECT role, content
       FROM conversation_turn
      WHERE chatwoot_account_id = $1 AND chatwoot_conversation_id = $2
      ORDER BY chatwoot_message_id DESC
      LIMIT $3`,
    [accountId, conversationId, TURN_MAX + 1],
  );
  const rows = res.rows ?? [];
  let truncated = rows.length > TURN_MAX;
  const newestFirst = rows.slice(0, TURN_MAX);

  let turns: Turn[] = newestFirst
    .map((r: Record<string, unknown>) => ({
      role: String(r["role"]) === "customer" ? ("customer" as const) : ("business" as const),
      content: String(r["content"]),
    }))
    .reverse();

  let total = turns.reduce((n, t) => n + t.content.length, 0);
  while (total > TURN_MAX_CHARS && turns.length > 1) {
    total -= turns[0]!.content.length;
    turns = turns.slice(1);
    truncated = true;
  }
  return { turns, truncated };
}

/**
 * When the business last said something to this customer, in epoch ms.
 *
 * THIS IS THE IDLE CLOCK, and it exists because the obvious source is broken.
 * The sweeper used to read `last_activity_at` from Chatwoot's `conversations#show`,
 * which returns HTTP 500 for an AgentBot token once a team is assigned — and a
 * team is assigned BY ESCALATION, so the endpoint breaks at exactly the moment
 * the sweeper starts needing it. Measured 2026-08-17 on account 2: show → 500,
 * while `conversations/2/labels` → 200 with the same token, so the credential is
 * fine and the endpoint is not.
 *
 * Two properties this has and `last_activity_at` did not:
 *
 *  1. IT IS OURS. No third-party endpoint can strand a customer by failing.
 *  2. IT MEASURES THE RIGHT SIDE. `last_activity_at` moves on ANY message, so a
 *     customer sending "are you there?" pushed their own handback further away —
 *     the more they chased, the longer they were ignored. Idleness is a property
 *     of the party who owes a reply, so it is measured from the last BUSINESS
 *     turn.
 *
 * During a human-held episode the bot is suppressed, so a `business` turn in
 * that window is a human's. The one exception is the escalation line itself
 * ("I'll connect you with a colleague"), which is the correct place to start
 * the clock: it is the last thing the customer was told.
 */
export async function readLastBusinessTurnMs(
  exec: SqlClient,
  accountId: number,
  conversationId: number,
): Promise<number | null> {
  const res: QueryResult<Record<string, unknown>> = await exec.query(
    `SELECT max(created_at) AS last_business
       FROM conversation_turn
      WHERE chatwoot_account_id = $1
        AND chatwoot_conversation_id = $2
        AND role = 'business'`,
    [accountId, conversationId],
  );
  const raw = (res.rows ?? [])[0]?.["last_business"];
  if (raw === null || raw === undefined) return null;
  const ms = raw instanceof Date ? raw.getTime() : Date.parse(String(raw));
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Decide whether a webhook payload is a turn worth recording, and as whom.
 *
 * FAIL CLOSED ON `private`: only an explicit boolean false is public. A missing,
 * null or string flag is treated as a private note and dropped — the same rule
 * `webhook.ts` already applies, and the one the first history attempt got wrong.
 */
export function classifyTurn(payload: {
  event: string | null;
  messageType: string | null;
  private: boolean | null;
  content: string | null;
  messageId: number | null;
  senderType?: string | null;
  /** Chatwoot id of the sending bot, when the sender is a bot. */
  senderId?: number | null;
  /** OUR agent bot's id, from the binding. */
  ourAgentBotId?: number | null;
}): { role: "customer" | "business"; author: TurnAuthor; content: string } | null {
  if (payload.event !== "message_created") return null;
  if (payload.messageId === null) return null;
  if (payload.private !== false) return null;
  const text = (payload.content ?? "").trim();
  if (text.length === 0) return null;
  if (payload.messageType === "incoming") {
    return { role: "customer", author: "customer", content: text };
  }
  if (payload.messageType === "outgoing") {
    // `agent_bot` is us. Anything else that can post an outgoing public message
    // is a person. A missing sender type is UNKNOWN, never assumed to be the AI:
    // over-crediting the AI is exactly the error this field exists to prevent.
    // "agent_bot" alone is not proof it is OURS. An inbox can carry another
    // bot, and crediting its words to this agent is the same over-claim the
    // author column exists to prevent — so when both ids are known and differ,
    // the turn is attributed to that other bot, not to us.
    let author: TurnAuthor;
    if (payload.senderType === "agent_bot") {
      const known =
        typeof payload.senderId === "number" && typeof payload.ourAgentBotId === "number";
      author = known && payload.senderId !== payload.ourAgentBotId ? "human" : "ai";
    } else if (typeof payload.senderType === "string" && payload.senderType.length > 0) {
      author = "human";
    } else {
      author = "unknown";
    }
    return { role: "business", author, content: text };
  }
  // activity / template / anything else is not a turn
  return null;
}
