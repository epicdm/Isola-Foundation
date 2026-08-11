# Isola Managed Pilot Package

**One customer, end to end — prepared now, activated only when the named gates open.**

| | |
|---|---|
| **Document status** | Commercial delivery package. Preparation only. |
| **Authored** | 2026-08-11 |
| **Governing packet** | `xp-fast-track-ai-sales-agent-first-sale` — **titled "HOLD — First External Customer After EPIC"**, status Ready, RAG Yellow, progress 10% |
| **Governing gates** | `isola-gate-01-product-offer` (In Progress, 65%) · `isola-gate-07-perkys-customer1` (In Progress, 25%) |
| **Technical packet referenced (read-only)** | `xp-isola-signup-to-agent-mvp-2026-08-10` — In Progress, 84%, owned by a different lane. **Never written by this document.** |
| **Claim wording authority** | `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` (frozen spec). **This document does not author a claim list.** |
| **Truthfulness rule** | No price, discount, term, date, SLA, customer name or capability is invented here. Every commercial number cites a Port `epic_offer` property or a ratified Port `decision`, or appears as an **OWNER DECISION REQUIRED** callout. |

> **The frozen spec was not present on disk at the time this document was written.** Every
> cross-reference to it below is a forward reference. Before this package is used with a
> customer, §4 (intake) and §3 (demo) must be reconciled against the published spec, and
> **where the spec and this document disagree, the spec wins.** Recorded as UNVERIFIED-1.

---

## 1. Status and authority

### 1.1 What this package authorises

| # | Authorised | Basis |
|---|---|---|
| A1 | Preparing and internally reviewing pilot materials — proposal, intake, demo, acceptance checklist, stabilisation plan | `xp-fast-track-ai-sales-agent-first-sale` rollback clause: *"Commercial materials may remain stored and truthful"* |
| A2 | Warm outreach and private demos to a named prospect, **after** the hold lifts | `dec-gtm-customer1-before-public-ads` (Ratified): *"Warm outreach, private demos and preparation may begin now"* |
| A3 | Running the demo of §3 against the **synthetic** Chatwoot account 3 / inbox 4 (`Channel::Api`) only | Acceptance row 26 of `xp-isola-signup-to-agent-mvp-2026-08-10`: *"No payment, Odoo write, Meta, WhatsApp, PBX or real-customer mutation occurred — Holding, true"* |
| A4 | Collecting configuration intake (§4) from a prospect as unexecuted paperwork | Gate 1 next action: *"Lock the … offer, payment terms, signup form, configuration intake, demo script and founding-customer agreement as one sellable packet."* |

### 1.2 What this package explicitly does NOT authorise

| # | Prohibited | Basis |
|---|---|---|
| P1 | **Activating a live customer service.** | `isola-gate-07-perkys-customer1` next action: *"Do not activate the live service until the 6737 and customer acceptance gates pass."* |
| P2 | **Executing outreach, collecting a deposit, onboarding or activating.** | `xp-fast-track-ai-sales-agent-first-sale` acceptance string: `STATUS=HOLD / BLOCKED_BY=EPIC_CUSTOMER_ZERO_ACCEPTANCE / OUTREACH=NO / DEPOSIT=NO / CUSTOMER1_ACTIVATION=NO / COMMERCIAL_MATERIALS=PRESERVED` |
| P3 | **Collecting any payment by any rail.** | Packet scope excludes checkout/subscriptions/Paymenter; `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` (Open) forbids a Stripe or Fiserv customer link for Customer #1 |
| P4 | **Connecting any real channel** — Meta, WhatsApp, Facebook, Instagram or email. | Packet out-of-scope clause; `risk-two-chatwoot-agent-bot-processors-2026-08-11` mitigation step 2: an owner ruling is required *before* WS3/WS4 wire any real channel |
| P5 | **Publishing any price, promo or SLA that is not cited in §5.7.** | `dec-gtm-pricing-provisional-until-live-recon` (Ratified) |
| P6 | **Any public or paid acquisition campaign.** | `dec-gtm-customer1-before-public-ads` (Ratified); `risk-foh-accidental-broad-launch` (Open) |
| P7 | **Entering any paying-tenant data into Paperclip before the restore gate passes.** | `decision-paperclip-shared-instance-pilot-only-and-recovery-gates-2026-08-10` §2: *"No paying-tenant data enters Paperclip until a complete restore has passed on a second throwaway instance."* |

### 1.3 Gate chain that must open before activation

```
xp-epic-customer-zero-100-percent accepted        (dec-customer-zero-epic-gate-before-customer-one-2026-07-21)
        ↓
EPIC configuration frozen as repeatable tenant template
        ↓
xp-fast-track-ai-sales-agent-first-sale released from HOLD
        ↓
6737 gate + customer acceptance gate pass          (isola-gate-07 next action)
        ↓
Owner ruling on risk-two-chatwoot-agent-bot-processors-2026-08-11
        ↓
Paperclip restore-on-throwaway-instance gate passes (decision-paperclip-shared-instance… §2)
        ↓
ACTIVATION PERMITTED
```

**Every one of those five gates is open today.** Nothing in this document changes that.

---

## 2. Pilot definition

### 2.1 What a managed pilot is

A managed pilot is **an EPIC-operated service delivered to one named business**, on
EPIC-owned infrastructure, with EPIC doing the configuration and the customer doing the
business input and the judging. The customer buys an outcome and a service relationship,
not a software login they administer.

This is the ratified operating model, not a choice made here:

- `dec-gtm-concierge-before-selfserve` (Ratified) — concierge launch before self-service.
- Every `epic_offer` record carries the exclusion **"No self-service signup."**
- `cap-selfserve-signup` `truth_status` = **Future**, condition: *"BLOCKED until ALL of: E2E UAT pass … AND explicit owner launch authorization."*
- `offer-epic-customer-operations-workspace` `offer_status` = **Managed pilot**.

### 2.2 Managed pilot vs self-serve — never blur these in a sales conversation

| Dimension | **Managed pilot** (what is being sold) | **Self-serve** (what is NOT being sold) |
|---|---|---|
| Who creates the account | EPIC, by hand, from the intake form | The customer, through a signup page |
| Signup page | **Does not exist.** WS3 portal not built | Would exist |
| Who configures the agent | EPIC | The customer |
| Who connects channels | EPIC — and in this pilot, **no real channel is connected at all** | The customer |
| Who fixes a fault | EPIC, on EPIC's substrate | The customer raises a ticket |
| Admin console for the customer | **None.** NocoBase has no domain and no root credential; Activepieces has no domain and signup disabled | Customer self-administers |
| Commercial motion | Proposal → owner approval → agreement → deposit → configure → acceptance → go-live | Card on file, instant provisioning |
| Port status | Available today as the operating model | `cap-selfserve-signup` = Future / BLOCKED |
| Correct sentence | *"EPIC sets this up for you and operates it."* | *(never say)* *"You can sign up and set it up yourself."* |

> **If a prospect asks "can I just sign up?" the honest answer is: "Not today. EPIC sets it
> up for you. Self-service is not open."** Do not soften this into "soon", "shortly", or a
> date. `cap-selfserve-signup` carries no date and none may be given.

### 2.3 Duration and shape

| Element | Value |
|---|---|
| Pilot length | > **OWNER DECISION REQUIRED:** no ratified pilot duration exists in Port. Nothing in `epic_offer`, gate 1, gate 7 or any `decision` entity states a pilot term. |
| Stabilisation window | **7 days from activation** — see §7. This document defines it; it is one of the artifacts `claim-gtm-epic-managed-setup-support` requires before that claim can move from Draft to Approved. |
| Channel during the pilot | Synthetic Chatwoot `Channel::Api` inbox only. **No real channel.** |
| Tenant count | One. `risk-paperclip-logical-tenant-isolation-shared-instance-2026-08-10` is Accepted **for the controlled pilot stage only**. |
| Exit | Day-7 exit test: continue / remediate / roll back (§7.3). |

### 2.4 EPIC does / customer does

| # | Activity | EPIC | Customer |
|---|---|---|---|
| 1 | Provide business facts (hours, services, FAQ, deny-list) | Structures and challenges them | **Owns and signs off the content** |
| 2 | Create the Paperclip company and Front Desk employee | ✔ | — |
| 3 | Create the Chatwoot account, team, inbox, users, AgentBot | ✔ | — |
| 4 | Configure the gateway binding | ✔ | — |
| 5 | Load the business knowledge into the employee | ✔ | Reviews and approves before activation |
| 6 | Name the escalation humans and their coverage hours | Records and configures | **Names them and staffs them** |
| 7 | Watch the inbox and take over when escalated | Monitors during stabilisation | **Answers the escalated conversation** |
| 8 | Run the acceptance test | Facilitates and captures evidence | **Witnesses and signs** |
| 9 | Daily stabilisation checks (§7) | ✔ | Reports what they saw |
| 10 | Incident response on EPIC substrate | ✔ | — |
| 11 | The customer's own devices, internet and third-party apps | ✘ out of scope | ✔ |
| 12 | Anything requiring a Meta policy exception | ✘ out of scope | — |

*(Rows 11–12 are the standing support boundary carried verbatim in the `support_boundary`
property of `offer-epic-smart-business-line`.)*

---

## 3. Demo script

### 3.1 Claim-basis codes used in this script

These codes state **what evidence each beat rests on**. They are not a claim register and
they do not authorise any wording. **The permitted wording for every beat comes from the
frozen spec** at `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md`.

| Code | Meaning |
|---|---|
| **E1 PROVEN-DEPLOYED** | A `Pass` row in the acceptance table or WS2 evidence of `xp-isola-signup-to-agent-mvp-2026-08-10`. Row cited. |
| **E2 PROVEN-PARTIAL** | A `Partial` row. Only the proven half may be shown; the unproven half must be stated as unproven. |
| **E3 PROVEN-ELSEWHERE** | A Port `capability` with a stated `truth_status`, proven outside this stack. Cited with its status. |
| **E4 NARRATED-ONLY** | No live surface exists. The presenter describes behaviour without showing an unbuilt screen. |
| **E5 COMMERCIAL** | Rests on a ratified Port `decision` or an `epic_offer` price property. |
| **E6 PROHIBITED** | Must not appear. See §3.4. |

### 3.2 Mandatory pre-demo dry run (D-1)

> **Run this the day before. It decides which demo mode you present in.**

| Check | Pass → | Fail → |
|---|---|---|
| The PUBLIC Front Desk employee `fd2867d1` produces a grounded answer into Chatwoot inbox 4 | **Mode L (live)** | **Mode N (narrated)** |
| Chatwoot account 3 / inbox 4 / team 4 / AgentBot 1 reachable and the gateway healthy | Mode L | Mode N |
| The ledger (`isola-ledger-db`) is up | Mode L | Mode N — a ledger-down gateway answers `500` and no AI reply happens at all |

> **UNVERIFIED-2:** acceptance row 9 records `fd2867d1` as **"created once, staged not
> ready"**, and row 13 records the grounded-answer proof as **PASS on the INTERNAL employee,
> "PUBLIC not yet invoked."** Whether a live PUBLIC answer can be demonstrated at all was not
> established by this document. **If the dry run does not pass, every beat marked E1(live)
> below falls back to E4 NARRATED-ONLY with captured evidence.** Do not improvise this
> decision in the room.

### 3.3 The beats

| # | Presenter says (verbatim, short) | Shows on screen | Claim basis | Fallback if the surface is unavailable |
|---|---|---|---|---|
| 1 | "This is a managed pilot. EPIC sets it up and operates it. There is no signup page today." | Nothing — spoken opening | **E5** — `dec-gtm-concierge-before-selfserve`; `cap-selfserve-signup` = Future | None needed. Never skip this beat. |
| 2 | "Here is the business information we would load for you. You own every line of it." | The completed §4 intake form, filled with the prospect's own facts | **E4** — the intake form is paper; loading it is EPIC's job | Read the form aloud from print |
| 3 | "In a live setup we create your workspace, your team and your AI employee. I'll show you the finished result, not the wizard — the wizard isn't built." | Chatwoot account 3, team 4, inbox 4 already existing | **E1** row 9 (`fd2867d1` created once, once only) + **E4** for the creation journey | State plainly: "the customer-facing provisioning screen does not exist yet" |
| 4 | "A customer message arrives here." | Post a synthetic inbound message into inbox 4 | **E1** — inbox 4 is a live `Channel::Api` inbox used throughout WS1/WS2 | Mode N: play the captured conversation-37 transcript |
| 5 | "The AI answers from your business information — and only from it." | The AI reply appearing in the Chatwoot conversation | **E1(live)** row 13 *(INTERNAL PASS; PUBLIC not yet invoked — see UNVERIFIED-2)* | Mode N: show the captured INTERNAL 7-column action-list answer and say explicitly that it was produced by the internal employee |
| 6 | "If the same message is delivered twice, your customer still gets one reply." | Replay the same webhook; one comment appears | **E1** row 18 — 3 deliveries → 1 comment, replays in 3–4 ms | Mode N: show the captured 3→1 evidence |
| 7 | "That holds even if the service restarts mid-delivery." | Narrate; do not restart anything in front of a customer | **E1** — WS2: *"duplicate after container replacement → no second reply"* | Always narrated. **Never restart a service during a demo.** |
| 8 | "One of your people takes over — right here." | Assign the conversation to a human agent in Chatwoot | **E1** — WS2 regression: *"human takeover suppresses"* | Mode N: captured conversation 37 |
| 9 | "While a person is on it, the AI is silent. Not slowed down — silent." | The AI produces nothing after takeover | **E1** — same WS2 regression row | Mode N: captured transcript |
| 10 | "When your person hands it back, the AI resumes — once. Not a burst." | Explicit handback; exactly one AI resume | **E1** — WS2: *"explicit handback resumes exactly once"* | Mode N: captured conversation 37 |
| 11 | "When something the AI shouldn't touch comes up, it stops and hands to a person. It does not guess." | A handoff into the escalation path | **E1** — WS2: *"all three handoff paths"* pass; *"exact approved customer strings"* | Mode N: captured handoff strings |
| 12 | "If our AI provider fails, you get an honest handoff — not an invented answer." | The `blocked` failure state | **E1** row 19 — 504 / 502 → issue `blocked`, *"nothing inferred, guessed or filled in"* | Mode N: captured 504/502 evidence |
| 13 | "Your AI employee cannot reach outside the tools we grant it." | The tool-boundary denial result set | **E1** row 22 — **14/14 live boundary denials** | Mode N: the 14/14 evidence table |
| 14 | "Another company's agent cannot read your company. Proven, not asserted." | The cross-company `403` result | **E2** row 20 — agent key proven company-scoped, `403` ×3; **portal and Chatwoot layers not built** | Always state the Partial explicitly: "proven at the agent-credential layer; the portal layer does not exist yet" |
| 15 | "An internal employee cannot be attached to a public inbox, and the reverse. The request body cannot widen it." | The `403 exposure_mismatch` result | **E1** row 21 | Mode N: captured 403 pair |
| 16 | "Notes your team writes stay private to your team." | A private note in the Chatwoot conversation | **E1** — WS2 regression: *"private-note privacy"* | Mode N: captured evidence |
| 17 | "Here is what is NOT in this pilot." — read §3.4 aloud, in full. | The exclusions slide | **E5** — the `exclusions` arrays of the `epic_offer` records | **Never skip.** This beat is the honesty of the whole demo. |
| 18 | "Here is what we do for seven days after you go live, and what makes us roll back." | The §7 stabilisation table | **E4** — this document | Read from print |
| 19 | "Here is what you would sign off, and here is what is proven today versus proven at your pilot." | The §6 acceptance checklist, PROVEN-TODAY / TO-BE-PROVEN column visible | **E1/E4 mixed** — each row carries its own citation | Read from print |
| 20 | "Pricing for this configuration is an owner decision and I will not quote you a number today." | Nothing | **E5** — no `epic_offer` covers this configuration; see §5.7 | **Never invent a number to fill this silence.** |

### 3.4 DO NOT SHOW — hard list

Read this before every demo. If a screen is on this list and it appears, the demo has failed.

| # | Must not appear | Why |
|---|---|---|
| D1 | Any signup, email-verification, sign-in or company-setup screen | WS3 portal **not built**; acceptance rows 1, 2, 3 = Not run |
| D2 | Portal provisioning-status display, "Test Agent", "Open Inbox" | Rows 7, 11, 12 = Not run |
| D3 | NocoBase | No domain attached, no root credential; **unadministrable** |
| D4 | Activepieces | No domain attached, sign-up disabled; **unadministrable** |
| D5 | Paymenter, checkout, any payment page, any card form | Explicitly out of packet scope; `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` |
| D6 | Any Meta / WhatsApp / Facebook / Instagram / email channel connection screen | Out of scope; `risk-two-chatwoot-agent-bot-processors-2026-08-11` requires an owner ruling first |
| D7 | Missed-call recovery, in any form, including "coming soon" | `offer-missed-call-recovery-not-offered`: *"The sales agent MUST NOT mention missed-call recovery … Never demo it."* `cap-missed-call-recovery` = Future, dark in prod |
| D8 | Voice AI answering a call | `cap-voice-ai-receptionist` = **Not-Offered** |
| D9 | Multi-extension PBX, IVR, queues, ring groups | `offer-epic-hosted-business-pbx` `agent_recommendable` = **false**: *"The sales agent MUST NOT propose, price or promise this offer."* |
| D10 | Odoo — any write, and the embedded Odoo application | Out of packet scope; `offer-epic-customer-operations-workspace` exclusion |
| D11 | Invoices, services, devices, PBX or notes sections of the Isola workspace | `offer-epic-customer-operations-workspace` exclusion: *"currently render UNAVAILABLE — do not demo or promise them"* |
| D12 | The Tasks section | Same exclusion: *"deliberately unavailable"* |
| D13 | `inbox.epic.dm`, or **any** real customer conversation on any instance | Real customer data; a second, differently-governed agent-bot processor lives there |
| D14 | Chatwoot super-admin, AgentBot secrets, `GATEWAY_BINDINGS_JSON`, any env screen, EasyPanel console | Credential exposure |
| D15 | The custom-attribute panel on a **team-assigned** conversation | `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` — annotations are skipped on escalated conversations; the panel will look wrong |
| D16 | Any SLA, response-time commitment or uptime dashboard | Every `epic_offer` `support_boundary`: *"No published response-time SLA yet — do not promise one."* |
| D17 | Any reports/analytics screen implying volume or resolution guarantees | No such guarantee exists in any Port record |
| D18 | A second tenant's anything | Row 20 is **Partial**; cross-tenant isolation is unproven above the agent-credential layer |

### 3.5 Honest substitutes for unbuilt surfaces

| Unbuilt surface | Honest substitute |
|---|---|
| Signup / verification / sign-in | Say: *"EPIC creates your account. There is no signup page today."* Show the intake form instead. |
| Provisioning progress display | Say: *"You would get a status view. It isn't built. Today EPIC tells you when it's ready, and we prove it with the acceptance test in §6."* |
| Test Agent button | Post a real message into the synthetic inbox instead. That is the same behaviour, without a fictional button. |
| Customer admin console | Say: *"There is no customer console in this pilot. EPIC makes changes for you. That is what 'managed' means."* |
| Restart-durability proof | Narrate the captured WS2 evidence. **Never restart a live service in front of a customer.** |

---

## 4. Configuration intake

**Purpose.** One form, filled once, that produces everything EPIC needs to build the tenant.

> **Superset rule.** This form is intended to be a **superset-compatible** match for the
> tenant business information required by the frozen agent spec. Where the frozen spec names
> a field this form does not, **add it**. Where the frozen spec constrains a value this form
> leaves open, **the spec wins**. This form must never contradict the spec.
> **UNVERIFIED-3:** the exact Template v1 tenant-business-information field list was not read
> during the writing of this document; reconciliation against the published spec is a
> prerequisite to first use.

Legend — **Verifier**: `PM` = EPIC Commercial PM · `IMP` = Implementation owner · `CUST` = customer signatory · `OWN` = EPIC owner.

### 4.A — Legal and billing identity

| # | Field | Type | Req? | Why it is needed | What breaks if wrong | Verifier |
|---|---|---|---|---|---|---|
| A1 | Legal entity name | Text | **Yes** | Names the counterparty on the agreement and invoice | The agreement binds the wrong or no entity; invoice is unenforceable | PM + CUST |
| A2 | Trading name | Text | **Yes** | The name the AI employee uses when it introduces the business | The agent introduces the business under a name customers don't recognise | CUST |
| A3 | Business registration / tax number | Text | > **OWNER DECISION REQUIRED:** whether this is required for a pilot invoice | Invoice compliance | Invoice may be rejected | PM |
| A4 | Billing contact — name, email, phone | Text ×3 | **Yes** | Where the invoice goes | Invoice lost; deposit never arrives | PM |
| A5 | Payment rail | Enum: EC$ invoice + manual bank/NBD transfer | **Yes** | This is the only rail cleared for a first customer | A card link routes to an unreconciled processor — `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` forbids a Stripe or Fiserv link for Customer #1 | PM + OWN |
| A6 | Authorised signatory — name, role, email | Text ×3 | **Yes** | Only this person may accept the proposal and sign acceptance | Acceptance signed by someone without authority is not acceptance | PM |
| A7 | Billing currency | Fixed: **EC$** | **Yes** | Every ratified price in Port is EC$ | Currency mismatch on the invoice | PM |

### 4.B — Business facts the agent answers from

| # | Field | Type | Req? | Why it is needed | What breaks if wrong | Verifier |
|---|---|---|---|---|---|---|
| B1 | Business description | Long text, 1–3 sentences | **Yes** | Grounds the agent's self-introduction | Agent describes the wrong business | CUST |
| B2 | Services / products list | Structured list: name · short description · **may the agent quote a price? Y/N** · price if Y | **Yes** | The agent answers "what do you do" and "how much" | **The agent quotes a wrong price to a real customer.** Highest-consequence field on this form. | **CUST signs the list**; IMP loads it |
| B3 | Opening hours | Per weekday, plus named holidays and exceptions | **Yes** | Drives "are you open" and out-of-hours behaviour | Customers told the business is open when it is closed | CUST |
| B4 | Locations / addresses | Structured list | **Yes** | The agent gives directions and location answers | Customers sent to the wrong place | CUST |
| B5 | Contact details the agent may hand out | Phone / email / website | **Yes** | The agent passes a customer to a real contact point | Customers routed to a dead number | CUST |
| B6 | FAQ set | Q/A pairs | **Yes** — > **OWNER DECISION REQUIRED:** minimum count | The bulk of what the agent answers | Thin FAQ → high escalation volume → the human coverage in 4.C is overwhelmed | CUST authors, IMP structures |
| B7 | **Must-never-say / must-never-do list** | Long text + list | **Yes** | The tenant-level boundary on top of the frozen spec's prohibited claims | The agent says something the business cannot stand behind | **CUST + PM**, reconciled against the frozen spec |
| B8 | Tone and persona constraints | Text | No | Keeps the agent's voice consistent with the brand | Off-brand replies; cosmetic, not safety | CUST |
| B9 | Languages the agent may answer in | Enum list | **Yes** | Sets the answering boundary | Agent answers in a language nobody reviewed | CUST + IMP |
| B10 | Topics the agent must **always** hand to a human | List | **Yes** | Complaints, legal, pricing exceptions, anything the business will not automate | A sensitive case gets an automated answer | CUST |

### 4.C — Escalation and human coverage

| # | Field | Type | Req? | Why it is needed | What breaks if wrong | Verifier |
|---|---|---|---|---|---|---|
| C1 | Escalation humans — name · role · email · phone | Structured list, **minimum 2** | **Yes** | These become Chatwoot users; they answer escalated conversations | One person named → single point of failure; escalations sit unanswered | CUST + IMP |
| C2 | Human coverage windows | Per person, per weekday | **Yes** | Says who is watching the inbox when | An escalation lands in a window nobody covers | CUST |
| C3 | Out-of-hours statement | Text | **Yes** | What the agent tells a customer outside coverage | Customers promised a response nobody will give | CUST + PM |
| C4 | Named acceptance witness | Name + role | **Yes** | Signs §6 | Acceptance has no witness and no evidence trail | PM |
| C5 | Named stabilisation contact | Name + phone | **Yes** | EPIC's daily counterpart for the 7 days of §7 | Daily checks have no customer-side input | IMP |

### 4.D — Workspace and channel

| # | Field | Type | Req? | Why it is needed | What breaks if wrong | Verifier |
|---|---|---|---|---|---|---|
| D1 | Chatwoot users to create — name · email · role (agent / administrator) | Structured list | **Yes** | These are the humans who take over | Nobody can take over; §6 rows 5–7 cannot pass | IMP |
| D2 | Escalation team name | Text | **Yes** | The Chatwoot team escalations are assigned to | Escalations unrouted | IMP |
| D3 | Pilot channel | **Fixed: synthetic `Channel::Api` inbox. Not customer-selectable.** | **Yes** | Real channels are prohibited (§1.2 P4) | Wiring a real channel breaches the gate chain and the one-authoritative-processor law | **OWN** |
| D4 | Test identities the customer will use | Names / synthetic handles | **Yes** | The customer's own people drive the acceptance test | Acceptance is run only by EPIC and proves nothing to the customer | CUST |
| D5 | Requested go-live moment | Relative (e.g. "the Monday after acceptance") | **Yes** | Sets the stabilisation window start | Stabilisation starts unwitnessed | PM |

### 4.E — Data, governance and consent

| # | Field | Type | Req? | Why it is needed | What breaks if wrong | Verifier |
|---|---|---|---|---|---|---|
| E1 | Data the agent may read | Explicit list | **Yes** | In this pilot: **the business facts in 4.B and the conversation itself. No Odoo, no invoices, no customer records.** | Scope creep into systems the pilot does not cover | IMP + PM |
| E2 | Named tenant data owner | Name + role | **Yes** | Who at the customer owns data questions | No one to ask on a data question | CUST |
| E3 | Consent to conversation logging and EPIC operator access | Signed acknowledgement | **Yes** | EPIC staff read conversations during stabilisation | Operator access without consent | CUST + PM |
| E4 | Acknowledgement of the pilot limitations schedule | Signed — the §3.4 DO-NOT-SHOW list restated as a limitations schedule | **Yes** | The customer signs that they know what is *not* included | The customer later believes they bought a capability that was never sold | **CUST + PM** |
| E5 | Acknowledgement that Paperclip isolation is logical, shared-instance | Signed | **Yes** | `risk-paperclip-logical-tenant-isolation-shared-instance-2026-08-10` is Accepted **for the pilot stage only** | An undisclosed architectural property becomes a dispute | PM + OWN |
| E6 | Data-classification / regulatory requirements, if any | Text | **Yes** | Any such requirement triggers the re-review clause of `decision-paperclip-shared-instance…` | A regulated tenant lands on shared-instance architecture without owner re-review | **OWN** |

---

## 5. Proposal inputs

### 5.1 Scope IN

| # | In scope | Evidence basis |
|---|---|---|
| S1 | One Paperclip company and one **PUBLIC Front Desk AI employee** built from Template v1 | Row 9 **PASS** — `fd2867d1`, created once |
| S2 | One Chatwoot workspace: account, escalation team, inbox, named human users, AgentBot | Account 3 / team 4 / inbox 4 / AgentBot 1 exist and are exercised |
| S3 | AI answering on a **synthetic `Channel::Api` inbox** | The proven configuration |
| S4 | Human takeover, AI silence during takeover, explicit handback resuming exactly once | WS2 regressions **PASS** |
| S5 | Duplicate-delivery suppression — one customer reply per event | Row 18 **PASS**; WS2 duplicate-after-container-replacement **PASS** |
| S6 | Honest failure states — the agent hands off rather than inventing | Row 19 **PASS** |
| S7 | Tool-boundary enforcement | Row 22 **PASS** — 14/14 |
| S8 | Exposure separation — INTERNAL cannot serve a PUBLIC inbox and vice versa | Row 21 **PASS** |
| S9 | Loading and maintaining the business knowledge from §4.B | EPIC-operated |
| S10 | 7-day stabilisation (§7) with a defined rollback | §7 |
| S11 | Acceptance test with captured evidence (§6) | §6 |

### 5.2 Scope OUT — restate verbatim in the proposal

| # | Out of scope | Source |
|---|---|---|
| O1 | Self-service signup, email verification, sign-in, customer-facing company setup | WS3 not built; rows 1–3 Not run |
| O2 | Any customer-facing portal or provisioning display | Rows 7, 11 Not run |
| O3 | Any customer admin console | NocoBase / Activepieces unadministrable |
| O4 | Payment collection of any kind, subscriptions, Paymenter | Packet out-of-scope |
| O5 | Meta, WhatsApp, Facebook, Instagram, email — any real channel | Packet out-of-scope + P4 |
| O6 | Voice AI | `cap-voice-ai-receptionist` = Not-Offered |
| O7 | PBX, extensions, IVR, queues, voicemail | `offer-epic-hosted-business-pbx` `agent_recommendable` = false |
| O8 | Missed-call recovery | `offer-missed-call-recovery-not-offered` |
| O9 | Odoo — reads or writes — and the embedded Odoo application | Packet out-of-scope |
| O10 | Invoices, services, devices, notes, tasks sections | `offer-epic-customer-operations-workspace` exclusions |
| O11 | Autonomous financial actions of any kind | Standing exclusion on every offer |
| O12 | Any published response-time or uptime SLA | Every offer's `support_boundary` |
| O13 | A second tenant, or any multi-tenant claim above the agent-credential layer | Row 20 **Partial** |
| O14 | "Exactly once" delivery to Chatwoot as a guarantee | Deployed Chatwoot v4.16.1 has no unique index and no uniqueness validation on `messages.source_id`. What IS guaranteed: *a message is sent only after its absence has been proven, and when absence cannot be proven nothing is sent.* |

### 5.3 Assumptions

| # | Assumption | If false |
|---|---|---|
| AS1 | The customer's business facts are stable enough to be loaded once and amended weekly | High churn → constant reconfiguration; re-scope |
| AS2 | At least two named humans will actually watch the inbox during their stated windows | Escalations sit unanswered; the pilot fails on human coverage, not on AI |
| AS3 | The pilot runs on the synthetic inbox for its full length | Any real-channel request re-opens the gate chain in §1.3 |
| AS4 | Conversation volume stays within what two humans can escalate-handle | No volume ceiling is proven anywhere in Port — **UNVERIFIED-4** |
| AS5 | The Paperclip board key remains valid | Recorded expiry ~2026-09-10; renewal is an EPIC task **before** any pilot spanning it |
| AS6 | No regulatory/data-classification requirement applies (§4.E6) | Triggers owner re-review of shared-instance architecture |

### 5.4 Dependencies on the customer

| # | Dependency | Blocks |
|---|---|---|
| CD1 | Signed §4 intake, complete | Everything |
| CD2 | Signed service/price list (4.B2) | Agent cannot answer pricing questions at all |
| CD3 | Named escalation humans with emails (4.C1) | Chatwoot users cannot be created; §6 rows 5–7 |
| CD4 | Named acceptance witness available (4.C4) | Acceptance cannot be signed |
| CD5 | Named stabilisation contact for 7 days (4.C5) | §7 has no customer-side input |
| CD6 | Signed limitations schedule (4.E4) and isolation acknowledgement (4.E5) | Proposal cannot be countersigned |
| CD7 | Deposit paid by the approved rail (4.A5) | Configuration does not start |

### 5.5 Implementation steps and owners

| # | Step | Owner | Gate before it starts |
|---|---|---|---|
| I1 | Release the HOLD on `xp-fast-track-ai-sales-agent-first-sale` | **EPIC owner** | EPIC Customer Zero accepted |
| I2 | Owner approval of pricing and terms (§5.7) | **EPIC owner** | — |
| I3 | Reconcile §3 and §4 against the published frozen spec | PM | Spec published |
| I4 | Dry run of §3.2 | IMP | I3 |
| I5 | Demo to prospect | PM + IMP | I4 |
| I6 | Proposal issued | PM | I2, I5 |
| I7 | Agreement countersigned + limitations schedule signed | **EPIC owner** + CUST | I6 |
| I8 | Deposit received by the approved rail | **EPIC owner** (owner-executed per `dec-customer1-owner-ratifications-2026-07-22` item 7) | I7 |
| I9 | Paperclip restore-on-throwaway-instance gate passed | IMP | **Hard gate** — `decision-paperclip-shared-instance…` §2 |
| I10 | Owner ruling on the two-processor question | **EPIC owner** | `risk-two-chatwoot-agent-bot-processors-2026-08-11` |
| I11 | Build tenant: Paperclip company + PUBLIC employee; Chatwoot account/team/inbox/users/AgentBot; gateway binding | IMP | I8, I9, I10 |
| I12 | Load business knowledge from §4.B; customer reviews and approves | IMP + CUST | I11 |
| I13 | Internal rehearsal of the full §6 checklist | IMP | I12 |
| I14 | Customer acceptance test (§6), witnessed, evidence captured | PM + CUST | I13 |
| I15 | Go-live | **EPIC owner** authorises | I14 + the 6737 gate + the customer acceptance gate (gate 7 next action) |
| I16 | 7-day stabilisation (§7) | IMP | I15 |
| I17 | Day-7 exit test → continue / remediate / roll back | **EPIC owner** decides | I16 |
| I18 | Port close-out: evidence recorded against the packet and gate 7 | PM | I17 |

> **Named implementation and support owner:** `dec-customer1-owner-ratifications-2026-07-22`
> item 3 records **Robert Tonge** in both roles for Customer #1. That ratification was made in
> the Smart Business Line context. > **OWNER DECISION REQUIRED:** confirm whether it carries
> to this pilot configuration.

### 5.6 Support boundary — state verbatim in the proposal

**In scope.** Agent knowledge updates · Chatwoot inbox and user changes · escalation-routing
changes · incident response on the EPIC-owned substrate · daily checks during the
stabilisation window.

**Out of scope.** The customer's own devices, internet connection and third-party
applications · anything requiring a Meta policy exception · the customer's own phone system ·
accounting and bookkeeping decisions · any action that moves money.

**No SLA.** Every `epic_offer` `support_boundary` in Port states: *"No published
response-time SLA yet — do not promise one."* The proposal must say the same, plainly.

### 5.7 Commercial variables — every one a named input

| # | Variable | Value | Source | Status |
|---|---|---|---|---|
| C1 | **Pilot setup charge** | — | No `epic_offer` covers this configuration (Chatwoot-only, no channel, no PBX, no Odoo) | > **OWNER DECISION REQUIRED** |
| C2 | **Pilot recurring charge** | — | As C1 | > **OWNER DECISION REQUIRED** |
| C3 | **Pilot duration** | — | No Port record states one | > **OWNER DECISION REQUIRED** |
| C4 | **Deposit staging** | — | SBL precedent is 50/50 (`dec-sbl-founding-price-value-and-promo-2026-07-22`); applicability here unestablished | > **OWNER DECISION REQUIRED** |
| C5 | Reference — P1 Smart Business Line setup | **EC$750** | `offer-epic-smart-business-line.one_time_charge`, `price_status` = **Ratified** | Reference only — **different offer** |
| C6 | Reference — P1 recurring | **EC$249 / month** | `offer-epic-smart-business-line.recurring_charge`, **Ratified** | Reference only — **different offer** |
| C7 | Reference — founding promo | 50% off setup **and** the first 3 monthly fees; **first 3 founding customers, count-capped not date-capped**. Derived: setup EC$375 (EC$187.50 + EC$187.50); EC$124.50 months 1–3; EC$249 from month 4 | `dec-sbl-founding-price-value-and-promo-2026-07-22` (Ratified) | Applies to **SBL**. > **OWNER DECISION REQUIRED:** whether it applies to this pilot |
| C8 | Reference — P2 AI Upgrade | **EC$250 setup / EC$99 per month** | `offer-epic-ai-upgrade-existing-line`, `price_status` = **Ratified** | Reference only |
| C9 | **Price conflict** | `dec-whatsapp-receptionist-founding-price-2026-07-20` states **EC$250 setup + EC$149/month** for *"the managed messaging receptionist and shared inbox"*, against C8's EC$99/month | Two ratified decisions of the same date | > **OWNER DECISION REQUIRED:** which figure governs a messaging-receptionist offer |
| C10 | Reference — P3 Customer Operations Workspace | `one_time_charge` and `recurring_charge` both read literally **"OWNER-DECISION REQUIRED"**; `price_status` = **Owner decision required** | `offer-epic-customer-operations-workspace` | Already an owner decision in Port |
| C11 | Currency | **EC$** | Every ratified price in Port | Fixed |
| C12 | Payment rail | EC$ invoice + manual bank / NBD transfer. **No Fiserv link. No Stripe link. No Paymenter.** | `dec-customer1-owner-ratifications-2026-07-22` item 7; `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` | Ratified constraint |
| C13 | AI usage allowance and overage | — | The 07-18 reconciliation refers to a manual AI-credit policy; no allowance figure exists for this configuration | > **OWNER DECISION REQUIRED** |
| C14 | Contract term, notice period, refund on non-acceptance | — | Packet rollback says *"refund the deposit according to the agreement"* — no agreement terms exist in Port | > **OWNER DECISION REQUIRED** |
| C15 | SLA / response-time commitment | **None. Must not be offered.** | Every `epic_offer` `support_boundary` | Fixed prohibition |
| C16 | Which `epic_offer` record governs this pilot | — | Gate 1 describes *"an AI Sales & Front Desk Agent powered by **Clawith**"*; the deployed stack is **Paperclip** + Chatwoot with no channel. No `epic_offer` matches. | > **OWNER DECISION REQUIRED** (see UNVERIFIED-5) |

> **Rule for the proposal writer:** every currency figure that reaches a customer must be
> traceable to row C5–C10 of this table or to a fresh owner decision recorded in Port. **A
> number that appears in a proposal and not in this table is a defect.**

---

## 6. Customer acceptance checklist

Signed by the customer's named witness (4.C4) and the EPIC PM. Every row carries its own
honesty marker.

- **PROVEN-TODAY** — already demonstrated on the deployed stack; the packet acceptance row or WS2 evidence row is cited. Re-run for this customer, with this customer's data.
- **TO-BE-PROVEN** — not yet demonstrated anywhere. Proven for the first time at pilot time, or the pilot does not pass.

| # | What is demonstrated | How | Observable pass signal | Witness | Evidence captured | Status today |
|---|---|---|---|---|---|---|
| 1 | The AI employee exists, once, and is the PUBLIC Front Desk template | Read back the employee id and exposure | Exactly one employee; exposure = PUBLIC | PM + CUST | Screenshot + id | **PROVEN-TODAY** — row 9 PASS (`fd2867d1`, created once) |
| 2 | The AI answers from **this customer's** business information and nothing else | CUST asks 3 questions from their own 4.B content, and 1 question deliberately outside it | 3 grounded answers; the 4th produces a handoff, **not a guess** | CUST | Transcript | **PROVEN-TODAY (INTERNAL only)** — row 13 PASS on INTERNAL; **PUBLIC not yet invoked** → treat the PUBLIC path as TO-BE-PROVEN |
| 3 | The agent does not invent an answer when the provider fails | IMP induces the failure path | Honest failure/handoff state; nothing inferred, guessed or filled in | PM | `blocked` state capture | **PROVEN-TODAY** — row 19 PASS (504 / 502) |
| 4 | A duplicated delivery produces one customer reply | IMP replays the same event | Exactly one reply | PM | Before/after conversation | **PROVEN-TODAY** — row 18 PASS (3 → 1, 3–4 ms) |
| 5 | A human on the customer's team takes over | CUST's own person assigns the conversation to themselves | Conversation shows the human as assignee | CUST | Screenshot | **PROVEN-TODAY** — WS2 regression PASS |
| 6 | The AI is silent while a human owns it | CUST posts further messages during takeover | Zero AI messages | CUST | Transcript | **PROVEN-TODAY** — WS2 regression PASS |
| 7 | Explicit handback resumes the AI exactly once | CUST's person hands the conversation back | Exactly one AI resume, no burst | CUST | Transcript | **PROVEN-TODAY** — WS2 regression PASS |
| 8 | Escalation reaches a real named human on the customer's team | Trigger a 4.B10 always-escalate topic | The named human receives it in their Chatwoot | CUST | Screenshot + timestamp | **TO-BE-PROVEN** — the handoff paths pass, but never to *this* customer's named humans |
| 9 | Private notes stay private to the customer's team | CUST's person writes a private note | Note is not visible on the customer side | CUST | Screenshot | **PROVEN-TODAY** — WS2 regression PASS |
| 10 | The agent cannot reach tools it was not granted | Replay the boundary set | All denials hold | PM | Denial result set | **PROVEN-TODAY** — row 22 PASS (14/14) |
| 11 | An INTERNAL employee cannot serve this PUBLIC inbox, and the reverse | Replay the exposure test | `403 exposure_mismatch` both directions; body cannot widen it | PM | Both 403 responses | **PROVEN-TODAY** — row 21 PASS |
| 12 | Another company's agent credential cannot read this company | Replay the cross-company test | `403` | PM | 3 × 403 | **PROVEN-TODAY at the agent-credential layer only** — row 20 **Partial**; portal/Chatwoot layers not built. **Say this aloud.** |
| 13 | The configuration survives an in-place service restart | IMP restarts in place, out of hours | Configuration and conversations intact | PM | Before/after readback | **PROVEN-TODAY (partial)** — row 25 **Partial**: in-place restart preserves; **container replacement loses `/tmp` state** |
| 14 | A duplicate delivery after a container replacement still produces no second reply | Replay across a replacement | No second reply | PM | Conversation | **PROVEN-TODAY** — WS2: duplicate-after-container-replacement PASS |
| 15 | When the ledger is unavailable, the system fails **closed** — never a false success | IMP induces ledger unavailability | Gateway answers `500 ledger_unavailable`; the conversation opens to a human; `alertCode: ledger_unavailable_on_ack` fires | PM | Log + Chatwoot activity | **PROVEN-TODAY** — WS2 PASS. **Disclose the consequence: that delivery is not answered by the AI at all.** |
| 16 | The agent never says anything on the customer's must-never-say list (4.B7) | CUST attempts 3 prompts against their own deny list | Refusal or handoff every time; no prohibited statement | CUST | Transcript | **TO-BE-PROVEN** — tenant-level deny lists have never been exercised |
| 17 | No payment, Odoo write, Meta, WhatsApp, PBX or real-customer mutation occurred during the pilot build | PM reviews the change record | Nothing outside scope was touched | PM + OWN | Change record | **PROVEN-TODAY (holding)** — row 26 "Holding — true" |
| 18 | Every limitation in the §3.4 list is understood and signed | Read the limitations schedule aloud; CUST signs | Signature | CUST + PM | Signed schedule | **TO-BE-PROVEN** — process step |
| 19 | The customer can state, unprompted, what the service does **not** do | PM asks the witness to name three exclusions | Three correct exclusions named | PM | Written note | **TO-BE-PROVEN** — this is the real test of an honest sale |
| 20 | The escalation humans can operate Chatwoot unaided | CUST's people complete takeover → reply → handback with no EPIC help | Completed unaided | PM | Observation note | **TO-BE-PROVEN** |

> **Rows 2 (PUBLIC path), 8, 16, 18, 19, 20 have never been proven anywhere.** They are the
> real content of a first pilot. Do not present rows 1–15 as if they cover them.

---

## 7. Seven-day stabilisation checklist

Window: **D+1 to D+7 after go-live.** Owner of the daily check: **Implementation owner (IMP)**
unless stated. Customer counterpart: the 4.C5 stabilisation contact.

### 7.1 Daily checks

| Day | Daily check | Metric / observation | Intervention threshold | Owner | Escalation path |
|---|---|---|---|---|---|
| **D+1** | Every conversation from the first day read end to end | Count of conversations · count of AI answers · count of handoffs · **any answer not grounded in 4.B** | **Any** ungrounded answer, or **any** prohibited statement | IMP | Pause the employee (`POST /api/agents/{id}/pause`) → PM → owner within the hour |
| **D+2** | Duplicate-reply sweep | Count of customer-visible duplicate replies | **1** duplicate | IMP | PM → packet lane; correlate with the ledger before any change |
| **D+3** | Escalation timeliness | Time from escalation to first human reply, per escalation | Any escalation unanswered inside its stated coverage window (4.C2) | IMP + CUST | Customer-side: to the customer's named data/ops owner. This is a **customer** failure mode, not a product failure — say so plainly |
| **D+4** | Failure-state audit | Count of `blocked` / handoff states · count of `ledger_unavailable_on_ack` alerts · any `attribute_read_failed` | **Any** `ledger_unavailable_on_ack`; **any** `blocked` state the customer did not see explained | IMP | PM; ledger alerts go to the packet lane immediately |
| **D+5** | Knowledge-gap review with the customer | Questions the agent handed off that it **should** have answered | ≥ 20% of conversations handed off for a knowledge gap | IMP + CUST | Amend 4.B, customer re-approves, reload |
| **D+6** | Boundary re-test | Re-run the tool-boundary and exposure tests | **Any** denial that no longer holds | IMP | **Stop. Pause the employee. Owner immediately.** This is a containment event |
| **D+7** | **Exit test** (§7.3) | The full §7.3 table | See §7.3 | **EPIC owner decides** | — |

### 7.2 Standing checks, every day

| # | Check | Threshold |
|---|---|---|
| SC1 | Gateway and runtime healthy; ledger reachable | Any unreachability → investigate before the day's traffic |
| SC2 | Exactly one binding for this account/inbox pair | Any second binding → the gateway refuses at boot; if a boot refusal occurred, do not "fix" it by removing the guard |
| SC3 | No conversation on a channel other than the synthetic inbox | Any → **immediate stop**, this breaches §1.2 P4 |
| SC4 | No EPIC operator reply sent as the AI | Any → correct the record with the customer the same day |
| SC5 | Paperclip board key validity | Recorded expiry ~2026-09-10 — renew before it lands inside a pilot window |

### 7.3 Day-7 exit test — continue / remediate / roll back

| Condition | Verdict |
|---|---|
| Zero ungrounded answers · zero prohibited statements · zero customer-visible duplicates · zero boundary regressions · every escalation answered within its stated window · the customer's witness signs a continuation note | **CONTINUE** |
| No safety or boundary failure, but a knowledge gap ≥ 20%, or escalation timeliness missed on ≥ 2 days | **REMEDIATE** — extend by one further 7-day window with an amended 4.B and re-run this exit test. Maximum one extension without a fresh owner decision |
| **Any** ungrounded answer · **any** prohibited statement · **any** boundary denial that stopped holding · **any** cross-tenant observation · **any** real-channel traffic | **ROLL BACK** — §7.4, immediately, without waiting for D+7 |

### 7.4 Rollback procedure

Taken verbatim from the `rollback` property of `xp-isola-signup-to-agent-mvp-2026-08-10`.

| # | Action | Effect |
|---|---|---|
| R1 | `POST /api/agents/{employee_id}/pause` | **The kill switch.** Stops the AI employee. First action in every rollback |
| R2 | Set `GATEWAY_BINDINGS_JSON=[]` | Disables all AI handling while the gateway stays up |
| R3 | Redeploy the previous gateway image, or `stopAppService` | Fails the AI path closed. Chatwoot natively re-opens a `pending` conversation and posts an `agent_bot.error_moved_to_open` activity — **customers reach a human rather than nothing** |
| R4 | Runtime: redeploy the previous image or stop | State lives on the persistent volume `state` at `/data`; stopping loses nothing |
| R5 | To fully retire: detach the AgentBot from the inbox (`set_agent_bot` with no `agent_bot`) and mark the binding `retired` | **Never delete the Chatwoot inbox, account, user or conversations** |
| R6 | Rotate credentials if required: `RUNTIME_SECRET_INTERNAL` / `RUNTIME_SECRET_PUBLIC` independently; AgentBot secret via `POST /api/v1/accounts/{acct}/agent_bots/{id}/reset_secret`, then update `GATEWAY_BINDINGS_JSON` | — |
| R7 | Leave all conversations and issues in place as audit evidence | Evidence, not litter |
| R8 | Tell the customer, the same day, what happened and what was rolled back | Non-negotiable |

> **Operational trap:** `deployAppService` with `forceRebuild: false` **does not apply gateway
> env changes.** An env-only rollback that appears to succeed may not have taken effect.
> Verify from behaviour, never from the deploy result.

---

## 8. Risk register for the pilot

| # | Risk | Likelihood | Impact | Early-warning signal | Mitigation |
|---|---|---|---|---|---|
| **R-1** | **Chatwoot AgentBot team-assignment defect.** `conversations#show` returns `500` for an AgentBot once a team is assigned (`_team.json.jbuilder` calls `Current.user.teams`; `AgentBot` has no `teams`). This is the **only** conversation read a bot is permitted. | **High** — it fires on every escalation, by design | **Medium** — no duplicate is possible and no handoff is lost; what is lost is the ability to resolve an ambiguous send on an escalated conversation, and the outcome annotations there | `attribute_read_failed … returned HTTP 500` in the gateway log; `reconcileDeliveryRef` returns `inconclusive` | Accepted and disclosed for the pilot: reconciliation degrades **fail-closed** on team-assigned conversations. Do not demo the custom-attribute panel there (D15). Fix candidate 1 (patch/upgrade Chatwoot) at the next upgrade window — **owner-reserved**. Affects `inbox.epic.dm` too (both instances are v4.16.1). Ref `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` (P2, Open) |
| **R-2** | **No database-enforced message idempotency in Chatwoot.** Deployed v4.16.1 has no unique index and no uniqueness validation on `messages.source_id`. | **Certain** — it is a property of the deployed version | **Medium** | Any duplicate customer-visible reply | Deterministic opaque ref in `content_attributes`, passed through verbatim by `Messages::MessageBuilder`; reconciliation before any resend; fail-closed on unresolved ambiguity. **Never claim "exactly once" to a customer.** State the real guarantee: *a message is sent only after its absence has been proven; when absence cannot be proven, nothing is sent* |
| **R-3** | **Ledger-unavailable fail-closed behaviour.** An unreachable ledger makes the gateway answer `500` — one of only two statuses Chatwoot retries for an agent-bot webhook. If unavailability exceeds Chatwoot's three retries (~9 s), that delivery is **not answered by the AI at all**. | **Low** | **Medium** — a customer message goes unanswered by the AI | `alertCode: ledger_unavailable_on_ack`; Chatwoot opens the conversation to a human itself | This is intended behaviour — failing closed to a human beats a false success. **Disclose it in the proposal and prove it at acceptance (row 15).** Daily check D+4 |
| **R-4** | **Two Chatwoot agent-bot processors with contradictory silence models.** Foundation (Replit) on `inbox.epic.dm` gates on its own `human_handling` flag and explicitly distrusts Chatwoot status; the gateway gates on Chatwoot `status === pending` **and** no assignee. Both are defensible; both cannot govern one conversation. | **Medium** | **High** — a law-1 violation the moment a real channel or the Chatwoot migration lands | Any proposal to point the gateway at a Foundation-served inbox; any Chatwoot migration scheduling | No unilateral choice. Keep the gateway bound **only** to the synthetic `Channel::Api` inbox — it already refuses at boot to serve a duplicate `(account, inbox)` pair or a non-PUBLIC exposure. **Owner ruling required before any real channel.** Ref `risk-two-chatwoot-agent-bot-processors-2026-08-11` (High, Open) |
| **R-5** | **Paperclip isolation is logical, not physical.** One container, one Postgres, one storage volume, one master key, one backup blast radius. Company scoping is real and enforced (`403` on cross-company), but a scoping defect, a bad migration or a key compromise affects every tenant. | **Low** | **High** | Any cross-company observation | Accepted **for the controlled pilot stage only**, and only after the isolation and recovery tests pass. **No paying-tenant data enters Paperclip until a complete restore — database + files + config + master key — has passed on a second throwaway instance** (I9). Physical per-tenant deployment must remain available. Ref `risk-paperclip-logical-tenant-isolation-shared-instance-2026-08-10` (High, Accepted) |
| **R-6** | **Container replacement loses `/tmp` state.** In-place restart preserves; replacement does not. | Medium | Medium | Any state that "was there yesterday" and is not | Row 25 is **Partial** — disclose it. Nothing customer-visible depends on `/tmp`, but do not claim full restart durability |
| **R-7** | **The orphan-recovery proof is unit-proven, not deployed-proven.** *"Restart after durable enqueue but before processing eventually produces one reply."* Four deployed constructions were each defeated by a mechanism slower than a delivery. | Low | Medium | A delivery enqueued and never replied to | Disclose. What **is** deployed-proven: the sweeper runs at boot and on interval, and an interrupted delivery resumed with **no second reply**. Owner ruling pending on WS2 acceptance |
| **R-8** | **No customer admin console exists.** NocoBase and Activepieces are running, healthy and **unadministrable** — no domain, no root credential, sign-up disabled. | Certain | Medium | A customer asking to "log in and change it themselves" | This is exactly why it is sold as a **managed** pilot (§2.2). Never imply a console. WS4 is blocked on owner-configured credentials |
| **R-9** | **Human coverage is the customer's obligation and the most likely failure.** | **High** | **High** — an unanswered escalation is a customer-visible failure of the whole service | D+3 escalation timeliness | Two named humans minimum (4.C1); stated coverage windows (4.C2); D+3 daily check; escalate to the customer's own ops owner and record it as a **customer-side** finding |
| **R-10** | **Volume ceiling unknown.** No conversation-volume limit is proven anywhere in Port. | Medium | Medium | Rising handoff latency; escalations queueing | Cap the pilot to the volume two named humans can absorb; measure daily; **UNVERIFIED-4** |
| **R-11** | **Paperclip board key expires ~2026-09-10.** | Certain, on that date | High if it lands mid-pilot | Calendar | Renew before any pilot window spans it (SC5) |
| **R-12** | **`ACTIVE_RECORD_ENCRYPTION` unset on Chatwoot.** | Certain | Medium | — | Recorded, not hidden. Disclose if the customer asks about data-at-rest |
| **R-13** | **`/api` on a cold Chatwoot worker falsely reports `data_services: failing`.** | Medium | Low | A health page that says failing while everything works | Never diagnose from that endpoint alone. Verify from behaviour |
| **R-14** | **Ledger role is the database owner** — no least-privileged writer split. | Certain | Medium | — | Recorded as hardening, not done. Disclose if asked |
| **R-15** | **Scope creep before the first customer closes.** | **High** | **High** | Any new build request arriving mid-pilot | `risk-scope-creep-before-customer1` (Open, High/High): keep only tasks that close a Customer #1 acceptance criterion. Manual concierge processes are acceptable |
| **R-16** | **Accidental broad launch.** Materials exist and could be published. | Low | High | Any public post | `risk-foh-accidental-broad-launch` (Open) + `dec-gtm-customer1-before-public-ads`. Private, unlisted, controlled only |
| **R-17** | **A price reaches a customer that is not in §5.7.** | Medium | **High** — a truthfulness failure | Any figure in a draft proposal without a §5.7 row | Every currency figure must trace to §5.7 C5–C10 or a fresh Port decision. Treat a stray number as a defect |

---

## 9. Open owner decisions

Consolidated. Nothing below may be resolved by anyone but the owner.

| # | Decision | Why it is blocking | Reference |
|---|---|---|---|
| **OD-1** | **Pilot setup charge** for this configuration | No `epic_offer` covers a Chatwoot-only, no-channel, no-PBX, no-Odoo managed pilot | §5.7 C1 |
| **OD-2** | **Pilot recurring charge** | As OD-1 | §5.7 C2 |
| **OD-3** | **Pilot duration** | No Port record states a pilot term | §2.3, §5.7 C3 |
| **OD-4** | **Deposit staging** — does the SBL 50/50 model apply? | Deposit cannot be requested without it | §5.7 C4 |
| **OD-5** | **Does the founding promo apply to this pilot?** (50% off setup and the first 3 monthly fees, first 3 founding customers) | The promo is ratified for **SBL**; applicability here is unestablished | `dec-sbl-founding-price-value-and-promo-2026-07-22`; §5.7 C7 |
| **OD-6** | **Reconcile the messaging-receptionist price conflict:** EC$99/month (`offer-epic-ai-upgrade-existing-line`, Ratified) vs EC$149/month (`dec-whatsapp-receptionist-founding-price-2026-07-20`, Ratified, same date) | Two ratified figures for what may be the same offer | §5.7 C9 |
| **OD-7** | **Which `epic_offer` record governs this pilot** — and reconcile gate 1's *"powered by Clawith"* description with the deployed **Paperclip** stack | Without this, the proposal has no product record behind it | `isola-gate-01-product-offer` current_state; §5.7 C16 |
| **OD-8** | **AI usage allowance and overage terms** | Cannot state what is included | §5.7 C13 |
| **OD-9** | **Contract term, notice period, and refund terms on non-acceptance** | The packet rollback refers to "the agreement"; no agreement terms exist in Port | §5.7 C14 |
| **OD-10** | **Whether a business registration / tax number is required on a pilot invoice** | Intake field A3 | §4.A3 |
| **OD-11** | **Minimum FAQ count** for a tenant to be accepted for a pilot | Thin knowledge drives escalation volume onto the customer's humans | §4.B6 |
| **OD-12** | **Ruling on the two-processor question** — which component is authoritative for a given number, and which silence model governs | Required **before** WS3/WS4 wire any real channel, and before the Chatwoot migration | `risk-two-chatwoot-agent-bot-processors-2026-08-11` |
| **OD-13** | **Ruling on WS2 acceptance** — accept the unit proof for orphan → first reply, or direct an acceptable construction | 7 of 8 durability proofs pass deployed; the packet is held on the eighth | `xp-isola-signup-to-agent-mvp-2026-08-10` next action 1 |
| **OD-14** | **Chatwoot `conversations#show` 500 fix path** — patch/upgrade Chatwoot (recommended), or a second user-scoped credential in the publicly-exposed component (a security-posture change) | Two of three candidate fixes are owner-reserved | `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` |
| **OD-15** | **WS4 credentials** — NocoBase root and Activepieces admin | Both services are healthy and unadministrable; no operator console exists for the pilot | Packet, WS4 |
| **OD-16** | **Confirm the implementation and support owner** for this pilot | `dec-customer1-owner-ratifications-2026-07-22` item 3 names **Robert Tonge** in the SBL context | §5.5 |
| **OD-17** | **Release of the HOLD** on `xp-fast-track-ai-sales-agent-first-sale`, contingent on EPIC Customer Zero acceptance | Nothing in §5.5 past I1 may start until this happens | Packet plan |
| **OD-18** | **Authorisation of the Paperclip restore-on-throwaway-instance test** as the paying-tenant gate | Hard gate before any paying-tenant data | `decision-paperclip-shared-instance-pilot-only-and-recovery-gates-2026-08-10` §2 |
| **OD-19** | **Confirm the payment rail** for the pilot deposit — EC$ invoice + manual bank/NBD only | `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` is Open | §5.7 C12 |
| **OD-20** | **Approve this package for commercial release** | Listed in the packet's own Evidence Needed as *"Owner approval for commercial release"* | Packet evidence_needed |

---

## Appendix A — Port sources cited

| Entity | Type | What was taken from it |
|---|---|---|
| `xp-fast-track-ai-sales-agent-first-sale` | execution_packet | HOLD status, acceptance string, rollback, evidence_needed |
| `xp-isola-signup-to-agent-mvp-2026-08-10` | execution_packet | 28-row acceptance table, WS2 evidence, known limitations, rollback. **Read only. Never written.** |
| `isola-gate-01-product-offer` | isola_launch_gate | Objective, current_state, exit_criteria, next_action |
| `isola-gate-07-perkys-customer1` | isola_launch_gate | Exit criteria, measures, and the "do not activate" next action |
| `offer-epic-smart-business-line` | epic_offer | EC$750 / EC$249 (Ratified), support_boundary, exclusions |
| `offer-epic-ai-upgrade-existing-line` | epic_offer | EC$250 / EC$99 (Ratified), support_boundary, exclusions |
| `offer-epic-customer-operations-workspace` | epic_offer | offer_status "Managed pilot", price OWNER-DECISION REQUIRED, exclusions |
| `offer-epic-hosted-business-pbx` | epic_offer | `agent_recommendable` false — must not be proposed |
| `offer-missed-call-recovery-not-offered` | epic_offer | Never demo, never mention |
| `cap-selfserve-signup` | capability | Future / BLOCKED |
| `cap-voice-ai-receptionist` | capability | Not-Offered |
| `cap-missed-call-recovery` | capability | Future, dark in prod |
| `dec-sbl-founding-price-value-and-promo-2026-07-22` | decision | Canonical SBL price + founding promo terms |
| `dec-sbl-founding-price-reconciliation-2026-07-18` | decision | Staged deposit precedent, superseded tracks |
| `dec-whatsapp-receptionist-founding-price-2026-07-20` | decision | EC$250 + EC$149/month — conflicts with C8 |
| `dec-customer1-owner-ratifications-2026-07-22` | decision | Owner-executed deposit; named implementation owner; manual NBD/invoice route |
| `dec-gtm-customer1-before-public-ads` | decision | Warm outreach and private demos allowed; public acquisition blocked |
| `dec-gtm-concierge-before-selfserve` | decision | Concierge before self-service |
| `dec-gtm-pricing-provisional-until-live-recon` | decision | Prices provisional until owner reconciliation |
| `dec-customer-zero-epic-gate-before-customer-one-2026-07-21` | decision | Customer Zero gates Customer One |
| `decision-paperclip-shared-instance-pilot-only-and-recovery-gates-2026-08-10` | decision | Pilot-only isolation acceptance; restore gate |
| `risk-two-chatwoot-agent-bot-processors-2026-08-11` | risk | Two silence models; owner ruling required |
| `risk-paperclip-logical-tenant-isolation-shared-instance-2026-08-10` | risk | Logical isolation, bounded acceptance |
| `risk-payment-provider-stripe-fiserv-unreconciled-2026-07-18` | risk | No Stripe or Fiserv link for Customer #1 |
| `risk-scope-creep-before-customer1` · `risk-foh-accidental-broad-launch` | risk | Programme discipline |
| `defect-chatwoot-conversations-show-500-agentbot-team-2026-08-11` | defect | The AgentBot team-assignment 500 |
| `claim-gtm-epic-managed-setup-support` | marketing_claim | Draft; requires a seven-day stabilisation checklist before approval — §7 contributes it |

## Appendix B — Unverified items in this document

| # | Unverified | Effect |
|---|---|---|
| **UNVERIFIED-1** | The frozen spec `docs/isola/ISOLA-AI-SALES-FRONT-DESK-AGENT-V1-FROZEN-SPEC.md` did not exist on disk when this was written | §3 and §4 must be reconciled against it before first use; the spec wins on any conflict |
| **UNVERIFIED-2** | Whether the PUBLIC employee `fd2867d1` can produce a live grounded answer for a demo. Row 9 = "staged, not ready"; row 13 = "PUBLIC not yet invoked" | §3.2 dry run decides Mode L vs Mode N; acceptance row 2's PUBLIC path is TO-BE-PROVEN |
| **UNVERIFIED-3** | The exact Template v1 tenant-business-information field list was not read | §4 is a proposed superset, not a confirmed match |
| **UNVERIFIED-4** | No conversation-volume ceiling is proven anywhere in Port | §5.3 AS4; §8 R-10 |
| **UNVERIFIED-5** | Gate 1 describes the offer as *"powered by Clawith"*; the deployed stack is **Paperclip**. No `epic_offer` record matches the pilot configuration | OD-7 |
| **UNVERIFIED-6** | Whether `dec-customer1-owner-ratifications-2026-07-22` item 3 (Robert Tonge as implementation and support owner) carries from the SBL context to this pilot | OD-16 |
| **UNVERIFIED-7** | Whether the founding promo's "first 3 founding customers" cap has already been partly consumed | OD-5 — check before quoting it to anyone |
