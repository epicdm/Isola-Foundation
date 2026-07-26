-- CW00 — one authoritative Foundation registration per Chatwoot door.
--
-- Chain of authority (canonical vocabulary):
--   Chatwoot account + inbox  →  exactly ONE active Foundation registration
--   (a ChatwootBinding row)   →  one Clawith agent  →  one owning tenant.
-- A ChatwootBinding row is a governed REGISTRATION pointing at a Clawith agent.
-- It is not itself an AI employee, and two of them on one door is not "two
-- agents" — it is an ambiguous front door.
--
-- ┌──────────────────────────────────────────────────────────────────────────┐
-- │ THIS MIGRATION WAS EDITED AFTER IT HAD ALREADY BEEN APPLIED TO           │
-- │ PRODUCTION. That is normally forbidden. It was done ONCE, under a        │
-- │ single narrowly-scoped owner exception, and is not a precedent.          │
-- │                                                                          │
-- │   applied to production : 2026-07-25 22:21:50.144659+00 → .399674+00     │
-- │   production ledger checksum (unchanged, permanent):                     │
-- │     a67295d73829ac254daa326e71d2cfb3eaf4660e387115df50cd8d59b64f8882     │
-- │                                                                          │
-- │ Prisma 6.19.3 does NOT re-verify checksums of already-applied migrations │
-- │ in `migrate status` or `migrate deploy`, so production is undisturbed;   │
-- │ `migrate dev` WILL report this migration as modified. That warning is    │
-- │ expected, and is legitimate ONLY for the exact checksum pair recorded in │
-- │ scripts/src/guard-cw00-checksum-exception.ts. Any other applied-migration│
-- │ checksum mismatch is a real defect and that guard fails closed on it.    │
-- └──────────────────────────────────────────────────────────────────────────┘
--
-- WHY THE EDIT WAS NECESSARY
-- The original migration opened with hard preconditions naming the exact
-- production rows. That made it safe to run unattended via `start:prod`, and it
-- worked: production is deduped and the unique index is live. But the same
-- guards made it UNREPLAYABLE. Measured on a disposable database, the real
-- 25-migration history applied to an empty database fails here with
--   'expected 1 or 2 ChatwootBinding rows on account 5 / inbox 3 / a2, found 0'
-- 24 migrations apply, the index is never created. Development (heliumdb) is in
-- exactly that position: one migration behind, index absent, zero duplicates.
-- So migration-only disaster recovery was broken, and development could never
-- converge. This edit makes the migration strict where production identity is
-- present and replayable where it is not.
--
-- THE FOUR BRANCHES, IN ORDER
--   0. GLOBAL DUPLICATE GUARD  — any duplicate (account_id, inbox_id, mode)
--      group other than the one reviewed pair aborts before any DML or DDL.
--   1. PRODUCTION FIRST RUN    — the reviewed pair is present in its exact
--      reviewed shape: assert full identity, write redacted evidence, delete
--      exactly the reviewed orphan, then enforce uniqueness.
--   2. PRODUCTION RE-RUN       — already deduped: assert the survivor is the
--      reviewed one, delete nothing, then enforce uniqueness.
--   3. ENVIRONMENT-NEUTRAL     — NONE of the reviewed identities exist:
--      delete nothing, require zero duplicates, then enforce uniqueness.
--   *  ANY OTHER SHAPE, including PARTIAL presence of the reviewed identity
--      set, aborts. Partial presence is treated as suspicious, never as
--      "close enough to neutral".
--
-- Being replayable does NOT relax production identity checks. Branches 1 and 2
-- carry exactly the assertions the original had.
--
-- Constraint shape: a full (non-partial) unique index named exactly as Prisma
-- names @@unique([account_id, inbox_id, mode]). inbox_id is nullable and
-- Postgres unique indexes are NULLS DISTINCT, so rows with no inbox never
-- collide; a partial index would be semantically identical for enforcement,
-- inexpressible in Prisma, and permanent drift. `mode` is part of the key
-- rather than a WHERE filter so the key is a strictly safer superset.
--
-- Residual gaps this constraint deliberately does NOT close, stated plainly:
--   (a) one 'a2' row and one 'mirror' row on the same inbox remain permitted;
--   (b) the same inbox_id under two different account_ids remains permitted;
--   (c) two rows with inbox_id IS NULL on the same account+mode remain
--       permitted (NULLS NOT DISTINCT is not Prisma-expressible).
-- lib/chatwoot-binding-resolution.ts (resolveActiveBinding) remains the runtime
-- second line of defence for all three.
--
-- Safety properties:
--   * Atomic. Prisma 6.19.3 applies each PostgreSQL migration in a transaction
--     with or without explicit BEGIN/COMMIT — verified by experiment, including
--     for this exact delete → create-index → failing-post-check shape. Any
--     abort below leaves the database byte-for-byte unchanged.
--   * Fail-closed. Every unrecognised shape RAISEs before any DML or DDL.
--   * Narrow. The delete is pinned to the exact id AND the full predicate and
--     asserts ROW_COUNT = 1.
--   * Non-cascading. Conversation.chatwoot_binding_id is ON DELETE SET NULL;
--     EscalationRef.chatwoot_binding_id is a bare TEXT snapshot with no FK.
--
-- PREFLIGHT: run prisma/preflight/20260725210000_cw00_binding_uniqueness_preflight.sql
-- (read-only) against the target FIRST. Because this migration will never re-run
-- in production, that preflight is the ONLY thing that re-proves production
-- identity — it is mandatory, not optional.

DO $$
DECLARE
  keep_id     CONSTANT text := 'cmrj1d06c000ds617dx9f59od';
  drop_id     CONSTANT text := 'cmrsbmzvm0001s62skjms8nfc';
  keep_tenant CONSTANT text := '43b006e4-33e0-42a8-bec7-4422ba290d79';
  drop_tenant CONSTANT text := 'ema_sales_tenant';
  keep_agent  CONSTANT text := 'cmrhp53b30007s61711vk4dbt';
  k_account   CONSTANT text := '5';
  k_inbox     CONSTANT text := '3';
  k_mode      CONSTANT text := 'a2';

  n_other_dupes   integer;
  other_dupe_desc text;
  n_key           integer;
  n_keep_row      integer;
  n_drop_row      integer;
  n_ident_present integer;
  n_conv          integer;
  n_escref        integer;
  n_deleted       integer;
  keep_ok         boolean;
  drop_ok         boolean;
BEGIN
  ---------------------------------------------------------------------------
  -- 0. GLOBAL DUPLICATE GUARD.
  --    Any duplicate door BEYOND the one reviewed pair would make the
  --    CREATE UNIQUE INDEX below fail with an opaque Postgres error. Detect it
  --    here, before anything is written, and name the offending group(s).
  --    Groups with inbox_id IS NULL are excluded: NULLS DISTINCT means they
  --    cannot violate the index.
  ---------------------------------------------------------------------------
  SELECT count(*),
         coalesce(string_agg(format('(account_id=%s, inbox_id=%s, mode=%s) x%s',
                                    d.account_id, d.inbox_id, d.mode, d.n), '; '), '')
    INTO n_other_dupes, other_dupe_desc
    FROM (
      SELECT account_id, inbox_id, mode, count(*) AS n
        FROM "ChatwootBinding"
       WHERE inbox_id IS NOT NULL
       GROUP BY account_id, inbox_id, mode
      HAVING count(*) > 1
    ) d
   WHERE NOT (d.account_id = k_account AND d.inbox_id = k_inbox AND d.mode = k_mode);

  IF n_other_dupes > 0 THEN
    RAISE EXCEPTION 'CW00 binding uniqueness: found % duplicate (account_id, inbox_id, mode) group(s) BEYOND the one reviewed pair on account 5 / inbox 3 / a2: %. This migration is authorised to remove exactly one specific orphan registration and nothing else; it will not guess which row of an unreviewed duplicate pair is authoritative. Stopping before any change (nothing deleted, no index created). Investigate each group, get the removal reviewed, then re-run.',
      n_other_dupes, other_dupe_desc;
  END IF;

  ---------------------------------------------------------------------------
  -- 1. Classify the environment by REVIEWED IDENTITY PRESENCE.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n_key
    FROM "ChatwootBinding"
   WHERE account_id = k_account AND inbox_id = k_inbox AND mode = k_mode;

  SELECT count(*) INTO n_keep_row FROM "ChatwootBinding" WHERE id = keep_id;
  SELECT count(*) INTO n_drop_row FROM "ChatwootBinding" WHERE id = drop_id;

  -- Every reviewed production-specific identity, across all three tables.
  SELECT (SELECT count(*) FROM "ChatwootBinding" WHERE id IN (keep_id, drop_id))
       + (SELECT count(*) FROM "Tenant"          WHERE id IN (keep_tenant, drop_tenant))
       + (SELECT count(*) FROM "Agent"           WHERE id = keep_agent)
    INTO n_ident_present;

  IF n_key = 2 AND n_keep_row = 1 AND n_drop_row = 1 THEN
    ------------------------------------------------------------------------
    -- BRANCH 1 — PRODUCTION FIRST RUN. Both reviewed rows present.
    -- Identity assertions are exactly those of the original migration.
    ------------------------------------------------------------------------
    SELECT EXISTS (
      SELECT 1
        FROM "ChatwootBinding" b
        JOIN "Tenant" t ON t.id = b.tenant_id
        JOIN "Agent"  a ON a.id = b.agent_id
       WHERE b.id = keep_id
         AND b.tenant_id = keep_tenant
         AND b.account_id = k_account AND b.inbox_id = k_inbox AND b.mode = k_mode
         AND t.status = 'active'
         AND a.id = keep_agent AND a.tenant_id = keep_tenant AND a.is_active
    ) INTO keep_ok;

    SELECT EXISTS (
      SELECT 1
        FROM "ChatwootBinding" b
        JOIN "Tenant" t ON t.id = b.tenant_id
       WHERE b.id = drop_id
         AND b.tenant_id = drop_tenant
         AND b.account_id = k_account AND b.inbox_id = k_inbox AND b.mode = k_mode
         AND b.agent_id IS NULL
         AND t.status = 'retired'
    ) INTO drop_ok;

    IF NOT keep_ok THEN
      RAISE EXCEPTION 'CW00 binding uniqueness: the registration to RETAIN does not match the reviewed state. Expected binding % on account 5 / inbox 3 / a2, owned by active tenant %, pointing at active agent % owned by that same tenant. Stopping before any change — no row has been deleted.',
        keep_id, keep_tenant, keep_agent;
    END IF;

    IF NOT drop_ok THEN
      RAISE EXCEPTION 'CW00 binding uniqueness: the registration to REMOVE does not match the reviewed state. Expected binding % on account 5 / inbox 3 / a2, owned by RETIRED tenant %, with agent_id IS NULL. It is not safe to delete a registration whose shape has changed since review (it may now be bound to a live Clawith agent). Stopping before any change.',
        drop_id, drop_tenant;
    END IF;

    ------------------------------------------------------------------------
    -- Redacted evidence snapshot, written BEFORE the delete. Deterministic id
    -- so a re-run cannot double-write it. Never token, never base_url.
    ------------------------------------------------------------------------
    SELECT count(*) INTO n_conv   FROM "Conversation"  WHERE chatwoot_binding_id = drop_id;
    SELECT count(*) INTO n_escref FROM "EscalationRef" WHERE chatwoot_binding_id = drop_id;

    INSERT INTO "AuditLog" (
      "id", "tenant_id", "consumer_account_id", "actor_id", "action",
      "entity", "entity_id", "request_id", "meta", "identity_id", "created_at"
    )
    SELECT
      'cw00-dedupe-' || drop_id,
      keep_tenant,
      NULL,
      'system',
      'chatwoot_binding.duplicate_removed',
      'ChatwootBinding',
      dropped.id,
      NULL,
      jsonb_build_object(
        'migration', '20260725210000_chatwoot_binding_account_inbox_mode_unique',
        'defect',    'CW00',
        'reason',    'Two Foundation registrations on one Chatwoot door (account 5 / inbox 3 / mode a2) made tenant+agent resolution ambiguous in app/api/chatwoot/agent-bot/route.ts.',
        'door',      jsonb_build_object('account_id', k_account, 'inbox_id', k_inbox, 'mode', k_mode),
        'removed',   jsonb_build_object(
                       'binding_id',    dropped.id,
                       'tenant_id',     dropped.tenant_id,
                       'tenant_status', dropped_tenant.status,
                       'agent_id',      dropped.agent_id,
                       'account_id',    dropped.account_id,
                       'inbox_id',      dropped.inbox_id,
                       'mode',          dropped.mode,
                       'created_at',    dropped.created_at,
                       'updated_at',    dropped.updated_at,
                       'token_redacted',    true,
                       'token_was_empty',   (dropped.token = ''),
                       'base_url_redacted', true
                     ),
        'retained',  jsonb_build_object(
                       'binding_id',              kept.id,
                       'tenant_id',               kept.tenant_id,
                       'tenant_status',           kept_tenant.status,
                       'agent_id',                kept.agent_id,
                       'agent_is_active',         kept_agent.is_active,
                       'agent_brain_provider',    kept_agent.brain_provider,
                       'created_at',              kept.created_at,
                       'updated_at',              kept.updated_at,
                       'token_redacted',    true,
                       'base_url_redacted', true
                     ),
        'referencing_rows', jsonb_build_object(
                       'conversations_set_null_by_fk', n_conv,
                       'conversation_ids_set_null', (
                         SELECT coalesce(jsonb_agg(c.id ORDER BY c.id), '[]'::jsonb)
                           FROM "Conversation" c
                          WHERE c.chatwoot_binding_id = drop_id
                       ),
                       'escalation_ref_snapshots_left_stale', n_escref
                     ),
        'constraint_added', 'ChatwootBinding_account_id_inbox_id_mode_key'
      ),
      NULL,
      CURRENT_TIMESTAMP
      FROM "ChatwootBinding" dropped
      JOIN "Tenant"          dropped_tenant ON dropped_tenant.id = dropped.tenant_id
      JOIN "ChatwootBinding" kept           ON kept.id = keep_id
      JOIN "Tenant"          kept_tenant    ON kept_tenant.id = kept.tenant_id
      JOIN "Agent"           kept_agent     ON kept_agent.id = kept.agent_id
     WHERE dropped.id = drop_id
    ON CONFLICT ("id") DO NOTHING;

    ------------------------------------------------------------------------
    -- Delete ONLY that one orphan row. Pinned by id AND full predicate.
    ------------------------------------------------------------------------
    DELETE FROM "ChatwootBinding"
     WHERE id         = drop_id
       AND tenant_id  = drop_tenant
       AND account_id = k_account
       AND inbox_id   = k_inbox
       AND mode       = k_mode
       AND agent_id IS NULL;

    GET DIAGNOSTICS n_deleted = ROW_COUNT;
    IF n_deleted <> 1 THEN
      RAISE EXCEPTION 'CW00 binding uniqueness: expected to delete exactly 1 registration, deleted %. Rolling back.', n_deleted;
    END IF;

    RAISE NOTICE 'CW00 binding uniqueness [production first run]: removed orphan registration % (retired tenant %, agent_id NULL). % conversation(s) had chatwoot_binding_id set to NULL by the ON DELETE SET NULL FK; % EscalationRef snapshot(s) now fail closed on resolve. Evidence written to AuditLog id cw00-dedupe-%.',
      drop_id, drop_tenant, n_conv, n_escref, drop_id;

  ELSIF n_key = 1 AND n_keep_row = 1 AND n_drop_row = 0 THEN
    ------------------------------------------------------------------------
    -- BRANCH 2 — PRODUCTION RE-RUN. Already deduped by an earlier run.
    -- The single survivor must be the active EPIC registration.
    ------------------------------------------------------------------------
    SELECT EXISTS (
      SELECT 1
        FROM "ChatwootBinding" b
        JOIN "Tenant" t ON t.id = b.tenant_id
        JOIN "Agent"  a ON a.id = b.agent_id
       WHERE b.id = keep_id
         AND b.tenant_id = keep_tenant
         AND b.account_id = k_account AND b.inbox_id = k_inbox AND b.mode = k_mode
         AND t.status = 'active'
         AND a.id = keep_agent AND a.tenant_id = keep_tenant AND a.is_active
    ) INTO keep_ok;

    IF NOT keep_ok THEN
      RAISE EXCEPTION 'CW00 binding uniqueness: account 5 / inbox 3 / a2 holds exactly one registration, but it is not the expected active EPIC one (id %, tenant %, agent % on an active tenant with an active agent). Something other than this migration changed the door. Stopping before any change.',
        keep_id, keep_tenant, keep_agent;
    END IF;

    RAISE NOTICE 'CW00 binding uniqueness [production re-run]: nothing to delete — account 5 / inbox 3 / a2 already holds exactly the active EPIC registration %. Proceeding to uniqueness enforcement.', keep_id;

  ELSIF n_ident_present = 0 AND n_key = 0 THEN
    ------------------------------------------------------------------------
    -- BRANCH 3 — ENVIRONMENT-NEUTRAL. None of the reviewed production
    -- identities exist anywhere: no reviewed bindings, no reviewed tenants,
    -- no reviewed agent, and nothing on the reviewed door. This is a fresh
    -- database or a development database that never carried production data.
    -- Delete nothing; enforce structure only.
    --
    -- The global guard at step 0 already proved there is no duplicate group
    -- outside the reviewed door, and n_key = 0 proves there is none on it, so
    -- CREATE UNIQUE INDEX below cannot fail on data.
    ------------------------------------------------------------------------
    RAISE NOTICE 'CW00 binding uniqueness [environment-neutral]: none of the reviewed production identities are present and the reviewed door is empty. No registration will be deleted. Enforcing uniqueness only.';

  ELSE
    ------------------------------------------------------------------------
    -- ANY OTHER SHAPE — including PARTIAL presence of the reviewed identity
    -- set. Partial presence is suspicious, never "close enough to neutral":
    -- it means something restored, seeded or mutated part of production's
    -- identity into this database, and this migration must not guess.
    ------------------------------------------------------------------------
    RAISE EXCEPTION 'CW00 binding uniqueness: unrecognised environment shape — rows on the reviewed door (account 5 / inbox 3 / a2) = %, reviewed KEEP binding present = %, reviewed DROP binding present = %, reviewed production identities present across ChatwootBinding/Tenant/Agent = %. Recognised shapes are: (a) production first run — 2 rows on the door with both reviewed bindings; (b) production re-run — 1 row, the reviewed KEEP binding, no DROP binding; (c) environment-neutral — zero reviewed identities anywhere and an empty door. Anything else, including PARTIAL presence of the reviewed production identity set, is treated as suspicious and refused. Stopping before any change — nothing deleted, no index created.',
      n_key, n_keep_row, n_drop_row, n_ident_present;
  END IF;
END $$;

-- CreateIndex
-- Mirrors @@unique([account_id, inbox_id, mode]) on model ChatwootBinding in
-- prisma/schema.prisma. Name matches Prisma's own convention exactly so
-- `prisma migrate diff` sees no drift.
CREATE UNIQUE INDEX IF NOT EXISTS "ChatwootBinding_account_id_inbox_id_mode_key"
  ON "ChatwootBinding"("account_id", "inbox_id", "mode");

-- Post-conditions. Anything failing here rolls the whole migration back,
-- including the delete above.
DO $$
DECLARE
  keep_id     CONSTANT text := 'cmrj1d06c000ds617dx9f59od';
  keep_agent  CONSTANT text := 'cmrhp53b30007s61711vk4dbt';
  idx_name    CONSTANT text := 'ChatwootBinding_account_id_inbox_id_mode_key';

  survivor_ok  boolean;
  n_key        integer;
  n_keep_row   integer;
  n_dupes      integer;
  idx_ok       boolean;
  idx_actual   text;
BEGIN
  ---------------------------------------------------------------------------
  -- P1. Production identity — asserted ONLY where the reviewed registration is
  --     present. In an environment-neutral database there is no production
  --     identity to assert, and demanding one is exactly what made the
  --     original migration unreplayable. Production identity is independently
  --     re-proved by the read-only preflight, which is mandatory for that
  --     reason.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n_keep_row FROM "ChatwootBinding" WHERE id = keep_id;

  IF n_keep_row > 0 THEN
    SELECT EXISTS (
      SELECT 1
        FROM "ChatwootBinding" b
        JOIN "Agent" a ON a.id = b.agent_id
       WHERE b.id = keep_id
         AND b.tenant_id = '43b006e4-33e0-42a8-bec7-4422ba290d79'
         AND b.account_id = '5' AND b.inbox_id = '3' AND b.mode = 'a2'
         AND a.id = keep_agent
    ) INTO survivor_ok;

    IF NOT survivor_ok THEN
      RAISE EXCEPTION 'CW00 binding uniqueness POST-CHECK FAILED: the active EPIC/EMA registration % (agent %) is not present on account 5 / inbox 3 / a2 after dedupe. Rolling back everything.', keep_id, keep_agent;
    END IF;

    SELECT count(*) INTO n_key
      FROM "ChatwootBinding"
     WHERE account_id = '5' AND inbox_id = '3' AND mode = 'a2';

    IF n_key <> 1 THEN
      RAISE EXCEPTION 'CW00 binding uniqueness POST-CHECK FAILED: expected exactly 1 registration on account 5 / inbox 3 / a2, found %. Rolling back everything.', n_key;
    END IF;
  END IF;

  ---------------------------------------------------------------------------
  -- P2. Universal: no duplicate door survives anywhere. True in every
  --     environment, including empty ones.
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n_dupes FROM (
    SELECT 1 FROM "ChatwootBinding"
     WHERE inbox_id IS NOT NULL
     GROUP BY account_id, inbox_id, mode
    HAVING count(*) > 1
  ) d;

  IF n_dupes > 0 THEN
    RAISE EXCEPTION 'CW00 binding uniqueness POST-CHECK FAILED: % duplicate (account_id, inbox_id, mode) group(s) survive. Rolling back everything.', n_dupes;
  END IF;

  ---------------------------------------------------------------------------
  -- P3. Universal: the index exists in EXACTLY the required SHAPE.
  --     Name alone is not sufficient. `CREATE UNIQUE INDEX IF NOT EXISTS`
  --     keys on the relation name, so a pre-existing same-named index that is
  --     non-unique, partial, invalid or on the wrong columns would be silently
  --     accepted and the containment would not actually be enforced — the same
  --     failure class as the 2026-07-22 "marked applied, DDL never ran"
  --     incident. Assert the structure, inside the transaction.
  ---------------------------------------------------------------------------
  SELECT EXISTS (
    SELECT 1
      FROM pg_index ix
      JOIN pg_class     i ON i.oid = ix.indexrelid
      JOIN pg_class     t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE i.relname   = idx_name
       AND n.nspname   = current_schema()
       AND t.relname   = 'ChatwootBinding'
       AND ix.indisunique
       AND ix.indisvalid
       AND ix.indisready
       AND ix.indpred IS NULL
       AND pg_get_indexdef(i.oid) = format(
             'CREATE UNIQUE INDEX %I ON %I.%I USING btree (account_id, inbox_id, mode)',
             idx_name, n.nspname, 'ChatwootBinding')
  ) INTO idx_ok;

  IF NOT idx_ok THEN
    SELECT coalesce(
             (SELECT pg_get_indexdef(i.oid)
                FROM pg_class i
                JOIN pg_namespace n2 ON n2.oid = i.relnamespace
               WHERE i.relname = idx_name AND n2.nspname = current_schema()),
             '(no index of that name in this schema)')
      INTO idx_actual;

    RAISE EXCEPTION 'CW00 binding uniqueness POST-CHECK FAILED: % is not a valid, ready, non-partial UNIQUE btree index on exactly (account_id, inbox_id, mode) of "ChatwootBinding". Actual definition: %. An index of the right name but the wrong shape does NOT enforce the containment. Rolling back everything.',
      idx_name, idx_actual;
  END IF;

  RAISE NOTICE 'CW00 binding uniqueness: post-checks passed — no duplicate door survives and uniqueness is structurally enforced.';
END $$;
