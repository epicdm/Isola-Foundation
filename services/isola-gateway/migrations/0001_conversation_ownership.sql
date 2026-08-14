-- 0001_conversation_ownership.sql
--
-- The durable conversation-ownership store for isola-gateway.
--
-- AUTHORITY
--   dec-THE-MISSION-isola-on-host03-two-testable-milestones-2026-08-14 (Ratified), M1.2
--   dec-chatwoot-escalation-contract-inbox46-2026-07-29                (Ratified)
--   dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29      (Ratified)
--
-- TARGET
--   Database `isola_ledger` on the existing managed instance
--   `isola_isola-ledger-db`. The SAME database as `delivery_ledger`, and
--   deliberately so: Postgres has no cross-database transaction, and a separate
--   database would make it permanently impossible to claim a delivery and move
--   ownership in one atomic step. That is the exact coupling the reply path
--   needs — suppress first, publish second, both or neither.
--
-- WHAT THIS REPLACES
--   Nothing is removed or altered. Today this service decides whether the AI
--   may speak from Chatwoot UI state (`evaluateSuppression`: status is
--   `pending` and nobody is assigned). That predicate cannot express an
--   episode, cannot express mid-handback, and treats a status flip as a grant
--   of authority — so an agent resolving and reopening a ticket, or an
--   automation rule doing it, hands the microphone back to the AI with no
--   reconciliation and no record.
--
--   These two tables are the durable answer it will consult instead. Until the
--   wiring lands they are written by nothing and read by nothing.
--
-- SAFETY
--   Purely additive and idempotent. Two new tables and their indexes. No
--   existing table is touched and `delivery_ledger` is not referenced.
--   Re-running is a no-op, which matters because this runs on every boot of the
--   service.
--
--   There is deliberately no `ALTER TABLE ... ADD CONSTRAINT` for the
--   exactly-once claim: that form has no IF NOT EXISTS, so a re-runnable
--   version would have to remove the constraint first, and every restart would
--   briefly leave the claim unenforced. A restart is precisely when a
--   redelivery storm arrives. A UNIQUE INDEX enforces identically — a duplicate
--   raises SQLSTATE 23505 either way.
--
-- NO CUSTOMER CONTENT
--   Identifiers, states, episodes, reason codes and timestamps only. No column
--   here can hold a message body, a model answer, an attachment name, a URL or
--   a credential.
--
-- ROLLBACK
--   Remove `conversation_ownership_transition` first (it has a foreign key onto
--   the other table), then `conversation_ownership`. That is safe only while
--   nothing reads them. Once the reply path consults this store, removing these
--   tables destroys the only durable record of who owns which conversation and
--   silently returns every conversation to the Chatwoot-derived predicate this
--   store exists to replace. Prefer leaving them in place: they are completely
--   inert to code that does not select them, so there is nothing to gain by
--   removing them and a live human hold to lose.
--
-- THIS FILE IS A COPY, NOT THE SOURCE.
--   What actually runs is `OWNERSHIP_SCHEMA_SQL` in `src/ownership-store.ts` —
--   this service has no migration runner and no ORM, matching the idiom
--   `src/ledger.ts` already established. `test/ownership-migration.test.ts`
--   asserts the two are byte-identical, so this file cannot drift into a
--   description of a schema that is not the one in use.

CREATE TABLE IF NOT EXISTS conversation_ownership (
  tenant_id                         text        NOT NULL,
  conversation_key                  text        NOT NULL,
  chatwoot_account_id               integer     NOT NULL,
  chatwoot_conversation_id          integer     NOT NULL,
  chatwoot_inbox_id                 integer,
  binding_id                        text,
  ownership_state                   text        NOT NULL DEFAULT 'AI_OWNED',
  ownership_episode                 integer     NOT NULL DEFAULT 0,
  handover_ack_episode              integer,
  ownership_changed_at              timestamptz,
  ownership_reason                  text,
  ownership_actor_ref               text,
  ownership_correlation_id          text,
  ownership_escalation_operation_id text,
  ownership_handback_operation_id   text,
  created_at                        timestamptz NOT NULL DEFAULT now(),
  updated_at                        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_ownership_pkey
    PRIMARY KEY (tenant_id, conversation_key),
  CONSTRAINT conversation_ownership_episode_nonneg
    CHECK (ownership_episode >= 0),
  CONSTRAINT conversation_ownership_ack_episode_nonneg
    CHECK (handover_ack_episode IS NULL OR handover_ack_episode >= 0)
);

CREATE INDEX IF NOT EXISTS conversation_ownership_tenant_state_idx
  ON conversation_ownership (tenant_id, ownership_state);

CREATE TABLE IF NOT EXISTS conversation_ownership_transition (
  id               bigint      GENERATED ALWAYS AS IDENTITY,
  tenant_id        text        NOT NULL,
  conversation_key text        NOT NULL,
  episode          integer     NOT NULL,
  from_state       text        NOT NULL,
  to_state         text        NOT NULL,
  reason           text        NOT NULL,
  operation_id     text        NOT NULL,
  operation_kind   text        NOT NULL,
  actor_ref        text,
  correlation_id   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversation_ownership_transition_pkey PRIMARY KEY (id),
  CONSTRAINT conversation_ownership_transition_conversation_fkey
    FOREIGN KEY (tenant_id, conversation_key)
    REFERENCES conversation_ownership (tenant_id, conversation_key)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- THE CLAIM. Exactly-once for escalation, assignment, handoff and handback is
-- this index and nothing else. A replayed webhook or a retried tool call
-- presenting the same operation id loses the INSERT, and its call site performs
-- no side effect.
--
-- A UNIQUE INDEX, not an ALTER TABLE ADD CONSTRAINT. Adding a constraint has
-- no IF NOT EXISTS form, so making it re-runnable needs a DROP first -- and
-- this DDL runs on EVERY boot, which would mean every restart briefly leaves
-- the claim unenforced. A restart is exactly when a redelivery storm arrives.
-- The enforcement is identical either way: a duplicate raises SQLSTATE 23505.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_ownership_transition_claim_key
  ON conversation_ownership_transition (tenant_id, conversation_key, operation_id);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_episode_idx
  ON conversation_ownership_transition (tenant_id, conversation_key, episode);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_created_idx
  ON conversation_ownership_transition (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS conversation_ownership_transition_correlation_idx
  ON conversation_ownership_transition (correlation_id);
