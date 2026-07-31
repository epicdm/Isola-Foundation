-- READ-ONLY preflight for migration
--   20260725210000_chatwoot_binding_account_inbox_mode_unique
--
-- Run this against the target database BEFORE `prisma migrate deploy`, with
-- psql (the `\echo` lines are psql meta-commands; drop them if you paste the
-- queries into another client).
-- It contains SELECTs only — no INSERT, UPDATE, DELETE, DDL or transaction
-- control.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ THIS PREFLIGHT IS MANDATORY, NOT ADVISORY.                               │
-- │                                                                          │
-- │ The migration was repaired (once, under a narrowly-scoped owner          │
-- │ exception) so that it is replayable in environments that do not hold     │
-- │ production's identity. As a direct consequence, its in-migration         │
-- │ production-identity assertion now runs ONLY where the reviewed           │
-- │ registration is present — and the migration will never re-run in         │
-- │ production at all, because production already has it applied.            │
-- │                                                                          │
-- │ THIS FILE IS THEREFORE THE ONLY THING THAT RE-PROVES PRODUCTION          │
-- │ IDENTITY. Do not skip it, and do not treat a clean `migrate status` as   │
-- │ a substitute: status proves the ledger, not the rows.                    │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- This file is NOT part of the Prisma migration folder and is never applied by
-- `migrate deploy`; it lives here as the reviewed operator procedure.
--
-- ── ACCEPTANCE ──────────────────────────────────────────────────────────────
-- PRODUCTION (post-migration, the current expected state):
--   Q1 → exactly 1 row: the KEEP id, active tenant, active agent
--   Q2 → keep_ok = true
--   Q3 → orphan_present = false          (the reviewed orphan is gone)
--   Q4 → 0 rows                          (no unreviewed duplicate group)
--   Q5 → exactly 1 row, and every one of is_unique / is_valid / is_ready /
--        is_non_partial / columns_exact / on_chatwootbinding = true
--   Q8 → shape = 'production-post-migration'
--
-- DEVELOPMENT / FRESH (pre-migration, environment-neutral or foreign-or-seeded):
--   Q1 → 0 rows on a genuinely fresh database; 1 row where the application's
--        instrumentation seeder has minted a binding on the reviewed door.
--        More than 1 row is a STOP condition.
--   Q2 → keep_ok = false
--   Q3 → orphan_present = false
--   Q4 → 0 rows
--   Q5 → 0 rows (index not yet present) — Q5 must NEVER return a row whose
--        shape flags are anything other than all-true; a same-named index with
--        a different definition is a STOP condition
--   Q8 → shape = 'environment-neutral' on a fresh database, or
--        'foreign-or-seeded' where the seeder has populated the door. Both are
--        safe: the migration deletes nothing in either and enforces structure
--        only. Anything else is a STOP condition.
--
-- STOP AND ESCALATE if Q8 reports 'PARTIAL-IDENTITY — REFUSE' or
-- 'UNRECOGNISED — REFUSE'. Partial presence of production's identity set is
-- treated as suspicious, never as "close enough".

\echo '=== Q1: every registration on the reviewed door (account 5 / inbox 3 / a2) ==='
SELECT b.id,
       b.tenant_id,
       t.status  AS tenant_status,
       b.agent_id,
       a.is_active AS agent_is_active,
       b.account_id,
       b.inbox_id,
       b.mode,
       b.created_at,
       b.updated_at
  FROM "ChatwootBinding" b
  LEFT JOIN "Tenant" t ON t.id = b.tenant_id
  LEFT JOIN "Agent"  a ON a.id = b.agent_id
 WHERE b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
 ORDER BY b.created_at;

\echo '=== Q2: is the reviewed KEEP registration intact, in full? ==='
SELECT EXISTS (
  SELECT 1
    FROM "ChatwootBinding" b
    JOIN "Tenant" t ON t.id = b.tenant_id
    JOIN "Agent"  a ON a.id = b.agent_id
   WHERE b.id         = 'cmrj1d06c000ds617dx9f59od'
     AND b.tenant_id  = '43b006e4-33e0-42a8-bec7-4422ba290d79'
     AND b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
     AND t.status     = 'active'
     AND a.id         = 'cmrhp53b30007s61711vk4dbt'
     AND a.tenant_id  = '43b006e4-33e0-42a8-bec7-4422ba290d79'
     AND a.is_active
) AS keep_ok;

\echo '=== Q3: does the reviewed orphan still exist? (post-migration this MUST be false) ==='
SELECT EXISTS (
  SELECT 1 FROM "ChatwootBinding" WHERE id = 'cmrsbmzvm0001s62skjms8nfc'
) AS orphan_present;

\echo '=== Q4: any duplicate (account_id, inbox_id, mode) group ANYWHERE — 0 rows required ==='
SELECT account_id, inbox_id, mode, count(*) AS n
  FROM "ChatwootBinding"
 WHERE inbox_id IS NOT NULL
 GROUP BY account_id, inbox_id, mode
HAVING count(*) > 1
 ORDER BY n DESC;

\echo '=== Q5: the unique index, by EXACT SHAPE — name alone is not sufficient ==='
SELECT i.relname                       AS index_name,
       n.nspname                       AS schema,
       t.relname                       AS table_name,
       ix.indisunique                  AS is_unique,
       ix.indisvalid                   AS is_valid,
       ix.indisready                   AS is_ready,
       (ix.indpred IS NULL)            AS is_non_partial,
       (t.relname = 'ChatwootBinding') AS on_chatwootbinding,
       (pg_get_indexdef(i.oid) = format(
          'CREATE UNIQUE INDEX %I ON %I.%I USING btree (account_id, inbox_id, mode)',
          i.relname, n.nspname, 'ChatwootBinding'))
                                       AS columns_exact,
       pg_get_indexdef(i.oid)          AS actual_definition
  FROM pg_index ix
  JOIN pg_class     i ON i.oid = ix.indexrelid
  JOIN pg_class     t ON t.oid = ix.indrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
 WHERE i.relname = 'ChatwootBinding_account_id_inbox_id_mode_key';

\echo '=== Q6: conversations that reference the reviewed orphan (ON DELETE SET NULL) ==='
SELECT count(*) AS conversations_referencing_orphan
  FROM "Conversation" WHERE chatwoot_binding_id = 'cmrsbmzvm0001s62skjms8nfc';

\echo '=== Q7: EscalationRef snapshots that reference the reviewed orphan (no FK) ==='
SELECT count(*) AS escalation_refs_referencing_orphan
  FROM "EscalationRef" WHERE chatwoot_binding_id = 'cmrsbmzvm0001s62skjms8nfc';

\echo '=== Q8: environment classification — must match one of the recognised shapes ==='
WITH s AS (
  SELECT
    (SELECT count(*) FROM "ChatwootBinding"
      WHERE account_id = '5' AND inbox_id = '3' AND mode = 'a2')          AS n_door,
    (SELECT count(*) FROM "ChatwootBinding"
      WHERE id = 'cmrj1d06c000ds617dx9f59od')                             AS n_keep,
    (SELECT count(*) FROM "ChatwootBinding"
      WHERE id = 'cmrsbmzvm0001s62skjms8nfc')                             AS n_drop,
    (SELECT count(*) FROM "ChatwootBinding"
      WHERE id IN ('cmrj1d06c000ds617dx9f59od','cmrsbmzvm0001s62skjms8nfc'))
  + (SELECT count(*) FROM "Tenant"
      WHERE id IN ('43b006e4-33e0-42a8-bec7-4422ba290d79','ema_sales_tenant'))
  + (SELECT count(*) FROM "Agent"
      WHERE id = 'cmrhp53b30007s61711vk4dbt')                             AS n_identity
)
SELECT n_door, n_keep, n_drop, n_identity,
       CASE
         WHEN n_door = 2 AND n_keep = 1 AND n_drop = 1
           THEN 'production-pre-migration (reviewed pair present — migration will dedupe)'
         WHEN n_door = 1 AND n_keep = 1 AND n_drop = 0
           THEN 'production-post-migration (already deduped — migration is a no-op)'
         WHEN n_identity = 0 AND n_door = 0
           THEN 'environment-neutral (development / fresh — migration creates the index only)'
         WHEN n_keep = 0 AND n_drop = 0 AND n_door <= 1
           THEN 'foreign-or-seeded (development with seeder-minted bindings — migration deletes nothing, creates the index only)'
         ELSE 'PARTIAL-IDENTITY OR UNRECOGNISED — REFUSE. Do not run the migration. Escalate.'
       END AS shape
  FROM s;

\echo '=== Q9: development safety for the environment-neutral path ==='
\echo '    safe_for_neutral_path must be true before deploying to development.'
WITH d AS (
  SELECT
    (SELECT count(*) FROM (
        SELECT 1 FROM "ChatwootBinding" WHERE inbox_id IS NOT NULL
         GROUP BY account_id, inbox_id, mode HAVING count(*) > 1) x)      AS dupe_groups,
    (SELECT count(*) FROM pg_class i
       JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE i.relname = 'ChatwootBinding_account_id_inbox_id_mode_key'
        AND n.nspname = current_schema())                                  AS same_name_index,
    (SELECT count(*) FROM pg_index ix
       JOIN pg_class i ON i.oid = ix.indexrelid
      WHERE i.relname = 'ChatwootBinding_account_id_inbox_id_mode_key'
        AND NOT (ix.indisunique AND ix.indisvalid AND ix.indisready
                 AND ix.indpred IS NULL))                                  AS wrong_shaped_index,
    (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'ChatwootBinding'
        AND column_name IN ('account_id','inbox_id','mode')
        AND data_type = 'text')                                            AS text_key_columns
)
SELECT dupe_groups, same_name_index, wrong_shaped_index, text_key_columns,
       (dupe_groups = 0 AND wrong_shaped_index = 0 AND text_key_columns = 3)
                                                                           AS safe_for_neutral_path
  FROM d;

\echo '=== Q10: exact column definitions of the three key columns ==='
SELECT column_name, data_type, is_nullable, column_default, ordinal_position
  FROM information_schema.columns
 WHERE table_schema = current_schema()
   AND table_name   = 'ChatwootBinding'
   AND column_name IN ('account_id','inbox_id','mode')
 ORDER BY ordinal_position;
