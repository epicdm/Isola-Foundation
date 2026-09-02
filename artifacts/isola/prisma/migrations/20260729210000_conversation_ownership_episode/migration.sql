-- Episode-aware conversation ownership.
--
-- AUTHORITY
--   xp-live-ai-first-customer-loop-6737
--   dec-chatwoot-escalation-contract-inbox46-2026-07-29        (Ratified)
--   dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29 (Ratified)
--   dec-foundation-clawith-structured-response-contract-2026-07-29 (Ratified)
--
-- WHAT THIS REPLACES
--   `Conversation.human_handling` was the SOLE authority over whether the
--   automated brain may answer a customer. A boolean cannot carry an episode,
--   cannot express "mid-handback", and cannot distinguish a human being
--   present from Chatwoot's status changing. The last of those is the live
--   defect: `conversation_resolved` set the boolean to false, which handed
--   response authority straight back to the AI with no reconciliation, no
--   human outcome in context, and no record that it had happened.
--
--   The column is NOT dropped. It stays as a compatibility projection of the
--   new state (lib/ownership/state.ts projectHumanHandling), written only by
--   the ownership engine. Dropping a live boolean in the same migration that
--   replaces it would make this change irreversible and would break every
--   dashboard counter that reads it.
--
-- SAFETY
--   Purely additive. One new table, eight new columns on "Conversation", new
--   indexes. No column is dropped, renamed or re-typed. No row is deleted.
--   Every new column has either a NOT NULL DEFAULT (so existing rows are
--   valid the instant the column exists) or is nullable. Older application
--   code does not select the new columns and is unaffected by them.
--
-- BACK-FILL — every existing conversation is mapped EXPLICITLY
--
--   human_handling = true   ->  ownership_state = 'HUMAN_OWNED', episode 1
--     These are the unresolved human conversations. Under the pre-migration
--     rule the AI was forbidden from replying to them; under the new rule a
--     HUMAN state forbids it too. Behaviour is preserved and the hold is now
--     durable: resolution alone can no longer clear it on a door where the
--     ownership model is authoritative. Episode 1 (not 0) so that a handback
--     naming episode 0 for one of these rows is refused as stale rather than
--     silently accepted.
--
--   human_handling = false  ->  ownership_state = 'AI_OWNED', episode 0
--     JUSTIFICATION, stated explicitly rather than assumed: under the
--     pre-migration rule these are exactly the conversations the AI was
--     PERMITTED to answer on the next inbound message. Mapping them to
--     AI_OWNED reproduces current live behaviour exactly.
--
--     This includes rows where a human once replied and the conversation was
--     later resolved — resolution cleared the boolean, so the pre-migration
--     system had already returned them to the AI and retains no record that a
--     human was ever involved. That history cannot be recovered from this
--     table, and inventing it would be a fabrication. Marking them HUMAN_OWNED
--     instead would silence the AI on conversations it is answering in
--     production today, which is a larger and unrequested behaviour change.
--     The reason string below records which rows were mapped on this basis so
--     the assumption is auditable rather than invisible.
--
--     No conversation with an ACTIVE human hold is mapped to an AI state:
--     `human_handling = true` is precisely the set of active holds the
--     pre-migration system knew about, and it is mapped to HUMAN_OWNED above.
--
--   No transition ledger rows are back-filled. The transitions that produced
--   these states happened before the ledger existed; writing rows for them
--   would invent an audit trail.
--
-- ROLLBACK (documented, tested by lib/ownership/migration.test.ts)
--   DROP TABLE "ConversationOwnershipTransition";
--   DROP INDEX "Conversation_tenant_id_ownership_state_idx";
--   ALTER TABLE "Conversation"
--     DROP COLUMN "ownership_state",
--     DROP COLUMN "ownership_episode",
--     DROP COLUMN "ownership_changed_at",
--     DROP COLUMN "ownership_reason",
--     DROP COLUMN "ownership_actor_ref",
--     DROP COLUMN "ownership_correlation_id",
--     DROP COLUMN "ownership_escalation_operation_id",
--     DROP COLUMN "ownership_handback_operation_id";
--   `human_handling` is untouched by this migration's schema change and stays
--   correct for every row throughout, so rolling back restores the previous
--   behaviour exactly with no data repair step. Dropping is the riskier act
--   once anything has written the columns; they are inert to older code, so
--   leaving them in place costs nothing.

-- ── Conversation: the authoritative ownership fact ──────────────────────────
ALTER TABLE "Conversation"
  ADD COLUMN "ownership_state"                   TEXT      NOT NULL DEFAULT 'AI_OWNED',
  ADD COLUMN "ownership_episode"                 INTEGER   NOT NULL DEFAULT 0,
  ADD COLUMN "ownership_changed_at"              TIMESTAMP(3),
  ADD COLUMN "ownership_reason"                  TEXT,
  ADD COLUMN "ownership_actor_ref"               TEXT,
  ADD COLUMN "ownership_correlation_id"          TEXT,
  ADD COLUMN "ownership_escalation_operation_id" TEXT,
  ADD COLUMN "ownership_handback_operation_id"   TEXT;

-- Active human holds. Scoped by the boolean alone; nothing else identifies them.
UPDATE "Conversation"
   SET "ownership_state"      = 'HUMAN_OWNED',
       "ownership_episode"    = 1,
       "ownership_changed_at" = COALESCE("updated_at", "created_at"),
       "ownership_reason"     = 'migration_backfill:human_handling_true_active_hold'
 WHERE "human_handling" = true;

-- Everything else: the AI was permitted to answer these before this migration
-- and is permitted to answer them after it. Reason recorded so the mapping is
-- auditable.
UPDATE "Conversation"
   SET "ownership_state"      = 'AI_OWNED',
       "ownership_episode"    = 0,
       "ownership_changed_at" = COALESCE("updated_at", "created_at"),
       "ownership_reason"     = 'migration_backfill:ai_permitted_pre_ownership_model'
 WHERE "human_handling" = false;

CREATE INDEX "Conversation_tenant_id_ownership_state_idx"
    ON "Conversation"("tenant_id", "ownership_state");

-- ── The transition ledger + exactly-once claim substrate ────────────────────
CREATE TABLE "ConversationOwnershipTransition" (
    "id"              TEXT NOT NULL,
    "tenant_id"       TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "episode"         INTEGER NOT NULL,
    "from_state"      TEXT NOT NULL,
    "to_state"        TEXT NOT NULL,
    "reason"          TEXT NOT NULL,
    "operation_id"    TEXT NOT NULL,
    "operation_kind"  TEXT NOT NULL,
    "actor_ref"       TEXT,
    "correlation_id"  TEXT,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationOwnershipTransition_pkey" PRIMARY KEY ("id")
);

-- THE claim. Exactly-once for escalation, assignment, handoff and handback is
-- this index and nothing else: a replayed webhook or retried tool call loses
-- the insert, and its call site performs no side effect.
CREATE UNIQUE INDEX "ConversationOwnershipTransition_tenant_conv_op_key"
    ON "ConversationOwnershipTransition"("tenant_id", "conversation_id", "operation_id");

CREATE INDEX "ConversationOwnershipTransition_conversation_id_episode_idx"
    ON "ConversationOwnershipTransition"("conversation_id", "episode");
CREATE INDEX "ConversationOwnershipTransition_tenant_id_created_at_idx"
    ON "ConversationOwnershipTransition"("tenant_id", "created_at");
CREATE INDEX "ConversationOwnershipTransition_correlation_id_idx"
    ON "ConversationOwnershipTransition"("correlation_id");

ALTER TABLE "ConversationOwnershipTransition"
  ADD CONSTRAINT "ConversationOwnershipTransition_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ConversationOwnershipTransition"
  ADD CONSTRAINT "ConversationOwnershipTransition_conversation_id_fkey"
  FOREIGN KEY ("conversation_id") REFERENCES "Conversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
