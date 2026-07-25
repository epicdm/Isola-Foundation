-- READ-ONLY preflight for migration
--   20260725210000_chatwoot_binding_account_inbox_mode_unique
--
-- Run this against the target database BEFORE `prisma migrate deploy`, with
-- psql (the `\echo` lines are psql meta-commands; drop them if you paste the
-- queries into another client).
-- It contains SELECTs only — no INSERT, UPDATE, DELETE, DDL or transaction
-- control. It reports every condition the migration's guards check, so a guard
-- can never be the thing that discovers a problem.
--
-- Why this file exists: if a guard fires during `prisma migrate deploy`,
-- Prisma marks the migration failed (P3009) and the documented recovery is
-- `prisma migrate resolve`, which CLAUDE.md §2.4 forbids. Recovering from that
-- would need an owner decision. Running this first makes that outcome
-- avoidable rather than merely unlikely.
--
-- This file is NOT part of the Prisma migration folder and is never applied by
-- `migrate deploy`; it lives here as the reviewed operator procedure.
--
-- Proceed with the migration only if ALL of the following hold:
--   Q1 → exactly 2 rows, and they are exactly the KEEP and REMOVE ids below
--        (or exactly 1 row = the KEEP id, meaning the migration already ran)
--   Q2 → keep_ok = true
--   Q3 → drop_ok = true
--   Q4 → 0 rows returned
--   Q5 → 0 rows returned (index not yet present) OR 1 row (already applied)
--   Q6/Q7 → informational: what the delete will set to NULL / leave stale

\echo '=== Q1: every registration on the target door (account 5 / inbox 3 / a2) ==='
SELECT b.id,
       b.tenant_id,
       t.status AS tenant_status,
       b.agent_id,
       b.account_id,
       b.inbox_id,
       b.mode,
       b.created_at,
       b.updated_at
  FROM "ChatwootBinding" b
  JOIN "Tenant" t ON t.id = b.tenant_id
 WHERE b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
 ORDER BY b.created_at;
-- Expected (first run): 2 rows —
--   cmrj1d06c000ds617dx9f59od | 43b006e4-33e0-42a8-bec7-4422ba290d79 | active  | cmrhp53b30007s61711vk4dbt
--   cmrsbmzvm0001s62skjms8nfc | ema_sales_tenant                     | retired | NULL

\echo '=== Q2: the registration to RETAIN matches the reviewed state ==='
SELECT EXISTS (
  SELECT 1
    FROM "ChatwootBinding" b
    JOIN "Tenant" t ON t.id = b.tenant_id
    JOIN "Agent"  a ON a.id = b.agent_id
   WHERE b.id = 'cmrj1d06c000ds617dx9f59od'
     AND b.tenant_id = '43b006e4-33e0-42a8-bec7-4422ba290d79'
     AND b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
     AND t.status = 'active'
     AND a.id = 'cmrhp53b30007s61711vk4dbt'
     AND a.tenant_id = '43b006e4-33e0-42a8-bec7-4422ba290d79'
     AND a.is_active
) AS keep_ok;
-- Must be true.

\echo '=== Q3: the registration to REMOVE matches the reviewed state ==='
SELECT EXISTS (
  SELECT 1
    FROM "ChatwootBinding" b
    JOIN "Tenant" t ON t.id = b.tenant_id
   WHERE b.id = 'cmrsbmzvm0001s62skjms8nfc'
     AND b.tenant_id = 'ema_sales_tenant'
     AND b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
     AND b.agent_id IS NULL
     AND t.status = 'retired'
) AS drop_ok;
-- Must be true on a first run. False after the migration has run (row gone).

\echo '=== Q4: any OTHER duplicate door that would make the unique index fail ==='
SELECT account_id, inbox_id, mode, count(*) AS n
  FROM "ChatwootBinding"
 WHERE inbox_id IS NOT NULL
 GROUP BY account_id, inbox_id, mode
HAVING count(*) > 1
   AND NOT (account_id = '5' AND inbox_id = '3' AND mode = 'a2');
-- Must return 0 rows. Any row here aborts the migration by design: this
-- migration is authorised to remove exactly one specific orphan registration
-- and will not guess which row of an unreviewed pair is authoritative.
-- Groups with inbox_id IS NULL are excluded on purpose — Postgres unique
-- indexes are NULLS DISTINCT, so they cannot violate the new index.

\echo '=== Q5: is the unique index already present? ==='
SELECT indexname, indexdef
  FROM pg_indexes
 WHERE schemaname = current_schema()
   AND tablename  = 'ChatwootBinding';
-- Expected before: no ChatwootBinding_account_id_inbox_id_mode_key.
-- Expected after:  it exists, as CREATE UNIQUE INDEX ... (account_id, inbox_id, mode).

\echo '=== Q6: rows the delete will set to NULL (Conversation FK is ON DELETE SET NULL) ==='
SELECT id AS conversation_id, tenant_id, chatwoot_inbox_id, status, last_message_at
  FROM "Conversation"
 WHERE chatwoot_binding_id = 'cmrsbmzvm0001s62skjms8nfc'
 ORDER BY id;
-- The migration also records these ids in its AuditLog evidence row
-- (meta -> 'referencing_rows' -> 'conversation_ids_set_null'), because
-- re-pointing them is the only side-effect that cannot be reconstructed from
-- the surviving rows afterwards.
-- Informational, not a gate. Any such conversation loses its binding snapshot
-- and /api/customer/escalate fails closed for it (schema.prisma:387-394) until
-- its next inbound message re-snapshots the surviving binding. That is a
-- degraded-but-safe outcome; the alternative (leaving an ambiguous door) is not.

\echo '=== Q7: EscalationRef snapshots that will go stale (no FK — untouched) ==='
SELECT count(*) AS escalation_refs_left_stale
  FROM "EscalationRef"
 WHERE chatwoot_binding_id = 'cmrsbmzvm0001s62skjms8nfc';
-- Informational. EscalationRef.chatwoot_binding_id is a bare TEXT snapshot with
-- no foreign key, so no row is deleted or modified. Refs that snapshotted the
-- removed binding fail closed on resolve — correct for a short-TTL capability.

\echo '=== Q8: full ChatwootBinding shape (no secrets) — sanity view ==='
SELECT b.account_id, b.inbox_id, b.mode, count(*) AS n
  FROM "ChatwootBinding" b
 GROUP BY b.account_id, b.inbox_id, b.mode
 ORDER BY b.account_id, b.inbox_id NULLS FIRST, b.mode;
-- Reviewed evidence (2026-07-25) records 8 rows total across accounts 5/131/144.
-- token and base_url are deliberately never selected anywhere in this file.
