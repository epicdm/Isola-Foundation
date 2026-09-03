-- Magnus <-> UISP/Odoo/LiteAccount voice-DID classification map.
--
-- Authority: dec-UISP-ODOO-voice-did-inventory-2026-09-03.
--
-- WHY A NEW TABLE, NOT AN EXTENSION OF uisp_odoo_map / uisp_odoo_map_service.
-- Those two are keyed on a UISP client/service id, always resolving TO an
-- Odoo partner. This table is keyed on a MAGNUS DID (Magnus is the voice/PBX
-- authority, per CLAUDE.md), and a row may resolve to a UISP client, an Odoo
-- partner with no UISP presence at all, a bff-v2 LiteAccount (wallet-billed,
-- not a CRM/ERP customer), or nothing yet. Forcing that into the existing
-- uisp-client-shaped tables would mean inventing a fake uisp_client_id for
-- every non-UISP row - exactly the kind of forced-shape workaround Isola's
-- own rules warn against.
--
-- CLASSIFICATION PIPELINE (dec-UISP-ODOO-voice-did-inventory-2026-09-03),
-- run against Magnus's 435 DIDs that carry a non-empty id_user (voice00,
-- measured 2026-09-03), each bucket's matches removed before the next runs:
--   1. prepaid_liteaccount  - bff-v2 lite_accounts.did / .magnusUserId
--   2. personal_line_test   - FORBIDDEN_DIDS (3742/9525/0001), TEST_IDENTITY,
--                             and username patterns test|debug|org_epiccommun_|ep_
--   3. uisp_linked          - exact phone/DID match, Phase 0's canonicaliser
--   4. odoo_linked          - Odoo partners tagged Voice/Magnus-CDR with no
--                             UISP ref (measured empty this run: the 4
--                             untagged candidates are wholesale carriers)
--   5. fuzzy_strong         - >=2 shared name tokens against UISP or all Odoo
--                             partners (2,602), OR a same-distinct-target tie
--   (fuzzy_weak and unclaimed rows are NOT written by this migration's
--   populate step - single-token/near-miss matches and the true residue go
--   to the owner as a review sheet first, per the ratifying decision. The
--   vocabulary below still names them so a later populate run needs no
--   further schema change.)
--
-- PROVEN BY EXECUTION 2026-09-03 against the live production database (this
-- is a CREATE TABLE against a table that does not yet exist - a zero-row
-- target per CLAUDE.md's migration law, not a `prisma db push`):
--   T1 migration applies cleanly under ON_ERROR_STOP=1
--   T2 a valid row insert accepted                              (positive control)
--   T3 bucket='not_a_real_bucket'   rejected by _bucket_vocab
--   T4 confidence='vibes'           rejected by _confidence_vocab
--   T5 uisp_client_id=0             rejected by _ids_positive
--   T6 duplicate magnus_did_id      rejected by the primary key
--   T7 a bucket4/odoo_linked row with uisp_client_id NULL and odoo_partner_id
--      set, alongside a bucket3/uisp_linked row with the reverse, both
--      accepted                                                 (positive control)
-- Every negative above is paired with a positive in the same run.

-- CreateTable
CREATE TABLE "uisp_magnus_map" (
    "magnus_did_id" TEXT NOT NULL,
    "magnus_did" TEXT NOT NULL,
    "magnus_user_id" TEXT NOT NULL,
    "magnus_username" TEXT,
    "uisp_client_id" INTEGER,
    "odoo_partner_id" INTEGER,
    "lite_account_id" TEXT,
    "bucket" TEXT NOT NULL,
    "matched_by" TEXT NOT NULL,
    "confidence" TEXT NOT NULL,
    "matched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,

    CONSTRAINT "uisp_magnus_map_pkey" PRIMARY KEY ("magnus_did_id")
);

-- CreateIndex
-- Not unique, same reasoning as uisp_odoo_map_odoo_partner_id_idx: one UISP
-- client or one Odoo partner can legitimately own more than one Magnus DID
-- (this measurement already found "Reboot IT" / "Perky's Pizza" / "Adam's
-- Health Care Services" each holding several).
CREATE INDEX "uisp_magnus_map_uisp_client_id_idx" ON "uisp_magnus_map"("uisp_client_id");
CREATE INDEX "uisp_magnus_map_odoo_partner_id_idx" ON "uisp_magnus_map"("odoo_partner_id");
CREATE INDEX "uisp_magnus_map_lite_account_id_idx" ON "uisp_magnus_map"("lite_account_id");
CREATE INDEX "uisp_magnus_map_bucket_idx" ON "uisp_magnus_map"("bucket");

-- Vocabulary closed at the database. Includes fuzzy_weak and unclaimed even
-- though this migration's populate step writes neither, so resolving the
-- owner's review sheet later needs no further schema change.
ALTER TABLE "uisp_magnus_map"
    ADD CONSTRAINT "uisp_magnus_map_bucket_vocab"
    CHECK ("bucket" IN ('prepaid_liteaccount', 'personal_line_test', 'uisp_linked',
                         'odoo_linked', 'fuzzy_strong', 'fuzzy_weak', 'unclaimed'));

ALTER TABLE "uisp_magnus_map"
    ADD CONSTRAINT "uisp_magnus_map_matched_by_vocab"
    CHECK ("matched_by" IN ('lite_account_magnus_user_id', 'lite_account_did',
                             'test_pattern', 'forbidden_did', 'exact_phone',
                             'fuzzy_name_strong', 'fuzzy_name_weak', 'manual',
                             'unclaimed'));

ALTER TABLE "uisp_magnus_map"
    ADD CONSTRAINT "uisp_magnus_map_confidence_vocab"
    CHECK ("confidence" IN ('exact', 'pattern', 'fuzzy_strong', 'fuzzy_weak',
                             'manual', 'none'));

-- Foreign ids are identifiers in other systems (UISP, Odoo), so no FK is
-- possible in this database. A 0 or negative id is the shape a failed
-- lookup takes when it is written instead of left NULL.
ALTER TABLE "uisp_magnus_map"
    ADD CONSTRAINT "uisp_magnus_map_ids_positive"
    CHECK (("uisp_client_id" IS NULL OR "uisp_client_id" > 0)
       AND ("odoo_partner_id" IS NULL OR "odoo_partner_id" > 0));

-- A row that names no target at all is only valid for the two buckets that
-- are defined to have none (an engineering/test account, or the genuinely
-- unclaimed residue) - every other bucket must point somewhere.
ALTER TABLE "uisp_magnus_map"
    ADD CONSTRAINT "uisp_magnus_map_target_required"
    CHECK (
        "bucket" IN ('personal_line_test', 'unclaimed')
        OR "uisp_client_id" IS NOT NULL
        OR "odoo_partner_id" IS NOT NULL
        OR "lite_account_id" IS NOT NULL
    );
