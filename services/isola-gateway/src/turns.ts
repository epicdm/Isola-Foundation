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
  content              text        NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_turn_pkey
    PRIMARY KEY (chatwoot_account_id, chatwoot_message_id),
  CONSTRAINT conversation_turn_role_known
    CHECK (role IN ('customer','business'))
);

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
       (tenant_id, chatwoot_account_id, chatwoot_conversation_id, chatwoot_message_id, role, content)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (chatwoot_account_id, chatwoot_message_id) DO NOTHING`,
    [input.tenantId, input.accountId, input.conversationId, input.messageId, input.role, text],
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
}): { role: "customer" | "business"; content: string } | null {
  if (payload.event !== "message_created") return null;
  if (payload.messageId === null) return null;
  if (payload.private !== false) return null;
  const text = (payload.content ?? "").trim();
  if (text.length === 0) return null;
  if (payload.messageType === "incoming") return { role: "customer", content: text };
  if (payload.messageType === "outgoing") return { role: "business", content: text };
  // activity / template / anything else is not a turn
  return null;
}
