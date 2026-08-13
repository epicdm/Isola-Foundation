# Portal Review Checkpoints — incremental owner-acceptance path

**Purpose.** Replace one big reveal at the end with five short, bounded sessions. Each
checkpoint is a demoable slice that ends in **one owner ruling** — accept, reject, or accept
with one named change — and each ruling unblocks a named next piece of work.

**Phillip is the Owner, not a reviewer.** Confirmed in Port:
`decision-apptension-customer-portal-nocobase-control-plane-2026-08-10` carries
`decided_by: "Owner (Phillip)"`, and `dec-one-roadmap-one-active-packet-2026-07-19` carries
`decided_by: "Phillip Alleyne"`. These sessions are **acceptance gates with real authority**,
not feedback rounds. A ruling given in a session is ratifiable on the spot and is recorded as
a Port `decision`.

**Status of this document.** Planning artefact only. It creates no code, changes no service,
and writes nothing to Port.

**Source of truth.** Port.io. Every capability claim below is drawn from:

| Record | Used for |
|---|---|
| `xp-isola-signup-to-agent-mvp-2026-08-10` (In Progress, 84%, Yellow) | The 28-row acceptance matrix and every "Pass / Partial / Not run" result quoted here |
| `decision-apptension-customer-portal-nocobase-control-plane-2026-08-10` (Ratified) | Which surface owns which capability |
| `decision-nocobase-native-isola-cockpit-2026-08-10` (Ratified, narrowed) | NocoBase = operator control plane only, never the customer UI |
| `decision-all-isola-whatsapp-numbers-non-production-2026-08-11` (Ratified) | Channel-testing posture — see §2 |
| `decision-one-authoritative-chatwoot-processor-2026-08-11` (Ratified) | `isola-gateway` is canonical; Foundation is legacy-only; the canonical AI silence contract |
| `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` (Ratified) | **WS2 accepted 8/8** · the assignee disambiguation · Paperclip replaced Clawith · "powered by Isola" naming · scope fences |
| `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` (P2, Open) | The team-assignment annotation hazard flagged in Checkpoints 4 and 5 |
| `defect-public-tenant-context-not-wired-to-runtime-2026-08-11` (**P0, Open**) | The known-open business-answer gap surfaced at Checkpoint 3 |
| `defect-model-initiated-escalation-no-state-transition-2026-08-11` (**P0, Open**) | The known-open "I want a human" gap surfaced at Checkpoint 4 |
| `dec-one-roadmap-one-active-packet-2026-07-19` (Ratified) | One active packet; the owner steers one thing at a time |
| `isola-gate-05-hermes-operator-experience` (Done, 100%) | Phillip named as owner/operator of the Hermes track |

> **WS2 is ACCEPTED on all eight deployed durability proofs.** WS3 is **not** blocked by WS2,
> and is **not** blocked by Activepieces access; it continues immediately at a safe commit
> boundary. Nothing in this document treats WS2 as an open gate. The two P0 defects surfaced
> at Checkpoints 3 and 4 are **Customer Zero / product gaps, not WS2 defects** — they do not
> reopen WS2, and a review session must not be used to argue that they do.

**This document never writes to the packet.** The packet is owned by a different session.
Rulings are recorded as `decision` entities; findings as `defect` / `idea` / `requirement`;
each session as a `uat_test_case`. A packet note is *requested* from the packet's owning
session — never written directly.

**Proven hosts** (Port evidence, 2026-08-11): Paperclip `https://isola-ai.saas00.epic.dm` ·
Chatwoot `https://isola-chat.saas00.epic.dm` · Gateway `https://isola-gw.saas00.epic.dm`.

> **UNVERIFIED:** `portal.saas00.epic.dm` appears **only** in the packet's `repository`
> property, describing the EasyPanel project. It appears in **zero** evidence records, and the
> customer portal is not built. Do not treat it as the customer portal URL. See
> OWNER DECISION 1.

---

## 0. Sequencing table

No calendar dates. Each trigger is a state condition that must be true first.

| # | Checkpoint | Earliest trigger condition (date-independent) | Duration | Who attends |
|---|---|---|---|---|
| **1** | Sign-in and company setup | The WS3 Apptension fork boots on the pinned commit **and** a public domain is attached **and** invite gating is closed in `UserSignupSerializer.validate()` **and** the social-auth pipeline **and** transactional email delivers a verification link | 25 min | **Phillip (Owner — rules)** · Isola engineering lead (drives the screen) · scribe (records to Port in-session) |
| **2** | Home (the dashboard) and provisioning | Checkpoint 1 accepted **and** provisioning writes real IDs the portal can read back **and** NocoBase is administrable (root bootstrap + domain) for the operator half | 25 min | Phillip (Owner) · engineering lead · scribe |
| **3** | My AI Company and employee profile | Checkpoint 2 accepted **and** the PUBLIC Front Desk employee for a *synthetic* tenant renders in the portal from Paperclip truth (not a fixture) | 20 min | Phillip (Owner) · engineering lead · scribe |
| **4** | Test Agent and Open Inbox | Checkpoint 3 accepted **and** the Test Agent control creates a real Chatwoot conversation **and** the PUBLIC employee has been invoked end to end at least once | 30 min | Phillip (Owner) · engineering lead · scribe |
| **5** | Human takeover and handback | Chatwoot account 3 / inbox 4 / AgentBot 1 reachable — **true today** | 30 min | Phillip (Owner) · engineering lead · scribe |

### Run-order note — Checkpoint 5 runs first, out of sequence

**Not because it unblocks anything.** WS2 is accepted 8/8 and WS3 is already proceeding at a
safe commit boundary; nothing in this review path gates WS3.

The reason is simpler: **Checkpoint 5 is the only checkpoint whose surfaces are already
deployed and proven.** Chatwoot, the gateway and the delivery ledger are all live today.
Checkpoints 1–4 need the WS3 portal, which is being built now. So Checkpoint 5 is the one
session that can give the owner something real to rule on *while* WS3 is under construction,
instead of leaving the owner with nothing to see until the portal lands.

Run order:

1. **Checkpoint 5 first**, in parallel with WS3 construction. The owner watches the deployed
   takeover and handback behaviour and rules on whether it is acceptable as the customer
   experience.
2. **WS3 lands on its own schedule**, unblocked, and Checkpoints 1 → 2 → 3 → 4 then run in
   sequence.
3. **Checkpoint 5 is re-run in sequence** at the end, through the full customer journey, for
   its own acceptance rows (15, 16, 17, 24, 28) — which the out-of-order run cannot close,
   because those rows require the journey and not just Chatwoot.

Say this out loud at the start of the out-of-order run, or it will be mistaken for acceptance
of rows it cannot touch.

---

## 1. Cross-checkpoint rule set

How to run a session so it produces an **owner ruling**, not a defect backlog.

| # | Rule | Why |
|---|---|---|
| R1 | **Synthetic tenants only.** Two fresh synthetic identities. No real customer data, ever. | The packet's own acceptance preamble requires it. A real customer in a session is an irreversible-risk stop condition. |
| R2 | **The owner rules; the room does not design.** Phillip answers the one stated ruling: accept, reject, or accept with one named change. Design opinions are captured as `idea`/`requirement`, not debated in the room. | A 25-minute acceptance gate that becomes a design workshop yields neither a ruling nor a design. |
| R3 | **A ruling is recorded before the session closes**, as a Port `decision` with `decided_by = "Owner (Phillip)"`, `decided_at`, `decision_text`, `rationale`, `status`. | An unrecorded owner ruling is re-litigated later. Correct Port in the same turn the ruling is given. |
| R4 | **Findings go to Port, not to chat.** Nothing raised is "handled" until it exists as a Port entity with an identifier read back in the room. | Verbal defects evaporate; this programme has repeatedly re-investigated already-documented facts. |
| R5 | **Read "Deliberately absent" aloud before the walkthrough starts.** | Absence must not be logged as a defect. Highest-yield rule here. |
| R6 | **Driver drives.** The engineering lead operates the screen; the owner watches and rules. No shared control. | Prevents accidental state mutation mid-session and keeps the owner in the ruling seat rather than the operator seat. |
| R7 | **No real customer contact.** No real person receives a message in any checkpoint. Per `decision-all-isola-whatsapp-numbers-non-production-2026-08-11`, no real customer contact may occur without a separate owner authorisation. | Row 26 must stay true across all five sessions. |
| R8 | **Never delete Chatwoot objects.** Retire bindings; leave synthetic conversations and issues in place as audit evidence. | Packet rollback section, verbatim. A prior incident lost 49 conversations. |
| R9 | **One session, one slice.** If the slice is not ready, cancel; do not substitute the next one. | A merged session reintroduces the big-reveal failure mode this document exists to prevent. |
| R10 | **Timebox is hard.** At the stated duration, stop and record the ruling as **given** or **deferred**. | Deferral is a legitimate, recordable owner outcome. Overrun is not. |
| R11 | **State the layer.** Every pass signal is labelled with the layer it was proven at (portal / gateway / runtime / Paperclip / Chatwoot). | Several matrix rows read `Pass (runtime layer)` or `Pass (credential layer)`; a layer-qualified pass is not a journey pass. |
| R12 | **No screenshots pasted into Port property text**; use `evidence` entities with `source_url`. | Keeps the record readable and avoids the string-overwrite hazard on upsert. |
| R13 | **The scribe reads back every created Port identifier before close.** | Closes the loop in the same turn. |
| R14 | **Customer-facing material says "powered by Isola" — never Clawith, never Paperclip.** Applies to every screen, string and spoken line in a walkthrough. Engine names may be used when speaking *about the architecture* to the owner; they must never appear on a customer surface. | Ratified. **Paperclip has replaced Clawith** as the AI Company OS, and a live inconsistency already exists — gate 1's offer still says "powered by Clawith" while the deployed stack is Paperclip. A checkpoint that shows an engine name to a "customer" bakes that inconsistency into the product. |
| R15 | **Two P0 gaps are known-open and will visibly fail.** They are announced before the walkthrough, not discovered during it — the business-answer gap at Checkpoint 3 and the "I want a human" gap at Checkpoint 4. Both are **Customer Zero / product gaps, not WS2 defects**, and neither reopens WS2. | An expected failure the owner was warned about is data. The same failure discovered live reads as a collapse, and invites re-litigating an accepted workstream. |

---

## 2. Channel-testing posture — what the non-production ruling does and does not change

`decision-all-isola-whatsapp-numbers-non-production-2026-08-11` (Ratified, Owner (Phillip)):
**every Meta/WhatsApp number currently attached to Isola is non-production** and may be
disconnected/reconnected during controlled testing without causing a customer outage.

| Question | Answer for this review path |
|---|---|
| Was any checkpoint here blocked on "that number is live"? | **No.** Not one. The MVP has **no real customer channel** by its own objective — the only channel in play is a synthetic Chatwoot `Channel::Api` inbox. So no blocker in this document is voided, because none existed. Stated explicitly so nobody re-derives it. |
| Does it change what Phillip sees? | **No.** No checkpoint uses `3742`, `9043`, `6737`, `0001`, `9525` or any shared-WABA number. |
| Does it change anything downstream? | It unblocks controlled channel testing, which sits immediately *after* this review path. The processor-authority question it would otherwise have forced is **already settled**: `isola-gateway` on EasyPanel is canonical and Foundation is legacy-only (`decision-one-authoritative-chatwoot-processor-2026-08-11`). Migration is one binding at a time, with before/after readback, proving one inbound message produces one reply and **zero** processing by the retired handler. |
| Does Law 1 change? | **No.** One authoritative processor per WhatsApp number stands unchanged, and no account, inbox or number may **ever** be attached to both processors. Non-production removes the *outage* risk, not the *correctness* risk of a split-brain webhook. |
| Can a real channel appear in this packet? | **No.** `decision-one-authoritative-chatwoot-processor-2026-08-11` states directly: **Meta / WhatsApp must not be connected in the current packet.** That is a scope fence on top of the MVP objective, not a restatement of it. |
| Anything to carry into the room? | The same ruling records that **real external people have recently been messaging 6737 and 3742** — 40 real conversations in inbox 46, humans replying in 34 of 40. "Non-production" is a commercial and governance label, not a statement that nothing is connected to the outside world. It is why the operating rule is **controlled testing, not dormancy**. None of that touches these checkpoints, which use synthetic inbox 4 on a different Chatwoot instance. |

---

## 3. Checkpoint 1 — Sign-in and company setup

### What Phillip sees

1. Driver opens the portal's public landing/sign-in surface in a clean browser profile.
2. Driver enters an **invite code** for synthetic tenant A. Signup without a valid invite is attempted first and is **refused** — Phillip watches the refusal.
3. Driver completes the signup form with a synthetic name, synthetic company name and a controlled mailbox address.
4. Driver opens the controlled mailbox, shows the verification email, clicks the link.
5. The portal confirms the address is verified and returns to sign-in.
6. Driver signs in with the newly verified credentials.
7. The portal presents **company setup** — the minimum required information only.
8. Driver submits company setup. The portal moves to whatever comes next and **stops there**.
9. Driver signs out and back in once, to show the account and company survive.

### Exact surface

| Element | Surface |
|---|---|
| Portal sign-up / verify / sign-in / company setup | **NOT BUILT — required:** (a) Apptension `saas-boilerplate` forked into an EPIC repository pinned at tag `5.0.0` = `931ad3fea9ef291d2a167d6f497ef240802780c4`; (b) built with `Dockerfile.render`; (c) `uv run` dropped from the start script; (d) port 80 or `PORT=5001`; (e) `STRIPE_CHECKS_ENABLED=False` (required to boot); (f) signup guarded against the Stripe subscription signal; (g) invite gating closed in `UserSignupSerializer.validate()` **and** the social-auth pipeline; (h) an EasyPanel service in project `isola` with a **public domain attached**; (i) a transactional email sender that actually delivers |
| Route paths | > **UNVERIFIED:** the concrete route paths are whatever the pinned fork exposes. They have not been read off commit `931ad3fe`. No route string is printed here for that reason. |

### Preconditions

| Precondition | State | Blocker |
|---|---|---|
| Apptension fork repository exists | **BLOCKED — in progress** | WS3 is proceeding at a safe commit boundary; it is **not** gated by WS2 (accepted 8/8) and **not** gated by Activepieces access. The packet `repository` still names the fork as "to be created", so the repository does not exist yet — this is build time remaining, not a gate. |
| Portal service deployed with a public domain | **BLOCKED** | Service does not exist. Domain unassigned — OWNER DECISION 1. |
| Invite codes minted for synthetic tenants A and B | **BLOCKED** | No invite/allowlist mechanism exists; issuance owner undecided — OWNER DECISION 8. |
| Controlled mailbox for synthetic tenant A | **BLOCKED** | > **UNVERIFIED:** no evidence record confirms a transactional email provider is configured for the portal. `Dockerfile.render` is required *because* transactional email silently breaks otherwise — a live risk, not a formality. |
| Clean browser profile | AVAILABLE | — |
| No real customer data | AVAILABLE | Enforced by R1. |

### What good looks like

- [ ] Signup **without** a valid invite is refused on screen with an honest message — not a silent failure, not a generic 500.
- [ ] The verification email arrives and its link works on first click.
- [ ] Sign-in succeeds with the verified credentials and lands signed in.
- [ ] Company setup asks only for the minimum required information — no payment field, no plan picker, no card capture.
- [ ] Sign-out then sign-in returns the same account and company, with no re-setup.
- [ ] Exactly one account and one company exist for tenant A — a second submit or refresh creates no second copy.

### Deliberately absent — read this aloud before starting

| Absent | Why |
|---|---|
| Any pricing page, plan selector, card form or checkout | **Payments are deferred until the MVP is accepted** (ratified). The MVP entitlement rule is `VERIFIED_SIGNUP + PILOT_APPROVED → PROVISION`. |
| Free-trial or subscription copy | The Stripe subscription signal is deliberately disabled (`STRIPE_CHECKS_ENABLED=False`). Surviving trial copy is upstream boilerplate text — a copy issue, not a commercial offer. |
| Open self-serve signup | Invite/allowlist gating is mandatory until payment, rate limiting and abuse controls are live. The refusal **is** the feature. |
| Home (the dashboard), AI Company, Test Agent, Open Inbox | Checkpoints 2–4. The walkthrough stops at company setup on purpose. |
| Social login providers | Not in scope; the social-auth pipeline is being closed *against* signup, not opened. |
| Any EPIC/operator screen | NocoBase is the operator control plane and is never the customer's UI (ratified). |
| Apptension boilerplate demo content (CRUD demo items, sample pages) | Upstream fork residue. Log as `idea` (cleanup), never as a defect against the Isola journey. |

### The owner ruling asked for

> **Accept the invite → signup → verify → sign-in → company-setup path as the only way a pilot customer enters Isola?** Accept · reject · accept with one named change.

**What the ruling unblocks:** the portal's entry contract freezes, so acceptance rows 1–5 can
be run and closed, and Checkpoint 2's dashboard work proceeds against a settled entry path
instead of a moving one. A rejection here is cheap; the same rejection discovered at
Checkpoint 4 is not.

### Acceptance rows covered

| Row | Test | Current stated result |
|---|---|---|
| 1 | Fresh invited user signs up | **Not run** |
| 2 | Email verification succeeds | **Not run** |
| 3 | User signs in | **Not run** |
| 4 | Exactly one Apptension organization exists | **Not run** |
| 5 | Exactly one canonical NocoBase tenant exists | **Not run** |

Row 5 is only partly observable here — the customer cannot see NocoBase. Its portal-visible
half is "the tenant resolves consistently after sign-in"; its authoritative half is checked by
the operator in Checkpoint 2.

### Blockers to running this checkpoint today

| Blocker | Owner |
|---|---|
| No portal repository, service or domain yet — WS3 build time remaining (no gate) | Isola engineering |
| No invite/allowlist mechanism and no issuance owner | Owner — OWNER DECISION 8 |
| Transactional email delivery unproven for the portal | Isola engineering |
| NocoBase unadministrable, so row 5's authoritative half cannot be shown | Owner — OWNER DECISION 4 |

### Feedback capture

| Type | Port blueprint | Fields to set |
|---|---|---|
| **The owner's ruling** | `decision` | `decision_text` (the ruling verbatim), `rationale`, `decided_by` = `Owner (Phillip)`, `decided_at`, `status` = `Ratified` (or `Proposed` if deferred) |
| Behaves wrongly against a stated contract | `defect` | `title` (surface + symptom), `description` (exact repro: browser, step number, expected, actual), `severity` `P0`/`P1`/`P2`, `status` = `Open`; relate to this session's `uat_test_case` |
| Missing capability that must exist before launch | `requirement` | `description`, `status`, `launch_criticality`, `freshness_date` |
| Want / improvement / copy change, not launch-blocking | `idea` | `description`, `source` = "Checkpoint 1 owner session", `status`, `gating`, `money_impact`, `customer` |
| The session itself | `uat_test_case` | one per checkpoint run: `description`, `status`, `test_env`, `evidence_ref`, `tester` = Phillip, `run_at` |
| Screen capture / artefacts | `evidence` | `description`, `evidence_type`, `value`, `source_url`, `captured_at` |
| Effect on packet progress | **Request a note** from the session that owns `xp-isola-signup-to-agent-mvp-2026-08-10`. Do **not** write the packet from a review session — Port replaces string properties wholesale on upsert, so a scribe's edit can silently destroy the 28-row matrix. |

---

## 4. Checkpoint 2 — Home (the dashboard) and provisioning

### What Phillip sees

1. Driver signs in as synthetic tenant A (state carried from Checkpoint 1).
2. The portal lands on the dashboard — **the sidebar entry is labelled “Home”, not “Dashboard”** — and shows **provisioning in progress** with a truthful state — not a fake progress bar.
3. Driver refreshes mid-provisioning. The state advances or holds; it never resets and never duplicates.
4. Driver triggers the retry/refresh control once. Phillip sees a retry return the **existing** resources rather than create a second set.
5. Provisioning completes. The dashboard shows the **real** identifiers it created — company, employee, workspace — not placeholders.
6. Driver deliberately shows one thing that is **not** ready, and the honest state it reports.
7. **Operator half:** driver switches to NocoBase and shows the same tenant, its bindings, its provisioning history and its retry state.
8. Driver signs out and back in; the dashboard reports the same state with the same identifiers.

### Exact surface

| Element | Surface |
|---|---|
| Customer dashboard / provisioning status | **NOT BUILT — required:** the Apptension fork from Checkpoint 1, plus a provisioning-status read path returning real external IDs from the authoritative engines (Paperclip, Chatwoot, the Isola registry) rather than portal-local copies |
| Provisioning orchestration | **NOT BUILT / UNADMINISTRABLE — required:** Activepieces 0.87.0 is deployed and healthy but has **no domain**, `AP_SIGN_UP_ENABLED=false`, and no admin credential in its env — no first user can be created and no flow authored |
| Operator control plane | **NOT REACHABLE — required:** NocoBase 2.0.48 is deployed and healthy but has **no domain attached** and no `INIT_ROOT_EMAIL` / `INIT_ROOT_PASSWORD`, so the UI cannot be bootstrapped |

### Preconditions

| Precondition | State | Blocker |
|---|---|---|
| Checkpoint 1 accepted | **BLOCKED** | Checkpoint 1 cannot run yet. |
| Portal dashboard exists and reads engine truth | **BLOCKED — in progress** | WS3 build time remaining; not gated. |
| Activepieces administrable | **BLOCKED** | No domain, signup disabled, no admin credential — OWNER DECISION 5. |
| NocoBase administrable | **BLOCKED** | No domain, no root bootstrap credentials — OWNER DECISION 4. |
| Provisioning is idempotent at the Paperclip layer | **AVAILABLE** | Row 6 passes at that layer: retry returned `existing`, `drift: none`. |
| A Paperclip Company created *for a synthetic tenant* | **BLOCKED** | Row 8: only the pre-existing EPIC company has been reused; per-tenant creation not yet exercised. |
| Chatwoot account/user/team/inbox/AgentBot creation path | **BLOCKED** | Row 10 Not run. Account 3 / team 4 / inbox 4 / AgentBot 1 exist, but were not created by the path under review. |

### What good looks like

- [ ] The in-progress state names what is being created; nothing implies completion before it is true.
- [ ] Refresh mid-flight changes nothing except forward progress — no reset, no second row, no duplicate company.
- [ ] The retry control returns the **same** identifiers, visibly — Phillip can compare the strings on screen before and after.
- [ ] Every identifier shown is a real external ID the driver can match in the authoritative engine on the next screen.
- [ ] The deliberately-not-ready item reads as an honest state with a next action — not "Ready", not a spinner forever, not a raw stack trace.
- [ ] In NocoBase, the same tenant, bindings and provisioning history appear, and the retry state agrees with what the customer saw.

### Deliberately absent — read this aloud before starting

| Absent | Why |
|---|---|
| Billing, usage metering, invoices, plan management | Payments deferred; Odoo writes and the embedded Odoo app are explicitly out of the MVP. |
| Any Odoo record | Same. Odoo is authoritative but out of MVP scope. |
| Channel connection (WhatsApp / Meta / email / SMS) | No real customer channel in the MVP. The only channel in play is a synthetic Chatwoot `Channel::Api` inbox. The non-production-numbers ruling does not add one here. |
| A generic agent marketplace, Soul editor, community templates, arbitrary agent creation | Explicitly out of scope in the packet objective. |
| Rich analytics, charts, conversation volume | Not in the MVP journey. |
| NocoBase presented as the customer's screen | Ratified: NocoBase is the operator control plane only. Step 7 is shown **as the operator view**, labelled as such. |
| A second tenant's data anywhere | Isolation is Checkpoint 3's subject; one tenant on screen here by design. |

### The owner ruling asked for

> **Accept this dashboard as the customer's provisioning-status surface — does it tell the truth?** Accept · reject · accept with one named state that must be shown differently.

**What the ruling unblocks:** the status contract freezes, so WS4's provisioning orchestration
can be authored against a fixed set of states instead of a moving one, and rows 7, 11 and 27
become runnable. It also settles what "truthful" means for every later status surface in the
product.

### Acceptance rows covered

| Row | Test | Current stated result |
|---|---|---|
| 6 | Refresh/retry creates no duplicates | **Pass (Paperclip layer)** — provisioning retry returned `existing`, `drift: none` |
| 7 | Provisioning progress is truthful | **Not run** |
| 8 | Exactly one Paperclip Company is created | Pre-existing EPIC company reused; **per-tenant creation not yet exercised** |
| 10 | Exactly one Chatwoot account/user/team/inbox/AgentBot path | **Not run** |
| 11 | Portal displays correct real IDs/status | **Not run** |
| 27 | EPIC operator sees tenant, bindings, provisioning history and retry state in NocoBase | **Not run** |

### Blockers to running this checkpoint today

| Blocker | Owner |
|---|---|
| Every Checkpoint 1 blocker | See above |
| NocoBase has no domain and no root credentials — row 27 cannot be shown at all | Owner — OWNER DECISION 4 |
| Activepieces has no domain, signup disabled, no admin credential — provisioning orchestration cannot be authored or demonstrated | Owner — OWNER DECISION 5 |
| Row 8 requires a per-tenant Paperclip company that has never been created | Isola engineering, after WS3 |

### Feedback capture

Same routing table as Checkpoint 1. Additionally:

- A provisioning state that is **wrong** (claims ready when it is not) → `defect`, `severity` `P1` minimum. Truthful states are a product law here, not a nicety.
- A provisioning state that is **ugly but honest** → `idea`.
- "The operator needs to see X here too" → `requirement` against the NocoBase control-plane scope, not a packet edit.

---

## 5. Checkpoint 3 — My AI Company and employee profile

### What Phillip sees

1. Driver signs in as synthetic tenant A and opens **My AI Company**.
2. Phillip sees the company and exactly **one** PUBLIC Front Desk employee — created once, from Template v1.
3. Driver opens the employee profile: name, role, exposure classification (PUBLIC), readiness state.
4. Driver shows the employee's state honestly — at time of writing the proven employee `fd2867d1` is **staged, not ready** — and what changes it.
5. Driver shows the tools/permissions the employee is allowed, and states plainly that everything else is denied.
6. **Known-open P0, announced first:** driver asks the employee **one business question about the tenant** — opening hours, service area, what the company does. **It will not be able to answer.** Driver states the cause before asking, not after. See the flag below.
7. Driver signs in as synthetic tenant **B** in a second browser profile and opens My AI Company. Phillip sees B's own company — **none** of A's data.
8. Driver attempts, from B, to open A's employee by identifier. It is refused.
9. Driver shows the INTERNAL/PUBLIC separation: an INTERNAL employee cannot be attached to the public inbox.

### ⚠ Known-open P0 flag for this checkpoint — announce before step 6

`defect-public-tenant-context-not-wired-to-runtime-2026-08-11` (**P0, Open**).
The PUBLIC Front Desk employee has **no tenant business information available when answering**.
`buildRuntimeContext` in the gateway returns only source, tenant/company IDs, Chatwoot
coordinates and the message — **no business-information field at all**, and a grep across
`services/` for any business-info/knowledge-base/company-profile field returns **zero
matches**. The runtime's entire Paperclip API surface has no company-profile read and no soul
read, so it could not fetch tenant knowledge even if it were stored there.

**What this is NOT:** it is *not* "the product cannot answer a business question". The runtime
demonstrably answers correctly from information placed in its run context — acceptance row 13
proves exactly that for the INTERNAL employee. The gap is that the **PUBLIC path has no wire**
from tenant configuration into that context, and no code writes tenant configuration anywhere.

**Compounding, and worth saying to the owner in the room:** EPIC's own business facts do not
exist as records either — no description, no operating-hours values, no service area, no
address, no public email; the live agent's `bio` and `welcome_message` are empty. Closing the
wire does not by itself produce an answer. The content has to exist.

**Classification, stated aloud:** this is a **P0 Customer Zero / product gap, NOT a WS2
defect**. WS2 is accepted 8/8 and this does not reopen it.

**Expected result of step 6: FAIL.** That is the point of running it — the owner should see the
gap that the next workstream closes, on the record, rather than hear about it second-hand.

### Exact surface

| Element | Surface |
|---|---|
| My AI Company / employee profile in the portal | **NOT BUILT — required:** the Apptension fork, plus a read path to Paperclip company/employee truth scoped by the signed-in tenant |
| Authoritative source behind it | Paperclip — deployed at `https://isola-ai.saas00.epic.dm` (Port-evidenced). This is the **engine's own UI**, not the customer surface. Showing it as a stand-in is acceptable only under OWNER DECISION 7, and must be labelled as the engine, not the product. |
| Proven objects | PUBLIC Front Desk employee `fd2867d1` (Template v1, **staged, not ready**) · INTERNAL employee `2b4cf82a` |

### Preconditions

| Precondition | State | Blocker |
|---|---|---|
| Checkpoint 2 accepted | **BLOCKED** | Chain above. |
| Portal My AI Company screen | **BLOCKED — in progress** | WS3 build time remaining; not gated. |
| One PUBLIC Front Desk employee from Template v1 | **AVAILABLE (engine layer)** | `fd2867d1` exists, created once, staged. Not yet rendered in any customer surface. |
| INTERNAL employee for the separation demo | **AVAILABLE (engine layer)** | `2b4cf82a`. |
| Exposure separation enforced | **AVAILABLE (credential layer)** | INTERNAL bearer on PUBLIC template → `403 exposure_mismatch`, and the reverse; the request body cannot widen it. |
| Cross-company refusal | **AVAILABLE (credential layer)** | Agent key proven company-scoped, 403 ×3. |
| A second synthetic tenant B with its own portal account | **BLOCKED** | > **UNVERIFIED:** no evidence record shows a second synthetic tenant exists at the portal or Paperclip layer today. Row 20 is explicitly **Partial** — "portal/Chatwoot layers not built". |

### What good looks like

- [ ] Exactly one PUBLIC Front Desk employee is listed. Not zero, not two.
- [ ] The readiness state on screen matches its real state (**staged, not ready** today) — the portal does not round it up to "Ready".
- [ ] The exposure classification (PUBLIC) is visible to the customer, not buried.
- [ ] Tenant B's My AI Company shows **nothing** belonging to tenant A — no name, no identifier, no count.
- [ ] Opening A's employee identifier while signed in as B is refused with an honest message, not a blank screen and not a stack trace.
- [ ] The allowed-tools list is finite and stated; the driver can name the denial behaviour without opening a log.
- [ ] **Nowhere on any customer-facing screen do the words "Clawith" or "Paperclip" appear.** Customer-facing material says **"powered by Isola"** (ratified). This is a real, checkable signal — Paperclip replaced Clawith, and gate 1's offer still carries the stale "powered by Clawith" wording.
- [ ] **(Expected to FAIL today)** The employee answers one business question about the tenant. Per `defect-public-tenant-context-not-wired-to-runtime-2026-08-11` (P0, Open) the PUBLIC path has no wire from tenant configuration into the runtime context, so it cannot. Record the failure against the existing defect; **do not** open a new one, and **do not** treat it as a WS2 regression.

### Deliberately absent — read this aloud before starting

| Absent | Why |
|---|---|
| Hiring more employees, creating arbitrary agents, editing the Soul, browsing a template marketplace | Explicitly out of MVP scope. The MVP hires exactly one Front Desk employee from Template v1. |
| Reporting lines, goals, budgets, work assignment | Paperclip owns these natively; not in the MVP journey. |
| Prompt or model configuration exposed to the customer | Not a customer-facing capability in this MVP. |
| The full Test Agent → Chatwoot round-trip | Checkpoint 4. This checkpoint is the *profile*, plus one deliberate business-question probe at step 6. |
| A **working** answer to the business question at step 6 | Known-open P0 above. Its absence is the expected result, announced in advance. |
| Any Chatwoot screen | Checkpoint 4. |
| Live channel bindings (a phone number, a WhatsApp badge) | No real channel in the MVP; a channel badge here would be a false claim, non-production ruling notwithstanding. |
| A "Ready" employee | Today's proven employee is **staged**. If it shows Ready before it is ready, that is a defect, not progress. |

### The owner ruling asked for

> **Accept "one company, one PUBLIC Front Desk employee, honest readiness, hard tenant separation" as the shape of what a pilot customer owns?** Accept · reject · accept with one named element that must change.

**What the ruling unblocks:** the workforce shape for the pilot is settled — Template v1
becomes the fixed MVP hire — so Checkpoint 4's Test Agent can be built against a known
employee contract, and row 20's portal layer can be implemented rather than debated.

**The ruling is about shape, not about step 6.** The business-answer gap is already recorded as
a P0 with a specified fix; the owner is not being asked to re-rule on it. If the owner wants to
change its priority or its fix approach, that is a separate `decision`, recorded separately.

### Acceptance rows covered

| Row | Test | Current stated result |
|---|---|---|
| 9 | Exactly one PUBLIC Front Desk employee from Template v1 | **Pass** — `fd2867d1`, created once, **staged not ready** |
| 20 | Tenant B cannot read, invoke, open or infer Tenant A's resources | **Partial** — agent key proven company-scoped (403 ×3); **portal/Chatwoot layers not built** |
| 21 | INTERNAL employee cannot be attached to the public inbox | **Pass (credential layer)** — INTERNAL bearer on PUBLIC template → `403 exposure_mismatch`, and the reverse; body cannot widen it |
| 22 | Disallowed runtime tools remain denied | **Pass** — 14/14 live boundary tests |

Row 13 is deliberately deferred to Checkpoint 4 — it is about the employee *answering*, not
about its profile.

### Blockers to running this checkpoint today

| Blocker | Owner |
|---|---|
| No portal My AI Company screen | Isola engineering — WS3 build time |
| Step 6 will fail: `defect-public-tenant-context-not-wired-to-runtime-2026-08-11` (P0, Open). Not a blocker to *running* the checkpoint — it is the finding the checkpoint is designed to surface | Isola engineering (fix specified in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` Part A) |
| Tenant business content does not exist as records for EPIC either, so closing the wire alone will not produce an answer | Owner + Isola engineering |
| Row 20's portal and Chatwoot layers do not exist, so isolation can only be shown at the credential layer | Isola engineering |
| No second synthetic tenant B proven at any layer above the agent key | Isola engineering |
| Whether Phillip may be shown Paperclip's native UI as a stand-in | Owner — OWNER DECISION 7 |

### Feedback capture

Same routing table. Additionally:

- **Any** cross-tenant leak observed, however small (a count, a name, an ID in a URL) → `defect`, `severity` `P0`, `status` `Open`, immediately, and the session **stops**. Tenant-isolation failure is a stop condition, not a finding.
- **Step 6's failure** → an `evidence` entity related to `defect-public-tenant-context-not-wired-to-runtime-2026-08-11`, **not** a new defect and **not** a note against WS2.
- An engine name ("Clawith", "Paperclip") visible on a customer surface → `defect`, `severity` `P2`, referencing the ratified "powered by Isola" naming rule.
- "The customer should also be able to …" → `idea` unless it blocks launch, in which case `requirement` with `launch_criticality` set.

---

## 6. Checkpoint 4 — Test Agent and Open Inbox

### What Phillip sees

1. Driver signs in as synthetic tenant A and opens the employee profile from Checkpoint 3.
2. Driver presses **Test Agent** and types one synthetic business question.
3. The employee answers, in the portal, using the synthetic business information from company setup.
4. Driver presses **Open Inbox**. Phillip lands in Chatwoot on the tenant's own workspace.
5. Phillip sees the **same** conversation — the same question, the same answer. One conversation, one reply.
6. Driver replays the same inbound event deliberately. Phillip sees that **no second reply** appears.
7. Driver triggers a controlled failure (runtime made unavailable). Phillip sees an honest failure/handoff state — not a fabricated answer, not silence.
8. **Known-open P0, announced first:** driver types **"I want a human"** as the synthetic customer. The AI replies with a polite sentence saying someone will help. Driver then shows Chatwoot: the conversation is **still `pending`**, the bot **still owns it**, **no human is assigned**, **no notification fired**. See the flag below.
9. Driver sends a small synthetic attachment and shows whether it persists and its background job completes.
10. Driver returns to the portal. The employee's state is consistent with what just happened.

### ⚠ Known-open P0 flag for this checkpoint — announce before step 8

`defect-model-initiated-escalation-no-state-transition-2026-08-11` (**P0, Open**).
A model-initiated escalation **changes no conversation state**. Owner ruling, verbatim:
*"A natural-language sentence claiming that a human will help is not a handoff."*

Only **gateway-detected** triggers move a conversation to `open` and assign it — attachment,
empty message, runtime failure. There are two escalation paths in the system and **only one of
them is real**. The sentence is the entire handoff.

**Why this matters, and worth saying in the room:** `xp-live-ai-first-customer-loop-6737`
records conversation 178 — a genuine total-outage complaint where the AI escalated as urgent
four times over two and a half hours and **no human ever replied**. That is this failure mode
with a real person on the other end.

**Classification, stated aloud:** **P0 Customer Zero / product gap, NOT a WS2 defect.** WS2 is
accepted 8/8 and this does not reopen it.

**Expected result of step 8: FAIL.** Announce it, run it, record it against the existing defect.

### Exact surface

| Element | Surface |
|---|---|
| Test Agent control | **NOT BUILT — required:** a portal control that creates a real Chatwoot conversation on the tenant's PUBLIC inbox via the proven gateway binding, and renders the reply in the portal |
| Open Inbox control | **NOT BUILT — required:** a portal link (or SSO handoff) into the tenant's Chatwoot workspace. OWNER DECISION 9 — Chatwoot login vs embedded view is undecided |
| Chatwoot destination | **EXISTS** — `https://isola-chat.saas00.epic.dm`, Chatwoot v4.16.1, **account 3 · team 4 · inbox 4 · AgentBot 1** |
| Chatwoot deep-link path | > **UNVERIFIED:** the exact in-app path for account 3 / inbox 4 has not been read off the deployed instance. Do not publish a deep link until it has been. |
| Gateway | **EXISTS** — `https://isola-gw.saas00.epic.dm` (public), durable delivery ledger, reserve-before-ACK |

### Preconditions

| Precondition | State | Blocker |
|---|---|---|
| Checkpoint 3 accepted | **BLOCKED** | Chain above. |
| Test Agent control | **BLOCKED** | Not built. |
| Open Inbox control | **BLOCKED** | Not built; handoff model undecided — OWNER DECISION 9. |
| Chatwoot account 3 / inbox 4 / AgentBot 1 | **AVAILABLE** | Deployed and proven. |
| PUBLIC employee invoked end to end at least once | **BLOCKED** | Row 13 passes for **INTERNAL** only — "PUBLIC not yet invoked". |
| Duplicate-suppression proof | **AVAILABLE (runtime layer)** | 3 deliveries → 1 comment, replays in 3–4 ms. |
| Honest-failure proof | **AVAILABLE** | 504 / 502, issue → `blocked`, "nothing inferred, guessed or filled in". |
| Attachment persistence | **BLOCKED** | Row 23 **Not run**; no deployed proof exists. |
| A Chatwoot agent login Phillip can use | **BLOCKED** | > **UNVERIFIED:** no record confirms a customer-usable agent login on account 3 for this session. |

### ⚠ Annotation-defect flag for this checkpoint

`defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` (P2, **Open**).
In Chatwoot v4.16.1, `GET /api/v1/accounts/{account}/conversations/{id}` returns **500** for an
AgentBot caller as soon as the conversation has a **team** assigned — `_team.json.jbuilder`
calls `Current.user.teams`, and `Current.user` is the AgentBot, which has no `teams`
association. `conversations#show` is the **only** conversation read a bot is permitted.

**Consequence:** if a step assigns team 4 to the bot-handled conversation, the gateway's
outcome annotations are **skipped** (`attribute_read_failed`) and send reconciliation degrades
to **fail-closed** (`inconclusive`). Phillip may see a conversation with **no outcome
annotation**. That is the known defect, **not** a new bug. No duplicate customer message can
result, and no handoff is lost.

**Instruction:** avoid team assignment in Checkpoint 4 — purely to keep the annotations
readable. Team assignment is exercised deliberately in Checkpoint 5.

> **Correction, load-bearing — do not carry the old assumption into this session.**
> **Team assignment alone is routing metadata and does NOT silence the AI.** What silences the
> AI is `open` status, a human **user** assignee, or an explicit human-takeover state. The AI
> may respond only when the PUBLIC binding is active, the conversation is `pending`, and no
> human-takeover condition exists. This was **verified in the deployed code** — the gateway
> reads `conversation.meta.assignee`, the *user* assignee — and it corrects a widely-held
> assumption. Any pass signal or configuration built on team-based suppression would have left
> the AI talking over a human, silently. Ratified in
> `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` and clarified
> into `decision-one-authoritative-chatwoot-processor-2026-08-11`.

### What good looks like

- [ ] Test Agent produces one answer, in the portal, grounded in the synthetic business information — not a generic assistant reply.
- [ ] Open Inbox lands in the tenant's own Chatwoot workspace, showing that tenant's inbox and nothing else.
- [ ] The **same** conversation and reply are visible in both surfaces — one conversation, one reply, no orphan.
- [ ] The deliberate replay produces **no second reply** on screen in Chatwoot.
- [ ] The controlled failure produces a visible, honest state with a next action — never a fabricated answer, never silence.
- [ ] **(Expected to FAIL today)** A customer typing **"I want a human"** produces a genuinely human-owned state — the conversation leaves `pending`, a human **user** is assigned, and a notification fires. Per `defect-model-initiated-escalation-no-state-transition-2026-08-11` (P0, Open) none of that happens; the customer gets a sentence and nothing else. Record against the existing defect; **do not** open a new one, and **do not** treat it as a WS2 regression.
- [ ] No customer-facing string names an engine — **"powered by Isola"**, never Clawith, never Paperclip (R14).
- [ ] Returning to the portal shows a state consistent with what happened in Chatwoot.

### Deliberately absent — read this aloud before starting

| Absent | Why |
|---|---|
| Any real customer, real phone number, WhatsApp, Meta, email or SMS | No real channel in the MVP. Everything here is a synthetic `Channel::Api` inbox. The non-production-numbers ruling permits controlled channel testing *elsewhere*; it does not put a channel into this checkpoint. |
| Outcome annotations on any team-assigned conversation | The upstream Chatwoot 500 above. Known, recorded, deliberately not worked around. |
| A working human handoff from "I want a human" | Known-open P0 above. Its absence is the expected result, announced in advance. |
| AI silence caused by a team assignment | **It never was silence.** Team assignment is routing metadata. If the AI keeps answering after a team is assigned, that is correct behaviour, not a defect. |
| An "exactly once" guarantee on Chatwoot sends | Deployed v4.16.1 enforces no message idempotency — `index_messages_on_source_id` is not unique and there is no uniqueness validation. What **is** enforced: a message is sent only after its absence is **proven**, and when absence cannot be proven, nothing is sent. |
| A reply if the ledger is unavailable beyond Chatwoot's ~3 retries (~9s) | Failing closed to a human is intended. Chatwoot opens the conversation to a human itself and `alertCode: ledger_unavailable_on_ack` fires. |
| Human takeover and handback | Checkpoint 5. |
| Conversation history from before this session | Synthetic workspace; no history by design. |

### The owner ruling asked for

> **Accept "test the employee in the portal, then open the real inbox and see the same conversation" as the proof that the AI is working?** Accept · reject · accept with one named signal that must be added.

**What the ruling unblocks:** the AI-proof contract freezes, so rows 12, 14 and the PUBLIC half
of row 13 can be closed, and the pilot has a repeatable demonstration that does not require an
engineer to read a log. It is also the last gate before the takeover contract in Checkpoint 5.

### Acceptance rows covered

| Row | Test | Current stated result |
|---|---|---|
| 12 | Test Agent creates a real Chatwoot conversation | **Not run** |
| 13 | Paperclip-backed employee answers using synthetic business info | **Pass (INTERNAL)** — correct 7-column action list; **PUBLIC not yet invoked** |
| 14 | Conversation and response appear in Chatwoot | **Not run** |
| 18 | Duplicate webhook produces no duplicate reply | **Pass (runtime layer)** — 3 deliveries → 1 comment, replays in 3–4 ms |
| 19 | Runtime timeout/failure produces an honest failure/handoff state | **Pass** — 504 / 502, issue → `blocked`, "nothing inferred, guessed or filled in" |
| 23 | Small synthetic attachment persists and its background job completes | **Not run** |

### Blockers to running this checkpoint today

| Blocker | Owner |
|---|---|
| Test Agent and Open Inbox controls do not exist | Isola engineering — WS3 build time |
| Step 8 will fail: `defect-model-initiated-escalation-no-state-transition-2026-08-11` (P0, Open). Not a blocker to *running* the checkpoint — it is the finding the checkpoint is designed to surface | Isola engineering (fix specified in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` Parts B and C) |
| Row 13's PUBLIC path has never been invoked | Isola engineering |
| Row 23 has no deployed run | Isola engineering |
| Open Inbox handoff model (Chatwoot login vs embedded/SSO) undecided | Owner — OWNER DECISION 9 |
| Chatwoot `conversations#show` 500 fix path undecided; three candidates recorded, two owner-reserved | Owner — OWNER DECISION 6 |
| Whether the Test Agent path reuses the proven inbox-4 binding | Isola engineering — UNVERIFIED 8 |

### Feedback capture

Same routing table. Additionally:

- A **missing outcome annotation** on a team-assigned conversation → **do not open a new defect**. Add an observation referencing `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`.
- **Step 8's failure** → an `evidence` entity related to `defect-model-initiated-escalation-no-state-transition-2026-08-11`, **not** a new defect and **not** a note against WS2.
- A **duplicate customer reply** → `defect`, `severity` `P0`, session stops. It contradicts a proven property and must be investigated before further review.
- A fabricated answer under failure → `defect`, `severity` `P0`. Honest failure is a product law.
- A **successful-transfer message sent when the transfer did not succeed** → `defect`, `severity` `P0`. The required behaviour is explicit: the customer is not told transfer succeeded until the state transition succeeds, and on failure or ambiguity the system fails closed rather than inventing a successful-transfer message.

---

## 7. Checkpoint 5 — Human takeover and handback

**This is the session that runs first** — not because it unblocks anything, but because it is
the only checkpoint whose surfaces are already deployed and proven. See the run-order note in
§0. It carries **one** owner ruling.

The processor-authority and silence-model questions this checkpoint used to carry are
**already ratified** and are demonstrated here rather than debated:
`decision-one-authoritative-chatwoot-processor-2026-08-11` and
`decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`.

### What Phillip sees

1. Driver opens Chatwoot on the tenant's inbox with an active AI-handled conversation.
2. Synthetic customer sends a question; the AI answers. Baseline established.
3. **The disambiguation, shown not asserted:** driver assigns **team 4 only** — no user assignee. Synthetic customer sends another message. **The AI still answers.** Team assignment is routing metadata; it does not silence the AI.
4. Driver now assigns a human **user** as assignee. Synthetic customer sends another message. Phillip watches: **the AI does not reply.**
5. The human replies. Phillip confirms it reaches the synthetic customer's view.
6. The human writes a **private note**. Phillip confirms the customer cannot see it.
7. The human performs an **explicit handback**. The AI resumes — and replies **exactly once**.
8. Driver shows that a **status change alone does not override the human assignment**, and that **only** explicit handback returned control.
9. Driver demonstrates the accepted durability behaviour as context, not as a question: an in-place restart preserving state, an interrupted-after-commit delivery reconciling with **no second reply**, and the ledger-unavailable path answering `500` rather than a false 200. **WS2 is accepted 8/8; nothing here is being re-litigated.**
10. Driver signs the customer out and back in. Tenant and readiness state unchanged.
11. Driver repeats a compressed version of the whole journey for synthetic tenant **B**, with **no manual database edits** *(sequenced re-run only — not possible on the out-of-order first run)*.

> **Steps 3 and 4 are the most valuable minutes in this entire review path.** They are the only
> place the owner sees, live, that team assignment does **not** silence the AI. That assumption
> was widely held and wrong; a configuration built on it would have left the AI talking over a
> human, silently. Do not compress these two steps.

### Exact surface

| Element | Surface |
|---|---|
| Takeover, private note, handback | **EXISTS** — Chatwoot v4.16.1 at `https://isola-chat.saas00.epic.dm`, account 3 · team 4 · inbox 4 · AgentBot 1 |
| Suppression predicate (ratified, and matching deployed code) | AI may respond **only** when the PUBLIC binding is active, the conversation is `pending`, and no human-takeover condition exists. **Silences AI:** `open` status · a human **user** assignee · an explicit human-takeover state. **Does NOT silence AI:** a team assignment (routing metadata). The gateway reads `conversation.meta.assignee` — the *user* assignee. |
| Resume path | **Explicit handback only**, resuming **exactly once**. A status change must never override an existing human assignment. |
| Delivery ledger | **EXISTS** — `isola/isola-ledger-db`, private Postgres 16, `exposedPort: 0`, no domain; atomic key `(tenant_id, binding_id, chatwoot_account_id, chatwoot_inbox_id, event_id, action_type)` |
| Portal-side state after takeover | **NOT BUILT — required:** whatever the portal shows a customer while a human is handling their conversation. Undefined today. |
| Second synthetic tenant journey (row 28) | **NOT BUILT** — depends on Checkpoints 1–4 |

### Preconditions

| Precondition | State | Blocker |
|---|---|---|
| Chatwoot account 3 / team 4 / inbox 4 / AgentBot 1 | **AVAILABLE** | Deployed and proven. |
| Takeover suppresses AI | **AVAILABLE (gateway layer)** | Proven live this packet, conversation 37. Matrix row 15 is still **Not run** because it must be proven **through the customer journey**, not only at the gateway. |
| Explicit handback resumes exactly once | **AVAILABLE (gateway layer)** | Same evidence, same caveat (row 17). |
| Private-note privacy | **AVAILABLE** | Listed in the packet's passing regressions. |
| Durability demonstration material | **AVAILABLE** | **All eight** durability proofs accepted, including duplicate-after-container-replacement → no second reply. Shown as context, not as a question. |
| Processor authority and silence model | **RESOLVED — AVAILABLE to demonstrate** | Ratified: `isola-gateway` (EasyPanel) is canonical, Foundation is legacy-only and must never process the same binding. Foundation's `human_handling` remains legacy-only and must not become a second source of truth. |
| A team assignment that can be made without a user assignee (step 3) | **AVAILABLE** | Chatwoot supports team-only assignment; team 4 exists on account 3. |
| Restart durability | **PARTIAL** | Row 25: in-place restart preserves; **container replacement loses `/tmp` state** (measured). |
| Second synthetic tenant end-to-end | **BLOCKED** | Row 28 Not run; depends on the whole chain. Only reachable on the sequenced re-run. |

### ⚠ Annotation-defect flag for this checkpoint

Step 3 onward assigns **team 4** to a bot-handled conversation — exactly the trigger for
`defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11`. Note the two are
independent: the team assignment does **not** silence the AI, but it **does** break the bot's
`conversations#show` read. Expect and pre-announce:

- The gateway logs `attribute_read_failed` and **skips** the custom-attribute write rather than clobbering it.
- `reconcileDeliveryRef` returns `inconclusive`; send reconciliation is **fail-closed** on this conversation.
- Phillip will see a correctly-handled conversation with **no outcome annotation**.
- **No duplicate customer message is possible**, and **no handoff is lost**. What is lost is the ability to resolve an ambiguous send on an already-escalated conversation.

This is the one checkpoint where the defect is guaranteed to fire. Say so before step 3.
`decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` is explicit that
**Chatwoot must not be modified in this packet** merely to make prepared rules work.

### What good looks like

- [ ] **After a team-only assignment, the AI still answers.** Team assignment is routing metadata. This is a pass, not a defect.
- [ ] After a human **user** is assigned, the synthetic customer's next message receives **no AI reply** — visible silence, not a race won by luck.
- [ ] The human's reply is visible to the synthetic customer.
- [ ] The private note is visible to staff and **not** to the customer.
- [ ] After explicit handback the AI replies **exactly once** — not zero, not twice.
- [ ] A status change alone does **not** override the existing human assignment.
- [ ] The in-place restart leaves the conversation, tenant and readiness state intact.
- [ ] *(Sequenced re-run only)* Tenant B's compressed run needs **no manual database edit** at any step.

### Deliberately absent — read this aloud before starting

| Absent | Why |
|---|---|
| Outcome annotations on the escalated conversation | The Chatwoot 500 above. Guaranteed at this checkpoint. |
| Resolve-as-handback | Handback must be **explicit**. Resolution alone must not be accepted as handback — a prior recorded defect showed resolve acting as a silent handback with the AI's memory surviving the boundary. If resolve silently hands back here, that **is** a defect. |
| Any real customer or real channel in the takeover | Synthetic only. The non-production-numbers ruling authorises controlled channel testing as a separate activity; it does not put a real number into this session, and no real person may be contacted without separate owner authorisation. |
| Takeover from the portal | Chatwoot owns human takeover. The portal must not become a second inbox — one canonical frontend, no duplicate surfaces. |
| Container-replacement durability | Row 25 is **Partial** by measurement: in-place restart preserves; container replacement loses `/tmp` state. Show the in-place restart; state the limitation rather than hiding it. |
| Rows 24 and 28 on the out-of-order first run | They require the portal, which does not exist yet. They close only on the sequenced re-run. |
| Any re-litigation of WS2 | **WS2 is accepted 8/8.** Step 9 shows durability as context. Completed durability proofs are not rerun except for targeted regressions demonstrably caused by later code changes. |
| A debate about which processor is authoritative | Already ratified: `isola-gateway` is canonical, Foundation is legacy-only. Demonstrated here, not decided here. |
| A working handoff from a model-initiated escalation | That gap is Checkpoint 4's known-open P0. This checkpoint exercises **operator-initiated** takeover, which does work. |

### The owner ruling asked for

**Ruling 5 — does the deployed behaviour match the ratified contract, and is it acceptable as the customer experience?**

> **Accept the deployed takeover behaviour — team assignment does not silence, a human user assignee silences, explicit handback resumes exactly once — as conforming to the ratified silence contract and acceptable as what a pilot customer's staff will actually live with?** Accept · reject · accept with one named behaviour that must change.
>
> This is a **conformance and experience** ruling, not an authority ruling. Processor authority and the silence contract are already ratified; the owner is being asked whether the thing on screen is the thing that was ratified, and whether it is good enough to put in front of a pilot customer's staff.
>
> **What the ruling unblocks:** rows 15–17 become closable on the sequenced re-run; the escalation fix specified in `docs/isola/RUNTIME-TENANT-CONTEXT-AND-HANDOFF-CONTRACT.md` Parts B and C can be built against a confirmed target behaviour rather than an assumed one; and the Chatwoot operating configuration — whose prepared team-based suppression rules **must not be applied** — can be rewritten against what the owner has actually seen.

### Acceptance rows covered

| Row | Test | Current stated result |
|---|---|---|
| 15 | Human takeover suppresses AI | **Not run** (gateway-layer regression passes; the journey run has not happened) |
| 16 | Human reply reaches the test customer | **Not run** |
| 17 | Explicit handback resumes AI exactly once | **Not run** (gateway-layer regression passes; the journey run has not happened) |
| 24 | Logout and login preserve tenant and readiness state | **Not run** |
| 25 | Required service restart preserves configuration and data | **Partial** — in-place restart preserves; container replacement loses `/tmp` state (measured) |
| 26 | No payment, Odoo write, Meta, WhatsApp, PBX or real-customer mutation occurred | **Holding — true** |
| 28 | The journey repeats for a second synthetic tenant with no manual DB edits | **Not run** |

### Blockers to running this checkpoint today

| Blocker | Owner |
|---|---|
| **None for the out-of-order first run.** Chatwoot, the gateway and the ledger are all deployed and proven, and no ruling gates it. Steps 1–10 can run today. | — |
| Rows 24 and 28 need the portal | Isola engineering — WS3 build time; closes on the sequenced re-run only |
| Row 25's container-replacement gap is measured and open | Isola engineering |
| Chatwoot 500 will fire on every escalated conversation until the fix path is chosen | Owner — OWNER DECISION 6 |
| Phillip must agree, before starting, that the out-of-order run is **not** acceptance of rows 15–17, 24 or 28 | Owner (stated at session start) |

### Feedback capture

Same routing table. Additionally:

- **Ruling 5** → `decision`, `decided_by` = `Owner (Phillip)`, `status` `Ratified`, referencing the two ratified processor/silence decisions it confirms conformance against.
- **If the AI goes silent on a team-only assignment** → `defect`, `severity` `P1`. That contradicts both the ratified contract and the verified deployed predicate, and means something changed.
- **If the AI keeps answering after a human user is assigned** → `defect`, `severity` `P0`, session stops. That is the AI talking over a human.
- A second reply after handback → `defect`, `severity` `P0`, session stops.
- Resolve acting as a silent handback → `defect`, `severity` `P1`, cross-referenced to the prior recorded instance of that class.
- Missing outcome annotation → observation against the existing Chatwoot 500 defect, **not** a new defect.

---

## 8. Full acceptance-row coverage map

All 28 rows are covered exactly once as a primary, so no row is orphaned and none is
double-counted for progress.

| CP | Rows | Rows already passing (any layer) | Rows Not run |
|---|---|---|---|
| 1 | 1, 2, 3, 4, 5 | — | 1, 2, 3, 4, 5 |
| 2 | 6, 7, 8, 10, 11, 27 | 6 | 7, 8*, 10, 11, 27 |
| 3 | 9, 20, 21, 22 | 9, 21, 22 | 20 (Partial) |
| 4 | 12, 13, 14, 18, 19, 23 | 13 (INTERNAL only), 18, 19 | 12, 14, 23 |
| 5 | 15, 16, 17, 24, 25, 26, 28 | 25 (Partial), 26 (Holding) | 15, 16, 17, 24, 28 |

\* Row 8 is recorded as "pre-existing EPIC company reused; per-tenant creation not yet
exercised" — neither a clean Pass nor a clean Not run.

**Totals as stated in the packet:** 8 rows Pass at some layer · 3 Partial/Holding · 1 ambiguous
(row 8) · 16 Not run.

---

## 9. What would make a checkpoint fail the review process itself

Not "the product failed" — the *session* failed, and it should be stopped and re-run.

| # | Process failure | Why it invalidates the session |
|---|---|---|
| F1 | The "Deliberately absent" list was not read aloud first | Every absence becomes a candidate defect; the session produces a backlog instead of a ruling. |
| F2 | The session ended with no ruling recorded — not even "deferred" | The whole point of a bounded checkpoint is an owner ruling. No ruling = no checkpoint. |
| F3 | Real customer data, a real phone number, or a live channel appeared | Violates MVP scope and puts row 26 at risk. The non-production ruling removes the outage risk, not the scope boundary. Stop immediately. |
| F4 | Fixtures, mocks or hand-seeded rows were shown as if they were provisioned truth | Repository code and seeded state are not evidence of deployed behaviour. An accepted checkpoint built on a fixture is worse than no checkpoint. |
| F5 | Two checkpoints were merged because "we're already here" | Reintroduces the big-reveal failure mode. The scope creep is the failure. |
| F6 | The owner drove the screen and mutated state mid-session | The owner becomes a co-author; the accept/reject boundary dissolves and the ruling is no longer independent. |
| F7 | Findings stayed verbal — no Port identifier read back before close | They will be re-derived from scratch later. This has happened repeatedly on this programme. |
| F8 | A known, already-recorded defect was logged again as new | Duplicates the ledger and inflates the apparent defect count. Reference, don't re-file. |
| F9 | A layer-qualified pass was presented as a journey pass | "Pass (runtime layer)" is not "the customer's journey works". Misrepresenting it makes the acceptance matrix untrustworthy. |
| F10 | The session ran past its timebox to "just finish it" | Fatigue converts a ruling into acquiescence. |
| F11 | The session wrote to `xp-isola-signup-to-agent-mvp-2026-08-10` | The packet is owned by another session, and Port replaces string properties wholesale on upsert — a scribe's edit can silently destroy the 28-row matrix. |
| F12 | A checkpoint ran before its §0 trigger condition was actually true | The result cannot be reused; the checkpoint must be re-run, and confidence in the earlier "acceptance" is spent. |
| F13 | An owner ruling was given but not recorded in the same turn | The next session re-litigates it, and the blocked workstream stays blocked despite the ruling existing. |
| F14 | A session was used to reopen **WS2**, or an already-ratified decision was re-argued instead of demonstrated | WS2 is accepted 8/8, and processor authority and the silence contract are ratified. The two P0 gaps at Checkpoints 3 and 4 are Customer Zero / product gaps and are not WS2 defects. Re-opening settled work is the most expensive failure mode available to a review session. |
| F15 | A known-open P0 was discovered live instead of announced in advance (R15) | An expected failure the owner was warned about is data; the same failure discovered live reads as a collapse and invites F14. |

---

## 10. OWNER DECISION REQUIRED — index

**Items 2 and 3 are RESOLVED** — struck through below with their citations, kept rather than
deleted so nobody re-derives them. Item 6 remains open and is surfaced inside a checkpoint so
the owner can see the defect fire before ruling on it. The rest are configuration and scoping
rulings needed to run the sessions at all.

> **OWNER DECISION REQUIRED 1:** Does the customer portal get its own public domain, and which hostname? `portal.saas00.epic.dm` appears only in the packet's `repository` property describing the EasyPanel project and in **no** evidence record; the three Port-evidenced hosts are `isola-ai`, `isola-chat` and `isola-gw` at `.saas00.epic.dm`. **Blocks Checkpoint 1.**

> ~~**OWNER DECISION REQUIRED 2:** WS2 acceptance — accept the unit proof for "restart after durable enqueue but before processing eventually produces one reply", or direct an acceptable construction.~~
>
> **RESOLVED — WS2 is ACCEPTED on all eight deployed durability proofs.** Cited:
> `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11` §4. WS3 is **not**
> blocked by WS2 and **not** blocked by Activepieces access; it continues at a safe commit
> boundary. **This is a gate on nothing.** The two P0 gaps at Checkpoints 3 and 4 are Customer
> Zero / product gaps and do not reopen it. Completed durability proofs are not rerun except for
> targeted regressions demonstrably caused by the code changes that close those gaps.

> ~~**OWNER DECISION REQUIRED 3:** Which component is the authoritative Chatwoot agent-bot processor for a given number, and which silence model governs.~~
>
> **RESOLVED — `isola-gateway` (EasyPanel) is the canonical Chatwoot processor; Foundation is
> legacy-only and must never process the same binding.** NocoBase records the authoritative
> tenant/account/inbox/binding; Paperclip owns the AI workforce. Foundation's `human_handling`
> stays legacy-only and must not become a second source of truth. Migration is one binding at a
> time with before/after readback, proving one inbound message produces one reply and **zero**
> processing by the retired handler; **no account, inbox or number may ever be attached to both**.
> Cited: `decision-one-authoritative-chatwoot-processor-2026-08-11` and
> `decision-isola-gateway-authoritative-processor-foundation-legacy-2026-08-11`.
> **The silence contract that follows is demonstrated at Checkpoint 5, steps 3–4, not re-decided:**
> team assignment is routing metadata and does **not** silence AI; `open` status, a human **user**
> assignee, or an explicit human-takeover state does. Verified against deployed code —
> the gateway reads `conversation.meta.assignee`.

> **OWNER DECISION REQUIRED 4:** Configure NocoBase root bootstrap (`INIT_ROOT_EMAIL` / `INIT_ROOT_PASSWORD`) and attach a domain. Without both, NocoBase is unadministrable and **acceptance row 27 can never be demonstrated**. **Blocks Checkpoint 2 step 7.**

> **OWNER DECISION REQUIRED 5:** Configure an Activepieces admin identity and attach a domain (currently no domain, `AP_SIGN_UP_ENABLED=false`, no admin credential — no first user can be created). Without it, cross-system provisioning cannot be authored or demonstrated. **Blocks Checkpoint 2.**

> **OWNER DECISION REQUIRED 6:** Choose the fix path for `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` — (1) patch/upgrade Chatwoot so `_team.json.jbuilder` guards `Current.user.respond_to?(:teams)` (recommended, at the next upgrade window); (2) give the gateway a second user-scoped Chatwoot credential (a security-posture change, owner-reserved); or (3) defer and accept missing annotations on escalated conversations. This also affects `inbox.epic.dm`, which is the same v4.16.1. **Affects Checkpoints 4 and 5; can be ruled at Checkpoint 5 where the defect fires in front of the owner.**

> **OWNER DECISION REQUIRED 7:** May Phillip be shown engine-native UIs (Paperclip at `isola-ai.saas00.epic.dm`, Chatwoot) as a stand-in during Checkpoints 2 and 3 before the portal exists, clearly labelled as the engine and not the product — or must those checkpoints wait for the portal? **Determines whether Checkpoints 2–3 can run at all before WS3.**

> **OWNER DECISION REQUIRED 8:** Who mints the invite codes for synthetic tenants A and B, and where does the allowlist live? Signup must stay invite-gated until payment, rate limiting and abuse controls are live. **Blocks Checkpoint 1.**

> **OWNER DECISION REQUIRED 9:** Does "Open Inbox" hand the customer a Chatwoot login with its own credential, or an embedded / SSO'd view? Determines what Checkpoint 4 step 4 shows and whether a second credential is issued to pilot customers. **Blocks Checkpoint 4.**

> **OWNER DECISION REQUIRED 10:** Are checkpoint sessions screen-recorded and attached as `evidence` entities with `source_url`, or is the scribe's written record sufficient? **Affects every checkpoint's feedback capture.**

---

## 11. UNVERIFIED — index

> **UNVERIFIED 1:** `portal.saas00.epic.dm` as the customer portal URL. Present only in the packet's `repository` property; zero evidence records reference it. It may be the EasyPanel panel itself.

> **UNVERIFIED 2:** The portal's concrete route paths (sign-up, verification, sign-in, company setup). Not read off pinned commit `931ad3fea9ef291d2a167d6f497ef240802780c4`. No route string is printed in this document for that reason.

> **UNVERIFIED 3:** The Chatwoot in-app deep-link path for account 3 / inbox 4. Not read off the deployed instance.

> **UNVERIFIED 4:** Whether a transactional email provider is configured and delivering for the portal. `Dockerfile.render` is required precisely because transactional email silently breaks otherwise — a live risk for acceptance row 2.

> **UNVERIFIED 5:** Whether a second synthetic tenant B exists at any layer above the agent key today. Row 20 is explicitly Partial, "portal/Chatwoot layers not built"; row 28 is Not run.

> **UNVERIFIED 6:** What moves PUBLIC employee `fd2867d1` from **staged** to **ready**, and which surface exposes that control to a customer.

> **UNVERIFIED 7:** Whether Chatwoot account 3 has a customer-usable agent login that Phillip can sign into for Checkpoints 4 and 5.

> **UNVERIFIED 8:** Whether the Test Agent path will reuse the proven inbox-4 gateway binding or introduce a new one. A new binding re-opens the duplicate-binding and exposure-classification checks the gateway currently refuses at boot.

> **UNVERIFIED 9:** Phillip's Port access level — whether they record rulings directly or the scribe records on their behalf.

> **UNVERIFIED 10:** Attachment persistence and background-job completion (row 23). No deployed run exists; it is unknown whether Checkpoint 4 step 8 will pass, fail, or be unrunnable.

> **UNVERIFIED 11:** What the portal shows a customer while a human is handling their conversation. Undefined today; Checkpoint 5 step 4 has no portal-side counterpart yet.

---

*Written against Port as of 2026-08-11. Port is the authority; where this document and Port disagree, re-read the record and correct this document.*
