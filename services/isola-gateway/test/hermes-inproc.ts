/**
 * Socket-free helpers for the direct Hermes tests.
 *
 *  - `callHandler`: drives the gateway's HTTP handler with an in-memory request and response (no
 *    listener, no port), so a SIGNED webhook can travel the real route -> ledger -> pipeline path
 *    in a sandbox that cannot open sockets.
 *  - `FakeTurnSql`: a faithful in-memory MODEL of the two statements the transcript store runs
 *    (insert-on-conflict-do-nothing, and the newest-N read keyed by account + conversation). It is
 *    NOT proof of the SQL text; it proves that the code passes the keys the SQL filters on.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import type { Handler } from "../src/app.js";
import type { QueryResult, SqlClient } from "../src/ledger.js";
import type { SignedRequest } from "./harness.js";

export interface HandlerResult {
  status: number;
  json: Record<string, unknown>;
}

export async function callHandler(handler: Handler, signed: SignedRequest, path = "/v1/chatwoot/agent-bot"): Promise<HandlerResult> {
  const body = Buffer.from(signed.raw, "utf8");
  const headers: Record<string, string> = { ...signed.headers, "content-length": String(body.length) };
  const req = Object.assign(Readable.from([body]), { method: "POST", url: path, headers }) as unknown as IncomingMessage;
  return new Promise<HandlerResult>((resolve, reject) => {
    let status = 0;
    const sent = { headersSent: false };
    const res = {
      get headersSent(): boolean {
        return sent.headersSent;
      },
      writeHead(code: number): void {
        status = code;
        sent.headersSent = true;
      },
      setHeader(): void {
        /* not needed */
      },
      end(payload?: string): void {
        let json: Record<string, unknown> = {};
        try {
          json = JSON.parse(payload ?? "{}") as Record<string, unknown>;
        } catch {
          json = {};
        }
        resolve({ status, json });
      },
    } as unknown as ServerResponse;
    try {
      handler(req, res);
    } catch (err) {
      reject(err);
    }
  });
}

export class FakeTurnSql implements SqlClient {
  readonly rows: Array<Record<string, unknown>> = [];
  /** Test hook: the next N INSERTs throw (a transcript store that is down for a moment). */
  failNextInserts = 0;
  /** Every INSERT attempted, including the failed ones (so a test can prove the write was TRIED). */
  insertAttempts = 0;
  /** The SQL text of every INSERT attempted, so a test can pin the PRODUCTION statement (the model below is not proof of it). */
  readonly insertStatements: string[] = [];

  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
    if (/INSERT INTO conversation_turn/.test(sql)) {
      this.insertAttempts += 1;
      this.insertStatements.push(sql);
      if (this.failNextInserts > 0) {
        this.failNextInserts -= 1;
        throw new Error("FakeTurnSql: simulated transcript store outage");
      }
      const [tenant, account, conversation, message, role, author, content] = params as unknown as [string, number, number, number, string, string, string];
      const exists = this.rows.some((r) => r["account"] === account && r["message"] === message);
      if (!exists) this.rows.push({ tenant, account, conversation, message, role, author, content });
      return { rows: [] as unknown as T[], rowCount: exists ? 0 : 1 };
    }
    if (/FROM conversation_turn/.test(sql) && /ORDER BY chatwoot_message_id DESC/.test(sql)) {
      // CODEX DH8: the WHERE clause is EVALUATED from the production SQL text, not re-implemented
      // here. A statement whose scope was widened (`AND 1 = 1`), reordered into something this
      // cannot read, or stripped of the account or conversation predicate is REFUSED, so a test
      // that reads through it fails when the production scope is removed.
      const where = /\bWHERE\b([\s\S]*?)\bORDER BY\b/i.exec(sql)?.[1];
      if (where === undefined) throw new Error("FakeTurnSql: no readable WHERE clause (predicate)");
      const COLUMN: Record<string, string> = { chatwoot_account_id: "account", chatwoot_conversation_id: "conversation" };
      const wanted = new Map<string, unknown>();
      for (const conjunct of where.split(/\bAND\b/i)) {
        const m = /^\s*(chatwoot_account_id|chatwoot_conversation_id)\s*=\s*\$(\d+)\s*$/.exec(conjunct);
        if (m === null) throw new Error(`FakeTurnSql: unsupported predicate "${conjunct.trim()}"`);
        wanted.set(COLUMN[m[1]!]!, params[Number(m[2]) - 1]);
      }
      if (!wanted.has("account") || !wanted.has("conversation")) {
        throw new Error("FakeTurnSql: the account AND the conversation predicate are both required (predicate missing)");
      }
      const limitAt = /\bLIMIT\s+\$(\d+)/i.exec(sql);
      const limit = limitAt === null ? Number.POSITIVE_INFINITY : Number(params[Number(limitAt[1]) - 1]);
      const picked = this.rows
        .filter((r) => [...wanted].every(([column, value]) => r[column] === value))
        .sort((a, b) => (b["message"] as number) - (a["message"] as number))
        .slice(0, limit);
      return {
        rows: picked.map((r) => ({ role: r["role"], content: r["content"], chatwoot_message_id: r["message"] })) as unknown as T[],
        rowCount: picked.length,
      };
    }
    if (/max\(created_at\)/.test(sql)) return { rows: [{ last_business: null }] as unknown as T[], rowCount: 1 };
    throw new Error("FakeTurnSql: unexpected statement");
  }
}
