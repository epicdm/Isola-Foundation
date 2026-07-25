-- CW00 — one authoritative Foundation registration per Chatwoot door.
--
-- Chain of authority (canonical vocabulary):
--   Chatwoot account + inbox  →  exactly ONE active Foundation registration
--   (a ChatwootBinding row)   →  one Clawith agent  →  one owning tenant.
-- A ChatwootBinding row is a governed REGISTRATION pointing at a Clawith agent.
-- It is not itself an AI employee, and two of them on one door is not "two
-- agents" — it is an ambiguous front door.
--
-- Defect: account_id='5' / inbox_id='3' / mode='a2' currently carries TWO
-- ChatwootBinding rows. Verified against production Neon (neondb,
-- ep-fancy-cake-aiczmqqq) on 2026-07-25:
--
--   KEEP    id  cmrj1d06c000ds617dx9f59od
--           tenant   43b006e4-33e0-42a8-bec7-4422ba290d79 (active)
--           agent_id cmrhp53b30007s61711vk4dbt (EMA, is_active, brain_provider clawith)
--           created  2026-07-13   updated 2026-07-17
--
--   REMOVE  id  cmrsbmzvm0001s62skjms8nfc
--           tenant   ema_sales_tenant (retired)
--           agent_id NULL  ← points at no Clawith agent at all
--           created  2026-07-19   updated 2026-07-25T19:21:26Z
--
-- app/api/chatwoot/agent-bot/route.ts resolves the owning tenant with
-- findMany({ where: { inbox_id, mode: 'a2' } }), so a second row on the same
-- door makes tenant/agent/token resolution ambiguous — the same failure class
-- as the 2026-07-01 account-5 incident (295-6737 vs EMA) that motivated the
-- inbox-scoped lookup in the first place. lib/chatwoot-binding-resolution.ts
-- (resolveActiveBinding) is the RUNTIME containment already shipped for this:
-- it prefers the active tenant over the retired duplicate. That containment is
-- a filter, not a structure. This migration removes the ambiguity itself and
-- then makes it unrepresentable.
--
-- ── Ordering (this order is mandatory) ───────────────────────────────────────
-- A unique index CANNOT be created while the duplicate still exists — Postgres
-- would reject the CREATE and abort the whole migration. So, inside this one
-- transaction: verify preconditions → snapshot evidence → delete the single
-- orphan row → create the unique index → verify the survivor. An earlier
-- proposal that created the constraint first was simply invalid.
--
-- ── Why a full UNIQUE INDEX and not a partial one ────────────────────────────
-- The key is (account_id, inbox_id, mode), created as a plain (non-partial)
-- unique index named exactly as Prisma names @@unique([account_id, inbox_id,
-- mode]). Reasoning:
--
--   * inbox_id is NULLABLE, and Postgres unique indexes are NULLS DISTINCT by
--     default. Rows with inbox_id IS NULL therefore never collide with anything
--     — a full index is already semantically identical, for enforcement
--     purposes, to a partial `WHERE inbox_id IS NOT NULL`. The partial variant
--     buys nothing and costs plenty (see next point). No existing row with a
--     NULL inbox_id can be broken by this.
--   * Prisma cannot express a partial index. A partial index would be permanent
--     drift: `prisma migrate diff` would forever want to drop it and add the
--     full one, and the declarative schema would never agree with the database.
--     CLAUDE.md requires schema.prisma and the database to agree, and the
--     EscalationRef incident (20260722203000) is this repo's standing lesson on
--     what silent schema drift costs. schema.prisma is updated in the same
--     commit with the matching @@unique.
--   * `mode` is deliberately part of the key rather than a `WHERE mode = 'a2'`
--     filter. mode has other values ('mirror' is the default) and this repo
--     cannot, from here, prove what the accounts 131/144 rows look like.
--     Including mode makes the key a strictly safer superset: it cannot reject
--     a legitimate mode-differentiated pair, while still eliminating the exact
--     ambiguity class the defect exhibits (two rows, same account, same inbox,
--     same mode).
--
-- Residual gaps this constraint deliberately does NOT close, stated plainly so
-- nobody mistakes it for total coverage:
--   (a) one 'a2' row and one 'mirror' row on the same inbox remain permitted;
--   (b) the same inbox_id under two different account_ids remains permitted
--       (the agent-bot lookup keys on inbox_id + mode and ignores account_id);
--   (c) two rows with inbox_id IS NULL on the same account+mode remain
--       permitted (no inbox = no door; NULLS NOT DISTINCT is not Prisma-
--       expressible and could fail on data this migration cannot inspect).
-- resolveActiveBinding() remains the second line of defence for all three.
-- Tightening further requires production data confirmation and is out of scope.
--
-- ── Safety properties ────────────────────────────────────────────────────────
--   * Idempotent. A second run finds one row on the door (the KEEP row),
--     deletes nothing, and still succeeds; CREATE UNIQUE INDEX IF NOT EXISTS is
--     a no-op the second time.
--   * Fail-closed. Every precondition mismatch RAISEs before any DML/DDL. A
--     migration runs in a transaction, so an abort leaves the database byte-for-
--     byte unchanged — no partial delete, no half-created index.
--   * Narrow. The DELETE is pinned to the exact id AND the full predicate
--     (tenant_id / account_id / inbox_id / mode / agent_id IS NULL) and asserts
--     ROW_COUNT = 1, so it cannot reach any other registration even if the id
--     were wrong.
--   * Non-cascading. Conversation.chatwoot_binding_id is ON DELETE SET NULL
--     (20260721010000), verified in that migration's DDL — deleting a binding
--     does not destroy conversations. EscalationRef.chatwoot_binding_id is a
--     bare TEXT snapshot column with no FK at all, so those rows are untouched;
--     any that snapshotted the removed binding will simply fail closed on
--     resolve, which is the correct behaviour for a short-TTL capability.
--     Both counts are recorded in the evidence row before the delete.
--
-- ── Evidence ─────────────────────────────────────────────────────────────────
-- The pre-delete state is written to "AuditLog" (the repo's existing governance
-- table — no out-of-band table is created, because an out-of-band table is
-- exactly what `prisma db push` silently drops). The snapshot is REDACTED: it
-- records ids, tenants, account/inbox/mode, agent, and timestamps, and never
-- `token` or `base_url`. The row id is deterministic, so a re-run cannot
-- double-write it.
--
-- ── Preflight ────────────────────────────────────────────────────────────────
-- Run prisma/preflight/20260725210000_cw00_binding_uniqueness_preflight.sql
-- (read-only) against the target database FIRST. If a guard below fires during
-- `prisma migrate deploy`, Prisma records this migration as failed (P3009) and
-- the documented recovery, `migrate resolve`, is FORBIDDEN by CLAUDE.md §2.4 —
-- recovering from that needs an owner decision. The preflight exists so that
-- never happens: it reports every condition this migration checks, without
-- writing anything.

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

  n_key           integer;
  n_other_dupes   integer;
  other_dupe_desc text;
  n_conv          integer;
  n_escref        integer;
  n_deleted       integer;
  keep_ok         boolean;
  drop_ok         boolean;
BEGIN
  ---------------------------------------------------------------------------
  -- 1a. Any OTHER duplicate door would make the CREATE UNIQUE INDEX below fail
  --     with an opaque Postgres error. Detect it here and abort with a message
  --     that names the offending group(s). Groups with inbox_id IS NULL are
  --     excluded because NULLS DISTINCT means they cannot violate the index.
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
    RAISE EXCEPTION 'CW00 binding uniqueness: found % duplicate (account_id, inbox_id, mode) group(s) BEYOND the one reviewed pair on account 5 / inbox 3 / a2: %. This migration is authorised to remove exactly one specific orphan registration and nothing else; it will not guess which row of an unreviewed duplicate pair is the authoritative one. Stopping before any change (nothing has been deleted, no index created). Investigate each group, get the removal reviewed, then re-run.',
      n_other_dupes, other_dupe_desc;
  END IF;

  ---------------------------------------------------------------------------
  -- 1b. How many registrations sit on the target door right now?
  ---------------------------------------------------------------------------
  SELECT count(*) INTO n_key
    FROM "ChatwootBinding"
   WHERE account_id = k_account AND inbox_id = k_inbox AND mode = k_mode;

  IF n_key = 1 THEN
    ------------------------------------------------------------------------
    -- Idempotent path: already deduped by an earlier run of this migration.
    -- The single survivor must be the active EPIC registration — if it is
    -- anything else, the wrong row survived and we must not proceed.
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

    RAISE NOTICE 'CW00 binding uniqueness: nothing to delete — account 5 / inbox 3 / a2 already holds exactly the active EPIC registration %. Proceeding to uniqueness enforcement.', keep_id;

  ELSIF n_key = 2 THEN
    ------------------------------------------------------------------------
    -- Expected first-run state. Both rows must match the reviewed evidence
    -- exactly. n_key = 2 plus both ids confirmed present proves the pair is
    -- exactly {keep_id, drop_id} — there is no unexpected third registration.
    --
    -- Hard identity checks: row ids, tenant ids, account/inbox/mode, the
    -- KEEP row's owning agent (exists, owned by the same tenant, is_active),
    -- the KEEP tenant is active, the DROP tenant is retired, and the DROP row
    -- points at no agent. brain_provider is recorded as evidence but is NOT a
    -- hard gate: it is a routing preference that may legitimately change,
    -- whereas ownership and active-ness are identity.
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
    -- 3. Redacted evidence snapshot, written BEFORE the delete.
    --    ON CONFLICT DO NOTHING keeps a re-run from double-writing.
    ------------------------------------------------------------------------
    SELECT count(*) INTO n_conv   FROM "Conversation"  WHERE chatwoot_binding_id = drop_id;
    SELECT count(*) INTO n_escref FROM "EscalationRef" WHERE chatwoot_binding_id = drop_id;

    INSERT INTO "AuditLog" (
      "id", "tenant_id", "consumer_account_id", "actor_id", "action",
      "entity", "entity_id", "request_id", "meta", "identity_id", "created_at"
    )
    SELECT
      'cw00-dedupe-' || drop_id,
      keep_tenant,                       -- attributed to the surviving authority that owns this door
      NULL,                              -- AuditLog XOR: exactly one of tenant_id / consumer_account_id
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
                       -- Recorded as ids, not just a count, so the ON DELETE
                       -- SET NULL side-effect is reversible: re-pointing these
                       -- conversations is the only part of this migration that
                       -- cannot be reconstructed from the surviving rows.
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
    -- 4. Delete ONLY that one orphan row. Pinned by id AND full predicate.
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

    RAISE NOTICE 'CW00 binding uniqueness: removed orphan registration % (retired tenant %, agent_id NULL). % conversation(s) had their chatwoot_binding_id set to NULL by the ON DELETE SET NULL FK; % EscalationRef snapshot(s) now fail closed on resolve. Evidence written to AuditLog id cw00-dedupe-%.',
      drop_id, drop_tenant, n_conv, n_escref, drop_id;

  ELSE
    RAISE EXCEPTION 'CW00 binding uniqueness: expected 1 or 2 ChatwootBinding rows on account 5 / inbox 3 / a2, found %. The reviewed evidence (2026-07-25) recorded exactly 2. Stopping before any change — this migration will not delete a row on a door whose shape it does not recognise.', n_key;
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
  keep_id   CONSTANT text := 'cmrj1d06c000ds617dx9f59od';
  keep_agent CONSTANT text := 'cmrhp53b30007s61711vk4dbt';
  survivor_ok boolean;
  n_key       integer;
BEGIN
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

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = current_schema()
       AND indexname  = 'ChatwootBinding_account_id_inbox_id_mode_key'
  ) THEN
    RAISE EXCEPTION 'CW00 binding uniqueness POST-CHECK FAILED: unique index ChatwootBinding_account_id_inbox_id_mode_key is missing. Rolling back everything.';
  END IF;

  RAISE NOTICE 'CW00 binding uniqueness: post-checks passed — one door, one registration, uniqueness enforced.';
END $$;
