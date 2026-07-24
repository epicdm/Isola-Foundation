# Clawith v1.8.3 Migration Ledger

Status: refined by R1.6 (`xp-clawith-r16-canonicality-backup-ledger-close`),
2026-07-24. Supersedes the pattern-grouped table in
`artifacts/isola/docs/CLAWITH-R1-RUNBOOK.md` (R1 inventory, still the
system-of-record for how the counts were first derived). Nothing in this
document has been executed — this is a read-only reconciliation, per
`decision-clawith-v183-migrate-or-retire-2026-07-24`.

## 0. Precondition status

| Precondition | Status |
|---|---|
| Verified encrypted backup + restore test | **DONE** — `defect-clawith-v183-no-verified-backup-2026-07-24` closed Fixed. See `evidence-clawith-r16-backup-2026-07-24`. |
| `/opt/isola-bridge` read-only inventory | **DONE** — classified OBSOLETE (recommended). See `defect-unregistered-isola-whatsapp-bridge-2026-07-24`. |
| 3742 truth-proof | **DONE** — Hermes (`bff.epic.dm`) proven sole live processor at both phone and WABA level. See `artifacts/isola/docs/CLAWITH-R16-3742-TRUTH-PROOF.md`. |
| port-8801 firewall persistence | **DONE** — DOCKER-USER rule saved to `/etc/iptables/rules.v4`, service enabled, internal traffic verified. |
| Realistic-tenant reconciliation | **DONE** — see section 2 below. |

## 1. Top-level classification (unchanged from R1 unless noted)

| Group | Count | Classification | Notes |
|---|---|---|---|
| 9043 / Demo Diner | 1 | OWNER DECISION | Unchanged. Forbidden number, out of scope for R1.6 entirely. |
| 3742 / Rex (`8e3a56fe...`) | 1 | OWNER DECISION → recommend DISABLE | De-escalated from "urgent, could be live" to "dormant duplicate credential, safe reversible disable" — see truth-proof doc. Disable script prepared, not executed. |
| 3742 / legacy EMA (`2dc199f0...`) | 1 | OWNER DECISION → recommend DISABLE | Same as above. Also carries a live Chatwoot binding (acct 5 / inbox 18) not investigated further this pass. |
| Perky's Pizza | 7 tenant rows (corrected count — R1 said "2 rows"; R1.6 restore-test query found 7 tenant rows named "Perky's Pizza") | OWNER DECISION (**Perky's Rule: MIGRATE or OWNER DECISION only, never discard**) | Confirmed real founding-pilot customer per `dec-sbl-founding-price-value-and-promo-2026-07-22`. Not currently connected. The 7-vs-2 count discrepancy itself needs owner/PM attention before migration — likely duplicate test signups alongside the one real pilot tenant; do not bulk-migrate all 7 without first identifying which row is the actual pilot. |
| Obvious QA/test/probe patterns | ~183 | DISCARD TEST DATA | Unchanged from R1. Safe to archive-then-drop now that a verified backup exists (was previously blocked on the backup gap). |
| Realistic-named cluster | 38 tenant rows (R1 estimated ~30; R1.6 regex match found 38) | **Reclassified — see section 2** | R1 could not distinguish these from real prospects by DB evidence alone. R1.6 added Odoo cross-check, channel-connectivity check, and message-source-channel check; recommend DISCARD for all but one (Ministry of Agriculture Dominica flagged separately). |
| `/opt/isola-bridge` (Aria) | 1 service, not a tenant row | OBSOLETE (recommended) | See section 3. |
| Everything not itemized | remainder | OWNER DECISION | Not individually reviewed. |

## 2. Realistic-tenant reconciliation (38 rows, the "~30" group)

Evidence columns per tenant: WhatsApp channel connectivity, Odoo
`res_partner`/`res_company` name match (read-only, `epic` production DB —
the only DB with real customer data; note **all 38 rows' `odoo_company_id`
were empty except Azure Salon's `=4`, which resolves to Odoo `res_partner`
id 4 = "Public user", a generic system record, not a real customer — this
FK should not be treated as evidence of realness**), and chat session
source_channel (whether any session was ever `whatsapp` vs. only
`trigger`/`web`).

| Business name | Tenant row(s) | Channel connected? | Odoo match? | Session activity | Verdict |
|---|---|---|---|---|---|
| Azure Salon | 1 | No | No (odoo_company_id=4 is a false lead, resolves to "Public user") | None | Recommend DISCARD |
| Bayside Mini Mart | 3 (2 within 2 min of each other) | No | No | 43 sessions, `trigger` only (scheduled heartbeat), never whatsapp | Recommend DISCARD |
| Bullseye Pharmacy | 2 | No | No | None | Recommend DISCARD |
| Caribbean Coffee Co | 2 | No | No | 11 sessions, `trigger` only | Recommend DISCARD |
| Coral Bay Trading Co | 2 | No | No | 44 sessions (43 `trigger` + 1 `web`), never whatsapp | Recommend DISCARD |
| Coral Coast Marine Supplies (+ "v2") | 2 (40 min apart) | No | No | None | Recommend DISCARD |
| Driftwood Bistro | 1 | No | No | 1 session, `trigger` | Recommend DISCARD |
| Eric Cafe | 6 (spread over Apr 24 - Jun 7, less clearly a single batch) | No | No | 6 sessions on one row, `web` only, last 2026-05-06 | Recommend DISCARD |
| Harbor Grill / Harbor Lights Grill | 2 (1 day apart, template-like naming) | No | No | None | Recommend DISCARD |
| Island Books | 2 | No | No | 3 sessions, `trigger` only | Recommend DISCARD |
| Keystone Cafe Two | 2 (20s apart) | No | No | None | Recommend DISCARD |
| Keystone Diner | 2 (4 min apart) | No | No | None | Recommend DISCARD |
| Mango Tree Kitchen | 1 | No | No | None | Recommend DISCARD |
| **Ministry of Agriculture Dominica** | 1 | No | No | **40 sessions, `trigger` only**, real government-agency name | **OWNER DECISION — highest sustained activity in this cluster but still zero independent (Odoo/WhatsApp) confirmation; do not lump with zero-activity siblings, but do not assume real without an explicit owner call** |
| Mitchell Bakery | 2 (22s apart) | No | No | None | Recommend DISCARD |
| Pebble Cove Store | 1 | No | No | None | Recommend DISCARD |
| Roseau Marine Supplies | 3 | 1 of 3 has a channel row (Rex, disconnected) | No | None | Recommend DISCARD (the one channel row is the same dormant Rex processor already covered in the 3742 truth-proof, not independent evidence of realness) |
| Wave Nine Bistro Two/Three/Four | 3 (within 3 min of each other) | No | No | None | Recommend DISCARD |

**Basis for the DISCARD recommendation:** zero of the 38 rows have ever had
a `whatsapp`-channel chat session (every session found is `trigger` —
scheduled internal heartbeat firing — or `web` — manual UI testing); zero
have a real Odoo `res_partner`/`res_company` match in the production `epic`
Odoo database (which contains exactly one real company, id 1); and most
show duplicate-name rows created seconds to minutes apart, a strong
automated-batch signature. This is a materially stronger evidence basis
than the R1 pass had (which only had DB row data and no cross-system
check), so the recommendation is now DISCARD rather than "cannot
distinguish" for all but Ministry of Agriculture Dominica, which is
flagged separately for an explicit owner look given its unusually high
(40-session) sustained trigger activity and identifiable real-world name.
**This is a recommendation, not an executed reclassification — final
disposition is still OWNER DECISION**, consistent with Perky's Rule-style
caution for named businesses.

## 3. `/opt/isola-bridge` (Aria)

See `defect-unregistered-isola-whatsapp-bridge-2026-07-24` for full detail.
Summary: OBSOLETE (recommended). Its own hardcoded phone number's live Meta
webhook already points to `bff.epic.dm`, not to this process; zero network
exposure path exists (no nginx, no firewall opening for :3210); zero
traffic evidence in available logs. Left running untouched this pass.

## 4. Counts (revised)

- MIGRATE: 0 confirmed this pass (still gated — 3742 needs an owner
  disable decision first; Perky's needs its 7-vs-2 discrepancy resolved
  before any row is migrated).
- ARCHIVE: 0.
- DISCARD TEST DATA: ~183 (obvious-pattern group, unchanged) + 37 of the 38
  realistic-named rows now carry an explicit DISCARD recommendation
  (pending owner approval) = ~220 tenants with a clear discard
  recommendation once approved.
- OBSOLETE: 1 service (`isola-bridge.service`, recommended, not executed).
- OWNER DECISION (the concrete short list, down from ~158 generic rows):
  1. 3742 split-brain — approve/deny the prepared disable script for Rex +
     legacy EMA (`CLAWITH-R16-3742-TRUTH-PROOF.md`).
  2. Perky's Pizza — resolve 7-vs-2 row count, identify the one real pilot
     tenant, approve its migration path. Never discard any of the 7 without
     that resolution.
  3. Ministry of Agriculture Dominica — approve or reject the DISCARD
     recommendation given its unusually high internal-trigger activity.
  4. `isola-bridge.service` (Aria) — approve/deny stop+disable (a future R3
     item; not touched this pass).
  5. The ~37 other realistic-named tenant rows — approve the bulk DISCARD
     recommendation in section 2 (can be approved as one batch given
     uniform evidence, or reviewed individually).
  6. 9043/Demo Diner — unchanged, out of scope, stays with Hermes.
  7. 3 extra nginx-fronted apps (`app.isola.epic.dm`, `chat.isola.epic.dm`,
     `staging.isola.epic.dm`) — still not traced, carried forward from R1,
     out of scope for R1.6.

## 5. R2 / R3 draft packets

See `artifacts/isola/docs/CLAWITH-R2-R3-DRAFTS.md` (drafts only, not
dispatched).
