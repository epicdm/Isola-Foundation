/**
 * The checked-in migration and the DDL that actually runs must be the same SQL.
 *
 * This service has no migration runner: `OWNERSHIP_SCHEMA_SQL` in
 * `src/ownership-store.ts` is applied at boot and that is the whole mechanism.
 * The file under `migrations/` exists so the schema has something reviewable
 * with a diff — and a reviewable copy that has drifted from the executed
 * original is worse than none, because it invites a reviewer to approve a
 * schema nobody runs.
 *
 * So: the file must CONTAIN the constant verbatim. Nothing else is asserted
 * about the file, so its prose header is free to say more than the SQL does.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { OWNERSHIP_SCHEMA_SQL } from "../src/ownership-store.js";

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/0001_conversation_ownership.sql", import.meta.url)),
  "utf8",
);

describe("the migration file is the SQL that runs", () => {
  it("contains OWNERSHIP_SCHEMA_SQL verbatim", () => {
    expect(MIGRATION).toContain(OWNERSHIP_SCHEMA_SQL.trim());
  });

  it("the comparison is not vacuous", () => {
    expect(OWNERSHIP_SCHEMA_SQL.trim().length).toBeGreaterThan(1000);
    expect(MIGRATION).toContain("conversation_ownership_transition_claim_key");
    // A string that appears in the file but NOT in the constant, proving the
    // assertion above is comparing the SQL and not just matching the file
    // against itself.
    expect(MIGRATION).toContain("ROLLBACK");
    expect(OWNERSHIP_SCHEMA_SQL).not.toContain("ROLLBACK");
  });

  it("declares the exactly-once claim as a unique index, never as a droppable constraint", () => {
    expect(OWNERSHIP_SCHEMA_SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+conversation_ownership_transition_claim_key\s+ON conversation_ownership_transition \(tenant_id, conversation_key, operation_id\)/,
    );
    // No statement in the executed DDL may remove anything. This is the
    // property that makes it safe to run on every boot.
    const executable = OWNERSHIP_SCHEMA_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(/\bDROP\b/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    expect(executable).not.toMatch(/\bALTER TABLE\b/i);
  });

  it("carries no column that could hold customer content", () => {
    const forbidden =
      /\b(content|body|message_text|answer|answer_text|text_body|attachment|file_name|filename|url|token|secret|password|api_key|customer_name|phone)\b/i;
    const executable = OWNERSHIP_SCHEMA_SQL.split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(executable).not.toMatch(forbidden);
  });
});
