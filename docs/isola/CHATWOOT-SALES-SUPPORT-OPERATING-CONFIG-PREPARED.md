# Chatwoot sales & support operating configuration — PREPARED, NOT APPLIED

**Date:** 2026-08-11
**Revised:** 2026-08-11 — see §15 Revision history. Revised against the owner ruling of
2026-08-11 and the decisions named in §1.0.
**Producer:** Chatwoot native operations lane
**Class:** configuration specification. Prepared for later application by an authorised operator.

---

## 1. Status banner

> ## ⛔ PREPARED CONFIGURATION — NOT VERIFIED DEPLOYED BEHAVIOUR. NOTHING HERE HAS BEEN EXECUTED.
>
> **This session created, modified and deleted exactly zero Chatwoot objects.** No label,
> team, inbox, automation rule, macro, custom attribute, canned response, SLA, agent or
> AgentBot was created, changed or removed. No Chatwoot write API was called. No Port entity
> was written. No employee record, NocoBase schema, Activepieces flow or Meta asset was
> touched.
>
> **Read this document as a proposal, not as a description of the instance.** Every API shape
> in §10 was read from the tagged v4.16.1 **source**; none of it was executed against this
> deployment. Every rule in §§3–9 is prepared configuration. **Repository and document text is
> not evidence of deployed behaviour** (CLAUDE.md §5). §11 is the only place where behaviour on
> this instance would be established, and §11 has not been run.
>
> **⛔ The ratified conversation-state ruling governs first.** Any element of this document that
> contradicts the ruling in §1.0 **must not be applied**, whatever else this document says about
> it, and whatever its stated status elsewhere. Where a rule is both prohibited by the ruling
> and blocked by a defect, the prohibition is the operative reason and the defect is an
> additional constraint on top — never the other way round.
>
> **⛔ Do not modify Chatwoot to make a prepared rule work.** If a rule in this document
> requires a change to Chatwoot itself, it is **deferred**, and the change is a separate,
> separately-authorised item. This packet proposes no Chatwoot patch, no upgrade and no
> monkey-patch.

### 1.0 The ratified conversation-state ruling — binding, and it governs the whole document

Ratified 2026-08-11 as
`decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`, and appended as
a clarification to `decision-one-authoritative-chatwoot-processor-2026-08-11`.

| Condition | Effect on the AI |
|---|---|
| **Team assignment alone** | **Routing metadata. Does NOT silence the AI.** |
| `status = open` | **Silences the AI** |
| A human **user** assignee | **Silences the AI** |
| An explicit human-takeover state | **Silences the AI** |

**The AI may respond only when all three of the following hold at once:**

1. the **PUBLIC** binding is active for `(${CW_ACCOUNT}, ${CW_INBOX_SALES})`;
2. the conversation status is **`pending`**;
3. **no** human-takeover condition exists — no human user assignee, no explicit human-takeover
   state.

**Human handback clears the human-owned state and resumes the AI exactly once. Explicit
handback is the only resume path.** Nothing else — no timer, no resolve, no team change, no
label — resumes the AI.

**"Unassigned" is now defined.** The original text of
`decision-one-authoritative-chatwoot-processor-2026-08-11` said the AI may answer when a
conversation is *"pending and unassigned"*. The owner has disambiguated it: **unassigned means
no human user assignee.** It does **not** mean "no team". A conversation assigned to a team and
to no person, left `pending`, is AI-owned and the AI answers it — by ruling, not by accident.

**Consequence, stated once and applied throughout.** Team assignment is routing metadata only.
**No team-based suppression rule may be applied on this instance.** Any such rule is *wrong*,
independent of any defect. §6.5 carries the full re-classification.

### 1.0.1 Other ratified decisions this revision depends on

| Decision | Effect here |
|---|---|
| `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` | **`isola-gateway` on EasyPanel is the canonical Chatwoot processor.** Foundation is **legacy-only** and must never process the same binding. This **resolves OD-3** and closes P2. |
| `decision-one-authoritative-chatwoot-processor-2026-08-11` (as clarified) | The conversation-state ruling in §1.0. |
| Paperclip replaced Clawith as the runtime | **Naming rule, §1.0.2.** |
| NocoBase is the authoritative control-plane source | Tenant, agent, offer, entitlement and **binding** configuration are sourced from NocoBase. Chatwoot is never the control plane, and this document never proposes it as one. |
| WS2 (`xp-isola-signup-to-agent-mvp-2026-08-10`) **accepted 8/8** | Closes P1's acceptance dependency. The tenant-context and escalation gaps are **P0 product gaps, not WS2 defects**, and are tracked separately (§8.0). |
| `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` | **Stands, unchanged.** The accepted fail-closed limitation and its **separate** patch/upgrade requirement are retained in full (§6.5). |
| `defect-model-initiated-escalation-no-state-transition-2026-08-11` | Governs §8. One durable handoff action for both deterministic and model-initiated escalation; the customer is not told a transfer succeeded until the state transition succeeds; fail closed on failure or ambiguity. |

### 1.0.2 Naming rule — customer-visible strings

**Customer-visible material says "powered by Isola".** Never *Clawith*. Never *Paperclip*.
Never any internal runtime, engine or vendor name.

This applies to every string a customer can read: canned response bodies (§10 step 8), macro
`send_message` bodies (§10 step 9), the inbox unavailable message (§10 step 2), the widget
copy, and the AI's own escalation acknowledgement. **No customer-visible string specified in
this document names an internal runtime**, and none may be authored later that does.

Internal names appearing in this document — `isola-gateway`, `isola-runtime`, Paperclip, Odoo,
Magnus, NocoBase — are **architecture references in an internal engineering document**. They
are not customer-visible copy and must never be copied into any.

### 1.1 What must be true before any step in §10 may be applied

| # | Precondition | Current state | Owner |
|---|---|---|---|
| P1 | `xp-isola-signup-to-agent-mvp-2026-08-10` (WS2) is accepted and its session has handed back. Its synthetic fixtures (account 3, user 6, team 4, inbox 4, AgentBot 1, employees `fd2867d1` / `2b4cf82a`) are released or explicitly frozen as read-only. | **WS2 accepted 8/8.** The acceptance half of P1 is satisfied. What remains of P1 is only the fixture release/freeze: account 3 and its objects stay **read-only to this lane** regardless. | Owner ruling |
| P2 | **RESOLVED.** Which component is the authoritative Chatwoot processor, and which silence model governs. | **Closed by `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`: `isola-gateway` on EasyPanel is the canonical Chatwoot processor; Foundation is legacy-only and must never process the same binding.** The governing silence model is the ruling in §1.0 — status + human **user** assignee + explicit human-takeover state. Foundation's `human_handling` DB flag is legacy and has no authority over this binding. | Ratified |
| P3 | `risk-isola-chatwoot-storage-config-mismatch-2026-08-08` is reconciled — web vs Sidekiq storage, `FRONTEND_URL`, `SECRET_KEY_BASE`. | **Open, High.** Explicitly *not* closed by the L20 baseline packet. | Infra |
| P4 | `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` exists and its approved/prohibited claim list is ratified. Every canned response and macro body in §10 must be checked against it before creation. | Being authored by a parallel lane. **This document does not author a claim list and must not be read as one.** | Parallel lane + owner |
| P5 | The owner has ratified: the stage set (§3), the staleness thresholds (§7), the escalation response targets (§8), and the label retirements in step 11 (one-way). | Not ratified. Raised as OD-1 … OD-9 in §13. | **Owner only** |
| P6 | **No longer a precondition for team-based suppression — that is now prohibited outright.** Every team-based *suppression* rule is **PROHIBITED BY RULING** (§1.0, §6.5) and is not unblocked by closing this defect. `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` remains a precondition only for any future team **assignment** on a bot-handled conversation, for any reason. | **Open, P2**, upstream Chatwoot bug. **Accepted fail-closed limitation; its patch/upgrade is a separate, separately-authorised item.** This packet proposes no Chatwoot change. | Owner |
| P7 | One code dependency has landed: `lead_stage` added to `APPROVED_CUSTOM_ATTRIBUTE_KEYS` in `services/isola-gateway/src/chatwoot.ts`, plus a conditional stamp of `lead_stage: "new"` **only when the key is absent**. **Confirmed required, not optional:** v4.16.1 has no automation action and no macro action that sets a custom attribute, so there is no configuration-only route to stamping a stage. Without P7 every new lead starts with `lead_stage` unset (which §3.1 defines as `new`, so the design degrades rather than breaks). See §5.4. | Not started. | Engineering |
| P8 | Real EPIC customer data is authorised on this instance. The `xp-chatwoot-native-human-baseline-2026-08-10` closeout states verbatim that closing it *"does not authorize real EPIC customer data on this instance"*. | Not authorised. | **Owner only** |

### 1.2 Who authorises

**Eric Giraud**, acting owner, under the same standing authority that closed
`xp-chatwoot-native-human-baseline-2026-08-10`. P5 and P8 are owner-only under CLAUDE.md §6
(material product scope, customer contact). **P2 is closed** by the 2026-08-11 ruling. P1
additionally requires the WS2 session to release its fixtures — this lane must never write to
that packet or its objects.

Application is a separate, authorised session. This document is its input, not its licence.

---

## 2. Target and scope

### 2.1 Which instance — and which one this is *not*

| | Target of this document | Explicitly NOT the target |
|---|---|---|
| Deployment | EasyPanel project `isola`, service `chat` (+ `chatwoot-sidekiq`, `chatwoot-db` `pgvector/pg17`, `chatwoot-redis`) | Deepseek `inbox.epic.dm` |
| Version | Chatwoot **v4.16.1**, Community Edition (runtime-verified: Captain, SLA, Custom Roles and Custom Assignment Policies all render upgrade gates) | v4.16.1 CE, same version, different data |
| Host | `isola-chat.saas00.epic.dm` | `inbox.epic.dm` |
| Processor | **`isola-gateway` (`isola-gw.saas00.epic.dm`) → `isola-runtime` → the agent runtime. Canonical, by ruling.** | Foundation on Replit (`isola-foundation.replit.app/api/chatwoot/agent-bot`) — **legacy only.** It must never process this binding. |
| Silence model | **The §1.0 ruling:** the AI answers only when the PUBLIC binding is active, `status === "pending"`, and no human-takeover condition exists (no human **user** assignee, no explicit human-takeover state). **Team assignment is routing metadata and does not silence the AI.** | Foundation's own `human_handling` DB flag. **Legacy. No authority over this binding.** |
| Governing decision | `decision-gate3-chatwoot-greenfield-no-migration-2026-08-09` — greenfield, no historical migration; and `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` | — |

**Every element of this configuration targets the EasyPanel `chat` instance only.** Nothing
here applies to, is derived from, or may be executed against `inbox.epic.dm`. The two
instances run the same version and are trivially confusable; every apply step in §10 begins
with a host assertion for that reason.

**`risk-two-chatwoot-agent-bot-processors-2026-08-11` is RESOLVED.**
`decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` rules that
**`isola-gateway` on EasyPanel is the canonical Chatwoot processor** and that **Foundation is
legacy-only and must never process the same binding**. This document is written against the
isola-gateway model because it is the ruled-canonical processor, not merely because it happens
to be the one bound here. The governing silence model is the §1.0 ruling, not any component's
implementation detail.

The one-authoritative-processor law (CLAUDE.md §2.1) is therefore satisfied by construction on
this instance: one binding, one processor, one silence model. Human takeover remains a governed
escalation contract, never a second webhook.

### 2.2 Which account — parameterised, with a recommended default

**The configuration is fully parameterised.** Every step in §10 is written against
`${CW_ACCOUNT}`, never a literal account id.

**Recommended default: `${CW_ACCOUNT} = 2`.** Reasons, in order:

1. Account 2 is already named *EPIC Communications Inc* and is already the EPIC tenant on
   this instance. One tenant, one account, is the model the whole routing law rests on
   (`dec-chatwoot-account-inbox-authoritative-routing-2026-07-25`). Creating a second account
   for the same business would manufacture the exact ambiguity that law exists to prevent.
2. Creating a new Chatwoot account requires the `/super_admin` console or the **Platform
   API** — a broader credential surface than the Application API, and one that historically
   carried a token-harvest path on the other instance. Avoiding an account creation avoids
   touching it at all.
3. Account 2 already carries the proven human-only baseline: team 2 `Front Desk`, business
   hours (Mon–Fri 09:00–17:00, *La Paz* GMT-4, matching Dominica/AST), a verified
   administrator, and a proven restricted-Agent RBAC test.

**Accounts this configuration must never be applied to:**

| Account | Why not |
|---|---|
| **3** | Another session's synthetic WS2 fixture (user 6, team 4, inbox 4, AgentBot 1). Read-only to this lane. |
| Account 5 on `inbox.epic.dm` | Different instance. Out of scope per the greenfield decision. |

### 2.3 Which inboxes

| Parameter | Meaning | Recommended value | Note |
|---|---|---|---|
| `${CW_INBOX_SALES}` | The revenue inbox this configuration operates | **to be created** (step 2) | Not inbox 3, not inbox 4 |
| `${CW_INBOX_BASELINE}` | The frozen human-only baseline inbox | `3` (`EPIC Human Baseline Test`, website widget) | **Do not reconfigure.** It is a frozen acceptance fixture. Labels and attributes created here are account-scoped and will become visible on it; that is unavoidable and harmless. Automation rules and saved filters must be scoped to exclude it. |

Inbox 3 is *not* reused as the sales inbox: it is the evidence artefact behind a Done packet,
its name asserts what it is, and rebinding it would destroy the only clean no-AI reference
point on this instance.

### 2.4 Full parameter set

| Parameter | Description | Recommended / source |
|---|---|---|
| `${CW_HOST}` | Chatwoot base URL | `https://isola-chat.saas00.epic.dm` |
| `${CW_ACCOUNT}` | Operating account id | `2` |
| `${CW_INBOX_SALES}` | Sales/support inbox id | created in step 2 |
| `${CW_TEAM_FRONTDESK}` | Front Desk team id | `2` (existing) |
| `${CW_TEAM_ESCALATIONS}` | Escalations team id. **Routing metadata only — it is not and can never be a suppression signal (§1.0, §6.5).** | created in step 3 — **see §6.5 before using it for anything** |
| `${CW_TOKEN_ADMIN}` | Application API token of a human administrator. Never the Platform API. Never an AgentBot token. | operator-held, secret store only |
| `${GW_BINDING_ID}` | isola-gateway binding for `(${CW_ACCOUNT}, ${CW_INBOX_SALES})` | gateway env |

### 2.5 Relationship to the existing design corpus

| Document | Relationship |
|---|---|
| `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` (R0) | **Builds on.** Its edition analysis (CE gaps: no SLA, no audit log, no custom roles, no required resolution attributes, no capacity assignment) holds for v4.16.1 CE and is not re-derived here. Its §11 lifecycle blueprint is the ancestor of §3. Its inventory is of account 5 and does not describe this instance. |
| `docs/isola/CHATWOOT-R1-EXECUTION-PLAN.md` | **Builds on** its execution discipline (before-state capture, one action / one verification / one evidence record, no Platform API, recorded reversal per step). Its R1A–R1G change plan is account-5 work and is out of scope here. |
| `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` | **AUTHORITATIVE for handoff mechanics** (being specified in parallel). §8 references it and deliberately does **not** re-specify the durable handoff action, the explicit human-takeover state, or handback's exactly-once semantics. Where it and §8 differ, **it wins**. |
| `docs/isola/CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` | **LEGACY.** Written when Foundation was a processor; Foundation is now legacy-only (§1.0.1). Its **invariants** survive (§8.1) because the gateway implements them independently; its **routing and processor role are superseded** — see CF-2 and CF-7. This document adds no second escalation contract. |
| `docs/isola/CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` | **Compatible.** Its `SAFE_TO_RETURN` allowlist covers `labels` and `custom_attributes.correlation_id`; §4 and §5 add keys it will project. Its deep-link format is instance-specific (`inbox.epic.dm`) and is superseded for this instance by `${CW_HOST}/app/accounts/${CW_ACCOUNT}/conversations/{display_id}`. |
| `docs/isola/CHATWOOT-FIRST-WORKSPACE-FIXTURE.md` | **Compatible.** Its two genuine manager gaps (overdue follow-ups, approvals/risks) are confirmed here as still native gaps — §7 assigns overdue follow-ups to an external scheduler, not to Chatwoot. |
| `docs/isola/CHATWOOT-DEEPSEEK-TO-COOLIFY-MIGRATION-RUNBOOK.md` | **Superseded and must not be executed** (its own banner says so). No baseline id in it applies here. |
| `artifacts/isola/lib/chatwoot-lead-context.ts` + `artifacts/isola/scripts/setup-lead-pipeline-chatwoot-attrs.sql` | **Direct ancestor of §3.** The stage vocabulary is reused, not reinvented. Explicit deltas in §3.4. That code targets account 5 and applied its definitions by direct Postgres `INSERT`; §10 does not — direct DB mutation is emergency containment, not the operating model (CLAUDE.md §7). |

### 2.6 What this configuration supersedes, explicitly

| Superseded | By | Reason |
|---|---|---|
| `pilot_stage` attribute key (account 5) | `lead_stage` (§5) | "Pilot" is factually wrong for real revenue work. Greenfield instance, no migration, so no rename cost. |
| `source` / `campaign` free-text conversation attributes (account 5) | the `source-*` label group (§4) | Free text is neither enumerable nor natively reportable. Labels are both. |
| `handoff_state`, `ai_mode`, `human_owner` attributes (account 5) | **nothing — deliberately not carried over** (§5.3) | Two of the three inputs to ownership are native Chatwoot fields the processor already reads (`status`, the human **user** assignee). The third — the explicit human-takeover state — belongs to `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`, not to a free-floating Chatwoot attribute. A second copy that can disagree is a defect generator. |
| `urgent` label (account 2, existing) | native conversation `priority` (§4.4) | Chatwoot CE has a first-class priority field. A label duplicating it splits the signal. |
| `sales` / `support` labels (account 2, existing) | `intent-sales` / `intent-support` (§4) | Convention normalisation. Retirement is one-way and owner-gated (step 11, OD-8). |
| The demo automation rule on account 2 (already deactivated, renamed `L20 Verification-Only Demo Automation`) | rule `AR-1` (§10 step 10) | It auto-labelled `sales` with no ratified rule behind it. Leave it deactivated; do not reactivate. |

---

## 3. Lead stages

### 3.1 The stage set — one set, no alternatives

Seven stages. This is the vocabulary already defined in
`artifacts/isola/lib/chatwoot-lead-context.ts` (`PILOT_STAGES`), reused deliberately rather
than reinvented, with the values normalised to machine-safe lowercase-kebab and the key
renamed.

| # | Value | Display | Entry — the stage is entered when… | Exit — the stage is left when… | Who moves it |
|---|---|---|---|---|---|
| 1 | `new` | New | the first inbound message creates the conversation on `${CW_INBOX_SALES}` | a need has been stated **and** a contactable identity is on the contact record (name **and** phone or email) | isola-gateway on first contact (P7); otherwise the operator |
| 2 | `qualified` | Qualified | the need, the rough timing **and** serviceability are all established, and the business can serve it | a demonstration/site survey is scheduled, **or** both parties agree none is needed | operator |
| 3 | `demo` | Demo | a demonstration, site survey or trial is scheduled, with a date recorded in `lead_next_action_at` | the demonstration has happened or was declined, **and** pricing has been asked for or offered | operator |
| 4 | `proposal` | Proposal | a written quote or price has been sent **and** its reference is recorded in `lead_quote_ref` | the customer accepts, declines, or passes the no-response threshold (§7) | operator |
| 5 | `commitment-pending` | Commitment pending | the customer has verbally accepted; a signature, deposit or paperwork item is outstanding | the outstanding item arrives (→ `won`) or is withdrawn (→ `lost`) | operator |
| 6 | `won` | Won | the commercial commitment is complete **and** recorded in Odoo | **terminal.** The conversation transitions to onboarding (§9) | operator |
| 7 | `lost` | Lost | the customer declined, is not serviceable, or passed the no-response threshold — **and** an `outcome-lost-*` label states which | **terminal**, except reactivation (below) | operator |

**Transition law.** Forward-only through 1→5. Any stage may go to `lost`. `lost` may return
to `new` on a genuine reactivation — and only to `new`, so a reactivated lead is re-qualified
rather than resumed mid-pipeline. Skipping forward (e.g. `new` → `proposal`) is permitted and
common; skipping backward is not. **Chatwoot enforces none of this** — see §3.3.

**Unset is `new`.** A conversation with no `lead_stage` value is treated as `new` by every
queue and every threshold. This is not laziness: until P7 lands, the gateway cannot write the
attribute, so unset is the real steady state for a fresh lead and the design must be honest
about it rather than depend on a write that does not happen.

### 3.2 How a stage is represented

**A conversation custom attribute, `lead_stage`, of display type `list`.** Not a label. Not
the conversation status.

### 3.3 Justification against v4.16.1 capability, and the trade-off

**Why not conversation `status`.** Chatwoot's status is a closed set of four values —
`open`, `pending`, `resolved`, `snoozed` — and it is **not free**. Under the §1.0 ruling it is
a **load-bearing input to the ownership contract**: the AI answers only when the PUBLIC binding
is active, `status === "pending"`, and no human-takeover condition exists. The deployed
implementation of that predicate lives in `services/isola-gateway/src/webhook.ts`
(`evaluateSuppression`), which reads `status` and `conversation.meta.assignee` — the **user**
assignee. Repurposing status to carry a pipeline stage would change *who is talking to the
customer* every time a salesperson moved a lead. It is disqualified on safety, not on capacity.

**Why not labels.** Labels in v4.16.1 are a multi-select tag set. There is no mutually-
exclusive label group, no radio-button semantics and no validation preventing two stage
labels on one conversation. The conversation labels endpoint is a **full replacement** of the
set (verified against deployed v4.16.1 source, `services/isola-gateway/src/chatwoot.ts`), so
every writer must read-modify-write; a stage change would become a read, a filter-out of six
sibling labels, and a rewrite — six chances to clobber a human's labels on every stage move.
A stage is mutually exclusive by definition. Labels are the wrong shape for it. This is the
same conclusion `chatwoot-lead-context.ts` reached, and for the same reason.

**Why a `list` custom attribute.** A conversation custom attribute definition of display type
`list` with a populated value set renders as a **single-select dropdown** in the conversation
sidebar. One value at a time, chosen from a closed set, visible to the operator in the place
they are already working, and filterable in the conversation filter builder.

**The trade-off, stated plainly.** Chatwoot CE 4.16.1 Reports include a **Labels** report but
**no custom-attribute report**. Choosing an attribute costs you native stage-distribution
reporting: you cannot open Reports and see how many leads sit in `proposal`.

Two mitigations, both in this configuration:

1. **Saved filters give live per-stage counts.** One saved conversation filter per working
   stage (§10 step 7) puts the count in the sidebar. This is a live queue, not a historical
   report — it cannot answer "how many leads were in proposal last month".
2. **The two terminal outcomes are mirrored as labels** — `outcome-won` and the four
   `outcome-lost-*` labels (§4). Win rate and loss reason therefore *are* natively
   reportable through the Labels report, which is the reporting question that actually gets
   asked. The intermediate stages are not, and that is the accepted cost.

**Duplicate-state risk, acknowledged rather than hidden.** `lead_stage = won` and the
`outcome-won` label encode the same fact twice. The attribute is authoritative; the label is
derived and exists only for reportability. A conversation carrying one without the other is a
**defect**, not a state, and §11 verification V-9 checks for exactly that divergence. No other
part of this design duplicates state — see §5.3, where three account-5 attributes are rejected
for precisely this reason.

### 3.4 Deltas from the ancestor vocabulary

| Ancestor (`chatwoot-lead-context.ts`, account 5) | Here | Why |
|---|---|---|
| key `pilot_stage` | key `lead_stage` | Real revenue work is not a pilot. Greenfield instance, no migration cost. |
| Title-cased values with spaces (`Commitment pending`) | lowercase-kebab (`commitment-pending`) | One convention across labels, attribute values and filter queries. Display names carry the human-readable form. |
| Stage set (7 values) | **unchanged** | The set is sound and was designed against this business. Reinventing it would be gratuitous divergence. |
| `source` / `campaign` / `offer` / `requested_assistant` text attributes | `source-*` labels; `offer` and `requested_assistant` dropped | Free text is unreportable. `offer` and `requested_assistant` had zero writers and no defined vocabulary; adding them now would repeat account 5's 30-unwritten-definitions problem. |

---

## 4. Label taxonomy

### 4.0 What a v4.16.1 label actually is — four fields, and three hard constraints

A Chatwoot label has exactly four writable fields: **`title`**, `description`, `color`,
`show_on_sidebar`. There is **no separate display name**. The `title` *is* the label, and it is
what appears on every conversation. Verified against the v4.16.1 tag
(`app/models/label.rb`, `app/controllers/api/v1/accounts/labels_controller.rb`).

Three constraints the model enforces, all verified in source:

1. **`title` is force-lowercased** before validation (`self.title = title.downcase`). An
   uppercase label cannot be stored. Every title below is already lowercase.
2. **`title` must match `\A[\p{L}\p{N}]+[\p{L}\p{N}_-]+\Z`** (`RegexHelper::UNICODE_CHARACTER_NUMBER_HYPHEN_UNDERSCORE`).
   No spaces. Only unicode letters, digits, `_` and `-`. It may not begin with `_` or `-`, and
   it must be **at least two characters**. Every title below satisfies this.
3. **`title` is unique per account**, enforced by both a model validation and a DB index.

`color` is a plain string column with **no validation at all** (DB default `#1f93ff`). The
swagger describes it as a hex code with the leading `#`, and that is the convention used
throughout this table — but nothing in Chatwoot will reject a malformed value, so a typo lands
silently.

**Groups below are a convention this configuration and its writers honour; v4.16.1 enforces
nothing.** A conversation can carry two labels from the same group and Chatwoot will not
object. Where a group is marked exclusive, exactly one writer is responsible for maintaining
exclusivity, and V-9 checks it.

### 4.1 Lifecycle — exclusive, exactly one at all times

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `lifecycle-lead` | `#1F93FF` | Not yet a customer. The commercial relationship is being established. | Automation `AR-1` on conversation creation | lifecycle (exclusive) |
| `lifecycle-onboarding` | `#7B61FF` | Won. Provisioning is in flight and not yet complete. | Human, at the §9 transition | lifecycle (exclusive) |
| `lifecycle-customer` | `#1B5E20` | Live, provisioned, paying. | Human, when provisioning completes | lifecycle (exclusive) |
| `lifecycle-former` | `#78909C` | Cancelled or churned. Retained for history and reactivation. | Human | lifecycle (exclusive) |

### 4.2 Source — exclusive, at most one, written once and never changed

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `source-inbound-whatsapp` | `#25D366` | Arrived unprompted on a WhatsApp business number. | Automation `AR-1`, keyed on the inbox | source (exclusive) |
| `source-inbound-web` | `#00838F` | Arrived through the website widget. | Automation `AR-1`, keyed on the inbox | source (exclusive) |
| `source-referral` | `#00ACC1` | Named referrer. Record the referrer in a private note. | Human | source (exclusive) |
| `source-outbound` | `#5C6BC0` | EPIC initiated contact. | Human | source (exclusive) |
| `source-walk-in` | `#8D6E63` | Originated off-channel and was entered into Chatwoot by staff. | Human | source (exclusive) |

Source is derivable from the inbox only for the two inbound channels. Everything else is a
human judgement made once, at first contact. A source label is **never** revised — a lead that
came in by referral and later clicked an ad is still a referral.

### 4.3 Intent — exclusive, at most one, revisable

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `intent-sales` | `#8E24AA` | Buying, pricing, availability, new service. | Human (the AI may propose in a private note; it does not apply intent labels) | intent (exclusive) |
| `intent-support` | `#3949AB` | An existing service is not working as expected. | Human | intent (exclusive) |
| `intent-billing` | `#00695C` | Invoice, payment, balance, plan change. | Human | intent (exclusive) |
| `intent-admin` | `#546E7A` | Account details, contacts, documents, non-commercial requests. | Human | intent (exclusive) |

### 4.4 Escalation — exclusive, at most one, cleared on handback

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `escalation-requested` | `#FB8C00` | The customer explicitly asked for a person. | **isola-gateway** escalate path, or human. **Not Foundation** — Foundation is legacy-only and must never process this binding (§1.0.1). | escalation (exclusive) |
| `escalation-ai-limit` | `#F4511E` | The AI could not answer, or the message carried no readable text. Covers the gateway `handed_off` and `handoff_blocked` outcomes. | isola-gateway | escalation (exclusive) |
| `escalation-complaint` | `#C62828` | Dispute, refund, or a customer who is upset. Priority `high` or `urgent`. | Human | escalation (exclusive) |
| `escalation-billing` | `#AD1457` | A billing matter the front desk may not settle. | Human | escalation (exclusive) |

### 4.5 Outcome — exclusive, at most one, terminal

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `outcome-won` | `#2E7D32` | Commitment complete and recorded in Odoo. Mirrors `lead_stage = won`. | Human, with the stage change | outcome (exclusive) |
| `outcome-lost-price` | `#B71C1C` | Lost on price or terms. | Human | outcome (exclusive) |
| `outcome-lost-no-response` | `#616161` | Passed the no-response threshold (§7) with no decision. | Human, or the stale scheduler at Tier 3 if OD-5 permits | outcome (exclusive) |
| `outcome-lost-not-serviceable` | `#455A64` | EPIC cannot serve the location or the requirement. | Human | outcome (exclusive) |
| `outcome-lost-other` | `#757575` | Any other loss. **Requires a private note stating the reason** — an unexplained `other` is a reporting hole. | Human | outcome (exclusive) |

### 4.6 AI state — exclusive, at most one, written only by isola-gateway

These two already exist as the gateway's compiled defaults
(`DEFAULT_ANSWERED_LABEL` / `DEFAULT_ESCALATED_LABEL`,
`services/isola-gateway/src/config.ts`). Their titles are **fixed by deployed configuration**,
not chosen here. Creating them as account labels adds a colour, a description and a Settings
entry; it does not change what the gateway writes.

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `isola-ai-answered` | `#90A4AE` | The AI sent the customer an answer on the last delivery. | isola-gateway (outcome `replied`) | ai-state (exclusive) |
| `isola-ai-escalated` | `#FF7043` | The AI did not answer; the conversation was escalated or handed off. | isola-gateway (outcomes `escalated`, `handed_off`, `handoff_blocked`) | ai-state (exclusive) |

**Why these two must be created before the gateway is bound.** The conversation labels
endpoint sets `label_list` through `acts_as_taggable`, which creates a *tag*, not an account
`Label` record. A tag with no Label row has no colour, no description and no Settings entry.

> **UNVERIFIED:** whether v4.16.1 back-fills an account `Label` record for a tag created this
> way. The mechanism above says it does not, but that was inferred from the code path rather
> than observed. **Mitigation, which makes the answer not matter:** step 4 creates both labels
> explicitly *before* step 12 binds the gateway, so the Label record exists either way.

### 4.7 Operational — not grouped

| `title` | `color` | `description` | Applied by | Group |
|---|---|---|---|---|
| `awaiting-customer` | `#FFB300` | The ball is with the customer. Suspends the staleness clock for one threshold period (§7). | Human | none |
| `followup-due` | `#F9A825` | The stale scheduler has flagged this conversation. Cleared on the next inbound or outbound message. | Stale scheduler (§7, Tier 1) | none |

### 4.8 Existing labels on account 2

| Existing | Disposition | Gate |
|---|---|---|
| `sales` (red) | Superseded by `intent-sales`. Retire in step 11. | OD-8 — **one-way** |
| `support` | Superseded by `intent-support`. Retire in step 11. | OD-8 — **one-way** |
| `urgent` | Superseded by native `priority`. Retire in step 11. | OD-8 — **one-way** |

Deleting a label removes it from every conversation carrying it, and re-creating the label
does not restore those assignments. On this instance the only conversations are synthetic UAT
fixtures, so the loss is nil — but it is still a one-way step and still owner-gated. The
lower-risk alternative is to leave all three in place, unused; that is defensible and costs
nothing but a cluttered picker.

---

## 5. Custom attributes

### 5.1 Conversation attributes

| Key | Display name | Type | Applies to | Written by | Allowed values |
|---|---|---|---|---|---|
| `lead_stage` | Lead Stage | `list` | conversation | Operator (Chatwoot UI); **isola-gateway** once P7 lands. **Not Foundation** — it is legacy-only for this binding (§1.0.1). | `new`, `qualified`, `demo`, `proposal`, `commitment-pending`, `won`, `lost` |
| `lead_next_action_at` | Next Action Due | `date` | conversation | Operator only | A calendar date. The stale scheduler **reads** it and never writes it — see §7.4. |
| `lead_quote_ref` | Quote Reference | `text` | conversation | Operator only | The Odoo quotation/opportunity reference. Odoo remains authoritative for the quote itself; this is a pointer, not a mirror. |
| `onboarding_ref` | Onboarding Reference | `text` | conversation | **Foundation only** | The Foundation provisioning record id. Written once at the §9 transition. |
| `isola_tenant_id` | Isola Tenant ID | `text` | conversation | **isola-gateway only** | Tenant UUID |
| `isola_agent_id` | Isola Agent ID | `text` | conversation | **isola-gateway only** | Runtime agent id. Operator-facing display name is **Isola Agent ID**; no internal runtime name is rendered anywhere a customer can see (§1.0.2). |
| `isola_last_outcome` | Isola Last Outcome | `text` | conversation | **isola-gateway only** | `replied`, `escalated`, `handed_off`, `handoff_blocked` (the `DeliveryOutcome` union, `services/isola-gateway/src/pipeline.ts`) |
| `isola_last_correlation_id` | Isola Last Correlation ID | `text` | conversation | **isola-gateway only** | Correlation id |
| `isola_last_run_at` | Isola Last Run At | `text` | conversation | **isola-gateway only** | ISO-8601 **timestamp**. Deliberately `text`, not `date`: the gateway writes `new Date(...).toISOString()`, a full datetime, which a `date`-typed field would not render. |

The five `isola_*` keys are not a proposal. They are the exact contents of
`APPROVED_CUSTOM_ATTRIBUTE_KEYS` in `services/isola-gateway/src/chatwoot.ts` — the gateway
writes these and silently drops everything else. Creating the definitions gives them display
names and sidebar placement; it does not change what is written.

### 5.2 Contact attributes

| Key | Display name | Type | Applies to | Written by | Allowed values |
|---|---|---|---|---|---|
| `business_name` | Business Name | `text` | contact | Operator | Free text. The trading name, when the contact is a person acting for a business. |
| `service_area` | Service Area | `text` | contact | Operator | Free text. The parish/district for serviceability. Not an address — the full address belongs in Odoo. |

Two only. Account 5 accumulated 35 definitions of which 5 were ever written; that is the
failure mode to avoid, and the only defence is refusing to define a field until a named writer
exists for it.

### 5.3 Attributes deliberately NOT created

| Rejected | Reason |
|---|---|
| `handoff_state` | **Not a second Chatwoot-side copy of the takeover state.** Under the §1.0 ruling, the conditions that silence the AI are `status`, the human **user** assignee, and an explicit human-takeover state. The first two are native Chatwoot fields the gateway already reads. The third is **not** defined here: its durable representation and its transition mechanics are specified in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`, which is authoritative for it. Minting a free-floating `handoff_state` conversation attribute in Chatwoot would create a fourth writer of a fact that contract owns, with no rule saying which wins. Account 5 carries this attribute; account 2 will not. **If the handoff contract later requires a Chatwoot-side projection of the takeover state, it defines it — this document does not, and this document is not the place to invent one.** |
| `ai_mode`, `human_owner` | Same reason. `human_owner` in particular duplicates the native **user** assignee, which is also what drives Chatwoot's own notifications and reports — and which is the exact field the §1.0 ruling makes load-bearing. |
| `source`, `campaign` | Superseded by the `source-*` label group — enumerable and natively reportable, which free text is not. |
| `offer`, `requested_assistant` | No writer, no vocabulary, no reader. Define them when something writes them. |
| `correlation_id` | The gateway already writes `isola_last_correlation_id`. A second correlation key with a different name on the same conversation is how cross-system audit gets harder, not easier. |

### 5.4 The write-path constraint that governs all of §5

Four facts, all verified against the v4.16.1 tag and the deployed gateway client:

1. **Conversation attributes REPLACE. Contact attributes MERGE.** They are different
   endpoints with different semantics, and confusing them destroys data:

   | | Endpoint | Semantics |
   |---|---|---|
   | Conversation | `POST /api/v1/accounts/{a}/conversations/{c}/custom_attributes` with `{"custom_attributes": {...}}` | **Plain assignment.** Keys you omit are **destroyed**. Read-modify-write is mandatory. |
   | Contact | `PUT /api/v1/accounts/{a}/contacts/{id}` with `{"custom_attributes": {...}}` at top level | **Merge.** Existing keys survive. |
   | Contact, delete keys | `POST /api/v1/accounts/{a}/contacts/{id}/destroy_custom_attributes` with `{"custom_attributes": ["key1"]}` | Array of key names. |
   | Conversation, delete keys | — | **No such endpoint exists.** Removing a conversation key means rewriting the whole object without it. |

2. The gateway already implements the read-modify-write correctly
   (`getCustomAttributes` → `mergeCustomAttributes` → `setCustomAttributes`) and **skips the
   write entirely if the read fails**, because clobbering an operator's attributes is worse
   than not writing. **Any scheduler or Foundation action added later must adopt the identical
   discipline.**
3. **The gateway will not write `lead_stage`.** `filterApprovedAttributes` drops any key
   outside the five `isola_*` keys. So until P7 lands, no automated path stamps a stage and
   every new lead's `lead_stage` is unset. §3.1 makes unset ≡ `new` for exactly this reason.
4. **No automation rule and no macro can set a custom attribute.** Verified: the 19 automation
   action names and the 16 macro action names in v4.16.1 contain no set-attribute action.
   **P7 is therefore required, not optional** — there is no configuration-only route to
   stamping a stage.

The P7 change is one line — adding `"lead_stage"` to `APPROVED_CUSTOM_ATTRIBUTE_KEYS` — plus
the pipeline supplying `lead_stage: "new"` **only when the attribute is currently absent**, so
a later delivery never resets an operator's stage back to `new`. That conditional is the whole
risk of P7 and must be tested before it ships.

**Verified definition constraints** (`app/models/custom_attribute_definition.rb`, v4.16.1):

- `attribute_display_type` enum: `text:0, number:1, currency:2, percent:3, link:4, **date:5**, list:6, checkbox:7`
- `attribute_model` enum: `conversation_attribute:0, contact_attribute:1` (a third,
  `company_attribute:2`, exists but is tied to the premium `companies` flag — do not use it)
- `attribute_key` must match `\A[\p{L}\p{N}_.\-]+\z` — no spaces; not case-folded; no minimum
  length. Unique per `(account_id, attribute_model)`.
- `attribute_key` **may not collide with a standard attribute**. For conversations those are:
  `status priority assignee_id inbox_id team_id display_id campaign_id labels
  browser_language country_code referer created_at last_activity_at`. None of the eleven keys
  in §5.1–§5.2 collides.
- Asymmetry worth knowing: the create body takes `attribute_display_type` / `attribute_model`
  as **integers**, but the read response returns them as **enum name strings** (`"text"`,
  `"conversation_attribute"`). A round-trip comparison that expects integers back will fail.

---

## 6. Ownership model

### 6.0 The governing ruling — read this before any table in §6

The four-row ruling of §1.0 governs every rule in this section, and every rule elsewhere in
this document that touches who is speaking to the customer:

| Condition | Effect on the AI |
|---|---|
| **Team assignment alone** | **Routing metadata. Does NOT silence the AI.** |
| `status = open` | **Silences the AI** |
| A human **user** assignee | **Silences the AI** |
| An explicit human-takeover state | **Silences the AI** |

The AI may respond only when **all three** hold: the **PUBLIC binding is active**, the
conversation is **`pending`**, and **no human-takeover condition exists**. Human handback
clears the human-owned state and resumes the AI **exactly once**; **explicit handback is the
only resume path**.

**Team assignment is nowhere in that list, and may never be added to it by configuration.**

### 6.1 The authoritative state table

On this instance, ownership is not a field. It is the combination of `status`, the human
**user** assignee (`meta.assignee`), and the explicit human-takeover state defined by
`docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`. `meta.team` is **not** part of it.
This table is the whole ownership model.

| `status` | `meta.assignee` (human **user**) | Human-takeover state | `meta.team` | Owner | AI behaviour | Gateway reason code | Meaning |
|---|---|---|---|---|---|---|---|
| `pending` | null | none | **any — set or unset** | **AI** | Replies | — (`{action: "reply"}`) | The AI holds the conversation. The only state in which it speaks. **A team may be assigned here and the AI still answers — by ruling.** |
| `pending` | set | any | any | **Human** | Silent | `human_assigned` | A human claimed it without opening it. Legitimate, and the quietest way to take over. |
| `pending` | null | **present** | any | **Human** | Silent | (handoff contract) | Explicit human takeover without an assignee. Silencing here is a ruling requirement; the mechanics belong to the handoff contract. |
| `open` | null | any | any | **Nobody** | Silent | `status_not_pending` | **Escalated and unclaimed.** The dangerous state — see §6.3. |
| `open` | set | any | any | **Human** | Silent | `status_not_pending` | Normal human ownership. |
| `resolved` | any | any | any | Nobody | Silent | `status_not_pending` | Closed. |
| `snoozed` | any | any | any | Nobody | Silent | `status_not_pending` | Deferred. Chatwoot un-snoozes on schedule or on a new inbound. |

**The `meta.team` column is deliberately "any" on every row.** That is the ruling made visible:
there is no combination of team values that changes the AI's behaviour on any row.

> **Deferred, not proposed.** The third row — silencing on an explicit human-takeover state with
> no assignee — is a **ruling requirement whose Chatwoot-side representation is not specified
> here**. The deployed `evaluateSuppression` reads `status` and `meta.assignee` only. Closing
> that gap is the handoff contract's work, not this packet's. **This document proposes no
> Chatwoot change and no gateway change to implement it.** Until it is implemented, the
> operating rule that covers the same ground is A2/A3: takeover is expressed by assigning a
> named human user, which the deployed predicate already honours.

### 6.2 Assignment rules

| Rule | Statement |
|---|---|
| **A1** | A new conversation on `${CW_INBOX_SALES}` is created `pending` and **unassigned**. No automation assigns it. This is the AI-owned state, and it is the default. |
| **A2** | A human takes over by **assigning themselves** — `POST /api/v1/accounts/{a}/conversations/{c}/assignments {"assignee_id": <id>}`, or the UI assignee picker. That single act silences the AI (`human_assigned`) without changing status, so the conversation does not jump queues. **This route is `POST` only** — there is no `PATCH`, `PUT` or `DELETE` on it, and `PATCH /conversations/{id}` accepts `priority` and nothing else. |
| **A3** | A human hands back by **clearing the assignee and setting status to `pending`**. Both are required. Clearing the assignee alone leaves an `open` conversation, which is still silent. ⚠ **Clearing is done by sending the key with an explicit `null`** — `{"assignee_id": null}`. The controller gates on `params.key?`, so *omitting* the key does not unassign; it falls through and does nothing. |
| **A4** | Round-robin auto-assignment is **OFF** on `${CW_INBOX_SALES}`. Auto-assigning on creation would set a human **user** assignee (`meta.assignee`) and permanently silence the AI on every conversation. Team 2 `Front Desk` currently has auto-assign **on** — see §6.5. |
| **A5** | **No automation rule may contain `assign_team` or `assign_agent`.** For `assign_agent`, because it sets a human user assignee and silences the AI (A4). For `assign_team`, because a team assignment on a bot-handled conversation triggers `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` — **and because, per §1.0, it would achieve nothing anyway: a team assignment does not silence the AI.** Precedent: owner ruling D2 on the other instance (`CHATWOOT-R1-EXECUTION-PLAN.md` §4.4) — no account-wide automation may overwrite governed escalation routing. |
| **A6** | The escalated-and-unclaimed state is discovered through the `Escalated & unclaimed` saved filter and the native Unassigned tab, not through an assignment. Discovery is a queue problem, not an assignment problem. |
| **A7** | **A team assignment is never a takeover.** Assigning a team routes and reports; it does not silence the AI and must never be documented, trained or tooled as though it does. The only takeover acts are A2 (assign a named human user) and the explicit human-takeover path in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`. |

### 6.3 What "unassigned" means — defined by ruling, and still ambiguous in one specific way

**Definition, per the 2026-08-11 clarification to
`decision-one-authoritative-chatwoot-processor-2026-08-11`: "unassigned" means *no human user
assignee*. It does not mean "no team".** A conversation assigned to a team and to no person is
**unassigned** for every purpose in this document, and the AI answers it when the status is
`pending`.

With that settled, one real ambiguity remains — and it is about status, not teams.
`meta.assignee == null` alone still says nothing useful, because it means two opposite things:

- with `status = pending`: **the AI is handling it.** Correct, expected, the steady state.
- with `status = open`: **it has been escalated and no human has picked it up.** Every second
  here is a customer waiting while nobody is looking.

Any queue, alert or report that filters on "unassigned" without also constraining status is
wrong. Every saved filter in §10 step 7 constrains both. **No queue may substitute a team
condition for the assignee condition** — a team constraint answers a different question
entirely and would silently mis-populate F1 and F2.

### 6.4 Interaction with the silence model — five consequences

**C-1. Team assignment does not silence the AI — and that is now the RULE, not an accident of
implementation.**

*The finding.* The gateway reads `conversation.meta.assignee`, which in a Chatwoot webhook
payload is the **user** assignee. A team assignment populates `meta.team`, which
`evaluateSuppression` never reads. A conversation assigned to a team but to no person, and left
`pending`, is **still answered by the AI**. Silence on the gateway's escalate path comes from
the `toggle_status → open` call that runs *before* the team assignment, not from the
assignment.

*The status of that finding, as of 2026-08-11.* When this document was first written, this was
reported as an **implementation hazard** — behaviour that happened to be true and that any
team-based design would have to work around. The owner ruling has **adopted it as the
contract**: team assignment is routing metadata and does not silence the AI, by decision. The
implementation and the ruling now agree, and the ruling is the authority.

*What follows.* A team-based suppression rule is not a rule that is currently broken and will
work later. It is a rule that is **wrong**, permanently, and no defect fix makes it right. See
§6.5.

**C-2. The gateway's escalation write order is fixed and must not be reasoned around.**
From `services/isola-gateway/src/pipeline.ts`: private note → `toggle_status: open` → team
assignment (only when `escalationTeamId` is configured) → labels → custom attributes. On the
no-readable-text handoff path, the customer acknowledgement is sent **only after** status and
assignment both succeed; if either fails, nothing is said to the customer and the outcome is
`handoff_blocked`. That ordering is load-bearing: it exists so the gateway cannot tell a
customer a colleague has taken over when no colleague has.

**C-3. Chatwoot has its own native bot-failure escalation, and it is invisible to this
taxonomy.** When a webhook delivery to the bot fails and the conversation is `pending`, and
the account lacks the `keep_pending_on_bot_failure` feature (it does lack it), Chatwoot
**auto-opens** the conversation and posts an `agent_bot.error_moved_to_open` activity. No
Isola code runs, so **no label is applied and no attribute is written**. The result is an
`open`, unassigned, unlabelled conversation. This is why the escalation queue in §10 step 7
is defined on **status and assignee**, never on a label: a label-based queue silently misses
every native auto-open.

**C-4. `toggle_status` auto-assigns when a human agent drives it to `open`.** Verified in
v4.16.1: `set_conversation_status` checks `should_assign_conversation?`, and when the
resulting status is `open` **and the caller is a human agent**, the conversation is assigned
to that caller. This is a useful safety property and it narrows §6.3: the `open` + unassigned
state cannot arise from a human clicking Open. It arises only from the gateway's escalate
path (which calls `toggle_status` as the **bot**, and therefore triggers Chatwoot's own
`bot_handoff!` instead of a self-assignment) and from the native auto-open in C-3. Both are
machine-produced, which is exactly why F1 is the alarm it is.

**C-5. `toggle_status` with no `status` field is a toggle, not a no-op.** Omitting `status`
calls `Conversation#toggle_status`, which flips `open ⇄ resolved` and forces `pending` or
`snoozed` to `open`. **Always send `status` explicitly.** An omitted field here silently
changes who owns the conversation.

### 6.5 Team-based rules — PROHIBITED BY RULING, and additionally blocked by a defect

> ### ⛔ REASON 1 (GOVERNING) — PROHIBITED BY RULING
>
> **`decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`, and the
> 2026-08-11 clarification to `decision-one-authoritative-chatwoot-processor-2026-08-11`:
> team assignment is routing metadata and does NOT silence the AI.**
>
> **Every rule in this document that treats a team assignment as an ownership, suppression,
> takeover or handoff signal is WRONG and must never be applied.** Not deferred. Not pending a
> fix. Wrong.
>
> This prohibition is **independent of any defect**. If
> `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` were closed tomorrow, a
> team-based suppression rule would still be prohibited, because the ruling — not the bug — is
> what forbids it. A rule built on "assigning a team stops the AI" encodes a belief the owner
> has ruled false, and it would fail silently: the AI would keep answering a conversation the
> operator believed a team had taken over.

> ### ⚠ REASON 2 (ADDITIONAL CONSTRAINT, ON TOP) — `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`
>
> **This defect stands, unchanged, and is retained in full.** It constrains a narrower thing
> than Reason 1: **any** team assignment on a conversation an AgentBot handles — for routing,
> for reporting, for any purpose at all — not merely a suppression rule.
>
> **The defect.** In v4.16.1, `_team.json.jbuilder` renders `Current.user.teams`. For an
> AgentBot, `Current.user` is an `AgentBot`, which has no `teams` association. So
> `GET /conversations/{id}` — `conversations#show` — returns **500 once a team is assigned**.
>
> **Why that is severe here, and not merely cosmetic.** `conversations#show` is the *only*
> conversation read an AgentBot token is permitted. From the deployed v4.16.1
> `AccessTokenAuthHelper::BOT_ACCESSIBLE_ENDPOINTS`, the messages index is not bot-accessible
> (`GET .../messages` answers `401 {"error":"Access to this endpoint is not authorized for
> bots"}`). The gateway therefore uses `conversations#show` for three things, all of which
> degrade the moment a team is assigned:
>
> | Gateway function | Effect of the 500 |
> |---|---|
> | `reconcileDeliveryRef` — proving whether a reply was already sent | Returns `inconclusive`. The caller **fails closed**: an unproven absence is not an absence, so the reply is **not sent**. A real customer answer can be withheld. |
> | `getCustomAttributes` — the read half of the read-modify-write | Read fails, so the attribute write is skipped. `isola_last_outcome`, `isola_last_correlation_id` and the rest are silently never written. |
> | `getConversationRecord` — restart recovery | The delivery cannot be rebuilt from the system that owns the message. |
>
> This is present-tense, not hypothetical: on the gateway's own escalate path, **`annotate()`
> runs *after* the team assignment**, so configuring `escalationTeamId` makes the attribute
> write fail on **every** escalation. That finding is retained verbatim.
>
> **The fail-closed behaviour is ACCEPTED, not a thing to design around.** Withholding an
> unprovable reply is the correct outcome and must stay correct.
>
> **⛔ The patch/upgrade is a SEPARATE requirement, and this packet does not carry it.** No
> Chatwoot patch, no version upgrade, no monkey-patch and no workaround inside Chatwoot is
> proposed, specified or authorised here — **and none may be proposed merely to make a
> prepared rule in this document work.** Any rule that would need one is **deferred**.

**Ordering, stated explicitly.** Reason 1 governs. Reason 2 is an additional constraint layered
on top. A reader deciding whether to apply a team-based rule stops at Reason 1 and never
reaches Reason 2. A reader deciding whether to assign a team for a *legitimate non-suppression*
purpose passes Reason 1 and is then stopped by Reason 2.

**Which rules this re-classifies.** Every one of the following was previously marked
*CONDITIONAL — BLOCKED BY DEFECT*. Each is now re-classified against the stronger reason:

| Rule / location | Was | Now |
|---|---|---|
| `assign_team ${CW_TEAM_ESCALATIONS}` on the escalate path (§8.2 E1–E6, §10 step 12 `escalationTeamId`) | Conditional — blocked by defect | **PROHIBITED BY RULING.** It was only ever wanted because a team was believed to route *and* to mark the conversation as human-owned. It does not mark anything. Additionally blocked by the defect. |
| `assign_team` for domain routing, billing vs technical (§6.5 alternative table) | Conditional — blocked by defect | **Not prohibited by the ruling** — routing is exactly what a team legitimately is. **Blocked by the defect** on bot-handled conversations, and therefore **deferred**. |
| Team assignment as a takeover signal (§6.2 A7, §6.6) | Conditional — blocked by defect | **PROHIBITED BY RULING.** A team is never a takeover. |
| A5 — no `assign_team` in any automation rule (§6.2) | Blocked by defect | **Prohibited by ruling** for any suppression intent; **blocked by the defect** for any other intent. Either way: no `assign_team` in any automation rule. |
| `Escalate — complaint` macro, no team assignment (§10 step 9) | Blocked by defect | **Prohibited by ruling**, plus the defect. Unchanged in effect: still no team. |
| Step 3a `Escalations` team creation (§10 step 3) | Created but unused | **Unchanged — still created, still unused.** Creating a team is not assigning one. |

**The design that §10 actually applies — unchanged in substance, corrected in justification:**

| Instead of | Do this | Trade-off |
|---|---|---|
| `assign_team ${CW_TEAM_ESCALATIONS}` on escalation | Leave the conversation with **no human user assignee**. `status = open` plus the `escalation-*` label plus the `Escalated & unclaimed` saved filter is the whole routing mechanism. **`status = open` is what silences the AI here — per the ruling — and it always was.** | No team-level routing. Everyone with inbox membership sees one shared escalation queue. Acceptable at current headcount (one administrator, one restricted agent); it will not scale past a handful of operators. |
| `assign_team` for domain routing (billing vs technical) | Use the `intent-*` labels plus one saved filter per intent. | Labels do not notify. A team assignment produces a Chatwoot notification; a label does not. Discovery becomes pull, not push. **Deferred** against the defect, not prohibited. |
| Team assignment as a takeover signal | **Assign a named human user** (`assignee_id`). It both silences the AI (§1.0, §6.1) and notifies that person. | Requires a person, not a rota. |

**Do `${CW_TEAM_ESCALATIONS}` and team 2 `Front Desk` still get created and kept?** Yes —
teams remain correct for human-only inboxes and for reporting, which is what routing metadata
is for. Step 3 creates the team; **nothing in this configuration assigns a conversation to it**,
and nothing ever treats a team as a suppression signal. **Team 2 `Front Desk` currently has
auto-assign enabled**; that must be turned off before the team is ever attached to
`${CW_INBOX_SALES}`, or A4 is violated — note that A4 is about auto-assigning a **user**, which
genuinely does silence the AI.

### 6.6 The AI-vs-human ownership contract

**This contract encodes the §1.0 ruling exactly. Where any other text in this document differs,
this section and §1.0 win.**

#### 6.6.1 The ruling, as the contract states it

| Condition | Effect on the AI |
|---|---|
| **Team assignment alone** | **Routing metadata. Does NOT silence the AI.** |
| `status = open` | **Silences the AI** |
| A human **user** assignee | **Silences the AI** |
| An explicit human-takeover state | **Silences the AI** |

#### 6.6.2 The clauses

| Clause | Statement |
|---|---|
| **O1** | **The AI may respond if and only if all three hold: (a) the PUBLIC binding for `(${CW_ACCOUNT}, ${CW_INBOX_SALES})` is active; (b) `status = pending`; (c) no human-takeover condition exists — no human **user** assignee, and no explicit human-takeover state.** There is no other AI-ownership signal, no flag and no attribute. |
| **O1a** | **"Unassigned" means no human *user* assignee.** It does **not** mean "no team". This is the owner's disambiguation of the original decision text, and it is binding on every rule, queue, macro and scheduler clause in this document. |
| **O1b** | **A team assignment is routing metadata and never silences the AI.** A `pending` conversation assigned to a team and to no person is **AI-owned and the AI answers it**. No configuration may be applied that assumes otherwise (§6.5). |
| **O2** | A human takes ownership by assigning **a named human user** (A2), and the AI is silent from the next inbound message. No handshake, no acknowledgement, no wait. **Assigning a team is not taking ownership.** |
| **O3** | **The AI never resumes on its own.** Human handback clears the human-owned state and resumes the AI **exactly once**. **Explicit handback is the only resume path** — no timer, no resolve, no team change, no label, no elapsed time and no scheduler may resume it. Handback is the explicit human act in A3: assignee cleared **and** status set to `pending`. |
| **O3a** | "Exactly once" is a property the resume path must guarantee, not an aspiration. A handback that fires twice is a defect, not a retry. The durable mechanism is specified in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`; this document does not re-specify it. |
| **O4** | Chatwoot's **Resolve** is not a handback. This is `def-chatwoot-resolve-acts-as-handback-<legacy-runtime>-session-survives-2026-07-30`, a structural property of Chatwoot, not a bug in Isola. **The 2026-08-11 ruling makes O3 the governing rule: resolve is not an explicit handback, so it must not resume the AI.** What Chatwoot itself does on reopen is still unobserved on this instance — see UV-9 / OQ-1, which the ruling narrows but does not close. |
| **O5** | The AI never claims to have done anything it cannot do, and stops talking after it escalates. That is the employee template's own contract (`artifacts/isola/templates/employees/isola-ai-sales-front-desk-agent/v1/AGENTS.md`), not a Chatwoot setting, and Chatwoot cannot enforce it. |
| **O6** | Chatwoot is **never** the authorization authority. Chatwoot's two role tiers (`administrator`, `agent`) gate Chatwoot's own settings screens only. Custom roles are Enterprise and absent. Foundation `Membership.role` is authoritative for every governed action. |
| **O7** | Chatwoot is **never** the control plane. Tenant, agent, offer, entitlement and **binding** configuration are sourced from **NocoBase**, which is authoritative for them. Chatwoot holds the conversation and nothing else. |
| **O8** | **`isola-gateway` is the only processor for this binding.** Foundation is legacy-only and must never process it. Two processors on one binding is the failure this ruling exists to prevent. |

#### 6.6.3 Every place this document previously used a team as an ownership signal — corrected

| Location | Was | Corrected to |
|---|---|---|
| §6.1 state table | `(status, meta.assignee)` pair, no team column | `status` + human **user** assignee + human-takeover state; `meta.team` explicitly "any" on every row |
| §6.2 A5 | "no `assign_team`" justified by the defect | Justified by the ruling first, the defect second; A7 added |
| §6.5 | "CONDITIONAL — BLOCKED BY DEFECT" | "PROHIBITED BY RULING", defect as an additional constraint |
| §8.2 E1–E6 | "**no team** (§6.5)" — read as a defect workaround | **no team**, because a team would neither route the ownership nor silence the AI. `status = open` is the silencing act. |
| §9.1 transition | "Assign a **named human** (never a team — §6.5)" | Unchanged in effect; the reason is now O1b, not the defect |
| §10 step 12 `escalationTeamId` | "must be left ABSENT while the defect is open" | Must be left **ABSENT**, full stop — a team would not silence the AI, and the defect additionally breaks attribute writes |
| §13 CF-2 | Superseded by the defect | Superseded by the **ruling**, and additionally by the defect |

---

## 7. Stale-lead follow-up

### 7.1 The mechanism decision, and why it is forced

**Chatwoot automation rules cannot do this — VERIFIED, three independent ways, against the
v4.16.1 tag.**

1. **The listener is purely event-driven.** `AutomationRuleListener` exposes exactly five
   discrete callbacks — `conversation_created`, `conversation_updated`, `conversation_opened`,
   `conversation_resolved`, `message_created` — each fired synchronously from the Rails event
   dispatcher. There is no polling entry point. (The public docs list four; `conversation_opened`
   is real but undocumented. `event_name` has **no server-side validation**, so a typo is
   persisted silently and simply never fires — a real configuration hazard.)
2. **No automation job is scheduled.** `config/schedule.yml` runs `TriggerScheduledItemsJob`
   every 5 minutes, which fans out to exactly five things: one-off campaigns, reopen snoozed
   conversations, reopen snoozed notifications, auto-resolve conversations, and WhatsApp
   template sync. **Automation-rule evaluation is not among them.**
3. **Age cannot even be expressed as a condition.** `created_at` and `last_activity_at` exist
   in `lib/filters/filter_keys.yml` with `is_greater_than` / `days_before` operators — but
   they are **absent from `AutomationRule#conditions_attributes`**, so a rule using either is
   rejected at create time with `422 "Automation conditions created_at not supported."`

There is no "after N hours with no activity" trigger in Chatwoot v4.16.1, in any edition.

**The one native elapsed-time mechanism is auto-resolve, and it is the wrong tool.** Verified
shape: it is **account-level, not inbox-level** — there is no `auto_resolve_*` field on Inbox.
The current field is `auto_resolve_after`, a `store_accessor` on `accounts.settings`, measured
in **minutes** (minimum 10, maximum 1,439,856), set by a flat top-level body on
`PATCH /api/v1/accounts/{account_id}`. The older `accounts.auto_resolve_duration` column
(in days) still exists in the schema and is **no longer read** — do not set it.
`auto_resolve_ignore_waiting` exists and skips conversations awaiting an agent reply, and
`auto_resolve_label` additively stamps a label on resolution.

It is still the wrong tool for a sales pipeline: it resolves without a human judgement and
without a recorded reason. `auto_resolve_label` could stamp `outcome-lost-no-response`, which
makes it *less* wrong — but a lead closed by a timer is a lead nobody decided to lose.
**Recommendation: leave auto-resolve OFF** (OD-5). It is off by default on a greenfield
account, so the recommendation is to change nothing.

**Therefore: an external scheduler.** Not a Chatwoot automation, not a macro (a macro is
operator-triggered, never time-triggered).

**Which scheduler is an open question (OD-6).** Activepieces 0.87.0 is deployed in the `isola`
project and would be the natural home, but it is **unadministrable** — no domain, no bootstrap
credentials — and the same is true of NocoBase. The available alternative is a scheduled job
in `isola-runtime`. This configuration does not choose; it specifies the contract the scheduler
must satisfy (§7.4), which is identical either way. **Whatever runs it, it is not a second
processor for this binding** (O8) and it is not a resume path (G2a).

### 7.2 Thresholds — proposed, requiring ratification

All windows are **business hours** on the inbox's own schedule (Mon–Fri 09:00–17:00, La Paz
GMT-4 = AST, matching Dominica). A weekend does not age a lead.

| Stage | Staleness threshold | Measured from | Action |
|---|---|---|---|
| `new` (incl. unset) | **4 business hours** | the last inbound message with no outbound after it | Tier 1 |
| `qualified` | **2 business days** | the last message in either direction | Tier 1 |
| `demo` | **1 business day** after `lead_next_action_at` | the recorded demo date | Tier 1 |
| `proposal` | **3 business days** | the message that carried the quote | Tier 1 + the note proposes a specific follow-up |
| `commitment-pending` | **2 business days** | the last message in either direction | Tier 1 + raise `priority` to `high` |
| `won` | n/a | — | governed by §9, not by staleness |
| `lost` | n/a | — | terminal |

Two threshold rules that are **not** per stage, and matter more than any of the above:

| Condition | Threshold | Action |
|---|---|---|
| `status = open` **and** unassigned | **30 minutes** in business hours | Tier 1 + `priority` → `high`. This is the §6.3 dangerous state and the §6.4 C-3 blind spot. It is the single highest-value alarm in this configuration. |
| Any `escalation-*` label **and** unassigned | **15 minutes** in business hours | Tier 1 + `priority` → `urgent` |

**"Unassigned" in both rows means *no human user assignee* (O1a).** A team assignment does not
clear either alarm, because a team assignment does not mean anybody has picked the conversation
up. A conversation sitting `open` with a team and no person is exactly the state these two
alarms exist to catch, and it must keep firing.

**Suspension.** The `awaiting-customer` label suspends the stage clock for exactly one
threshold period, then it resumes and the label is cleared. This prevents `awaiting-customer`
becoming a permanent silencer — which is what it would become if it suspended the clock
indefinitely.

> **OWNER DECISION REQUIRED (OD-4):** every number in this section is a proposal by this lane.
> None has been agreed. They are stated as exact values rather than "TBD" so the owner has
> something concrete to accept, amend or reject — not because they are settled.

### 7.3 The follow-up action, in three tiers

| Tier | Action | Customer-visible | Permitted when | Status |
|---|---|---|---|---|
| **1 — Nudge** | Exactly one private note per threshold crossing, stating the stage, the elapsed time and the recommended next action. Apply `followup-due`. Optionally raise `priority`. | **No** | Any status except `resolved` | Recommended for v1 |
| **2 — AI follow-up to the customer** | An AI-composed message to the customer | **Yes** | Only under §7.4, and only through a new gateway code path that does not exist | **Not in v1.** See §7.5 |
| **3 — Auto-loss** | Set `lead_stage = lost`, apply `outcome-lost-no-response`, add a private note, resolve | No customer contact | Only after the `proposal` or `commitment-pending` threshold has been crossed **twice** with no response | **OD-5.** Recommended OFF in v1 |

`followup-due` is cleared by the scheduler on the next message in either direction. A stale
`followup-due` on an active conversation is noise, and noise is how an alarm stops being read.

### 7.4 The guardrail — preventing an AI follow-up to a human-owned conversation

This is the load-bearing safety requirement of §7.

**The guardrail is code, not configuration. Chatwoot cannot enforce it.** Chatwoot has no
per-token capability scoping, so a scheduler holding any Application API token can post a
public message to any conversation. The guardrail therefore has the same class and the same
weakness as the AI-suppression gate itself (C7 in the R0 design): it is a **code-side**
obligation on whichever component runs the scheduler, and its absence is silent.

Mandatory clauses for any scheduler that acts on this account:

| # | Clause |
|---|---|
| **G1** | **Re-read at action time, never act on scan-time state.** The gap between "this looked stale" and "I am about to write" is exactly when a human takes over. Every write is preceded by a fresh `GET /conversations/{id}`. |
| **G2** | **Apply the §1.0 ruling predicate verbatim** before any customer-visible action: the PUBLIC binding is active **and** `status === "pending"` **and** there is no human-takeover condition — no human **user** assignee, no explicit human-takeover state. Not an equivalent, not an approximation — the identical predicate, so no two components can disagree about who owns a conversation. **`meta.team` is not an input and must not be read.** A scheduler that treated a team assignment as "a human has this" would fall silent on conversations the AI legitimately owns, and would still act on conversations a person actually owns. |
| **G2a** | **The scheduler is not a resume path.** Per O3, explicit human handback is the only way the AI resumes. A scheduler must never clear an assignee, never set `status` to `pending`, and never take any action whose effect is to hand a conversation back to the AI. |
| **G3** | Additionally refuse if: any `escalation-*` label is present; `lead_stage ∈ {won, lost}`; `lifecycle-onboarding` or `lifecycle-customer` is present; the conversation is `snoozed`. |
| **G4** | **Tier 1 is private-only.** The scheduler's note-posting path is structurally incapable of posting a public message — `private: true` is a constant in that path, not a parameter. A boolean that can be `false` will eventually be `false`. |
| **G5** | **One note per threshold crossing.** Idempotent on `(conversation_id, stage, threshold_generation)`, in the scheduler's own store. Repeated scans must not repeat the note. Chatwoot offers no help: `messages.source_id` has no unique index and no uniqueness validation in v4.16.1, so there is **no database-enforced idempotency** available — the claim must be the scheduler's own. |
| **G6** | **Read-modify-write for labels and attributes.** Both endpoints are full replacements (§5.4). If the read fails, skip the write. |
| **G7** | **The scheduler never writes `lead_stage`** — except at Tier 3, if OD-5 permits it. Stage is a human judgement. A scheduler that advances stages produces a pipeline that reports on its own timer rather than on reality. |
| **G8** | **The scheduler never writes `lead_next_action_at`.** It reads it. That field is the operator's commitment; a scheduler that rewrites it erases the commitment it was supposed to check. |

### 7.5 Why Tier 2 is not in v1 — two independent blockers

1. **There is no code path.** A Chatwoot AgentBot is only invoked on `message_created`. Nothing
   in the gateway can be triggered by a timer, and adding an outbound-initiated path means a
   new endpoint with its own claim column and its own idempotency — a build item, not
   configuration. The delivery-ledger discipline in `services/isola-gateway/src/ledger.ts`
   (reserve before ACK, exactly-once) is the pattern it would have to follow.
2. **The WhatsApp 24-hour window.** Any customer-visible follow-up more than 24 hours after
   the last inbound message falls outside Meta's customer-service window and requires an
   approved message template. Templates are a Meta asset change and therefore **owner-gated**
   (CLAUDE.md §6). Almost every threshold in §7.2 lands outside 24 hours. Tier 2 is
   consequently a Meta problem before it is a Chatwoot problem.

---

## 8. Escalation

### 8.0 Where the handoff mechanics are specified — and it is not here

> **⛔ `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` is AUTHORITATIVE for the
> handoff mechanics.** It is being specified in parallel. **This document does not re-specify
> them and must not be read as a second source for them.** Where this section and that contract
> differ, **that contract wins**, and this section is what must change.

What that contract owns, and this document therefore does not define:

- the durable handoff action itself — its identity, its claim, its idempotency, its retry and
  its failure semantics;
- the representation and lifecycle of the **explicit human-takeover state** (the fourth row of
  the §1.0 ruling), including how handback clears it exactly once;
- the tenant-context propagation that a handoff carries.

What **this** document still owns: the Chatwoot-side *configuration* that the handoff acts on —
the `escalation-*` labels (§4.4), the saved-filter queues that surface an escalated
conversation (§10 step 7), the response targets (§8.2), and the rule that no team is assigned
(§6.5).

**`defect-model-initiated-escalation-no-state-transition-2026-08-11` governs this section.**
Three requirements follow from it and are binding on every row of §8.2:

| # | Requirement |
|---|---|
| **H1** | **One durable handoff action.** Deterministic escalation (a rule fired, a gateway outcome) and **model-initiated** escalation (the AI itself decides a person is needed) route through the **same** durable handoff action. There are not two escalation paths with two sets of semantics; a model-initiated escalation is not a message the AI sends and hopes about. |
| **H2** | **The customer is not told a transfer succeeded until the state transition succeeds.** No acknowledgement, no "I'm passing you to a colleague", no closing message may precede a confirmed state transition. This is the same ordering the gateway already enforces on the no-readable-text path (C-2) — the defect is that the model-initiated path did not enforce it. |
| **H3** | **Fail closed on failure or ambiguity.** If the state transition fails, or its outcome cannot be proven, **say nothing to the customer** and record a truthful operational failure. An unproven success is a failure. This is the same discipline as `reconcileDeliveryRef` returning `inconclusive` (§6.5) and it is accepted, not worked around. |

**Consequence for this document, stated plainly.** Rows E1 and E5 in §8.2 describe
model-initiated escalation. Their **Chatwoot-side configuration** — which labels, which status,
which queue, which target — is specified here and is unaffected. Their **mechanics** — how the
escalation becomes a durable action, when the customer may be told, what happens on failure —
are the handoff contract's, are **currently defective** per the named defect, and are **not
fixed by anything in this packet**. Until that contract lands, E1 and E5 are **deferred as
mechanisms**, live only as Chatwoot configuration.

### 8.0.1 Relationship to the older Foundation handoff contract

`docs/isola/CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` (§§3–8) is the **legacy** contract,
written when Foundation was a processor. Foundation is now legacy-only and must never process
this binding (§1.0.1). Its invariants (§8.1) survive because they are sound and are
independently implemented in `services/isola-gateway/src/pipeline.ts` and `handoff.ts`; its
**routing** does not — see CF-2. **`RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` supersedes
it for handoff mechanics.** This document creates no third contract.

### 8.1 The invariants inherited, not restated

Exactly one private note per episode. At most one customer-facing message per episode.
Assignment failure keeps the AI suppressed and records a truthful operational failure rather
than telling the customer a human is engaged. Fail closed on any routing mismatch. Chatwoot CE
writes no audit log, so no acceptance may cite one — the conversation activity log and the
gateway's own delivery ledger are the record.

These are consistent with H1–H3 and are not a separate set. Where H1–H3 are stricter, H1–H3
govern.

### 8.2 Trigger → action → notification → target → fallback

| # | Trigger | Detected by | Action, in order | Notification | Target first human response | Fallback if unanswered |
|---|---|---|---|---|---|---|
| **E1** | Customer explicitly asks for a person | The employee runtime returns an escalate result — **model-initiated, therefore governed by H1–H3 and currently defective as a mechanism (§8.0)** | private note → `toggle_status: open` → **no team** (§6.5) → labels `escalation-requested` + `isola-ai-escalated` → **then, and only if the state transition succeeded (H2)**, the AI's own single closing message. On failure or ambiguity: **say nothing** (H3) | `Escalated & unclaimed` filter + native Unassigned tab | **15 min** in hours | +15 min: `priority` → `urgent`. +30 min: second private note; out-of-band owner alert |
| **E2** | Message carries no readable text (attachment-only, empty, unsupported content type) | Gateway `{action: "handoff"}` — deterministic | `toggle_status: open` → **no team** → one private note (reason, attachment type and count, correlation id) → **then** exactly one customer acknowledgement, verbatim from `handoff.ts`. **This path already satisfies H2**: the acknowledgement follows the transition, never precedes it | same | **30 min** | same as E1 |
| **E3** | AI runtime failure — `runtime_no_text`, `reply_failed`, `reply_unresolved` | Gateway escalate path — deterministic | private note → `toggle_status: open` → **no team** → label `isola-ai-escalated` → **no customer message at all** | same | **15 min** | same as E1 |
| **E4** | The handoff itself failed — `handoff_blocked` | Gateway | private note stating **nothing was said to the customer**. Status may still be `pending`. | **The status-based filter misses this.** Caught only by the `AI blocked` filter on `isola_last_outcome = handoff_blocked` | **15 min** | Manual. Treat as an incident if it recurs. |
| **E5** | Complaint, dispute, refund, or an upset customer | Employee template rule (**model-initiated — H1–H3 apply, as E1**); or operator judgement | As E1, plus `escalation-complaint`, plus `priority` → `high` | same | **15 min** | Owner notified out of band |
| **E6** | Billing matter beyond the front desk | Operator judgement | As E1, plus `escalation-billing` + `intent-billing` | `Billing` saved filter | **1 business hour** | +1 business hour: `priority` → `high` |
| **E7** | **Chatwoot's own bot-failure auto-open** — webhook delivery to the bot failed | Chatwoot, natively. `agent_bot.error_moved_to_open` activity | Chatwoot sets `open`. **No Isola code runs: no label, no note, no attribute.** | **Only** the status-based `Escalated & unclaimed` filter and the Unassigned tab. This is precisely why that filter is status-based (§6.4 C-3). | **15 min** | Investigate gateway availability — E7 means a delivery failed, not that a customer needed a person |

### 8.3 Response targets are measured, not enforced

**There is no SLA enforcement available to this configuration.** Every target in the table
above is an operating commitment observed through the saved filters and the native
first-response-time report. Nothing in Chatwoot will page anyone, breach anything, or escalate
on its own. Any SLA clock and breach ledger is a Foundation obligation (R1 execution plan
§6.1), unbuilt.

Two things are separately true and should not be conflated:

- **The SLA UI is gated on this instance.** Runtime-verified on account 2: SLA, Captain,
  Custom Roles and Custom Assignment Policies all render upgrade screens. `config/features.yml`
  marks `sla` as `premium: true, enabled: false`.
- **Whether the SLA *API* is reachable on a stock image is unresolved.** In the v4.16.1 source,
  the `sla_policies` and `applied_slas` routes are **not** wrapped in an
  `if ChatwootApp.enterprise?` guard the way some other enterprise routes are, and the SLA
  cron iterates accounts that have policy rows without checking the feature flag.

> **UNVERIFIED:** whether `GET /api/v1/accounts/${CW_ACCOUNT}/sla_policies` responds on this
> deployment. Read from source layout, never executed. **This does not change the design** —
> a feature whose UI is gated and whose availability is uncertain cannot carry a customer
> commitment. But nobody should assert "the SLA endpoints are absent" without probing, and
> nobody should create an SLA policy row on the strength of a probe that happens to answer:
> on the other instance two SLA policies existed for months with `applied_slas = 0`, inert
> decoration that a later session mistook for an active clock.

> **OWNER DECISION REQUIRED (OD-7):** the response targets above are this lane's proposals.

### 8.4 Handback — the only resume path

**Per §6.6 O3: explicit human handback is the only way the AI resumes, and it resumes exactly
once.** Nothing else does it — no timer, no elapsed threshold, no resolve, no team change, no
label, no scheduler (G2a).

The Chatwoot-side act is: **clear the assignee *and* set status to `pending`. Both.** Clearing
the assignee alone leaves the conversation `open` and therefore silent, which looks like a
handback and is not one. Setting `pending` while a human user assignee remains is likewise not
a handback — it is the `human_assigned` state.

The `Hand back to AI` macro (§10 step 9) is the operator affordance for doing both in one click.
**The macro is an affordance, never an enforcement** — CE cannot require a field or a sequence
before a status change, so nothing in Chatwoot prevents a half-handback.

> **Deferred to the handoff contract.** Clearing the **explicit human-takeover state**, and the
> exactly-once property of the resume, are specified in
> `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`. This document does not specify
> them and proposes no Chatwoot or gateway change to implement them. Until that contract lands,
> the two Chatwoot fields above are the whole of what an operator can do, and the exactly-once
> guarantee is **not yet in place** — which is a known gap, honestly stated, not a solved
> problem.

---

## 9. Handoff to onboarding

### 9.1 The transition

| Question | Answer |
|---|---|
| **Trigger** | An operator sets `lead_stage = won`. Nothing else triggers it. |
| **What closes** | **Nothing in Chatwoot.** The sales conversation is explicitly *not* resolved at this point. Resolving would (a) discard the live thread the customer will use to ask about their installation, and (b) put the conversation into the ambiguous reopen state in OQ-1. |
| **What opens** | A Foundation provisioning record and the Odoo customer/order. Both are outside Chatwoot. Chatwoot has no concept of provisioning and must not be given one. |
| **A second Chatwoot conversation?** | **No.** One contact on one inbox keeps one conversation. Opening a second splits the timeline, and on a WhatsApp inbox the channel will route the customer's next message to whichever conversation Chatwoot picks — which is exactly the ambiguity that produces duplicate-processor bugs. |
| **Chatwoot changes, in order** | 1. `lead_stage` → `won`. 2. Add `outcome-won`. 3. Remove `lifecycle-lead`, add `lifecycle-onboarding` (read-modify-write). 4. Foundation writes `onboarding_ref` (Foundation remains the **provisioning** authority; "legacy-only" applies to Chatwoot *processing*, not to entitlements or provisioning). 5. Assign a **named human user** — **never a team**. A team assignment would leave the conversation AI-owned (O1b) and so would not protect it at all; only a named user does. 6. Status stays `open`. |
| **What carries across** | Contact identity; the conversation display id and its deep link `${CW_HOST}/app/accounts/${CW_ACCOUNT}/conversations/{display_id}`; `isola_tenant_id`; `isola_last_correlation_id`; `onboarding_ref`; the outcome and lifecycle labels; the full message and private-note history. |
| **What does not carry across** | Any commercial term. Price, plan, discount and contract terms live in Odoo from this moment. A private note may reference them; Chatwoot never becomes their source. |

### 9.2 Which system becomes authoritative, and when

| From the moment `lead_stage = won` is set | Authority |
|---|---|
| **Odoo** | The commercial record — customer, order, invoice, plan, price. |
| **Foundation** | Entitlements, governed provisioning, permissions, audit correlation. `onboarding_ref` points here. |
| **Magnus** | Any DID, number or PBX artefact provisioned as part of the sale. Never rebuilt in Isola. |
| **Chatwoot** | The conversation timeline **only**. It is authoritative for what was said and when, and for nothing else. |

Chatwoot was never authoritative for the sale. What changes at `won` is not Chatwoot's role —
it is that a second and third system acquire records that must not diverge from it, and the
only defence against divergence is that Chatwoot holds pointers (`onboarding_ref`,
`lead_quote_ref`) rather than copies.

### 9.3 The AI-ownership constraint at the transition — a real hazard

The silence predicate does not read `lead_stage`. Per §1.0 it reads status, the human **user**
assignee and the human-takeover state. **A won conversation returned to `pending` with no human
user assignee is answered by the sales AI**, which will attempt to sell to a customer who has
already bought.

Three mitigations, all required:

1. A conversation carrying `lifecycle-onboarding` or `lifecycle-customer` **must never be set
   to `pending`**. This is an operating rule; Chatwoot cannot enforce it.
2. It must keep a named **human user** assignee, which silences the AI independently of status
   (§6.1). **Assigning the onboarding *team* would not do this** — it is routing metadata and
   leaves the conversation AI-owned (O1b). This is the single most likely place for the old
   team-based intuition to cause a live customer-visible failure, which is why it is called out
   here rather than only in §6.5.
3. The stale scheduler refuses to act on it (§7.4 G3).

**There is no onboarding AI employee.** The repository defines exactly two employee templates —
`isola-ai-sales-front-desk-agent` (PUBLIC) and `epic-staff-operations-coordinator` (INTERNAL).
Onboarding is therefore **human-owned in v1**, and that is a statement of fact about what
exists, not a policy preference.

> **OWNER DECISION REQUIRED (OD-9):** whether onboarding is ever AI-assisted. If it is, it
> needs its own PUBLIC employee and its own binding, and a second employee on one inbox is not
> a capability the current one-binding-per-inbox model has.

### 9.4 When the conversation may finally be resolved

When provisioning is complete **and** the customer has been told so in the conversation. Then
`lifecycle-onboarding` → `lifecycle-customer`, and resolve.

The state the conversation reopens into on the customer's next message is OQ-1 and must still
be **observed** before this step is performed routinely. What the ruling changes: the operating
rule no longer depends on the answer — **resolve is not a handback, and the AI does not resume
on a reopen** (O3, O4). The observation now determines whether a *defect* is owed against the
gateway and the handoff contract, not which policy to adopt.

---

## 10. Apply plan

### 10.1 Rules that apply to every step

1. **Host assertion first.** Every step asserts `${CW_HOST}` is the EasyPanel instance. The two
   Chatwoot instances run identical versions and are trivially confusable.
2. **Precondition check before mutation.** Every step reads the current collection first and
   **skips** if the object already exists. This is what makes each step re-runnable without
   creating duplicates — not any idempotency guarantee from Chatwoot.
3. **Before-state capture is a precondition, not a courtesy.** The rollback in §12 is valid
   only against the before-state captured at apply time. If live state has drifted, re-capture
   and re-plan.
4. **One action, one verification, one evidence record.** No batching of unrelated mutations.
5. **Application API only** (`api_access_token`, a human administrator's token). **Never** the
   Platform API. Never an AgentBot token for an admin operation. Never direct Postgres — the
   ancestor `setup-lead-pipeline-chatwoot-attrs.sql` did exactly that on account 5, and it is
   emergency containment, not the operating model (CLAUDE.md §7).
6. **Projection on every read.** Never print a raw inbox, webhook or agent_bot response — they
   carry `provider_config`, `secret` and `access_token`. Use the allowlist discipline in
   `scripts/src/guard-chatwoot-safe-read.ts`.
7. **UI-first for definitions.** Where a step's API body shape is not verified, the admin UI
   path is given as primary. A dropdown never needs an enum value to be guessed.

### 10.2 The steps

---

#### Step 0 — Preflight (no mutation)

**Precondition check**
```
GET ${CW_HOST}/api
```
**Expected:** `{"version":"4.16.1", ...}`. If the version differs, stop — this document is
version-specific.

> `/api` on a cold worker falsely reports `"data_services":"failing"`. That is a known
> artefact of a cold worker, **not** an outage. Re-request before treating it as a fault. Only
> the `version` field gates this step.

**Also capture, as the before-state record:** the full lists of labels, custom attribute
definitions, teams, inboxes, automation rules, macros, canned responses and saved filters on
`${CW_ACCOUNT}`, projected to non-credential fields. This capture **is** the rollback baseline.

**Expected before-state on account 2**, from the frozen baseline:
labels `sales`, `support`, `urgent`; one custom attribute definition `l20_baseline_marker`;
teams `Front Desk` (id 2) and an unexplained team literally named `Team`; inbox 3; one
**deactivated** automation rule; one macro (id 1); one canned response (`greeting`); zero saved
filters; zero agent bots; zero webhooks. **Any deviation means the instance moved and this plan
must be re-planned, not forced.**

---

#### Step 1 — Confirm the target account

**Precondition check:** UI → `${CW_HOST}/app/accounts/${CW_ACCOUNT}/settings/general`.
**Expected:** account name *EPIC Communications Inc*. If `${CW_ACCOUNT}` resolves to the WS2
synthetic account (3) or anything else, **stop**.

**No mutation.**

---

#### Step 2 — Create the sales inbox

**Precondition check:** UI → Settings → Inboxes. Skip if an inbox with the target name exists.

**UI path:** Settings → Inboxes → **Add Inbox** → choose the channel → name it → **do not add
agents yet** → Finish.

**Settings that are load-bearing and must be set explicitly:**

| Setting | Value | Why |
|---|---|---|
| Enable auto assignment | **OFF** | A4. Auto-assignment sets `meta.assignee` on creation and permanently silences the AI on every conversation. |
| Enable business hours | **ON**, Mon–Fri 09:00–17:00, La Paz (GMT-4) | Matches the frozen baseline and Dominica/AST. §7 thresholds are measured against it. |
| Unavailable message | Set, truthful | The only out-of-hours acknowledgement the customer gets. |
| CSAT | **OFF** | Deliberate. Precedent D6 on the other instance: CSAT stays off until AI suppression, escalation, human response and explicit handback are all proven. None is proven on this instance. |
| Inbox members | Added in step 3 | An inbox with zero members is a black hole — inbox 17 on the other instance took nine conversations nobody could see. |

**Record `${CW_INBOX_SALES}`** from the resulting URL.
**Expected:** the inbox appears in the list; `GET /api/v1/accounts/${CW_ACCOUNT}/inboxes`
includes it. Project the response — a raw inbox record carries `provider_config`.

> **OWNER DECISION REQUIRED (OD-2):** which channel. A website widget is applicable
> immediately. A WhatsApp channel is a Meta asset change, owner-gated, and subject to the
> one-authoritative-processor law — it must not be created without a per-number ruling under
> `risk-two-chatwoot-agent-bot-processors-2026-08-11`. **Recommendation: website widget for
> v1.**

---

#### Step 3 — Teams and inbox membership

**Precondition check:** UI → Settings → Teams.

**3a.** Skip if a team named `Escalations` exists; otherwise create it. Description:
`Routing metadata only. A team assignment does NOT silence the AI (ratified 2026-08-11). No conversation is assigned to this team: team-based suppression is PROHIBITED BY RULING, and any team assignment on a bot-handled conversation is additionally blocked by defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11. See docs/isola/CHATWOOT-SALES-SUPPORT-OPERATING-CONFIG-PREPARED.md §6.5.` Record `${CW_TEAM_ESCALATIONS}`.
**Allow auto-assign: OFF.**

**3b.** Set team 2 `Front Desk` **auto-assign to OFF** (it is currently on). Required by A4
before the team is associated with `${CW_INBOX_SALES}` in any way.

**3c.** Add inbox members to `${CW_INBOX_SALES}`.
> ⚠ **The inbox-members update is a FULL REPLACEMENT** — every agent not named in the call is
> removed. Always send the complete target list, never the additions. This exact behaviour
> cost the other instance a documented near-miss (R1 plan §4.1). On a brand-new inbox the
> current list is empty, so the target list is simply the full intended set.

**3d.** Leave the unexplained team named `Team` **untouched**. It is an open administrative
question for the owner (OQ-3), not this lane's to resolve, and not a security finding.

**Expected:** Settings → Teams shows `Front Desk`, `Escalations`, `Team`. The sales inbox lists
its members.

---

#### Step 4 — Labels (25 objects)

**Precondition check**
```
GET ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/labels
Header: api_access_token: ${CW_TOKEN_ADMIN}
```
**Skip any label whose `title` already exists.** Chatwoot enforces title uniqueness per
account, so a re-run without the check produces a `422`, not a duplicate — but checking first
makes the step clean rather than merely safe.

Note the response-shape asymmetry when scripting: **`index` returns
`{"payload":[ … ]}` (wrapped), while `create`, `show` and `update` return the bare object.**
`DELETE` returns an empty body.

**API — verified against the v4.16.1 tag** (`labels_controller.rb`:
`params.require(:label).permit(:title, :description, :color, :show_on_sidebar)` — exactly
those four fields, nothing else):

```
POST ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/labels
Content-Type: application/json
api_access_token: ${CW_TOKEN_ADMIN}

{ "title": "lifecycle-lead",
  "description": "Not yet a customer. The commercial relationship is being established.",
  "color": "#1F93FF",
  "show_on_sidebar": true }
```

A flat body is correct: Rails parameter wrapping is enabled
(`config/initializers/wrap_parameters.rb`), so the controller's `params.require(:label)` is
satisfied by an unwrapped JSON object. `{"label": { … }}` also works.

**Expected response:** `200` with the bare object, `title` echoed **lowercase**, and `id`
present. Repeat once per row in §4.1–§4.7, 25 in total.

**Equivalent UI path:** Settings → Labels → **Add Label**.

**Two constraints that will bite a careless run** (both §4.0):
`title` is force-lowercased, so a title typed with capitals lands lowercase and a later exact
comparison fails; and `color` has **no validation at all**, so a malformed hex is accepted
silently and shows as a broken swatch rather than an error.

**Order matters for two of them.** `isola-ai-answered` and `isola-ai-escalated` must exist
**before** step 12 binds the gateway (§4.6).

**Expected end state:** 25 new labels; the pre-existing `sales`, `support`, `urgent` untouched
(step 11 handles those); 28 total.

---

#### Step 5 — Custom attribute definitions (11 objects)

**Precondition check**
```
GET ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/custom_attribute_definitions?attribute_model=conversation_attribute
GET ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/custom_attribute_definitions?attribute_model=contact_attribute
```
Both return a **bare JSON array** (no `payload` wrapper). Skip any `attribute_key` present.

**API — verified against the v4.16.1 tag.** Permitted fields:
`attribute_display_name`, `attribute_description`, `attribute_display_type`, `attribute_key`,
`attribute_model`, `regex_pattern`, `regex_cue`, `attribute_values[]`. (`default_value` appears
in the response but is **not** permitted on write.)

```
POST ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/custom_attribute_definitions
Content-Type: application/json
api_access_token: ${CW_TOKEN_ADMIN}

{ "attribute_display_name": "Lead Stage",
  "attribute_key": "lead_stage",
  "attribute_description": "The single pipeline stage this lead is in. Mutually exclusive.",
  "attribute_display_type": 6,
  "attribute_model": 0,
  "attribute_values": ["new","qualified","demo","proposal","commitment-pending","won","lost"] }
```

Enum values for the remaining ten definitions: `attribute_display_type` — `text` = **0**
(all `isola_*` keys, `lead_quote_ref`, `onboarding_ref`, `business_name`, `service_area`),
`date` = **5** (`lead_next_action_at`), `list` = **6** (`lead_stage`). `attribute_model` —
conversation = **0**, contact = **1**.

**Equivalent UI path:** Settings → Custom Attributes → **Add Custom Attribute**. Either path is
acceptable; the UI removes any chance of an enum transcription error and is the safer choice
for a single manual run.

**Expected:** `200` per create. The response returns `attribute_display_type` and
`attribute_model` as **name strings** (`"list"`, `"conversation_attribute"`), not the integers
sent — do not treat that as a failed write.

**Expected end state:** nine conversation definitions and two contact definitions; and — the
check that actually matters — opening any conversation shows **Lead Stage** in the sidebar as a
**dropdown with exactly seven options**. The `l20_baseline_marker` definition is left in place.

---

#### Step 6 — Business hours

Covered by step 2 for `${CW_INBOX_SALES}`. **No change to inbox 3.**

**Expected:** the sales inbox's business hours match Mon–Fri 09:00–17:00 La Paz (GMT-4).

---

#### Step 7 — Saved conversation filters (8 objects, **per operator**)

> ### ⚠ Saved filters are PER-USER, not account-shared
>
> Verified against the v4.16.1 tag (`custom_filters_controller.rb`): `index` scopes to
> `user: Current.user`, `create` merges `user: Current.user`, and `show`/`update`/`destroy`
> can only reach the caller's own filters. **There is no account-shared saved filter in
> Chatwoot v4.16.1.** A per-user cap also applies (`Limits::MAX_CUSTOM_FILTERS_PER_USER`);
> exceeding it returns `422`.
>
> **Consequence for this step, and it is not a small one.** These eight queues are the
> discovery mechanism for the entire escalation and stale-lead design (§6.3, §7, §8.2). They
> cannot be created once by an administrator and inherited. Each operator gets them **only**
> if they are created under that operator's own session or token. Step 7 must therefore be
> repeated per operator, and **onboarding a new operator is incomplete until it has been run
> for them** — otherwise their F1 is empty and escalations are invisible to them personally.
>
> Two of the eight have native equivalents that need no filter and are available to everyone:
> F1 is approximated by the native **Unassigned** tab, and F3 by the native **Mine** tab. They
> are approximations, not substitutes — the native Unassigned tab does not constrain status,
> so it mixes the AI-owned population (F2) with the escalated-and-unclaimed one (F1), which is
> precisely the §6.3 ambiguity. Treat the native tabs as a fallback, never as the design.

**Precondition check:** `GET ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/custom_filters` **as the
operator whose filters are being created**. Skip any name present.

**Primary path — UI:** Conversations → **Filter** → build the query → **Save filter** → name
it. Signed in as the operator concerned.

| # | Name | Query | Why it exists |
|---|---|---|---|
| F1 | `Escalated & unclaimed` | inbox = `${CW_INBOX_SALES}` AND status = `open` AND assignee is none | **The most important queue in this configuration.** Status-based, deliberately *not* label-based, so it also catches Chatwoot's native bot-failure auto-open (§6.4 C-3), which carries no label. |
| F2 | `AI owns now` | inbox = `${CW_INBOX_SALES}` AND status = `pending` AND assignee is none | The AI-owned population, visible rather than assumed. |
| F3 | `Mine — open` | assignee = me AND status = `open` | Personal queue. |
| F4 | `Awaiting customer` | label = `awaiting-customer` AND status ≠ `resolved` | The suspended-clock population. |
| F5 | `Proposal` | `lead_stage` = `proposal` | Per-stage count, mitigation 1 for the §3.3 trade-off. |
| F6 | `Commitment pending` | `lead_stage` = `commitment-pending` | Highest-value stage; deserves its own queue. |
| F7 | `Complaints` | label = `escalation-complaint` AND status ≠ `resolved` | E5. |
| F8 | `AI blocked` | `isola_last_outcome` = `handoff_blocked` | **The only way to see E4.** The customer was told nothing and the status may still be `pending`, so no status-based queue catches it. |

**API shape, if scripting rather than clicking.** Verified: the permitted fields are
`name`, **`filter_type`** and `query`.

> ⚠ **The published swagger names this field `type`. The swagger is wrong.** The controller
> permits `filter_type`. A body sending `type` has it silently dropped and the record falls
> back to the DB default — which happens to be `conversation`, so the mistake is invisible
> until a `contact` or `report` filter is attempted. Use `filter_type`.

`filter_type` enum: `conversation:0` (default), `contact:1`, `report:2`. All eight below are
`conversation`.

```
POST ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/custom_filters
{ "name": "AI owns now",
  "filter_type": "conversation",
  "query": { "payload": [
    {"attribute_key":"inbox_id","filter_operator":"equal_to","values":[<inbox>],"query_operator":"AND"},
    {"attribute_key":"status","filter_operator":"equal_to","values":["pending"],"query_operator":null}
  ]}}
```

> **UNVERIFIED — three residual gaps, each with its own mitigation:**
>
> 1. **The inner shape of `query` is a convention, not a contract.** The column is free-form
>    `jsonb` with **no server-side validation** — the API stores whatever object is sent. The
>    `{"payload":[…]}` shape above is what the dashboard writes and what `POST
>    /conversations/filter` reads, but nothing validates it, so a malformed query saves
>    successfully and returns the wrong population silently. **Mitigation: build in the UI.**
> 2. **Whether an `is_not_present` operator is accepted for `assignee_id`** in a saved filter
>    (needed by F1 and F2 for "assignee is none"). `lib/filters/filter_keys.yml` does define
>    `is_present` / `is_not_present`, but the swagger for `POST /conversations/filter` lists
>    only `equal_to`, `not_equal_to`, `contains`, `does_not_contain`. **Mitigation: build F1
>    and F2 in the UI first and confirm the operator appears in the picker.** If it does not,
>    F1 and F2 are not buildable, the native Unassigned tab is the only fallback, and the
>    §6.3 ambiguity becomes a live operational problem that must be **reported to the owner**,
>    not worked around.
> 3. **Whether a conversation custom attribute is usable as a saved-filter condition**
>    (needed by F5, F6, F8). Confidence here is higher than it was: the *automation* condition
>    validator explicitly admits any key in
>    `account.custom_attribute_definitions.pluck(:attribute_key)`, and the conversation filter
>    endpoint carries a `custom_attribute_type` discriminator — but the saved-filter path was
>    not traced end to end. **Mitigation: build F5 in the UI and confirm the population before
>    saving.** If custom attributes are not filterable, F5/F6/F8 are not buildable, §3.3
>    mitigation 1 fails, and the stage-representation choice should be **re-opened** (OQ-2)
>    rather than patched.

---

#### Step 8 — Canned responses

**Precondition check:** `GET ${CW_HOST}/api/v1/accounts/${CW_ACCOUNT}/canned_responses`
(optional `?search=`). Skip existing shortcodes. The existing `greeting` stays.

**Verified body:** exactly two fields — `short_code` and `content`. Content supports
Liquid-style variables such as `{{contact.name}}`. Note there is **no `show` route** in
v4.16.1: `GET .../canned_responses/{id}` returns 404, so verification is done through the
index, not by fetching one.

> ⛔ **Every canned response body must be checked against
> `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` before creation.** This
> document deliberately specifies shortcodes and *purposes* only, and authors **no claim text**.
> A canned response is a claim EPIC makes to a customer in writing; the frozen spec is the only
> authority for what may be claimed.

> ⛔ **Naming rule (§1.0.2) applies to every body created in this step.** Customer-visible copy
> says **"powered by Isola"**. It never names *Clawith*, never names *Paperclip*, and never
> names any internal runtime, engine or vendor. No shortcode below carries such a name, and
> none may be authored that does.

| Shortcode | Purpose | Constraint |
|---|---|---|
| `handover` | Confirm a colleague is taking over and restate what has been captured | Must not promise a response time not agreed in OD-7. **Must not be sent until the handoff state transition has succeeded (H2)** — and never at all on failure or ambiguity (H3). |
| `quote-sent` | Confirm a quote has been sent and state where to find it | Must reference the Odoo quote, never restate its figures |
| `outofhours` | Acknowledge outside business hours | Must match the inbox's unavailable message |
| `serviceability` | Explain that serviceability must be checked before anything is promised | Must not state coverage — coverage is a claim |
| `notserviceable` | Decline honestly when EPIC cannot serve the location | Must not offer an alternative not in the frozen spec |

---

#### Step 9 — Macros

**Precondition check:** Settings → Macros. Skip existing names. Keep the existing
`Route to Front Desk (Support)` (id 1) unchanged.

**The macro action vocabulary is 16 values, verified from `Macro::ACTIONS_ATTRS` at the
v4.16.1 tag:** `send_message`, `add_label`, `assign_team`, `assign_agent`, `mute_conversation`,
`change_status`, `remove_label`, `remove_assigned_agent`, `remove_assigned_team`,
`resolve_conversation`, `snooze_conversation`, `change_priority`, `send_email_transcript`,
`send_attachment`, `add_private_note`, `send_webhook_event`.

> ⚠ **This is not the same list as the automation one.** Automations have 19; macros have 16.
> Macros lack `send_email_to_team`, `open_conversation` and `pending_conversation`. Do not copy
> an action list from step 10 into a macro — three of them will `422`.

Body fields (flat): `name`, `visibility` (`personal:0` default, `global:1`), and
`actions: [{action_name, action_params: []}]`. **`visibility` is coerced** — an agent-role
caller always receives `personal` regardless of what is sent, so global macros must be created
by an administrator.

| Macro | Actions | Buildable? |
|---|---|---|
| `Hand back to AI` | `remove_assigned_agent`; `change_status` → `pending` | **Yes.** Both actions are in the verified list. This is the §8.4 affordance for O3 — **the only resume path** — and the most important of the four. It must **not** also carry `remove_assigned_team`: removing a team neither silences nor resumes anything, and bundling it would teach the operator that teams are part of ownership. |
| `Escalate — complaint` | `change_status` → `open`; `add_label` `escalation-complaint`; `add_label` `intent-support`; `change_priority` → `high` | **Yes.** Use `change_status`, not `open_conversation` — the latter is automation-only. **No team assignment** — prohibited by ruling (a team would not silence the AI; `change_status → open` is what does), and additionally blocked by the defect (§6.5). |
| `Mark won` | `add_label` `outcome-won`; `add_label` `lifecycle-onboarding`; `remove_label` `lifecycle-lead` | **Partly.** No macro action can set a custom attribute, so `lead_stage` must be set by hand. **The macro's own description must say so**, or it becomes a trap that silently leaves the pipeline wrong. |
| `Take over from AI` | `assign_agent` | **Deferred — do not create.** `assign_agent` takes a **named** agent id in `action_params`; a shared "assign to whoever ran this" macro is not expressible from the verified action list, and one macro per operator is worse than the native control. **Use the native assignee picker for takeover** — one click, and exactly what A2 already specifies. |

> **UNVERIFIED:** whether v4.16.1 accepts a `"self"` sentinel in `assign_agent`'s
> `action_params`. Not found in the source read. If it does exist, `Take over from AI` becomes
> buildable as one global macro — worth a one-minute check in the UI action picker before
> accepting the deferral above.

> ⚠ **A macro is an affordance, never an enforcement.** CE 4.16.1 has no required-resolution-
> attribute feature (`conversation_required_attributes` is Enterprise and absent). An operator
> can always resolve, relabel or reassign without using any macro. No acceptance text may
> describe a macro as enforcement.

**Worth knowing when reading Chatwoot's own behaviour:** macro and automation `add_label`
actions call the model's **additive** `add_labels`, unlike the conversation labels *endpoint*,
which is a full replacement (§5.4). A macro adding a label therefore will not clobber existing
ones — but any code path doing the same thing through the API will, unless it
read-modify-writes.

**Execution note:** `POST /api/v1/accounts/{a}/macros/{id}/execute` with
`{"conversation_ids": [...]}` enqueues a background job and returns `200` immediately. The
`200` means *accepted*, not *applied* — never treat it as evidence the actions landed.

---

#### Step 10 — Automation rules

**Exactly one rule.** Precondition check: Settings → Automation. Skip if a rule with this name
exists. Leave the deactivated `L20 Verification-Only Demo Automation` deactivated; do not
reactivate it, and do not edit it.

**AR-1 — `Sales inbox: stamp lifecycle and source`**

| Field | Value |
|---|---|
| Event | Conversation Created |
| Condition | Inbox equals `${CW_INBOX_SALES}` |
| Actions | Add label `lifecycle-lead`; Add label `source-inbound-web` (or `source-inbound-whatsapp`, matching the channel chosen in OD-2) |
| Active | true |

**What AR-1 deliberately does not do, and why:**

| Not done | Why |
|---|---|
| No `assign_team` | A5 and §6.5. **Prohibited by ruling** — a team assignment is routing metadata and would not mark the conversation human-owned — and additionally blocked by the defect. |
| No `assign_agent` | A4 — it would set `meta.assignee` and silence the AI on every new conversation. |
| No `lead_stage = new` | A set-custom-attribute action is not available (below). Handled by P7, or by unset ≡ `new`. |
| No account-wide scope | The inbox condition is mandatory. An unscoped rule fires on inbox 3 and corrupts the frozen baseline. |
| No `conversation_updated` rule | Account 5's rule 3 fired account-wide on every `status = open` and raced the governed escalation contract. Its removal was owner ruling D2. It is not recreated here. |

**Verified vocabulary for v4.16.1** — use it, do not guess, and note there is **no server-side
validation of `event_name` at all**, so a misspelled event is persisted happily and simply
never fires:

- **Events (5):** `conversation_created`, `conversation_updated`, `conversation_opened`,
  `conversation_resolved`, `message_created`. The public docs list four; `conversation_opened`
  is real but undocumented.
- **Actions (19):** `send_message`, `add_label`, `remove_label`, `send_email_to_team`,
  `assign_team`, `assign_agent`, `remove_assigned_agent`, `remove_assigned_team`,
  `send_webhook_event`, `mute_conversation`, `send_attachment`, `change_status`,
  `resolve_conversation`, `open_conversation`, `pending_conversation`, `snooze_conversation`,
  `change_priority`, `send_email_transcript`, `add_private_note`. Anything else →
  `422 "Automation actions X not supported."`
- **Condition `attribute_key` (18 built-ins):** `content`, `email`, `country_code`, `status`,
  `message_type`, `browser_language`, `assignee_id`, `team_id`, `referer`, `city`,
  `company_name`, **`inbox_id`**, `mail_subject`, `phone_number`, `priority`,
  `conversation_language`, `labels`, `private_note` — **plus any defined custom attribute
  key**, which the validator admits explicitly. `created_at` and `last_activity_at` are
  **not** in the set and are rejected at create time (§7.1).
- `query_operator` must be `AND` or `OR`; only the last condition may omit it. Body is flat
  (`name`, `description`, `event_name`, `active`, `conditions[]`, `actions[]`).

**There is no set-custom-attribute action.** AR-1 therefore cannot stamp `lead_stage = new`,
and **P7 is required rather than optional** — this closes the question rather than deferring
it.

---

**AR-2 — `Sales inbox: notify escalations team on open` — OPTIONAL, owner-gated**

The §6.5 design costs one real thing: labels do not notify. `send_email_to_team` recovers most
of it **without assigning a team**, so it touches neither the ruling nor the defect — it is a
**notification**, and a notification is not an ownership signal. It changes nothing about who
is speaking to the customer:

| Field | Value |
|---|---|
| Event | Conversation Updated |
| Conditions | Inbox equals `${CW_INBOX_SALES}` **AND** Status equals `open` |
| Actions | `send_email_to_team` → `[{"team_ids": [${CW_TEAM_ESCALATIONS}], "message": "<short pointer to the conversation, no customer content>"}]` |
| Active | owner's choice |

This gives the escalation queue a push signal that the pure-label design lacks, and it is the
only verified way to notify a team in v4.16.1 without assigning to it.

> **UNVERIFIED — the reason AR-2 is optional rather than recommended:** whether
> `conversation_updated` re-fires on subsequent updates to an already-`open` conversation, and
> therefore whether AR-2 emails the team repeatedly for one escalation. No per-conversation
> de-duplication for automation rules was found in the source read. **Mitigation: apply AR-2
> last, `active: false`, then activate it and drive exactly one escalation while watching the
> mailbox.** If it double-fires, deactivate it — a notification channel that cries wolf is
> worse than none, and the saved-filter queue still works. Do not apply AR-2 in the same pass
> as anything else.

---

#### Step 11 — Retire superseded labels — ONE-WAY, OWNER-GATED

**Do not run without an explicit owner instruction naming these three labels (OD-8).**

`sales`, `support`, `urgent`. Deleting a label removes it from **every** conversation carrying
it, and re-creating the label does not restore those assignments. On this instance the only
conversations are synthetic UAT fixtures, so the practical loss is nil — but the step is still
one-way.

**Precondition:** re-read the label list, and read the conversation count carrying each,
immediately before deletion. Record both.

**Lower-risk alternative, entirely defensible:** leave all three in place and unused. The cost
is a cluttered picker. **If in any doubt, take the alternative.**

---

#### Step 12 — Bind the gateway (gateway configuration, not Chatwoot)

**Not a Chatwoot configuration step**, and listed only so its ordering is unambiguous.

**Preconditions:** P1, P4, P7 satisfied (**P2 is closed by ruling**), and steps 2–10 applied and
verified.

The `(${CW_ACCOUNT}, ${CW_INBOX_SALES})` binding is added to `GATEWAY_BINDINGS_JSON` with the
PUBLIC sales employee. Boot enforces the invariants: no duplicate `(account, inbox)` pair, no
non-PUBLIC exposure, no binding without an AgentBot secret and access token. Boot is where
those are proven — the gateway refuses to start otherwise.

> ⛔ **`escalationTeamId` must be left ABSENT on this binding — permanently, not pending a fix.**
>
> **Reason 1, governing: it would not do the thing it looks like it does.** A team assignment
> is routing metadata and does not silence the AI (§1.0, O1b). Setting `escalationTeamId` would
> produce escalations that *look* routed to a team while the conversation remains AI-owned in
> every respect that matters. Closing the defect below would not change this.
>
> **Reason 2, an additional constraint on top:** setting it makes the gateway assign a team on
> every escalation, and **`annotate()` runs *after* the assignment** — so `conversations#show`
> 500s and the custom-attribute write is silently skipped on every escalated conversation
> (`defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`, retained in full).
>
> Absent means "escalate but do not assign a team", which is exactly the §6.5 design.

Creating the AgentBot and its inbox binding in Chatwoot is part of this step. **P2 is closed** —
`isola-gateway` is the ruled-canonical processor and Foundation must never process this binding
(§1.0.1). This step is now gated on P1, P4, P7 and the binding configuration sourced from
**NocoBase**, which is authoritative for it (O7). It remains listed last because it is the step
that makes the AI live.

---

#### Step 13 — Priority

No configuration required. `priority` is a native conversation field available in the UI today
and currently unused. Adopting it is an operating convention (§7.2, §8.2), not a setting.

**Verified against v4.16.1** (`app/models/conversation.rb`):

- The enum has **four values only: `low`, `medium`, `high`, `urgent`.** There is no `none`.
- Set it with `POST /api/v1/accounts/{a}/conversations/{c}/toggle_priority {"priority": "high"}`,
  or `PATCH /conversations/{c} {"priority": "high"}` (the only field that route accepts).
- **To clear a priority, POST `toggle_priority` with no `priority` param at all.** The
  implementation is `self.priority = priority.presence`, so an absent param yields `nil`. This
  is covered by the shipped controller spec.

> **UNVERIFIED — do not use `"none"`.** The swagger and the public API reference both list
> `none` in the priority enum. The model does not have it, and `"none".presence` returns
> `"none"`, which is assigned straight into a Rails enum with no such member — the expected
> result is an `ArgumentError`, i.e. a 500. No shipped spec covers it and this lane did not
> execute it against a live instance. **Clear priority by omitting the field, never by sending
> `"none"`.** Note also that automations and macros use a different convention again — the
> literal string `"nil"` — so the three must not be copied between each other.

> ⚠ Do not send `sla_policy_id` on any conversation update. It is an Enterprise parameter.

---

## 11. Verification matrix

Every proof below is an **observation of behaviour or of a rendered surface**. Not one is a
write-then-read-back through the same credential that made the write — that proves only that
the API accepted a value, which is the weakest possible evidence and the one that produced the
"CB-0 shipped green and served pre-fix code" precedent.

| # | Element | Proof by observation | Fails if |
|---|---|---|---|
| **V-1** | Instance identity | `GET ${CW_HOST}/api` returns `4.16.1`, and the browser address bar reads `isola-chat.saas00.epic.dm` throughout | Any step was performed against `inbox.epic.dm` |
| **V-2** | Labels | Sign in as the **restricted Agent** (Eric Giraud, Agent tier, inbox+team membership only) in a **separate browser profile**, open a conversation, and observe all 25 labels in the picker with their colours. Then open Reports → Labels and observe they are selectable dimensions. | A label is missing, uncoloured, or absent from Reports — which would mean it exists as a bare tag rather than an account label |
| **V-3** | `lead_stage` definition | In the same restricted-agent session, observe **Lead Stage** in the conversation sidebar rendering as a **dropdown with exactly seven options in stage order**. | It renders as a free-text box (wrong display type) or shows the wrong option count. A successful attribute *write* proves nothing here — Chatwoot's `custom_attributes` jsonb column has no foreign key to the definitions table and accepts arbitrary keys with or without a definition. |
| **V-4** | Other attribute definitions | Same session: all nine conversation attributes visible in the sidebar; both contact attributes visible on a contact record | Any is absent — most likely created on the wrong `attribute_model` |
| **V-5** | Sales inbox | Send a real message through the deployed channel and observe the conversation appear with `status = pending`, **no assignee**, and AR-1's two labels present | An assignee appears (auto-assignment is on — A4 violated) or no labels appear (AR-1 mis-scoped) |
| **V-6** | AR-1 scope | Create a conversation on **inbox 3** and observe **no** label is applied | AR-1 fires on inbox 3 — the frozen baseline is being corrupted |
| **V-7** | Business hours | Load the widget outside 09:00–17:00 AST and observe the unavailable message | The message does not appear or contradicts the canned `outofhours` response |
| **V-8** | Saved filters | **Per operator.** In each operator's own session, observe their eight filters in the sidebar, open each, and reconcile the population against a manually-built ad-hoc filter with the same query. Saved filters are per-user (§10 step 7), so an administrator seeing all eight proves nothing about anyone else. | A count differs (the stored `query` is not what was intended — it is unvalidated jsonb, so a malformed query saves silently), **or** an operator has fewer than eight (step 7 was not run for them, and escalations are invisible to that person) |
| **V-9** | Stage/label coherence | Query for conversations where `lead_stage = won` **XOR** `outcome-won` is present. Expect **zero**. Repeat for `lead_stage = lost` XOR any `outcome-lost-*`. | Any row returns — the §3.3 duplicate-state risk has materialised and must be treated as a defect, not reconciled by hand |
| **V-10** | Silence model — AI-owned | With the gateway bound, send an inbound while `status = pending` and unassigned. Observe a customer-visible reply **and** a gateway log line with outcome `replied`. | No reply, or a reply with no matching log line |
| **V-11** | Silence model — human **user** assigned | Assign the conversation to a **person**, leave status `pending`, send another inbound. Observe **no** customer message and a gateway log line `human_assigned`. | Any customer-visible message appears. This is the single most important negative test in the matrix. |
| **V-12** | Silence model — open | Clear the assignee, set status `open`, send another inbound. Observe **no** customer message and `status_not_pending`. | Any customer-visible message appears |
| **V-13** | Escalation path E2 | Send an **attachment with no text**. Observe, in order: status becomes `open`; exactly one private note naming the attachment **type and count only**; exactly one customer acknowledgement matching `handoff.ts` **byte for byte**; label `isola-ai-escalated`; and the conversation appearing in F1. | The note contains a filename or URL; the acknowledgement is reworded; two messages appear; F1 misses it |
| **V-14** | Escalation queue catches the native auto-open | Induce a bot delivery failure and observe the conversation auto-open with an `agent_bot.error_moved_to_open` activity, **no label**, and **still appear in F1** | F1 misses it — meaning F1 was built label-based, which is exactly the §6.4 C-3 failure |
| **V-15** | Team defect, if the defect is ever closed | Assign a team to a bot-handled conversation and observe the gateway's next delivery still writes `isola_last_outcome`. **Until the defect is closed, this test must not be run against a live conversation** — it will break reconciliation. **Passing this test does NOT unblock team-based suppression**, which is prohibited by ruling and not by this defect (§6.5). It would only permit a team assignment for legitimate routing or reporting. | Attributes stop being written — the defect is still live |
| **V-18** | **The ruling — team assignment does not silence the AI** | On a disposable conversation: `status = pending`, **no human user assignee**, assign a **team**, then send an inbound. Observe the AI **replies** and the gateway logs outcome `replied`. This is a positive test of §1.0 row 1, and the proof that no configuration has smuggled a team condition into the suppression path. **Blocked by the defect on a bot-handled conversation — therefore DEFERRED until the defect is closed. Do not run it and do not patch Chatwoot to enable it.** | The AI falls silent — meaning something is reading `meta.team`, contradicting the ruling |
| **V-19** | Handback is the only resume path | After a human takeover (V-11), attempt each non-handback route in turn — resolve and reopen, remove the team, wait past every §7.2 threshold — and observe the AI stays silent in every case. Then perform an explicit handback (clear assignee **and** set `pending`) and observe it resumes, **once**. | The AI resumes on anything other than an explicit handback (O3 violated), or resumes more than once from a single handback (O3a violated) |
| **V-16** | Restricted-agent isolation | The restricted Agent cannot reach Settings, Automation, or Reports; can reach only their member inbox | Any admin surface is reachable. Re-proves the frozen baseline's negative-access result after this configuration lands |
| **V-17** | No credential leaked | Grep the apply session transcript and every evidence artefact for `provider_config`, `access_token`, `secret`, `api_access_token` values | Any value appears. Projection discipline failed |

---

## 12. Rollback

**No step in this plan deletes a conversation, an inbox, an account, a user or a message.**
That is a hard constraint, not a preference — precedent
`defect-chatwoot-49-conversations-deleted-unrecovered-2026-07-27`: 49 conversations deleted on
an "inert" assessment, still unrecovered.

Reverse in **last-in-first-out** order and read back after each reversal.

| Step | Mutation | Reversal | Reversible? |
|---|---|---|---|
| 0 | none | n/a | n/a |
| 1 | none | n/a | n/a |
| 2 — inbox | Inbox created | **Do not delete the inbox** if it has taken any conversation. Instead: remove all inbox members, disable auto-assignment, set working hours closed, and remove the widget script from the site. If it has taken **zero** conversations, deletion is safe but still owner-gated. | Yes, without deletion |
| 3a — team | `Escalations` team created | Delete the team. Safe **only** while no conversation is assigned to it — and nothing in this plan assigns one. | Yes |
| 3b — Front Desk auto-assign | Flag set to OFF | Restore to ON | Yes |
| 3c — inbox members | Members added | Re-issue the **full** captured member list. Never a partial list. | Yes |
| 4 — labels | 25 labels created | Delete the 25 created labels. Because they were created *before* any conversation carried them, deletion removes nothing from any conversation — provided rollback happens before the inbox goes live. **After go-live this becomes one-way**: deleting a label strips it from every conversation carrying it. | Yes before go-live; **one-way after** |
| 5 — attributes | 11 definitions created | Delete the definitions. Values already written under those keys **survive** (the jsonb column has no FK to the definitions table) — they simply stop rendering in the sidebar. Re-creating a definition restores rendering but not its UI history. | Partial |
| 6 — business hours | Inbox schedule set | Restore the captured schedule | Yes |
| 7 — saved filters | 8 filters created **per operator** | `DELETE /custom_filters/{id}` — **as that operator**, since filters are per-user and an administrator cannot reach another user's. Purely additive; deleting one touches no conversation. | Yes, per operator |
| 8 — canned responses | Responses created | Delete them | Yes |
| 9 — macros | 3 macros created (`Take over from AI` deferred) | Delete them. A macro's *past effects* on conversations are not undone — those are ordinary label/status/priority changes and are reversed individually. | Yes (the macro), no (its past effects) |
| 10 — AR-1 | Rule created | Set `active: false` first, then delete. Deactivating is one reversible boolean and preserves the row, its id and its history — prefer it. **Labels AR-1 already applied are not removed by deleting the rule** and must be removed per conversation if that is wanted. | Yes (the rule), manual (its effects) |
| 10 — AR-2, if applied | Rule created | Set `active: false`. This is the *expected* outcome if the double-fire check fails, not an exceptional one — AR-2 is applied last and alone precisely so this reversal is isolated. | Yes |
| 11 — label retirement | 3 labels deleted | **NOT REVERSIBLE.** Re-creating `sales`/`support`/`urgent` restores the label objects but **not** their assignment to any conversation. | **NO — one-way** |
| 12 — gateway binding | Binding added to `GATEWAY_BINDINGS_JSON`; AgentBot created and bound | Remove the binding entry and restart. In Chatwoot, deactivate the `agent_bot_inboxes` binding — **do not delete the AgentBot**, because its access token is referenced by the gateway configuration. The human inbox continues to work with no bot. | Yes |
| 13 — priority | none | n/a | n/a |

**One-way steps: step 11 only** (and step 4 after go-live). Everything else is fully
reversible. **If in doubt, skip step 11** — a cluttered label picker is not a problem worth an
irreversible action.

---

## 13. Conflicts and open questions

### 13.1 OWNER DECISION REQUIRED

**Resolved on 2026-08-11: OD-3. Still open: OD-1, OD-2, OD-4, OD-5, OD-6, OD-7, OD-8, OD-9.**

| # | Decision | Why it is the owner's |
|---|---|---|
| **OD-1** | **OPEN. Which account is the operating account.** This document recommends account 2 and is parameterised so any other choice costs nothing but a substitution. Account 3 is another session's fixture and must never be chosen. | Tenant model; irreversible naming |
| **OD-2** | **OPEN, but no longer blocked by OD-3.** Which channel the sales inbox uses. Website widget is applicable now. A WhatsApp channel remains a **Meta asset change** and therefore owner-gated in its own right. The one-authoritative-processor precondition it used to wait on **is now satisfied**: `isola-gateway` is the ruled-canonical processor and Foundation is legacy-only, so a per-number binding has a defined owner. Recommendation: widget for v1 — the Meta gate, not the processor question, is what still stands. | Meta asset; customer-visible commitment |
| **OD-3** | ✅ **RESOLVED 2026-08-11** by `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`. **`isola-gateway` on EasyPanel is the canonical Chatwoot processor. Foundation is legacy-only and must never process the same binding.** The governing silence model is the §1.0 ruling: the AI answers only when the PUBLIC binding is active, `status = pending`, and no human-takeover condition exists — where **team assignment is routing metadata and never silences the AI**. `risk-two-chatwoot-agent-bot-processors-2026-08-11` is closed by this decision, and P2 with it. **Consequences propagated to:** §1.0.1, §2.1 (both tables and the following paragraph), §6.0–§6.6, §8.0.1, §10 step 12, CF-2. | Was explicitly reserved to the owner; now ruled |
| **OD-4** | **OPEN. Ratify the staleness thresholds** in §7.2. Every number there is this lane's proposal and none has been agreed. | Operating commitment; workload |
| **OD-5** | **OPEN. Tier 3 auto-loss and native auto-resolve.** Recommendation: both **off** in v1. A silently-closed lead is worse than a stale one. **Reinforced by the ruling:** auto-resolve changes status, and status is a load-bearing input to who is speaking to the customer — a timer must not be given a vote in that. | Commercial policy |
| **OD-6** | **OPEN. Which scheduler runs §7.** Activepieces is deployed but unadministrable; the alternative is a scheduled job in `isola-runtime`. Whichever is chosen, G1–G8 bind it, including **G2a: the scheduler is not a resume path.** | Architecture; unblocking Activepieces is separate work |
| **OD-7** | **OPEN. Ratify the escalation response targets** in §8.2. CE has no SLA engine, so these are observed commitments, not enforced ones. | Customer-facing commitment |
| **OD-8** | **OPEN. Retire `sales`, `support`, `urgent`** (step 11). One-way. The lower-risk alternative — leave them unused — is fully defensible. | Irreversible |
| **OD-9** | **OPEN. Is onboarding ever AI-assisted?** No onboarding employee template exists; v1 is human-owned by fact, not by preference. If it should be AI-assisted it needs its own PUBLIC employee, and a second employee on one inbox is not something the current one-binding-per-inbox model supports. | Material product scope |

### 13.2 UNVERIFIED

Each of these is a claim this lane could **not** confirm against actual v4.16.1 behaviour. None
is asserted as fact anywhere in this document, and each carries a mitigation that removes it
from the critical path.

**Verification method.** Every API shape in §10 was read from the **tagged v4.16.1 source** of
`chatwoot/chatwoot` (`raw.githubusercontent.com/chatwoot/chatwoot/v4.16.1/…`), cross-checked
against `developers.chatwoot.com`. Where source and published docs disagree, **source wins**
and the disagreement is named at the point of use — there are three such cases: the saved
filter `filter_type` field (docs say `type`), the priority `none` value (docs list it, the
model has no such member), and the automation event list (docs list four, source handles five).
None of this is runtime evidence for *this deployment*; §11 is.

**Resolved during this session** — these were open when §10 was first drafted and are now
verified from source, recorded so a later reader does not re-derive them:

| Was | Now |
|---|---|
| Label creation body and constraints | **VERIFIED.** Four fields only; `title` force-lowercased, regex-constrained, min 2 chars, unique per account; `color` entirely unvalidated. |
| `attribute_display_type` for `date` | **VERIFIED = 5.** Full enum in §5.4. |
| Whether any automation trigger is time-based | **VERIFIED: none is.** Proven three independent ways (§7.1). |
| Whether an automation action can set a custom attribute | **VERIFIED: it cannot.** P7 is required, not optional. |
| Which macro actions exist | **VERIFIED: 16**, listed in §10 step 9. `remove_label` and `remove_assigned_agent` both exist, so `Hand back to AI` is buildable. |
| Auto-resolve field, scope and unit | **VERIFIED:** account-level `auto_resolve_after`, minutes, min 10; `auto_resolve_ignore_waiting` and `auto_resolve_label` both exist. |
| AgentBot read permissions | **VERIFIED** against `BOT_ACCESSIBLE_ENDPOINTS`: `conversations#show` permitted; `conversations#index` and `messages#index` both return `401`. Confirms §6.5. |
| `messages.source_id` idempotency | **VERIFIED NEGATIVE.** Plain non-unique index, no model validation, no upsert path. Duplicates are accepted. (The uniqueness that does exist is on `contact_inboxes.source_id`, a different guarantee entirely.) |

**Still unverified:**

| # | Unverified | Where | Mitigation |
|---|---|---|---|
| **UV-1** | Whether v4.16.1 back-fills an account `Label` record when `POST /conversations/{id}/labels` names an unknown tag. The code path (`label_list=` via acts_as_taggable) says it does not, but that was inferred rather than observed. | §4.6 | Step 4 creates both gateway labels explicitly *before* step 12 binds the gateway, so the answer cannot matter |
| **UV-2** | Whether `assign_agent` accepts a `"self"` sentinel in `action_params` | §10 step 9 | If it does, `Take over from AI` becomes one global macro. One-minute check in the UI action picker. Meanwhile the native assignee picker does the job |
| **UV-3** | Whether `conversation_updated` re-fires on repeated updates to an already-`open` conversation, and therefore whether AR-2 notifies repeatedly | §10 step 10 | AR-2 is optional, applied last, alone, inactive first, then driven once while watching the mailbox. Deactivate if it double-fires |
| **UV-4** | Whether a saved filter accepts `is_not_present` on `assignee_id`. `filter_keys.yml` defines the operator; the `/conversations/filter` swagger lists only four operators | §10 step 7 | Build F1 and F2 in the UI first. If unavailable, F1/F2 are not buildable, the native Unassigned tab is the only fallback, and the §6.3 ambiguity becomes a live problem to **report**, not absorb |
| **UV-5** | Whether a conversation **custom attribute** works as a saved-filter condition. Confidence is moderate — the automation validator admits custom attribute keys and the filter endpoint carries a `custom_attribute_type` discriminator — but the saved-filter path was not traced end to end | §10 step 7 | Build F5 in the UI and confirm the population before saving. If not filterable, §3.3 mitigation 1 fails and the stage representation should be **re-opened** (OQ-2) |
| **UV-6** | The enforced inner shape of a saved filter's `query`. The column is unvalidated jsonb; `{"payload":[…]}` is what the dashboard writes, i.e. convention, not contract | §10 step 7 | Build in the UI. A malformed query saves successfully and returns the wrong population silently — which is why V-8 reconciles counts rather than checking for a 200 |
| **UV-7** | The runtime result of `toggle_priority` with `"priority": "none"`. Expected to be a 500 (`"none".presence` is `"none"`, assigned into an enum without that member), but not executed | §10 step 13 | Clear priority by **omitting the field**. Never send `"none"` |
| **UV-8** | Whether the SLA API surface responds on this deployment. The routes are not guarded by `ChatwootApp.enterprise?` in source, but the UI is gated and this was not probed | §8.3 | No commitment may rest on it either way. Do not create an SLA policy row on the strength of a probe — inert policies were mistaken for an active clock on the other instance |
| **UV-9** | Whether Chatwoot reopens a **resolved** conversation as `open` or as `pending` when an AgentBot is bound to the inbox | OQ-1 below | **STILL UNVERIFIED — the ruling narrows it but does not close it.** It now has a mitigation it did not have before. See the UV-9 note immediately below. |

#### UV-9 after the ruling — narrowed, mitigated, still unverified

**Does the 2026-08-11 ruling change UV-9? Partly. It changes what a bad answer *means*; it does
not tell us what Chatwoot does.**

| | Before the ruling | After the ruling |
|---|---|---|
| **Is the Chatwoot behaviour known?** | No | **Still no.** The ruling is a decision about Isola's contract; it has no power over what Chatwoot's reopen code does. Only the OQ-1 observation settles that. |
| **Is there a mitigation?** | **None.** This was the highest-impact unknown in the document precisely because a bad answer was unbounded. | **Yes.** O3 now states that **explicit handback is the only resume path** and that resolve is not a handback (O4). So if Chatwoot reopens as `pending`, that is a **contract violation to be fixed**, not an ambiguity to be interpreted. The rule to write no longer waits on the observation. |
| **Which branch is now dangerous?** | Both, symmetrically | **Asymmetric.** Reopen-as-`open` is now *aligned* with the ruling: the AI stays silent, which is what O3 requires, and F1 plus the Unassigned tab surface the customer. Reopen-as-`pending` is now a **defect against the ruling** — an implicit resume with no explicit handback — and would need a suppression fix, not a policy debate. |
| **Impact if unanswered** | High and undefined | **Bounded.** The operating rule is written either way. What remains unknown is whether a fix is owed. |

**What has not changed, and must not be softened:** the observation is still required, and
§9.4's dependency on it stands. **No fix may be proposed in this packet.** If the observation
shows reopen-as-`pending`, that is a finding to record against the handoff contract and the
gateway — **not** a licence to modify Chatwoot here (§1 banner).

### 13.3 Open questions

**OQ-1 — What status does a resolved conversation reopen into?** Still unobserved, and still the
highest-impact *unverified* item — but **no longer two-sided in its consequences**, because the
ruling has decided what the answer must be made to mean:

- If Chatwoot reopens as **`pending`**, the AI would silently resume with no explicit handback.
  Under O3 that is now a **violation of the ratified contract**, not a design fork. On a `won`
  customer the sales agent would resume selling to someone who has already bought (§9.3). It is
  the account-5 defect `def-chatwoot-resolve-acts-as-handback-<legacy-runtime>-session-survives-2026-07-30`
  reproduced here, and it would need a suppression fix owned by the handoff contract and the
  gateway. **Which is not this packet's to write.**
- If Chatwoot reopens as **`open`**, the AI stays silent — **which is what O3 requires** — and
  the returning customer lands in an `open` conversation with no human user assignee that F1
  and the Unassigned tab surface. This branch needs no fix, only the queue that already exists.

**The operating rule no longer waits on the observation:** it is O3 in both branches — the AI
resumes only on explicit handback. What the observation determines is whether a **defect** is
owed, and against which component.

**Method, unchanged:** on a disposable conversation on a bot-bound inbox, resolve it, send an
inbound, and read the resulting status. Do this before §9.4 is performed routinely. **Record
the result; do not fix Chatwoot in this packet on the strength of it.**

**OQ-2 — Is `lead_stage` filterable?** UV-5. If not, §3.3 mitigation 1 fails and the stage
representation choice should be **re-opened**, not patched. Labels would still be the wrong
shape for a mutually-exclusive stage, so the honest fallback would be to accept that stage is
sidebar-only and un-queryable — which is a materially worse product and should be surfaced as
such rather than absorbed.

**OQ-3 — The unexplained team named `Team`.** Team count moved 1 → 2 on account 2 with no
team-creation action by any lane. Recorded in the frozen baseline evidence as an open
administrative question. Left untouched by step 3d. Not a security finding; not this lane's to
resolve.

**OQ-4 — Pre-first-boot drift on this instance.** Port carries an unexplained contradiction:
one record found the instance in a pre-first-boot state (no SuperAdmin, no account, every route
redirecting to onboarding) on 2026-08-10T13:58Z, directly contradicting an earlier record
claiming a working owner login already existed on 2026-08-09T23:35Z. The instance was
subsequently onboarded and account 2 exists, so it is moot for current state — but the
discrepancy was never explained, and an instance that can silently reset is an instance whose
configuration cannot be assumed to persist. **Step 0's before-state capture is the defence:**
if it does not match §10 step 0's expected baseline, the instance moved and this plan must be
re-planned rather than forced.

### 13.4 Conflicts with the existing corpus, stated explicitly

| # | Conflict | Resolution |
|---|---|---|
| **CF-1** | The account-5 design (`CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §11, `CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` §3) carries `handoff_state`, `ai_mode` and `human_owner` as first-class attributes. This document **rejects all three** (§5.3). | **This document supersedes them for account 2 only.** On this instance the gateway reads `status` + `meta.assignee` and nothing else has a vote, so a parallel state field can only drift. Account 5 is a different instance under a different processor and keeps its own model. |
| **CF-2** | The account-5 design and `CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` §4 both route escalations to a **team**, and both treat that assignment as marking the conversation human-owned. This document assigns **no team** (§6.5). | **Superseded by the ruling first, the defect second.** (1) `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` and the 2026-08-11 clarification: **team assignment is routing metadata and does not silence the AI**, so the team-as-ownership premise is false and closing any defect will not revive it. (2) `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` additionally blocks any team assignment on a bot-handled conversation. The design is labels + status + saved filter. **Do not "revisit when the defect is closed" — the ruling is what forbids it.** |
| **CF-7** | `CHATWOOT-FOUNDATION-HANDOFF-CONTRACT.md` is written for Foundation as a processor. | **Foundation is legacy-only** and must never process this binding. Its *invariants* (§8.1) survive because they are independently implemented in the gateway; its **routing and its processor role do not**. `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` is authoritative for handoff mechanics and supersedes it (§8.0). |
| **CF-8** | Earlier corpus documents and defect identifiers name the previous customer-agent runtime. | **Paperclip replaced it.** Internal architecture references may name a runtime; **no customer-visible string may** — customer-facing material says **"powered by Isola"** (§1.0.2). Historical defect identifiers are left readable but de-branded in text where they appeared inline. |
| **CF-3** | `CHATWOOT-REVENUE-CONTEXT-CONTRACT.md` §6 fixes the deep-link format to `https://inbox.epic.dm/app/accounts/{a}/conversations/{c}`. | Instance-specific. For account 2 the format is `${CW_HOST}/app/accounts/${CW_ACCOUNT}/conversations/{display_id}`. The contract's *shape* is unchanged; only the host differs. |
| **CF-4** | `chatwoot-lead-context.ts` applies its attribute definitions by direct Postgres `INSERT`. | **Not repeated.** §10 uses the admin UI/Application API only. Direct DB mutation is emergency containment (CLAUDE.md §7). |
| **CF-5** | `CHATWOOT-OPERATING-WORKSPACE-DESIGN.md` §12 R1c step 13 and the R1 plan's R1E-12 both contemplate enabling CSAT. | **Deferred here too**, on the same seven conditions, none of which is met on this instance: AI suppression, escalation, human response and explicit handback are all unproven on account 2, and the queue is staffed by one administrator and one restricted agent. |
| **CF-6** | The frozen baseline packet configured account 2 as a deliberately **no-AI** workspace and its closeout states that closing it does not authorise real EPIC customer data on this instance. This document configures an AI-handled revenue inbox on that same account. | **Not a contradiction, but a boundary.** This configuration adds a *new* inbox and leaves inbox 3 untouched, so the no-AI baseline survives as a reference. But P8 stands: real customer data on this instance is a separate owner authorisation that this document does not grant and cannot imply. |

---

## 14. What this document deliberately does not do

- It does not apply anything. Nothing here has been executed. **It is prepared configuration,
  not verified deployed behaviour.**
- **It does not propose, specify or authorise any change to Chatwoot** — no patch, no upgrade,
  no monkey-patch, no workaround inside Chatwoot — and specifically **not to make any prepared
  rule in this document work.** A rule that would need one is deferred.
- **It does not specify the handoff mechanics.** `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md`
  is authoritative for them: the durable handoff action, the explicit human-takeover state, its
  exactly-once clearing on handback, and tenant-context propagation. This document configures
  only the Chatwoot surface those mechanics act on.
- **It does not treat a team assignment as an ownership, suppression, takeover or handback
  signal anywhere.** Team assignment is routing metadata (§1.0). Every such rule is prohibited
  by ruling, not merely blocked by a defect.
- **It does not name an internal runtime in any customer-visible string.** Customer-facing
  material says "powered by Isola" (§1.0.2).
- It does not author a claim list, a price, a coverage statement or any customer-facing copy.
  Canned responses and macros are specified by shortcode and purpose only; every body must be
  taken from `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md`.
- It does not re-open `risk-two-chatwoot-agent-bot-processors-2026-08-11`, which is **resolved**:
  `isola-gateway` is the canonical processor, Foundation is legacy-only. It records the
  consequence and applies it; it does not re-litigate it.
- It does not claim Chatwoot CE 4.16.1 provides SLA enforcement, audit logs, custom roles,
  required resolution attributes or capacity-based assignment. It provides none of these.
- It does not claim any macro, label or automation **enforces** anything. CE cannot require a
  field before a status change, and every guardrail in §7.4 is a code obligation Chatwoot
  cannot police.
- It does not claim `messages.source_id` provides idempotency. It has no unique index and no
  uniqueness validation in v4.16.1; every exactly-once guarantee here is a claim column in the
  writer's own store.
- It does not touch account 3, inbox 4, AgentBot 1, employees `fd2867d1` / `2b4cf82a`, or any
  object on `inbox.epic.dm`.
- It does not claim any automation rule or macro can set a custom attribute. Neither can; that
  is why P7 exists.
- It does not treat the published Chatwoot API reference as authoritative where it disagrees
  with the v4.16.1 source. Three documented fields are wrong or misleading for this version
  (saved-filter `type`, priority `none`, the four-event automation list) and each is corrected
  at the point of use rather than silently followed.
- It does not treat source-level verification as runtime evidence. Every API shape in §10 was
  read from the tagged v4.16.1 source; **none of it was executed against this deployment.**
  §11 is where behaviour on this instance is established, and nothing in §10 should be trusted
  over an observation in §11.
- It does not assume the instance is in the state described. Step 0's before-state capture is
  the only thing that establishes that, and a mismatch means re-plan, not proceed.

---

## 15. Revision history

### Revision 2 — 2026-08-11 — corrected against the owner ruling of 2026-08-11

**Why this revision exists.** Revision 1 was written before the owner ruled on conversation
state. It was **not originally right** on one substantive point and one framing point, and this
section exists so a later reader can see that rather than infer it.

**What was wrong, stated plainly:**

1. **Team-based rules were classified by the wrong reason.** Revision 1 marked every team rule
   *CONDITIONAL — BLOCKED BY DEFECT*, which implied that closing
   `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` would unblock them. It
   would not. Team assignment is routing metadata and **never** silences the AI, so a
   team-based suppression rule is **wrong**, not blocked. A reader of revision 1 could
   legitimately have waited for a defect fix and then applied a rule that would have failed
   silently in production — with the AI still answering a conversation an operator believed a
   team had taken over.
2. **The ownership model under-specified "unassigned".** Revision 1 said the AI owns a
   conversation when `status = pending` and `meta.assignee` is null, and separately noted (as
   an implementation hazard, in §6.4 C-1) that teams do not silence the AI. The two were never
   reconciled into a single stated contract, and "unassigned" was left to the reader.

**What was right and is retained.** The §6.4 C-1 finding itself — that the gateway reads
`conversation.meta.assignee`, the **user** assignee, and never reads `meta.team`, so team
assignment never silenced the AI — was correct, and the owner has now **made it the rule rather
than an accident of implementation**. Revision 2 promotes it from a hazard note to the governing
contract.

**Changes, by section:**

| Section | Change |
|---|---|
| Header | Added a revision line pointing here. |
| **§1 banner** | Strengthened. Now states plainly that this is **prepared configuration, not verified deployed behaviour**; that any element contradicting the ratified ruling **must not be applied**; and that **no Chatwoot change may be proposed here to make a prepared rule work**. |
| **§1.0 (new)** | The ratified conversation-state ruling, as the four-row table, with the three-condition respond test, the exactly-once handback rule, and the owner's disambiguation of "unassigned" = no human **user** assignee. |
| **§1.0.1 (new)** | The other ratified decisions this revision depends on: canonical processor, NocoBase as control plane, WS2 accepted 8/8, the retained defect, the model-initiated-escalation defect. |
| **§1.0.2 (new)** | Naming rule. Customer-visible strings say **"powered by Isola"** and never name an internal runtime. |
| **§1.1 P1** | WS2 recorded as **accepted 8/8**; only the fixture freeze remains. |
| **§1.1 P2** | **RESOLVED.** Closed by the canonical-processor decision. |
| **§1.1 P6** | Re-framed: team-based suppression is prohibited by ruling and is **not** unblocked by closing the defect. The defect is retained as a constraint on any team assignment for any purpose, with its **separate** patch/upgrade requirement stated and explicitly not carried by this packet. |
| **§1.2** | P2 removed from the owner-only list; it is closed. |
| **§2.1** | Processor row: gateway canonical, Foundation legacy-only. Silence-model row rewritten to the ruling. Governing-decision row updated. The trailing paragraph now records the risk as **resolved** instead of open. |
| **§2.4** | `${CW_TEAM_ESCALATIONS}` annotated as routing metadata only. |
| **§3.3** | The "why not status" argument now cites the ruling as the reason status is load-bearing, with the implementation named as the deployed expression of it rather than the source of the rule. |
| **§5.3** | `handoff_state` rejection re-argued: the explicit human-takeover state is real under the ruling, but its representation belongs to the handoff contract, and this document does not invent a Chatwoot-side copy. |
| **§6.0 (new)** | The ruling restated at the head of the ownership section, governing everything below it. |
| **§6.1** | State table rebuilt: `status` + human **user** assignee + human-takeover state, with a `meta.team` column that reads "any" on **every** row. Third row added for takeover-without-assignee, marked **deferred** as to mechanism. |
| **§6.2** | A4 clarified to *user* assignee. A5 re-justified (ruling first, defect second). **A7 added:** a team assignment is never a takeover. |
| **§6.3** | Now opens with the ruling's definition of "unassigned". The remaining ambiguity is correctly scoped to status, not teams. Queues forbidden from substituting a team condition for the assignee condition. |
| **§6.4 C-1** | Rewritten in three parts — the finding, its promotion from hazard to ratified rule, and the consequence that no defect fix makes a team rule right. |
| **§6.5** | **The central change.** Retitled *PROHIBITED BY RULING, and additionally blocked by a defect*. Two banners in explicit order: Reason 1 (governing, the ruling) then Reason 2 (additional constraint, the defect). The defect is retained **in full**, including the `annotate()`-runs-after-assignment finding and the accepted fail-closed behaviour, with its patch/upgrade named as a **separate** requirement this packet does not carry. A re-classification table maps every previously *CONDITIONAL* rule to its new status. |
| **§6.6** | Rewritten. Now carries the four-row ruling table verbatim, O1 as the three-condition test, **O1a** (what "unassigned" means), **O1b** (teams never silence), O3 rewritten as *explicit handback is the only resume path, exactly once*, **O3a**, **O7** (NocoBase is the control plane), **O8** (one processor). A closing table lists every place teams were previously used as an ownership signal and its correction. |
| **§7.2** | "Unassigned" in both cross-stage alarms defined as no human **user** assignee; a team assignment does not clear either alarm. |
| **§7.4** | G2 rewritten to the ruling predicate, with `meta.team` explicitly excluded as an input. **G2a added:** the scheduler is not a resume path. |
| **§8.0 (new)** | Points at `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` as **authoritative** for handoff mechanics and declines to re-specify them. Adds H1–H3 from `defect-model-initiated-escalation-no-state-transition-2026-08-11`: one durable handoff action for deterministic and model-initiated escalation alike; no success told to the customer before the state transition succeeds; fail closed on failure or ambiguity. |
| **§8.0.1 (new)** | The Foundation handoff contract recorded as legacy; its invariants survive, its routing and processor role do not. |
| **§8.1** | Ledger attribution de-branded; H1–H3 noted as governing where stricter. |
| **§8.2** | E1 and E5 marked **model-initiated** and bound to H1–H3; E1's closing message gated on a successful state transition. E2 noted as already satisfying H2. |
| **§8.4** | Retitled *the only resume path*; encodes O3, names the half-handback failure, and defers the takeover-state clearing and the exactly-once property to the handoff contract. |
| **§9.1, §9.3** | "Never a team" re-justified on O1b rather than the defect. §9.3 flags this as the most likely place for the old team intuition to cause a live customer-visible failure. |
| **§9.4** | Notes that the operating rule no longer depends on OQ-1's answer; the observation now determines whether a defect is owed. |
| **§10 step 3a** | Team description rewritten to lead with the ruling. |
| **§10 step 8** | Naming rule applied to canned responses; `handover` gated on H2/H3. |
| **§10 step 9** | `Hand back to AI` forbidden from bundling `remove_assigned_team`; `Escalate — complaint` re-justified. |
| **§10 step 12** | `escalationTeamId` must be absent **permanently**, ruling first and defect second. Preconditions updated (P2 closed); binding configuration sourced from **NocoBase**. |
| **§11** | V-11 clarified to *user* assignee. V-15 annotated: passing it does **not** unblock team-based suppression. **V-18 added** (positive test of the ruling — **deferred**, blocked by the defect, and explicitly not to be enabled by patching Chatwoot). **V-19 added** (handback is the only resume path, exactly once). |
| **§13.1** | **OD-3 marked ✅ RESOLVED** with the decision cited and its propagation listed. OD-2 unblocked from OD-3 but still owner-gated on the Meta asset. All other ODs explicitly marked OPEN. OD-5 and OD-6 annotated against the ruling. |
| **§13.2** | UV-9 re-scored with a dedicated subsection: **still unverified**, but now **mitigated** by O3 and **asymmetric** in consequence. UV-1 … UV-8 unchanged; the eight items resolved to VERIFIED are unchanged. |
| **§13.3 OQ-1** | Rewritten: no longer a two-sided policy fork. The operating rule is O3 in both branches; the observation determines whether a defect is owed, and no fix may be proposed in this packet. |
| **§13.4** | CF-2 re-argued (ruling first, defect second) with the "revisit when the defect closes" instruction removed. **CF-7** and **CF-8** added. |
| **§14** | Five new statements of what this document does not do — most importantly that it proposes no Chatwoot change and does not specify handoff mechanics. |
| **§15** | This section. |

**What was deliberately NOT changed.** Every verified API shape in §5.4, §10 and §13.2 stands
as written and was not revisited — the ruling touches ownership semantics, not Chatwoot's HTTP
surface. The eight unknowns resolved to **VERIFIED** in §13.2 are unchanged. The stage set
(§3.1), the label taxonomy (§4), the attribute set (§5.1–§5.2), the staleness thresholds
(§7.2), the apply-plan step structure (§10) and the rollback table (§12) are unchanged in
substance; only their justifications were corrected where they had rested on a team-based or
defect-based premise.

**Application status after this revision: still PREPARED, still NOT APPLIED. Zero Chatwoot
objects created, modified or deleted. Zero Port writes. Zero Meta, NocoBase, Activepieces or
Paperclip changes. No git state changed. This file is the only artefact this revision touched.**

### Revision 1 — 2026-08-11 — original

Prepared configuration for the EasyPanel `chat` instance, account 2. Superseded in part by
revision 2 as recorded above.
