# Early-access intake record design — proposal for Odoo, 2026-09-26

Per the growth decision: persist in the existing customer/lead system (Odoo, where currently authoritative)
— not chat history, not a new shadow CRM. This is a **specification proposal** for AGENT/LINE to verify
against the real Odoo schema and wire; this lane has no direct Odoo access and hasn't queried the live
schema (per CLAUDE.md's Odoo authority rules, that's the ledger's own domain, not mine to probe).

## Proposed model: `crm.lead`, a distinct pipeline, not the sales one

Odoo's standard lead/opportunity model. Recommend a **separate CRM pipeline/team** for early-access
interest (e.g. `team_id` = "Personal Line Early Access") rather than mixing into whatever pipeline handles
real sales conversations — the decision explicitly requires "keep interest registration distinct from line
activation or payment," and a shared pipeline risks exactly that conflation.

| Requirement | Proposed field | Note |
|---|---|---|
| Verified contact/channel | `phone` (standard) + `medium_id` (standard, set to "WhatsApp") | `phone` should be the WhatsApp-verified number the concierge already confirmed — never an unverified typed number |
| Source/hotspot/referral | `source_id` (standard `utm.source`, e.g. "hotspot-downtown") + `campaign_id` (standard `utm.campaign`, e.g. "early-access-2026-09") | Matches the `(source:X)` value from the WhatsApp prefill 1:1 |
| Consent to launch follow-up | `x_consent_launch_followup` (new boolean) + `x_consent_captured_at` (new datetime) | Not a standard field — must be added; recorded at the moment the concierge captures it, not assumed |
| Interests/location | `city`, `country_id` (standard) for location; `description` (standard, free text) for stated interests | Keep interests as free text initially — no new taxonomy needed for v1 |
| Signup time | `create_date` (standard, automatic) | No new field needed |
| Cohort | `x_cohort_code` (new char field, e.g. "cohort-01-hotspot-downtown") | A tag (`tag_ids`) would also work, but a dedicated field makes cohort reporting/filtering simpler than tag-parsing |
| Status | `x_early_access_status` (new selection field: Registered / Invited / Activated / Declined / Expired) | **Deliberately not `stage_id`** — that's the standard sales-pipeline stage and reusing it is exactly the conflation the decision warns against |
| Exact promised offer/version | `x_promised_offer_version` (new char field, e.g. "welcome-v1-bonus-voucher-ec10") | Critical for honesty and audit — if the welcome offer changes between cohorts, each record keeps what was actually promised at signup, not what's currently live |

## Deduplication

Look up by verified `phone` before creating a new record; a retry (same number messaging EARLY ACCESS
again) should update `x_cohort_code`/timestamps on the existing record if still Registered, never create a
duplicate. This is a wiring detail for whoever builds the intake handler (LINE/AGENT), flagged here as a
hard requirement, not something this lane can enforce from copy alone.

## What this does NOT propose

No new model, no parallel CRM, no gamification schema, no reward-ledger table — the growth decision
explicitly rules those out for v1 ("no new custom agent runtime, parallel CRM, generic gamification
engine"). Vouchers themselves are already decided to live in bff-v2, not Odoo
(`dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26`) — this intake record is about the
*interest registration*, not the reward mechanism.

## Open question for AGENT/LINE

Does the live Odoo instance already have a `team_id`/pipeline convention this should slot into, or does a
new team need creating? This lane doesn't have schema access to check — naming it as a dependency rather
than guessing.
