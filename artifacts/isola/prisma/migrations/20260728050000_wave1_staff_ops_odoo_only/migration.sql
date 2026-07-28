-- Wave 1 — internal staff operations, Odoo-only WorkRef.
--
-- AUTHORITY
--   dec-bff-freeze-spine-consolidation-execution-2026-07-28  (Ratified)
--   dec-wave1-workref-odoo-only-2026-07-28                   (Ratified)
--   packet xp-spine-wave1-internal-operations-migration
--
-- WHAT THIS MIGRATION DOES NOT DO, DELIBERATELY
--   It creates NO mirror of `epic_work_items`, no `OPS-` reference column, no
--   EpicWorkItem id, no compatibility field and no foreign key or link of any
--   kind to the BFF database. Read-only substrate evidence taken on
--   2026-07-28 found that 50 of 51 EpicWorkItem rows carry no Odoo model/id,
--   and that the sole row which does (OPS-000052 -> project.task 2570) points
--   at a task that does not exist in Odoo. EpicWorkItem is therefore not a
--   projection of a system of record; it is a competing authority, and a
--   bridge to it would have to be un-built before BFF could be retired.
--
--   It also performs NO BACK-FILL. Every column added to
--   "NotificationOutbox" below is nullable and starts NULL on existing rows.
--   Those rows were written before Foundation tracked provider outcomes; their
--   true delivery state is unknown, and writing a value would invent history —
--   the same reason OPS-000015 / 000053 / 000054 / 000055 stay untouched in
--   BFF.
--
-- SAFETY
--   Purely additive: two new tables, additive nullable columns on
--   "NotificationOutbox", and new indexes. No column is dropped, renamed,
--   re-typed or defaulted onto existing rows. Existing code paths do not
--   select the new columns until the corresponding client is generated, and
--   they are nullable when they do.
--
-- ROLLBACK
--   DROP TABLE "StaffWorkAction";
--   DROP TABLE "StaffBinding";
--   ALTER TABLE "NotificationOutbox"
--     DROP COLUMN "provider_status", DROP COLUMN "provider_error_code",
--     DROP COLUMN "provider_error_detail", DROP COLUMN "delivered_at",
--     DROP COLUMN "failed_at", DROP COLUMN "work_ref_model",
--     DROP COLUMN "work_ref_id", DROP COLUMN "correlation_id";
--   Dropping is the riskier act once anything has written these columns; the
--   columns are inert to older code, so leaving them costs nothing.

-- ── NotificationOutbox: delivery truth + Odoo work correlation ──────────────
--
-- provider_status is SEPARATE from `state` on purpose. `state` is the outbox's
-- own lifecycle (did we manage to hand this to Meta). provider_status is what
-- Meta later said actually happened. Collapsing the two is exactly what let
-- `sent` be read as "the staff member has it" for three weeks while a 131047
-- Re-engagement failure sat unnoticed.
ALTER TABLE "NotificationOutbox"
  ADD COLUMN "provider_status"       TEXT,
  ADD COLUMN "provider_error_code"   TEXT,
  ADD COLUMN "provider_error_detail" TEXT,
  ADD COLUMN "delivered_at"          TIMESTAMP(3),
  ADD COLUMN "failed_at"             TIMESTAMP(3),
  ADD COLUMN "work_ref_model"        TEXT,
  ADD COLUMN "work_ref_id"           INTEGER,
  ADD COLUMN "correlation_id"        TEXT;

-- The wamid join. Without an index here every wa-status callback is a table
-- scan, and the callback path is the one that must stay cheap.
CREATE INDEX "NotificationOutbox_external_ref_idx"   ON "NotificationOutbox"("external_ref");
CREATE INDEX "NotificationOutbox_correlation_id_idx" ON "NotificationOutbox"("correlation_id");

-- ── StaffBinding ────────────────────────────────────────────────────────────
--
-- "odoo_res_user_id" is named for exactly what it is. The legacy column
-- "odooUserOrEmployeeId" was ambiguous enough that three live rows were seeded
-- with hr.employee ids into a field consumed as a res.users id; the practical
-- consequence was that one person's acknowledgement would have read back
-- against another person's user, and one against an inactive system account.
-- The two ids are separate columns here.
CREATE TABLE "StaffBinding" (
  "id"                       TEXT NOT NULL,
  "tenant_id"                TEXT NOT NULL,
  "identity_id"              TEXT,
  "odoo_res_user_id"         INTEGER NOT NULL,
  "odoo_employee_id"         INTEGER,
  "display_name"             TEXT NOT NULL,
  "work_email"               TEXT,
  "manager_odoo_res_user_id" INTEGER,
  "wa_id"                    TEXT,
  "telegram_id"              TEXT,
  "role"                     TEXT NOT NULL DEFAULT 'staff',
  "active"                   BOOLEAN NOT NULL DEFAULT true,
  "verified_at"              TIMESTAMP(3),
  "created_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffBinding_pkey" PRIMARY KEY ("id")
);

-- One person per Odoo user per tenant, and one WhatsApp number per person per
-- tenant. The second constraint is what makes an ambiguous sender impossible
-- within a tenant rather than merely unlikely.
CREATE UNIQUE INDEX "StaffBinding_tenant_id_odoo_res_user_id_key" ON "StaffBinding"("tenant_id", "odoo_res_user_id");
CREATE UNIQUE INDEX "StaffBinding_tenant_id_wa_id_key"            ON "StaffBinding"("tenant_id", "wa_id");
CREATE INDEX "StaffBinding_tenant_id_idx" ON "StaffBinding"("tenant_id");
CREATE INDEX "StaffBinding_wa_id_idx"     ON "StaffBinding"("wa_id");

ALTER TABLE "StaffBinding"
  ADD CONSTRAINT "StaffBinding_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffBinding"
  ADD CONSTRAINT "StaffBinding_identity_id_fkey"
  FOREIGN KEY ("identity_id") REFERENCES "Identity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── StaffWorkAction ─────────────────────────────────────────────────────────
--
-- An idempotency and audit ledger. It records that an action was REQUESTED
-- against an authoritative Odoo record and whether Odoo accepted it. It holds
-- no title, no due date, no assignee-of-record and no state machine, because
-- any of those would make it a second task authority.
--
-- "applied_at" NULL means the write did NOT complete. A row in that state must
-- never be read as done — that is the whole family of defects this packet
-- exists to close (dispatched / configured / restarted / sent all read
-- stronger than they were).
CREATE TABLE "StaffWorkAction" (
  "id"               TEXT NOT NULL,
  "tenant_id"        TEXT NOT NULL,
  "staff_binding_id" TEXT NOT NULL,
  "work_ref_model"   TEXT NOT NULL,
  "work_ref_id"      INTEGER NOT NULL,
  "correlation_id"   TEXT NOT NULL,
  "action"           TEXT NOT NULL,
  "note"             TEXT,
  "source"           TEXT NOT NULL DEFAULT 'whatsapp',
  "actor_wa_id"      TEXT,
  "idempotency_key"  TEXT NOT NULL,
  "applied_at"       TIMESTAMP(3),
  "odoo_result"      JSONB,
  "failure_reason"   TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StaffWorkAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StaffWorkAction_tenant_id_idempotency_key_key" ON "StaffWorkAction"("tenant_id", "idempotency_key");
CREATE INDEX "StaffWorkAction_tenant_id_work_ref_model_work_ref_id_idx"  ON "StaffWorkAction"("tenant_id", "work_ref_model", "work_ref_id");
CREATE INDEX "StaffWorkAction_correlation_id_idx"   ON "StaffWorkAction"("correlation_id");
CREATE INDEX "StaffWorkAction_staff_binding_id_idx" ON "StaffWorkAction"("staff_binding_id");

ALTER TABLE "StaffWorkAction"
  ADD CONSTRAINT "StaffWorkAction_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "StaffWorkAction"
  ADD CONSTRAINT "StaffWorkAction_staff_binding_id_fkey"
  FOREIGN KEY ("staff_binding_id") REFERENCES "StaffBinding"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
