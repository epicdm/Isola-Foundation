# EPIC Customer Zero — Activation Pack

**Status:** Preparation artefact. Nothing in this document has been applied.
**Owning lane:** `xp-isola-customer-zero-launch-readiness-2026-08-11` (PM lane), output 3 of 8.
**Subordinate to:** `xp-isola-signup-to-agent-mvp-2026-08-10` (In Progress, 84%) — a different session owns that packet. This pack reads it and never writes it.
**Controlling decisions:** `dec-isola-restore-master-commercial-launch-plan-2026-08-03` · `dec-epic-customer-zero-completion-definition-2026-07-27` · `dec-customer-zero-epic-gate-before-customer-one-2026-07-21` · `decision-apptension-customer-portal-nocobase-control-plane-2026-08-10` · `decision-all-isola-whatsapp-numbers-non-production-2026-08-11`
**Claim authority:** the approved/prohibited claim register is **not** in this document. It is frozen separately at `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md`.

> **UNVERIFIED (document dependency):** at the time this pack was written, `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` did not yet exist on disk (a parallel lane is authoring it). Every reference below to "the frozen spec" is a forward reference. No claim wording in this pack may be used until that file exists and is frozen.

---

## Reading rules for this document

| Marker | Meaning |
|---|---|
| **Source** column populated | The value was read from the named Port entity or repo file. It is not asserted by this document. |
| `> **UNVERIFIED:**` | No authoritative record contains this value. It must be discovered or supplied before use. It is **not** a guess to be filled in. |
| `> **OWNER DECISION REQUIRED:**` | A human owner must rule. No agent, packet or lane may choose. |
| **BLOCKED** in a checklist | The surface the row tests is not built. The row cannot pass or fail; it can only be deferred. |

Isola law applies throughout: **repository code is not evidence of deployed behaviour**, and **a packet at 100% means only that item is accepted**.

---

## 1. What Customer Zero means here

### 1.1 The acceptance rule

EPIC Communications runs its own business on Isola, in normal daily work, **before any external customer is activated.**

| # | Rule | Source |
|---|---|---|
| 1 | EPIC is Isola client #1 and Customer Zero. If EPIC cannot operate on Isola, EPIC does not have a proven product to sell. | `dec-isola-restore-master-commercial-launch-plan-2026-08-03` (Ratified, Phillip Alleyne) |
| 2 | Customer Zero must be 100% and tested across every scenario **before** Customer One is approached. Outreach, prospect selection, external sends, proposal and payment are gated behind it. | `dec-customer-zero-epic-gate-before-customer-one-2026-07-21` (Ratified) |
| 3 | Customer Zero is **not** accepted from component tests alone. The owner must complete a normal tenant-owner walkthrough on desktop and mobile; EPIC staff must complete real operating work; the public customer loop must pass; the exact configuration must be frozen as the Customer #1 template. | `dec-epic-customer-zero-completion-definition-2026-07-27` §16 |
| 4 | EPIC has **two** coordinated views, not one blended super-admin experience: the tenant/customer view and the EPIC operator/admin view. The operator view must never be used to conceal a broken tenant experience. | `dec-epic-customer-zero-completion-definition-2026-07-27` |
| 5 | Failures have a truthful state, a named owner and a next action. | `dec-isola-restore-master-commercial-launch-plan-2026-08-03` §7 |
| 6 | The accepted EPIC configuration is frozen as the first repeatable tenant template. | Same, §8 |

### 1.2 How "daily use" is measured

Daily use is **not** a subjective judgement. It is scored on the `isola_epic_value_score` blueprint and graded by the Port scorecard `isola_epic_daily_value_maturity`.

| Level | Threshold (exact scorecard rule) | Source |
|---|---|---|
| Lab only | below all rules | scorecard `isola_epic_daily_value_maturity` |
| Usable fragments | `overall_score >= 21` | same |
| Daily assisted | `overall_score >= 41` **AND** `daily_adoption >= 3` | same |
| **Operational** | `overall_score >= 61` **AND** `daily_adoption >= 6` **AND** `business_loops_live >= 4` | same |

**Latest snapshot — `epic-value-uat-2026-08-06-s1-atlas-closure` (snapshot_at 2026-08-06, assessment_status "Evidence-verified"):**

| Dimension | Score | Dimension | Score |
|---|---|---|---|
| overall_score | **34 / 100** | authoritative_actions | 5 |
| value_stage | **Usable fragments** | business_loops_live | **2** |
| owner_login_access | 6 | reliability_trust | 7 |
| owner_attention_view | 5 | **daily_adoption** | **2** |
| staff_access_roles | 4 | plan_alignment | 8 |
| staff_agent_chat | 4 | customer_operations | 6 |
| work_commitments | 3 | | |

**Therefore the measurable Customer Zero bar is:** move `overall_score` 34 → ≥61, `daily_adoption` 2 → ≥6, and `business_loops_live` 2 → ≥4, evidenced by an additive, evidence-verified snapshot. The active business loop named in that snapshot is **"Revenue Loop 1 — enquiry to qualified opportunity, owned follow-up and truthful closure."**

> **UNVERIFIED:** the `isola_epic_value_score` blueprint defines `daily_adoption` as a 0–10 numeric dimension but Port carries **no written rubric** for what score 6 means in observable terms (e.g. "N consecutive working days", "N staff", "N loops closed without falling back to the old system"). Every snapshot to date sets it by narrative judgement.

> **OWNER DECISION REQUIRED (1):** ratify an observable rubric for `daily_adoption >= 6`. Suggested shape — *number of consecutive working days*, *number of distinct human users*, and *number of real business cases closed without reverting to the pre-Isola process*. No numbers are proposed here because none have been agreed.

### 1.3 Where Customer Zero actually stands

| Fact | Value | Source |
|---|---|---|
| Gate `isola-gate-06-customer-zero` | **In Progress, 30%**, launch_critical true | Port `isola_launch_gate` |
| Gate `isola-gate-05-hermes-operator-experience` ("EPIC Tenant Zero Business OS") | **Done, 100%** — Hermes Workspace Delta 1 accepted 2026-07-24; owner UAT passed on canonical `epic-operator`; standalone internal baseline **frozen** | Port `isola_launch_gate` |
| Programme packet `xp-epic-customer-zero-100-percent` | In Progress, 75% | Port `execution_packet` |
| Active MVP packet `xp-isola-signup-to-agent-mvp-2026-08-10` | In Progress, 84%, acceptance 28 rows, **tenant-facing journey has not started** | Port `execution_packet` |

**What EPIC operates today** (from the gate-05 `current_state` and the 2026-08-06 value snapshot) is the *internal* half: Hermes owner operations on the deepseek host, Foundation on Replit reading live Odoo and Chatwoot account 5, and one dedicated internal staff-chat agent (Atlas) that passed owner-tier UAT. That baseline is **frozen and standalone**. It is **not** the EasyPanel `isola` stack this pack activates against.

---

## 2. EPIC company profile — the tenant record

This is the record EPIC would hold **as a tenant**. Every field is sourced or flagged. Nothing here is inferred from what a communications company "probably" does.

### 2.1 Identity

| Field | Value | Source |
|---|---|---|
| Legal / trading name | **EPIC Communications Inc** | Chatwoot account 5 label `EPIC Communications Inc — LIVE`, `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md`; Odoo host `epic-communications-inc.odoo.com` |
| Port client record | `odoo_client:epic-tenant-zero` — "EPIC Communications (Tenant Zero)" | Port |
| Industry (as recorded) | `Small Business` | Port `odoo_client:epic-tenant-zero.industry` |
| Support plan | `Managed Odoo` | Port `odoo_client:epic-tenant-zero.support_plan` |
| Commercial status | `Implementation` | Port `odoo_client:epic-tenant-zero.commercial_status` |
| Data classification | `Internal` | Port `odoo_client:epic-tenant-zero.data_classification` |
| Account owner | `EPIC` | Port `odoo_client:epic-tenant-zero.account_owner` |
| Odoo partner id | `null` | Port `odoo_client:epic-tenant-zero.odoo_partner_id` |
| Foundation tenant id (internal only) | `43b006e4` | `docs/isola/CHATWOOT-FIRST-WORKSPACE-FIXTURE.md`, `CHATWOOT-R1-EXECUTION-PLAN.md` |
| bff-v2 tenant id | `8166ea11-8db0-4f26-879a-e2067be0a018` | `docs/isola/DISCOVERY-LEDGER.md` |
| Authoritative daily Odoo | `https://epic-communications-inc.odoo.com` | Port `odoo_instance:epic-odoo-01.description` (2026-08-06 correction) |
| Odoo factory reference (NOT daily) | `https://epic-tenant-zero-1-prod.apps.oec.sh`, 19.0 Community, `production_writes_allowed: false` | Port `odoo_instance:epic-odoo-01` |

> **UNVERIFIED (1):** the authoritative daily Odoo instance `epic-communications-inc.odoo.com` **has no Port `odoo_instance` catalog record.** `epic-odoo-01` explicitly states "A separate authoritative-instance catalog record must be discovered/registered." Until it exists, EPIC's tenant record points at a factory reference that is marked *do not route daily operations here*.

### 2.2 Business description

> **UNVERIFIED (2):** **no EPIC business description exists in any authoritative record.** Port's `odoo_client` carries only `industry: Small Business`. The live Clawith EMA agent's `role_description` is a single 95-character sentence and its `bio` and `welcome_message` are **empty** (`docs/isola/DISCOVERY-LEDGER.md` §5). The Foundation AI Team page for the internal assistant renders "No business description has been added yet" (value snapshot `epic-value-uat-2026-08-03b`).

> **OWNER DECISION REQUIRED (2):** supply the canonical EPIC Communications Inc business description — what EPIC sells, to whom, and in what words the agent may say it. This is the single largest gap in this pack. Everything the Front Desk agent says about EPIC is currently ungrounded.

### 2.3 Hours

> **UNVERIFIED (3):** **no business-hours clock values exist anywhere.** `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` records only that business hours are "defined" on inboxes 17 / 46 / 47 and "enabled on 3, 17, 46" — the *flags* are recorded, the *values* are not. The only timezone signal in the repository is an incidental reference to "a Dominica-timezone agent" in `docs/isola/CLAWITH-CONFIGURATION-FIRST-DOGFOOD-PLAN.md`.

> **OWNER DECISION REQUIRED (3):** ratify EPIC's operating hours and timezone, and state explicitly whether the Front Desk agent answers 24/7 or announces an after-hours state. Note the coupling: offer `offer-epic-smart-business-line` includes "After-hours schedule and warm handoff to a person" as a *sold component*, so the agent cannot describe the feature while EPIC's own hours are unset.

### 2.4 Service area

> **UNVERIFIED (4):** EPIC's own service area is not recorded. The nearest evidence is *target-customer* text on the offers — `offer-epic-smart-business-line.target_customer` reads "Dominica SMB, 1-15 staff…" — which describes who EPIC sells to, **not** where EPIC delivers. These are not the same claim and must not be conflated.

> **OWNER DECISION REQUIRED (4):** ratify EPIC's service area as a statement the agent may make.

### 2.5 Contact routes

| Route | Value | Status | Source |
|---|---|---|---|
| Public front door | `3742` / `+17678183742` | **Non-production** as of 2026-08-11 | `docs/isola/DISCOVERY-LEDGER.md` §6; `decision-all-isola-whatsapp-numbers-non-production-2026-08-11` (Ratified) |
| Front Desk / Customer Zero | `6737` / `+17672956737`, pnid `278390858690809`, WABA `227366173803234` | **Non-production** as of 2026-08-11 | `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` (inbox 46); same decision |
| Hermes internal / staff | `9043` / `+17678189043` | Non-production; **out of Customer Zero scope** | `docs/isola/DISCOVERY-LEDGER.md` §6 |
| Anansi | `9525` / `+17678189525` — no active processor | Non-production | `docs/isola/META-CUSTOMER-CHANNEL-ECOSYSTEM-DESIGN.md` |
| Legacy | `0001` — do not touch | Non-production | `docs/isola/DISCOVERY-LEDGER.md` §6 |
| Tenant human workspace (current, Replit/deepseek stack) | Chatwoot account **5**, `inbox.epic.dm` | Live internal baseline | `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` |
| Tenant human workspace (new EasyPanel stack) | Chatwoot account **3**, team 4, inbox 4, AgentBot 1 | Synthetic test objects, proven | `xp-isola-signup-to-agent-mvp-2026-08-10` |

> **UNVERIFIED (5):** the public front-door number is **internally contradictory**. `docs/isola/META-CUSTOMER-CHANNEL-ECOSYSTEM-DESIGN.md` records that `tenant_registry.displayPhone` says `+17678180001` while `brain-provider.ts:71` says `+17678183742` — "One is wrong and the number concerned is the public front door." A second unresolved question is carried in `docs/isola/EASYPANEL-TRANSITION-PACK.md` §4 item 7: whether `+1 767-295-6737` or `+1 767-818-3742` is the real target, and whether a phone-level Meta webhook override bypasses BFF entirely.

> **UNVERIFIED (6):** EPIC has **no recorded street address, no recorded public email address** in any of the eleven `docs/isola/` design documents or in any Port entity read for this pack.

**Consequence of the 2026-08-11 ruling:** because every Meta/WhatsApp number attached to Isola is non-production, **no number is a valid contact route the agent may quote to a customer today.** Customer Zero activation must proceed without any number claim (see §6).

### 2.6 Approved Isola offer information the agent may describe

These are the Port `epic_offer` records. The **wording** the agent may use is governed by the frozen spec, not by this table. This table exists so the tenant record is complete and so ratified-versus-unratified price status is unambiguous.

| Offer | Kind | Status | `agent_recommendable` | One-time | Recurring | Price status |
|---|---|---|---|---|---|---|
| `offer-epic-smart-business-line` — P1 EPIC Smart Business Line (Managed) | Package | Available now | **true** | **EC$750** | **EC$249 / month** | **Ratified** |
| `offer-epic-ai-upgrade-existing-line` — P2 AI Upgrade for an Existing Phone Line | Package | Available now | **true** | **EC$250** | **EC$99 / month** | **Ratified** |
| `offer-epic-customer-operations-workspace` — P3 Customer Operations Workspace (Isola), managed | Package | Managed pilot | **true** | — | — | **Owner decision required** |
| `offer-epic-hosted-business-pbx` — A1 EPIC Hosted Business PBX | Add-on | Later | **false** | — | — | Owner decision required |
| `offer-missed-call-recovery-not-offered` — X1 Missed-call recovery | Evaluated – not offered | Later | **false** | NOT PRICED | NOT PRICED | Not offered |

Binding constraints carried on those records, reproduced because they are refusals rather than absences:

- **A1:** "The sales agent MUST NOT propose, price or promise this offer." May be described only as a documented future upgrade path, with **no date**.
- **X1:** "The sales agent MUST NOT mention missed-call recovery as an included or upcoming feature." Never demo it. It is DARK in production.
- **P1 / P2:** `support_boundary` on both records states **"No published response-time SLA yet — do not promise one."**
- **P3:** several sections (invoices, services, devices, PBX, notes, tasks) "currently render UNAVAILABLE — do not demo or promise them until the readers ship."
- **P1 / P2 WhatsApp-calling claim:** requires "One live WhatsApp-calling re-probe BEFORE the calling claim is made for that number." Under the 2026-08-11 non-production ruling there is no number for which this probe currently holds.

> **OWNER DECISION REQUIRED (5):** ratify a setup and recurring price for `offer-epic-customer-operations-workspace` (P3), or mark it not-sellable. It is currently `agent_recommendable: true` with **no ratified price** — an agent could recommend something it cannot quote.

---

## 3. Founder and tenant roles

### 3.1 The two hats — stated explicitly

The same humans hold both. `dec-epic-customer-zero-completion-definition-2026-07-27` requires them to remain **two coordinated views, not one blended super-admin experience**.

| | EPIC-as-provider (operator) | EPIC-as-tenant (customer) |
|---|---|---|
| What it is | The party that provisions, supports and governs Isola tenants | The first tenant, receiving exactly what a paying customer receives |
| Surface (per `decision-apptension-customer-portal-nocobase-control-plane-2026-08-10`) | **NocoBase** — tenant lifecycle, provisioning state and history, bindings, entitlement, integration health, operator retry/reconcile | **Apptension portal** (sign-up → company setup → provisioning status → Test Agent → Open Inbox) **+ Chatwoot** (daily conversation work) |
| Authentication | Operator realm | Normal tenant-owner path — **not** an administrator bypass (`dec-epic-customer-zero-completion-definition-2026-07-27` §2) |
| Hard rule | "The operator view must never be used to conceal a broken or incomplete tenant experience." | If a capability only works from the operator view, the tenant experience has **failed**, not passed. |
| Isolation rule | Provider access is cross-tenant by design | Tenant access is single-tenant. `dec-epic-customer-zero-completion-definition-2026-07-27` §4: manager and staff roles are distinct, tenant-scoped and **negative-tested**. |

**The confusion this prevents:** every UAT to date was run as "Platform administrator acting-as tenant EPIC Communications Inc" (value snapshot `epic-value-uat-2026-08-03b`), i.e. through the provider hat wearing a tenant banner. That path proves the operator surface, not the tenant surface. Any Customer Zero evidence captured through an acting-as impersonation must be labelled as provider-path evidence and does **not** satisfy §2 of the completion definition.

### 3.2 Named humans on record

| Name | Recorded identity | Recorded state | Source |
|---|---|---|---|
| Eric Giraud | Chatwoot account 5, **user 1**, administrator / SuperAdmin, **confirmed**; 53 sign-ins, last 2026-08-02; teams 1 (epic support) and 7 (escalations); inboxes 46 and 47 | The **only operable console user** | `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md`, `CHATWOOT-R1-EXECUTION-PLAN.md` |
| Eric Giraud (duplicate) | Chatwoot **user 3**, 0 sign-ins | Duplicate record, unresolved | `CHATWOOT-R1-EXECUTION-PLAN.md` |
| Phillip | Chatwoot **user 131**, administrator, **unconfirmed** (never signed in); teams 1, 5, 7; inbox 46 | Named as owner/decision authority across Port decisions | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md`; Port `decided_by` fields |
| Veronica | Chatwoot user 129, agent, confirmed | Never signed in | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` |
| Dezy | user 130, agent, unconfirmed; teams 1, 5 | Verification Pending | `CHATWOOT-R1-EXECUTION-PLAN.md` |
| Hakeem | user 132, agent, unconfirmed; teams 1, 5 | Verification Pending | same |
| Kimberly | user 133, agent, unconfirmed; team 6 only, **no inbox membership** | "would log in to an empty workspace" | same |
| Joann Polydore | user 134, agent, unconfirmed; team 6 only, **no inbox membership** | same | same |
| QA Staff | user 135 | — | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` |
| *AI Ops Manager* | Odoo `hr_employee` row under tenant `43b006e4` | **Synthetic — must be excluded** from employment verification | `CHATWOOT-R1-EXECUTION-PLAN.md` R1A-0 |

> **UNVERIFIED (7):** **who holds the owner role, and under which surname, is not consistently recorded.** Port `decided_by` fields variously read "Owner (Phillip)", "Phillip Alleyne", "Eric (owner)" and "Phillip Alleyne and central Isola Operations PM". The 2026-08-03 value snapshot records the UAT operator as "Eric Alleyne (Platform administrator)" while Chatwoot user 1 is "Eric Giraud". At least one of these is wrong and the field concerned is the acceptance signatory.

> **OWNER DECISION REQUIRED (6):** state the canonical legal name and single system identity for each named role-holder below, and reconcile the duplicate Chatwoot user 1 / user 3.

### 3.3 Role definitions for Customer Zero

Four roles are required by this pack. The definitions are new to this document; the **privilege mappings** are sourced.

| Role | Held by | May do — portal (Apptension) | May do — Chatwoot | May do — operator (NocoBase) |
|---|---|---|---|---|
| **Owner** | *see UNVERIFIED (7)* | Sign up, verify email, sign in, complete company setup, view provisioning status, run Test Agent, Open Inbox | Chatwoot `administrator` on the tenant account: settings, inbox membership, teams, canned responses | **Nothing by default.** Provider-hat access is a *separate* identity (§3.1). |
| **Operator** (escalation handler / daily inbox) | Named staff — currently only Eric Giraud is operable | Sign in; view provisioning status read-only | Chatwoot `agent`: reply, private note, assign within team, apply approved labels, resolve, explicit handback | None |
| **Escalation handler** | Team 7 `escalations` — **2 members, 1 operable** | — | Receive assignment, reply, hand back | None |
| **Reviewer** (acceptance signatory) | Owner, per completion-definition §16 | Execute the §7 checklists on desktop **and** mobile | Observe; capture evidence | Read-only inspection of provisioning history |
| **Provider / platform administrator** | Separate identity, provider hat | **Must not** substitute for the tenant path | Platform-app level only | Tenant lifecycle, bindings, provisioning retry/reconcile |

### 3.4 Least-privilege mapping to actual system roles

| Governed action | Authoritative role source | Notes |
|---|---|---|
| Any governed business action | **Foundation `Membership.role`** — authoritative for every governed action | `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §5 |
| Chatwoot settings screens only | Chatwoot `User.role` — gates screens, **not** governed actions | same |
| Escalation team/operator selection | **Foundation**, per ruling D2. No account-wide automation may overwrite Foundation's assignment. | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §17.1 |
| Prohibited for **every** non-owner role | Reading raw Meta/Magnus/Odoo credentials · Platform API use · deleting conversations or inboxes · changing AgentBot bindings or webhook subscriptions · cross-tenant contact search | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §5 |
| Field employee | **No Chatwoot seat.** 9043 WhatsApp only: read + notify + confirm. No financial writes. | same — out of Customer Zero scope (9043 is Hermes-internal) |
| Agent tool posture | `execute_code`, `delete_file`, `import_mcp_server`, `install_skill` disabled on all five live agents — but "set by hand and nothing preserves it"; a newly created agent gets **41 default tools with no database row recording it** | `docs/isola/ISOLA-PREDEFINED-AGENT-CATALOGUE.md` |
| Exposure default | **Unclassified = INTERNAL, fail closed.** INTERNAL employees cannot attach to a PUBLIC inbox — proven `403 exposure_mismatch` at the credential layer, both directions, body cannot widen it | `CHATWOOT-R1-EXECUTION-PLAN.md` R1E-14; `xp-isola-signup-to-agent-mvp-2026-08-10` row 21 |

> **OWNER DECISION REQUIRED (7):** the new EasyPanel stack has **no role model yet** — Chatwoot account 3 has a single user (user 6) and the Apptension portal is unbuilt. Confirm whether Customer Zero roles are provisioned as *synthetic* identities on the new stack (recommended by §6) or whether the existing account-5 human roster is migrated. These are different activations with different blast radii.

---

## 4. Knowledge sources

What the agent is grounded on, and whether the **runtime actually has it today**. "Runtime" here means the deployed EasyPanel `isola` stack (Paperclip `ai` + `isola-runtime` + `isola-gateway`), not the frozen Replit/deepseek baseline.

| # | Source | Owner | Freshness requirement | Available to the runtime today? |
|---|---|---|---|---|
| 1 | **Paperclip Template v1** — the PUBLIC Front Desk employee template that produced `fd2867d1` | Paperclip (workforce authority, `decision-paperclip-native-agent-hiring-workforce-boundary-2026-08-09`) | Versioned; a template change is a new template version, never an in-place edit | **YES** — `fd2867d1` created once from Template v1, **staged, not ready** (`xp-isola-signup-to-agent-mvp` row 9, Pass) |
| 2 | **Synthetic business info** supplied to the Paperclip employee | This pack (§6) | Per activation run | **YES, but only INTERNAL is proven.** Row 13 passes for the INTERNAL employee `2b4cf82a` (correct 7-column action list); **PUBLIC has not yet been invoked** |
| 3 | **Approved claim register** — approved and prohibited claims, escalation and failure behaviour | `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` | Frozen at v1; changes require a new frozen version | **NO** — file does not yet exist (see header) |
| 4 | **Port `epic_offer` records** (P1, P2, P3, A1, X1) | Owner; price fields ratified separately | `price_status` must read `Ratified` before any price is spoken | **NO governed read path.** No evidence exists that the runtime can read Port. Offer facts must be **transcribed into the frozen spec**, not fetched. |
| 5 | **EPIC business description, hours, service area** | Owner | Must precede any activation that speaks about EPIC | **NO — does not exist.** See UNVERIFIED (2), (3), (4) |
| 6 | **Odoo live read** — customers, opportunities, tickets | Odoo (business system of record) | Live read, never re-derived from note text (`CHATWOOT-FIRST-WORKSPACE-FIXTURE.md`) | **NO — deliberately out of MVP scope.** `xp-isola-signup-to-agent-mvp-2026-08-10`: Odoo writes and the embedded Odoo application are explicitly out of scope; row 26 requires **no Odoo write** |
| 7 | **Chatwoot canned responses** — 19 on account 5 | Chatwoot / tenant | "Review for accuracy against current offers; no structural change" (`CHATWOOT-R1-EXECUTION-PLAN.md` R1E-6) — **not yet reviewed** | **NO** — they exist on account 5, not on the new stack's account 3 |
| 8 | **Chatwoot help-center portal (`User Guide`)** | Chatwoot / tenant | — | **NO — aspirational.** `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §13 lists it under "Optional future" as a *proposed* Clawith knowledge source |
| 9 | **Clawith `experience_entries`** (`status='published'`; no RAG, no embeddings) | Clawith v1.11.0 runtime | Publish-gated | **NO — different stack.** Clawith is the frozen Replit/deepseek baseline, not the EasyPanel runtime |
| 10 | **Foundation `Agent.business_info` / `knowledge_text` / `greeting`** | Foundation (Replit) | — | **NO — different stack**, and observed empty: the AI Team page renders "No knowledge has been added yet" |
| 11 | **Foundation FOH catalogue** (`lib/foh/catalog.ts`, 8 rows) | — | — | **NO — flagged aspirational.** "entirely mock. Not one creates an `Agent` row, a `ClawithBinding`, or a channel" (`ISOLA-PREDEFINED-AGENT-CATALOGUE.md`) |
| 12 | **Clawith `agent_templates`** (26 rows) | Clawith | — | **NO, and irrelevant** — "Generic SaaS/trading personas. Zero telecom, zero EPIC content. Persona text only." |

### 4.1 Honest summary

**Exactly one knowledge source is available to the deployed runtime today: the Paperclip employee's own configured content (rows 1–2).** Every other source is on a different stack, does not exist, is explicitly out of MVP scope, or is flagged aspirational. Sources 8, 11 and 12 are **aspirational** and must not be cited as grounding.

The operational consequence: **the Front Desk agent cannot be grounded on real EPIC knowledge until UNVERIFIED (2), (3) and (4) are resolved and the frozen spec exists.** This is precisely why §6 sequences synthetic-first.

> **OWNER DECISION REQUIRED (8):** rule on how offer facts reach the runtime — transcription into the frozen spec at freeze time (no live read, must be re-frozen when a price changes), or a governed read path built later. Transcription is the only option compatible with today's stack.

---

## 5. Escalation owners

### 5.1 The table

| Escalation type | Who owns it | How they are notified | Target response time | If they do not respond |
|---|---|---|---|---|
| **Explicit human request** (customer asks for a person) | Escalation handler — Chatwoot team `escalations` | Chatwoot assignment + private context note, written by Foundation/gateway per `dec-chatwoot-escalation-contract-inbox46-2026-07-29` | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Low-confidence / policy outcome** | Escalation handler | Same | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Approval boundary reached** | Owner | Same | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Unresolved governed-tool failure** | Operator, then owner | Same | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Complaint / sensitive issue** | Owner | Same | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Unsupported request** (out of approved capability) | Escalation handler | Same | **OWNER DECISION REQUIRED (9)** | **OWNER DECISION REQUIRED (10)** |
| **Runtime failure / provider error / persistence failure** | Provider hat (platform), not the tenant | Gateway returns a truthful failure state from the runtime's structured `completionState`; issue → `blocked` (proven, row 19) | **OWNER DECISION REQUIRED (9)** | Fails **closed** to a human — proven behaviour, see §5.3 |
| **Ledger unavailable at ACK** | Provider hat | `alertCode: ledger_unavailable_on_ack`; Chatwoot opens the conversation to a human itself | n/a — automatic | Automatic: conversation is opened to a human. Recorded, not hidden. |

The six trigger types in rows 1–6 are **not invented** — they are the exact permitted triggers enumerated in `dec-chatwoot-escalation-contract-inbox46-2026-07-29` (Ratified 2026-07-29).

### 5.2 Why every response time is an owner decision

| Fact | Source |
|---|---|
| Two SLA policies exist on account 5 — **`EPIC Standard` 30m/60m/24h business-hours** and **`EPIC Urgent` 15m/30m/4h 24×7** — but both are **inert**: `applied_slas = 0`, SLA is a premium feature absent from Chatwoot CE | `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` |
| "**No acceptance criterion for this contract may cite a Chatwoot audit-log entry or an SLA figure**" — both Enterprise-only, absent from CE | `docs/isola/CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` §6 |
| Foundation must own the SLA clock: started on first inbound and on escalation; first-response, next-response and resolution targets; a persisted breach record; **business-hours aware**. "Breach evidence lives in Foundation and is the only SLA evidence that may be cited." **No numeric targets are set.** | `docs/isola/CHATWOOT-R1-EXECUTION-PLAN.md` §6.1 |
| Both sellable offers state: "**No published response-time SLA yet — do not promise one.**" | Port `epic_offer` P1 and P2 `support_boundary` |
| The only concrete operational threshold anywhere is the saved folder **`Unassigned > 15m`** — a *view*, not a commitment | `CHATWOOT-R1-EXECUTION-PLAN.md` R1E-4 |

**Therefore the inert SLA numbers (30m/60m/24h, 15m/30m/4h) must not be treated as agreed targets.** They are configuration that does nothing.

> **OWNER DECISION REQUIRED (9):** ratify first-response, next-response and resolution targets per escalation type, and state whether they are business-hours or 24×7. Blocked upstream by OWNER DECISION REQUIRED (3) — a business-hours target is undefined until hours are set.

> **OWNER DECISION REQUIRED (10):** ratify the non-response path per escalation type — who is escalated to, after how long, and by what mechanism. Note that Foundation must implement the clock; Chatwoot CE cannot.

### 5.3 Structural escalation problems that outlive any target time

| # | Problem | Source | Effect on Customer Zero |
|---|---|---|---|
| 1 | **Team `escalations` has 2 members and 1 is unconfirmed.** "a queue that only Eric and Phillip can serve is not a queue" | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §17.3; `CHATWOOT-R1-EXECUTION-PLAN.md` R1E-1 | Any target time is unachievable with one operable human |
| 2 | **Macro 3 `Escalate to Human` hard-codes `assign_agent 1`** (Eric personally), contradicting ruling D2 that Foundation owns selection | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` | Must be corrected to `assign_team` or removed before activation |
| 3 | **Assigning a team breaks the bot's only permitted read.** `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`: `_team.json.jbuilder` renders `Current.user.teams`; `Current.user` IS the AgentBot, which has no `teams`, so `conversations#show` 500s. Reconciliation degrades to fail-closed on escalated conversations. Affects **both** v4.16.1 instances, including `inbox.epic.dm`. | `xp-isola-signup-to-agent-mvp-2026-08-10` | **Every team-assignment rule in this pack is flagged against this defect.** No duplicate is possible as a result; what is lost is disambiguation of an uncertain send. |
| 4 | **`assignee_agent_bot_id` is NULL on all 91 conversations** — "dead in practice, do not derive handoff from it". The `human_takeover` label is the gate. | `docs/isola/DISCOVERY-LEDGER.md` | Handback detection must not be built on the assignee field |
| 5 | **Two agent-bot processors with contradictory silence models.** `risk-two-chatwoot-agent-bot-processors-2026-08-11`: Foundation (Replit) uses its own `human_handling` flag and explicitly distrusts Chatwoot status; the gateway uses Chatwoot status + assignee. No law-1 violation today (different instances, different inboxes) — but convergence or a real channel makes it one. | `xp-isola-signup-to-agent-mvp-2026-08-10` | **Owner ruling required before any real channel is wired.** Already listed as next-action 2 on the active packet. Not re-raised here as a new decision — it belongs to that packet. |
| 6 | Chatwoot CE provides **no SLA and no usable audit log**. Foundation must own both. | `CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` §6 | Evidence for §7 must be captured from Foundation/gateway, not Chatwoot |

**Proven escalation behaviour on the deployed EasyPanel stack** (from `xp-isola-signup-to-agent-mvp-2026-08-10`, gateway layer): duplicate webhook → exactly one reply · human takeover suppresses AI · explicit handback resumes exactly once · all three handoff paths · exact approved customer strings · private-note privacy · honest failure states. This is real and load-bearing — but it was proven at the **gateway** layer, not through the tenant portal journey, which is why matrix rows 15–17 still read "Not run".

---

## 6. Synthetic-first activation plan

### 6.1 Standing prohibitions for every step below

Sourced from `xp-isola-signup-to-agent-mvp-2026-08-10` (out-of-scope clause and acceptance row 26), and from this lane's own scope:

- **No payment.** No checkout, no subscription, no Paymenter.
- **No Odoo write**, and no embedded Odoo application.
- **No Meta, WhatsApp, Facebook, Instagram or email channel.** No PBX.
- **No real customer data**, and no real customer contact.
- **No modification** of Chatwoot test objects (account 3, user 6, team 4, inbox 4, AgentBot 1), live Paperclip employees (`fd2867d1`, `2b4cf82a`), NocoBase schemas or Activepieces flows.
- Entitlement rule for the MVP is `VERIFIED_SIGNUP + PILOT_APPROVED -> PROVISION`; signup is invite/allowlist gated (`decision-apptension-customer-portal-nocobase-control-plane-2026-08-10`).

### 6.2 Phase S — synthetic (runs entirely on synthetic identity and synthetic business data)

| Step | Action | Depends on | Blocked by |
|---|---|---|---|
| **S0** | Freeze the claim register at `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` | Parallel lane | — |
| **S1** | Define **two** synthetic tenant identities (28-row matrix requires "Two fresh **synthetic** tenant identities"). Synthetic company name, synthetic description, synthetic hours, synthetic service area, synthetic contact route. **None resembling EPIC's real details** — otherwise a synthetic run cannot be distinguished from a real one in evidence. | S0 | — |
| **S2** | Unblock administrative access to **NocoBase** and **Activepieces** through the supported mechanism only — no database edit, no key rotation, no redeploy, no flow change. Both are running, healthy and **unadministrable**: no domain attached, no root credentials, Activepieces signup disabled. | Owner action | **Owner** — this is a genuine hard blocker (`xp-isola-signup-to-agent-mvp` WS4) |
| **S3** | Owner ruling on WS2 acceptance (7 of 8 durability proofs pass deployed; "orphan → first reply" is unit-proven after four documented failed deployed constructions) | Owner | **Owner** |
| **S4** | Owner ruling on `risk-two-chatwoot-agent-bot-processors-2026-08-11` — which component is authoritative per number, which silence model governs | Owner | **Owner** — required *before* WS3/WS4 wire anything |
| **S5** | Build WS3 — the Apptension portal fork (pin tag `5.0.0` = `931ad3fea9ef291d2a167d6f497ef240802780c4`; `Dockerfile.render`; drop `uv run`; `STRIPE_CHECKS_ENABLED=False`; close invite gating in `UserSignupSerializer.validate()` **and** the social-auth pipeline) | S3, S4 | WS2 acceptance |
| **S6** | Build WS4 — Activepieces provisioning orchestration (create-or-get, idempotent) | S2, S5 | S2 |
| **S7** | Run the full 28-row acceptance with **synthetic tenant A**, executing checklists §7(a)–(d) | S5, S6 | — |
| **S8** | Repeat with **synthetic tenant B** — matrix row 28: no manual DB edits. Confirm row 20 cross-tenant denial at the portal and Chatwoot layers, not only the agent-key layer. | S7 | — |
| **S9** | Correct escalation configuration on the new stack: replace macro-3-style personal assignment, flag every team-assignment rule against `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` | S7 | — |
| **S10** | Record an additive, evidence-verified `isola_epic_value_score` snapshot. Additive only — prior snapshots are preserved unchanged (established practice on `epic-value-baseline-2026-08-03`). | S8 | — |

### 6.3 THE GATE — synthetic → real

**No step in Phase R may begin until every one of the following holds. This is the exact gate.**

| # | Gate condition | Evidence that closes it |
|---|---|---|
| G1 | All **28** acceptance rows of `xp-isola-signup-to-agent-mvp-2026-08-10` read Pass on synthetic tenant A **and** the journey repeats on synthetic tenant B with no manual DB edits (row 28) | The packet's own acceptance matrix, updated by its owning session — **not by this lane** |
| G2 | Row 20 (cross-tenant denial) is Pass at **three** layers — agent key, portal, Chatwoot — not the current Partial (agent key only) | Three recorded denials, one per layer |
| G3 | Row 26 holds true through the entire synthetic run: no payment, no Odoo write, no Meta/WhatsApp/PBX, no real-customer mutation | Explicit negative evidence per category |
| G4 | The frozen spec exists, and every approved claim traces to a Port `capability` truth_status or a proven acceptance row | `xp-isola-customer-zero-launch-readiness-2026-08-11` acceptance row 5 |
| G5 | UNVERIFIED (2), (3), (4) are resolved — EPIC business description, hours, service area exist as owner-ratified records | Port entity or ratified decision |
| G6 | OWNER DECISIONS (9) and (10) are ratified — escalation targets and non-response paths | Ratified Port `decision` |
| G7 | `risk-two-chatwoot-agent-bot-processors-2026-08-11` is ruled: one authoritative processor per number (Isola law 1) | Ratified Port `decision` |
| G8 | Team `escalations` has **more than one operable member**, or the owner accepts single-operator risk in writing | Confirmed Chatwoot users who have signed in |
| G9 | The authoritative EPIC Odoo instance (`epic-communications-inc.odoo.com`) has a Port `odoo_instance` catalog record | Port entity |
| G10 | Owner authorises the transition explicitly | Owner statement recorded in Port |

### 6.4 Phase R — real EPIC data, still no real channel

Only after the gate. Each step is separately owner-gated.

| Step | Action | Note |
|---|---|---|
| **R1** | Replace synthetic business data with EPIC's ratified real description, hours and service area on a **real EPIC tenant** in the new stack | Still no real channel |
| **R2** | Provision the real EPIC tenant through the *normal tenant-owner path* — **not** an administrator bypass (`dec-epic-customer-zero-completion-definition-2026-07-27` §2) | Provider-hat impersonation does not satisfy this |
| **R3** | Real named staff onboarded with distinct, tenant-scoped, **negative-tested** roles | §4 of the completion definition |
| **R4** | Owner walkthrough on **desktop and mobile** | §16 of the completion definition |
| **R5** | Real internal work run through the loops; capture defects from actual use rather than a staged final UAT (`isola-gate-06-customer-zero.next_action`) | — |
| **R6** | `isola_epic_value_score` reaches Operational: `overall_score >= 61`, `daily_adoption >= 6`, `business_loops_live >= 4` | §1.2 |
| **R7** | Freeze the accepted EPIC configuration as the Customer #1 template; a second operator reproduces it without undocumented DB/server changes | §14–15 of the completion definition |

### 6.5 Phase C — real channel

**Out of scope for this pack.** Any Meta/WhatsApp change is owner-only. Under `decision-all-isola-whatsapp-numbers-non-production-2026-08-11` every attached number is non-production and may be disconnected/reconnected during controlled testing — which makes controlled channel testing *safe*, but does not make it *in scope* here. Law 1 (one authoritative processor per number) and G7 govern it.

---

## 7. Acceptance checklist

Four checklists. Every row maps to a row of the 28-row acceptance matrix on `xp-isola-signup-to-agent-mvp-2026-08-10`.

**Legend:** `Pass / Fail` is left empty for the tester. **BLOCKED** means the underlying surface is not built — the row cannot be executed. Matrix results shown are the packet's own recorded results as of 2026-08-11 17:10Z.

### 7(a) Sign-in

| # | Step | Expected observable result | Pass/Fail | Evidence to capture | Matrix row | State |
|---|---|---|---|---|---|---|
| a1 | Open the portal at `portal.saas00.epic.dm` with an invite code, sign up with synthetic identity A | Account created; **no** Stripe/subscription prompt; signup refused without a valid invite | ☐ | Screenshot of the signup form and the success state; HTTP response | **1** | **BLOCKED — WS3 portal not built.** Domain is reserved; the Apptension fork does not exist. Matrix row 1 "Not run" |
| a2 | Attempt signup **without** an invite code, and via the social-auth pipeline | Both refused | ☐ | Two refusal screenshots | **1** | **BLOCKED — WS3.** Packet notes invite gating must close in `UserSignupSerializer.validate()` *and* the social-auth pipeline |
| a3 | Receive and click the verification email | Email arrives; link verifies; account marked verified | ☐ | Email headers, verification confirmation screen | **2** | **BLOCKED — WS3.** Packet warns transactional email silently breaks unless `Dockerfile.render` is used |
| a4 | Sign in with the verified synthetic identity | Lands on Home; correct tenant context shown | ☐ | Screenshot of Home with tenant identifier visible | **3** | **BLOCKED — WS3** |
| a5 | Sign out, sign back in | Tenant and readiness state preserved exactly | ☐ | Before/after screenshots of provisioning status | **24** | **BLOCKED — WS3** |
| a6 | Attempt to sign in to synthetic tenant A with synthetic tenant B's credentials | Refused; no cross-tenant data visible | ☐ | Refusal response | **20** | **BLOCKED — WS3.** Matrix row 20 currently **Partial** — proven at the agent-key layer (403 ×3); portal and Chatwoot layers not built |

### 7(b) Onboarding / company setup

| # | Step | Expected observable result | Pass/Fail | Evidence to capture | Matrix row | State |
|---|---|---|---|---|---|---|
| b1 | Complete company setup with **synthetic** business data (name, description, hours, service area) | Saved; displayed back accurately | ☐ | Form screenshot + persisted values | **4** | **BLOCKED — WS3** |
| b2 | Verify exactly one Apptension organization was created | Count = 1 | ☐ | DB/API count query result | **4** | **BLOCKED — WS3** |
| b3 | Verify exactly one canonical NocoBase tenant exists | Count = 1 | ☐ | NocoBase record | **5** | **BLOCKED — WS4.** NocoBase has **no domain and no root credentials** — unadministrable (§6.2 S2) |
| b4 | Refresh the page and retry provisioning | No duplicates created | ☐ | Repeat count queries; retry response body | **6** | **Partially executable.** Matrix row 6 is **Pass at the Paperclip layer** (retry returned `existing`, `drift: none`). Portal/NocoBase layers **BLOCKED — WS3/WS4** |
| b5 | Verify exactly one Paperclip Company is created for the tenant | Count = 1, created by this journey | ☐ | Paperclip API response | **8** | **BLOCKED — WS4.** Matrix row 8: pre-existing EPIC company reused; **per-tenant creation not yet exercised** |
| b6 | Verify exactly one PUBLIC Front Desk employee is created from Template v1 | Count = 1; exposure = PUBLIC; template = v1 | ☐ | Employee record with template reference | **9** | **Executable at the Paperclip layer — matrix row 9 Pass** (`fd2867d1`, created once, **staged, not ready**). End-to-end via portal **BLOCKED — WS3** |
| b7 | Verify exactly one Chatwoot account / user / team / inbox / AgentBot path | One of each, correctly bound | ☐ | Chatwoot API dump of each object | **10** | **BLOCKED — WS4.** Objects exist on the current stack (account 3 / team 4 / inbox 4 / AgentBot 1) but were **not created by this journey**. Flag: team assignment triggers `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` |
| b8 | Watch the provisioning progress display | Progress is **truthful** — no step reports complete before it is | ☐ | Timed screenshots at each transition | **7** | **BLOCKED — WS3** |
| b9 | Compare displayed IDs against the real backend IDs | Portal shows real Paperclip/Chatwoot/NocoBase IDs, not placeholders | ☐ | Side-by-side portal vs API | **11** | **BLOCKED — WS3** |
| b10 | As the **provider hat**, open NocoBase and confirm tenant, bindings, provisioning history and retry state are visible | All four visible and correct | ☐ | NocoBase screenshots | **27** | **BLOCKED — WS4** (unadministrable) |
| b11 | Repeat b1–b10 for synthetic tenant B with **no manual DB edits** | Full journey repeats cleanly | ☐ | Full second run trace | **28** | **BLOCKED — WS3/WS4** |

### 7(c) Agent test

| # | Step | Expected observable result | Pass/Fail | Evidence to capture | Matrix row | State |
|---|---|---|---|---|---|---|
| c1 | Click **Test Agent** in the portal | A **real** Chatwoot conversation is created — not a simulation | ☐ | Chatwoot conversation ID + portal action log | **12** | **BLOCKED — WS3** |
| c2 | Ask a question answerable from the synthetic business info | Correct answer, grounded only in the synthetic data; no invented fact | ☐ | Full request/response transcript | **13** | **Partially executable.** Matrix row 13 is **Pass for INTERNAL** (`2b4cf82a`, correct 7-column action list); **PUBLIC not yet invoked**. Portal path **BLOCKED — WS3** |
| c3 | Ask about a capability listed as prohibited in the frozen spec (e.g. missed-call recovery, offer X1) | Refusal; no mention as included or upcoming | ☐ | Transcript | **13** | **BLOCKED — frozen spec does not exist** |
| c4 | Ask for a price on an offer whose `price_status` is not `Ratified` (P3) | No price quoted; honest deferral | ☐ | Transcript | **13** | **BLOCKED — frozen spec does not exist**; see OWNER DECISION (5) |
| c5 | Attempt a disallowed runtime tool | Denied | ☐ | Denial log per tool | **22** | **Executable — matrix row 22 Pass**, 14/14 live boundary tests |
| c6 | Present the INTERNAL employee bearer against the PUBLIC template, and the reverse | `403 exposure_mismatch` both directions; request body cannot widen it | ☐ | Both 403 responses | **21** | **Executable — matrix row 21 Pass** at the credential layer |
| c7 | Force a runtime timeout and a provider failure | Honest failure/handoff state; issue → `blocked`; "nothing inferred, guessed or filled in" | ☐ | 504 and 502 responses + issue state | **19** | **Executable — matrix row 19 Pass** |
| c8 | Send a duplicate webhook | Exactly one reply | ☐ | Delivery ledger rows + Chatwoot message count | **18** | **Executable — matrix row 18 Pass**, 3 deliveries → 1 comment, replays in 3–4 ms |
| c9 | Attach a small **synthetic** file; confirm persistence and background job completion | Attachment persists; job completes | ☐ | Storage record + job completion log | **23** | **Not run.** Runtime-layer executable in principle; portal path **BLOCKED — WS3** |
| c10 | From synthetic tenant B, attempt to read, invoke, open or infer tenant A's employee | Denied at every layer | ☐ | Denials per layer | **20** | **Partial — agent-key layer proven (403 ×3)**; portal/Chatwoot layers **BLOCKED** |
| c11 | Confirm no payment, Odoo write, Meta, WhatsApp, PBX or real-customer mutation occurred during c1–c10 | Zero in every category | ☐ | Explicit negative evidence per category | **26** | **Executable — matrix row 26 "Holding — true"** |

### 7(d) Inbox

| # | Step | Expected observable result | Pass/Fail | Evidence to capture | Matrix row | State |
|---|---|---|---|---|---|---|
| d1 | Click **Open Inbox** in the portal | Lands in the correct Chatwoot account/inbox for this tenant only | ☐ | Screenshot of landed inbox with account/inbox IDs | **14** | **BLOCKED — WS3** |
| d2 | Confirm the c1 conversation and the agent's response appear | Both visible, correct content, correct order | ☐ | Conversation screenshot | **14** | **BLOCKED — WS3** for the portal path; the underlying send is proven at the gateway layer |
| d3 | Take over as a human operator | AI is suppressed immediately; no further AI message | ☐ | Chatwoot state + gateway suppression log | **15** | **Proven at the gateway layer** (packet WS2 regressions: "human takeover suppresses"). Matrix row 15 **"Not run"** — the *tenant-journey* row. Portal path **BLOCKED — WS3** |
| d4 | Reply as the human operator | Reply reaches the synthetic test customer **exactly once** | ☐ | Delivery ledger + recipient-side receipt | **16** | Same as d3 — gateway-layer proven, matrix row 16 **"Not run"**, portal path **BLOCKED — WS3** |
| d5 | Perform an **explicit** handback | AI resumes **exactly once**, with context | ☐ | Gateway log showing one resume | **17** | Same — gateway-layer proven, matrix row 17 **"Not run"**, portal path **BLOCKED — WS3** |
| d6 | Add a private note; confirm it is never customer-visible | Note is private | ☐ | Customer-side view showing absence | **14** | **Proven at the gateway layer** (private-note privacy). Portal path **BLOCKED — WS3** |
| d7 | Assign the conversation to a **team**, then have the bot read it | ⚠️ Expect **HTTP 500** on `conversations#show` | ☐ | The 500 response, filed against the defect | **10** | **KNOWN DEFECT — `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`.** Affects both v4.16.1 instances including `inbox.epic.dm`. Reconciliation degrades to fail-closed; no duplicate is possible |
| d8 | Restart the service in place, then replace the container | In-place restart preserves; container replacement must not lose configuration or data | ☐ | Before/after state dumps for both | **25** | **Partial — matrix row 25:** in-place restart preserves; **container replacement loses `/tmp` state (measured)**. WS2 moved dedup to `isola-ledger-db`, closing the duplicate-after-replacement gap |
| d9 | Confirm the tenant's Chatwoot view exposes **no** other tenant's conversations | Zero cross-tenant conversations | ☐ | Search/list result scoped to tenant | **20** | **BLOCKED — WS3/WS4**; Chatwoot layer of row 20 not built |

### 7.1 Checklist summary

| Checklist | Rows | Executable today | Blocked |
|---|---|---|---|
| (a) Sign-in | 6 | 0 | 6 — all on WS3 |
| (b) Onboarding | 11 | 0 fully; 2 partially at the Paperclip layer | 11 — WS3 and WS4 |
| (c) Agent test | 11 | 5 fully (c5–c8, c11), 2 partially (c2, c10) | 4 |
| (d) Inbox | 9 | 1 as a defect confirmation (d7), 1 partially (d8) | 7 |

**The dominant blocker is WS3 — the Apptension customer portal does not exist.** The second is WS4 — NocoBase and Activepieces are running, healthy and **unadministrable** (no domain, no root credentials, signup disabled). Neither is a code defect; both are gated on owner action.

---

## 8. What is deliberately excluded from Customer Zero

Non-goals. Each has a source. Excluding these is a decision, not an omission.

| # | Excluded | Why | Source |
|---|---|---|---|
| 1 | **Payment, checkout, subscriptions, Paymenter** | Deferred until the Signup-to-Agent MVP is accepted. Entitlement is `VERIFIED_SIGNUP + PILOT_APPROVED -> PROVISION`; the later payment implementation reuses the same provisioning workflow | `decision-apptension-customer-portal-nocobase-control-plane-2026-08-10` |
| 2 | **Meta, WhatsApp, Facebook, Instagram, email — any real customer channel** | Explicitly out of MVP scope; Meta changes are owner-only | `xp-isola-signup-to-agent-mvp-2026-08-10` |
| 3 | **PBX and voice** | Out of MVP scope. Magnus remains the voice/DID/CDR authority and is never rebuilt in Isola | Same; CLAUDE.md §1 |
| 4 | **Odoo writes and the embedded Odoo application** | Out of MVP scope. Odoo remains authoritative but is read-only here; matrix row 26 requires zero Odoo writes | `xp-isola-signup-to-agent-mvp-2026-08-10` |
| 5 | **Real customer data and any real customer contact** | Phase S is synthetic-only; the gate in §6.3 governs the transition | Same; this lane's scope |
| 6 | **A general agent marketplace, Soul editor, community templates, arbitrary agent creation** | Out of MVP scope | `xp-isola-signup-to-agent-mvp-2026-08-10` |
| 7 | **The 9043 Hermes internal path** | Protected internal number, explicitly "out of scope"; internal 9043 traffic must not be routed to the customer Chatwoot/Clawith path | `docs/isola/DISCOVERY-LEDGER.md` §6; `dec-epic-customer-zero-authoritative-topology-2026-07-30` |
| 8 | **Rebuilding or extending Hermes** | Gate 05 is **Done** and its standalone internal baseline is **frozen**. Hermes is EPIC-internal operator cockpit only and is never the customer-facing brain | `isola-gate-05-hermes-operator-experience`; CLAUDE.md §1 |
| 9 | **The first external customer** — outreach, deposit, onboarding, activation | HOLD until Customer Zero is accepted in daily operation and frozen as the repeatable template | `dec-isola-restore-master-commercial-launch-plan-2026-08-03` |
| 10 | **Customer #2 / template expansion beyond freezing the EPIC template** | Explicit freeze | Same |
| 11 | **Broad UI, Meta, PBX, agent-catalogue or platform work unrelated to an active EPIC business loop** | Explicit freeze | Same |
| 12 | **Missed-call recovery (offer X1)** | DARK in production. Must not be sold, demoed or implied | `epic_offer:offer-missed-call-recovery-not-offered` |
| 13 | **Multi-extension Hosted Business PBX (offer A1)** | Zero customer-scoped UAT; unresolved Critical tenant-isolation risk on the shared Asterisk context; no ratified price | `epic_offer:offer-epic-hosted-business-pbx` |
| 14 | **A second inbox, a second portal, or any duplicate surface** | Isola does not duplicate the Chatwoot inbox. One canonical customer portal | `dec-epic-customer-zero-completion-definition-2026-07-27` §3; `decision-apptension-customer-portal-nocobase-control-plane-2026-08-10` |
| 15 | **Any published response-time SLA** | Not ratified; Chatwoot CE cannot enforce one; both sellable offers say "do not promise one" | `epic_offer` P1/P2 `support_boundary` |
| 16 | **Generic multi-tenant hardening beyond the two-synthetic-tenant proof** | Row 28 and row 20 define the required isolation proof; broader hardening is not a Customer Zero goal | `xp-isola-signup-to-agent-mvp-2026-08-10`; `dec-epic-customer-zero-three-lane-execution-boundaries-2026-07-30` (Superseded, but the scoping principle is carried forward) |

---

## Appendix A — consolidated OWNER DECISION REQUIRED

| # | Decision | Section | Blocks |
|---|---|---|---|
| 1 | Observable rubric for `daily_adoption >= 6` | §1.2 | The measurable Customer Zero bar |
| 2 | Canonical EPIC business description | §2.2 | All agent grounding; gate G5 |
| 3 | EPIC operating hours and timezone; 24/7 vs after-hours behaviour | §2.3 | Gate G5; business-hours SLA targets |
| 4 | EPIC service area as a speakable claim | §2.4 | Gate G5 |
| 5 | Ratified price for offer P3, or mark it not-sellable | §2.6 | An `agent_recommendable` offer with no price |
| 6 | Canonical name and single system identity per role-holder; reconcile duplicate Chatwoot user 1 / user 3 | §3.2 | Acceptance signatory identity |
| 7 | Synthetic vs migrated role model on the new EasyPanel stack | §3.4 | Phase S role provisioning |
| 8 | How offer facts reach the runtime — transcription into the frozen spec vs a later governed read path | §4.1 | Knowledge grounding design |
| 9 | First-response / next-response / resolution targets per escalation type; business-hours or 24×7 | §5.1, §5.2 | Gate G6 |
| 10 | Non-response path per escalation type — who, after how long, by what mechanism | §5.1, §5.2 | Gate G6 |

Already open on the active packet and **not** re-raised here as new: WS2 acceptance ruling; the two-processor ruling (`risk-two-chatwoot-agent-bot-processors-2026-08-11`); WS4 credential configuration.

## Appendix B — consolidated UNVERIFIED

| # | Item | Section |
|---|---|---|
| 0 | `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` did not exist on disk when this pack was written | Header |
| 1 | The authoritative daily EPIC Odoo (`epic-communications-inc.odoo.com`) has no Port `odoo_instance` catalog record | §2.1 |
| 2 | No EPIC business description exists in any authoritative record | §2.2 |
| 3 | No business-hours clock values exist anywhere — only "defined"/"enabled" flags | §2.3 |
| 4 | EPIC's own service area is not recorded; offer `target_customer` text is not a service-area claim | §2.4 |
| 5 | Public front-door number is internally contradictory (`+17678180001` vs `+17678183742`; and `6737` vs `3742` carried forward unresolved) | §2.5 |
| 6 | No recorded street address and no recorded public email address for EPIC | §2.5 |
| 7 | Owner role-holder identity and surname are inconsistently recorded across Port and Chatwoot | §3.2 |

## Appendix C — sources read

**Port:** `isola_launch_gate` (`isola-gate-06-customer-zero`, `isola-gate-05-hermes-operator-experience`) · `execution_packet` (`xp-isola-signup-to-agent-mvp-2026-08-10` read-only, `xp-ema-demo-green-and-customer1-activation`, `xp-epic-customer-zero-100-percent`, `xp-isola-customer-zero-launch-readiness-2026-08-11`) · `epic_offer` (5 entities) · `isola_epic_value_score` (4 snapshots) · scorecard `isola_epic_daily_value_maturity` · `odoo_client:epic-tenant-zero` · `odoo_instance:epic-odoo-01` · `decision` (9 entities incl. `decision-all-isola-whatsapp-numbers-non-production-2026-08-11`, Ratified).

**Repo:** `docs/isola/DISCOVERY-LEDGER.md` · `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` · `CHATWOOT-FIRST-WORKSPACE-FIXTURE.md` · `CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` · `CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` · `CHATWOOT-R1-EXECUTION-PLAN.md` · `ISOLA-PREDEFINED-AGENT-CATALOGUE.md` · `CLAWITH-CONFIGURATION-FIRST-DOGFOOD-PLAN.md` · `ISOLA-REGISTRY-V1-CONTRACT.md` · `EASYPANEL-TRANSITION-PACK.md` · `META-CUSTOMER-CHANNEL-ECOSYSTEM-DESIGN.md` · `CLAUDE.md`.

**Not written to:** Port (read-only this session) · the active packet · any existing repo file · any Chatwoot, Paperclip, NocoBase or Activepieces object.
