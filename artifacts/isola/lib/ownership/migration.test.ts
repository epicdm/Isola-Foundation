/**
 * Migration validation, asserted on the artefacts themselves.
 *
 * `prisma migrate dev` cannot run in CI here (the workspace guard refuses a
 * non-dev database and the test runner has no database at all), so the
 * properties the packet requires of the migration are asserted against the
 * SQL and the schema directly. That is weaker than executing it, and is
 * stated as such: it proves the migration SAYS the right thing. Executing it
 * is the deploy step, and `prisma migrate diff --exit-code` (run manually and
 * recorded in the commit report) proves the SQL and the schema agree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/** Walk up from the test runner's cwd until the package root is found, so this
 *  works regardless of where vitest is invoked from. */
function findPackageRoot(start: string): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'prisma', 'schema.prisma'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot locate prisma/schema.prisma upward from ${start}`);
}

const ROOT = findPackageRoot(process.cwd());
const MIGRATION = path.join(
  ROOT, 'prisma', 'migrations', '20260729210000_conversation_ownership_episode', 'migration.sql',
);
const SCHEMA = path.join(ROOT, 'prisma', 'schema.prisma');

const sql = fs.readFileSync(MIGRATION, 'utf8');
const schema = fs.readFileSync(SCHEMA, 'utf8');

/** SQL with every `--` comment line removed, so assertions about what the
 *  migration DOES are not satisfied by what its comments SAY. */
const statements = sql
  .split('\n')
  .filter((l) => !l.trimStart().startsWith('--'))
  .join('\n');

describe('migration — safety', () => {
  it('PRESERVES EXISTING CONVERSATIONS — no destructive statement anywhere', () => {
    expect(statements).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(statements).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bTRUNCATE\b/i);
    expect(statements).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(statements).not.toMatch(/\bALTER\s+COLUMN\b/i);
    expect(statements).not.toMatch(/\bRENAME\b/i);
  });

  it('keeps human_handling in place as a compatibility projection', () => {
    expect(statements).not.toMatch(/DROP\s+COLUMN\s+"human_handling"/i);
    expect(schema).toContain('human_handling           Boolean   @default(false)');
    expect(schema).toContain('COMPATIBILITY PROJECTION, NO LONGER AUTHORITATIVE');
  });

  it('adds every required ownership column with a safe default or nullability', () => {
    for (const col of [
      'ownership_state', 'ownership_episode', 'ownership_changed_at', 'ownership_reason',
      'ownership_actor_ref', 'ownership_correlation_id',
      'ownership_escalation_operation_id', 'ownership_handback_operation_id',
    ]) {
      expect(statements).toContain(`ADD COLUMN "${col}"`);
      expect(schema).toContain(col);
    }
    // The two NOT NULL columns must carry a default, or the ALTER fails on a
    // non-empty table.
    expect(statements).toMatch(/"ownership_state"\s+TEXT\s+NOT NULL DEFAULT 'AI_OWNED'/);
    expect(statements).toMatch(/"ownership_episode"\s+INTEGER\s+NOT NULL DEFAULT 0/);
  });

  it('documents a rollback', () => {
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toContain('DROP TABLE "ConversationOwnershipTransition";');
    expect(sql).toContain('DROP COLUMN "ownership_state"');
  });
});

describe('migration — back-fill', () => {
  it('MAPS human_handling = true SAFELY to a human-owned, non-zero episode', () => {
    const stmt = statements.match(/UPDATE "Conversation"[\s\S]*?WHERE "human_handling" = true;/);
    expect(stmt).not.toBeNull();
    const body = stmt![0];
    expect(body).toContain(`"ownership_state"      = 'HUMAN_OWNED'`);
    expect(body).toContain(`"ownership_episode"    = 1`);
    expect(body).toContain('migration_backfill:human_handling_true_active_hold');
  });

  it('never maps an active human hold to an AI state', () => {
    const aiUpdates = statements.match(/UPDATE "Conversation"[\s\S]*?;/g) ?? [];
    for (const u of aiUpdates) {
      if (u.includes(`'AI_OWNED'`)) {
        // The only AI mapping must be scoped to human_handling = false.
        expect(u).toContain('WHERE "human_handling" = false');
      }
    }
  });

  it('maps every other conversation to an EXPLICITLY JUSTIFIED state', () => {
    const stmt = statements.match(/UPDATE "Conversation"[\s\S]*?WHERE "human_handling" = false;/);
    expect(stmt).not.toBeNull();
    expect(stmt![0]).toContain(`"ownership_state"      = 'AI_OWNED'`);
    // The justification is recorded ON THE ROW, not only in a comment, so the
    // assumption is auditable in production.
    expect(stmt![0]).toContain('migration_backfill:ai_permitted_pre_ownership_model');
    // …and spelled out for a reader of the migration.
    expect(sql).toContain('JUSTIFICATION, stated explicitly rather than assumed');
  });

  it('back-fills no transition ledger rows — that history did not happen', () => {
    expect(statements).not.toMatch(/INSERT\s+INTO\s+"ConversationOwnershipTransition"/i);
  });
});

describe('migration — the exactly-once claim', () => {
  it('creates the ledger table', () => {
    expect(statements).toContain('CREATE TABLE "ConversationOwnershipTransition"');
    for (const col of [
      '"tenant_id"', '"conversation_id"', '"episode"', '"from_state"', '"to_state"',
      '"reason"', '"operation_id"', '"operation_kind"', '"actor_ref"', '"correlation_id"',
    ]) {
      expect(statements).toContain(col);
    }
  });

  it('creates the UNIQUE index that makes every operation exactly-once', () => {
    expect(statements).toMatch(
      /CREATE UNIQUE INDEX "ConversationOwnershipTransition_tenant_conv_op_key"[\s\S]*?"tenant_id", "conversation_id", "operation_id"/,
    );
  });

  it('uses the same constraint name in the schema, so the two cannot drift', () => {
    expect(schema).toContain('map: "ConversationOwnershipTransition_tenant_conv_op_key"');
  });

  it('every identifier it creates fits Postgres\'s 63-character limit', () => {
    const names = [...statements.matchAll(/(?:INDEX|CONSTRAINT|TABLE)\s+"([A-Za-z0-9_]+)"/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n.length).toBeLessThanOrEqual(63);
  });

  it('scopes the ledger to a tenant and a conversation with real foreign keys', () => {
    expect(statements).toMatch(/FOREIGN KEY \("tenant_id"\) REFERENCES "Tenant"\("id"\)/);
    expect(statements).toMatch(/FOREIGN KEY \("conversation_id"\) REFERENCES "Conversation"\("id"\)/);
  });
});

describe('schema — no unrelated duplicate state platform', () => {
  it('adds exactly one new model', () => {
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
    const ownershipModels = models.filter((m) => /ownership/i.test(m));
    expect(ownershipModels).toEqual(['ConversationOwnershipTransition']);
  });

  it('keeps the current state ON Conversation rather than in a side table', () => {
    const conversationBlock = schema.split('model Conversation {')[1].split('\nmodel ')[0];
    expect(conversationBlock).toContain('ownership_state');
    expect(conversationBlock).toContain('ownership_episode');
  });
});
