# Clawith v1.8.3 — R2 and R3 draft packets

Drafts only, per R1.6 step 6. Neither packet is dispatched or approved.
Both are gated on the owner decisions listed in
`CLAWITH-V183-MIGRATION-LEDGER.md` section 4.

## R2 (draft) — Migrate-or-clean-start execution

**Depends on:** owner approval of the short list in ledger section 4
(items 1-5 minimum).

**Scope, per approved item:**

1. **3742 disable** (if approved): run the prepared script in
   `CLAWITH-R16-3742-TRUTH-PROOF.md` section D against
   `isolaruntime-postgres-1`. Verify per that doc's verification steps.
   Rollback: the paired reversal script in the same doc.
2. **Perky's Pizza migration** (once the 7-vs-2 discrepancy is resolved by
   the owner/PM): export the identified real pilot tenant's data
   (agent config, any channel history) from `isolaruntime` via `pg_dump
   --table` scoped to that tenant's rows, then create the tenant fresh on
   v1.11.0 (`clawith-v1110`) using the upstream tenant-creation flow (not a
   raw DB copy, per `decision-clawith-v183-migrate-or-retire-2026-07-24`'s
   "supported upstream models" requirement). Rollback: the v1.8.3 source
   row is untouched until this is verified working, so rollback is simply
   not cutting traffic over.
3. **Ministry of Agriculture Dominica** (if owner approves migrate rather
   than discard): same pattern as Perky's, scaled down (no channel history
   to carry since it never had a connected channel).
4. **isola-bridge teardown** (if approved) — this is really an R3-style
   action (retirement of a component, not migration of data), see R3 below
   for the actual steps; R2 would just be the "approved" gate-check to
   authorize R3 to touch it.
5. **~37 realistic-named tenant bulk discard** (if approved as a batch):
   `pg_dump` a scoped export of just those 37 tenant IDs (list in ledger
   section 2) into the existing backup bundle format first, then soft
   delete (`is_active = false`) rather than hard delete, with a documented
   re-activation path, for a minimum 30-day grace window before any hard
   delete. Same pattern to apply later to the ~183 obvious-QA-pattern
   group once that batch is separately approved.

**Acceptance for R2:** each migrated tenant has a working agent on
v1.11.0 verified via a live smoke test (not just a DB row count); each
discarded/disabled item has its pre-change state captured in a dated
export inside the existing backup lineage; 3742 disable verified per the
truth-proof doc's steps; no other tenant/agent/channel affected
(spot-check a control tenant, e.g. Perky's Pizza's real row if not itself
being migrated this round, remains untouched).

**Rollback for R2:** every action above has an explicit per-item rollback
already stated. No step in R2 is irreversible within the 30-day grace
window design.

## R3 (draft) — v1.8.3 retirement

**Depends on:** R2 complete and verified; explicit owner sign-off that no
further real tenant data remains on v1.8.3 requiring migration.

**Scope:**

1. Fully tear down the `isolaruntime-backend-1`, `-frontend-1`,
   `-postgres-1`, `-redis-1` containers via their compose project (the
   standard "bring the stack all the way down" compose command run from
   `/opt/isola-runtime`) — the packet-level restriction against destructive
   container operations applies to this session's tooling, not to a future
   owner-approved R3 packet; R3 should re-confirm this action explicitly
   with the owner at execution time regardless.
2. Disable restart: the compose stack has no systemd unit (confirmed in
   R1.6 backup step — it's plain compose-managed, restart policy
   `unless-stopped` set per-container), so retirement means the full
   compose teardown from step 1 (removes containers, and with nothing
   running there is nothing left to auto-restart) rather than disabling a
   systemd unit.
3. Remove routing/webhook dependencies: confirm
   `CLAWITH_DISPATCH_URL`/`tenant_registry.containerUrl` in the Foundation
   Replit env no longer point at `runtime.epic.dm:8800` for any live
   tenant (should already be moot once 3742 and any migrated tenants are
   off v1.8.3); remove the `runtime.epic.dm` nginx vhost only after
   confirming zero remaining inbound need (the 3 extra nginx-fronted apps
   — `app.isola.epic.dm`, `chat.isola.epic.dm`, `staging.isola.epic.dm` —
   still need their own dependency check first, per ledger section 4 item
   7, before this step can be considered complete).
4. No-traffic verification: 72h of zero connections to port 8800/8801
   (whichever remains) before considering retirement final.
5. Mark Retired in Port: update the `isola_component` (or equivalent)
   entity for the v1.8.3 stack, close
   `decision-clawith-v183-migrate-or-retire-2026-07-24`'s implementation
   status, archive `evidence-clawith-v183-inventory-2026-07-24` and this
   ledger as historical record.

**Acceptance for R3:** stack fully torn down, restart disabled, zero
routing dependencies remain pointing at it, 72h no-traffic window
observed, Port updated to Retired.

**Rollback for R3:** the R1.6 encrypted backup
(`v183-20260724-045902.tar.gpg`) plus any R2-stage exports are the
recovery path — a full stack restore from the verified backup, following
the same restore procedure already proven in R1.6 (restore into a fresh
postgres, restore the tree tar, recreate the compose stack). This is a
significantly heavier rollback than R2's per-item reversals, which is why
R3 is gated on R2 being fully verified first.
