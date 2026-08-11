/**
 * The ledger must never become a second copy of the conversation.
 *
 * The owner's constraint is explicit: identifiers, action type, payload digest,
 * run/correlation id, delivery state, Chatwoot message id, timestamps and safe
 * failure metadata — and NOT message bodies, AI answers, attachment filenames,
 * URLs, SIP credentials or any other customer content.
 *
 * A behavioural test can only prove that the paths it exercises stay clean.
 * This is a scan of the DDL itself, so a column added later fails the build.
 */
import { describe, expect, it } from "vitest";

import { LEDGER_SCHEMA_SQL } from "../src/ledger.js";

/** Every column the ledger is allowed to have, and why it is allowed. */
const PERMITTED_COLUMNS = new Set([
  // the atomic key
  "tenant_id",
  "binding_id",
  "chatwoot_account_id",
  "chatwoot_inbox_id",
  "event_id",
  "action_type",
  // integrity and correlation
  "payload_digest",
  "delivery_ref",
  "correlation_id",
  // state machine
  "delivery_state",
  "lease_owner",
  "lease_expires_at",
  "attempts",
  "failure_code",
  // identifiers needed to resume from Chatwoot, which owns the content
  "conversation_id",
  "message_id",
  "mode",
  "chatwoot_message_id",
  // timestamps
  "created_at",
  "updated_at",
  "completed_at",
]);

/** Pull the column names out of the CREATE TABLE body. */
function declaredColumns(sql: string): string[] {
  const body = /CREATE TABLE IF NOT EXISTS delivery_ledger \(([\s\S]*?)\n\);/.exec(sql);
  expect(body).not.toBeNull();
  return (body as RegExpExecArray)[1]!
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("CONSTRAINT"))
    .map((line) => line.split(/\s+/)[0] as string)
    .filter((name) => /^[a-z_]+$/.test(name));
}

describe("the ledger schema stores no customer content", () => {
  it("declares only permitted columns", () => {
    const columns = declaredColumns(LEDGER_SCHEMA_SQL);
    expect(columns.length).toBeGreaterThan(15);
    const unexpected = columns.filter((c) => !PERMITTED_COLUMNS.has(c));
    expect(unexpected).toEqual([]);
  });

  it("has no column whose name suggests content", () => {
    const forbidden =
      /\b(content|body|text|answer|message_body|payload|attachment|file_name|filename|url|uri|secret|token|credential|password|transcript|prompt)\b/;
    for (const column of declaredColumns(LEDGER_SCHEMA_SQL)) {
      // `payload_digest` is a hash, not a payload; allow it explicitly.
      if (column === "payload_digest") continue;
      expect(column).not.toMatch(forbidden);
    }
  });

  it("makes the owner's atomic key the primary key", () => {
    expect(LEDGER_SCHEMA_SQL).toMatch(
      /PRIMARY KEY\s*\(\s*tenant_id,\s*binding_id,\s*chatwoot_account_id,\s*chatwoot_inbox_id,\s*event_id,\s*action_type\s*\)/,
    );
  });

  it("is idempotent, so booting twice is safe", () => {
    const creates = LEDGER_SCHEMA_SQL.match(/CREATE (TABLE|INDEX)/g) ?? [];
    const guarded = LEDGER_SCHEMA_SQL.match(/IF NOT EXISTS/g) ?? [];
    expect(guarded.length).toBe(creates.length);
  });

  it("contains no destructive statement", () => {
    expect(LEDGER_SCHEMA_SQL).not.toMatch(/\b(DROP|TRUNCATE|DELETE|ALTER\s+TABLE\s+\w+\s+DROP)\b/i);
  });
});
