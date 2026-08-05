# Chatwoot R1 — owner rulings, contradiction reconciliation, and the reversible change plan

**Status:** planning only. **No Chatwoot mutation performed. No user confirmed. No inbox disabled.
No webhook deleted. No automation changed. No Dashboard App created. No credential provisioned.**
**Date:** 2026-08-05
**Authorising packet:** `xp-chatwoot-native-workspace-architecture-2026-08-05` (R0, design of record)
**Execution packet:** `xp-chatwoot-r1-native-configuration-2026-08-05`
**Predecessor design:** `docs/isola/CHATWOOT-OPERATING-WORKSPACE-DESIGN.md`
**Evidence class:** Port entity reads; Chatwoot 4.16 official API reference via Context7; live
read-only inspection of the deployed Chatwoot Postgres and Rails container.

---

## 0. Three findings that change the owner's premises

The owner's rulings were written against the R0 inventory. Three of them rest on premises that the
read-only capture for this session contradicts. Each is stated here before the plan, because two of
them change what R1 is allowed to do.

### F1 — Inbox 38 is not a dead door. D5's premise is two-thirds true.

D5 retires webhooks 72/73/74 "because their inboxes are retired." Live lifetime conversation counts:

| Inbox | Name | Lifetime conversations | Last message |
|---|---|---|---|
| 3 | `[RETIRED 2026-07-31] api-test-3` | **0** | never |
| 36 | `[RETIRED 2026-07-31] api-test-36` | **0** | never |
| 38 | `[RETIRED 2026-07-31] api-test-38` | **1** | **2026-08-04 14:42:06 UTC** |

Inbox 38 received conversation 215 (display 130) **four days after being renamed RETIRED**, carrying one
incoming message `[📞 voice call — permission granted, call incoming]` from contact 49 (an EPIC-internal
contact with a phone number, not an anonymous visitor). Webhook 74 is subscribed to `message_created`
and would have fired on it.

**Consequence.** Webhooks 72 and 73 serve doors with zero lifetime traffic and can be retired on the
evidence already in hand. **Webhook 74 cannot.** Something is still writing into inbox 38 through the
Channel::Api ingress as of yesterday, and the identity of that writer is not established. Deleting 74
before identifying it would silently sever a live path. R1C is therefore split: 72/73 proceed, 74 is
gated behind a producer-identification step.

### F2 — None of the nine inbox-17 conversations can be answered by anyone.

D4 asks whether any of the nine requires a human response. All nine are anonymous web-widget visitors
with **no email address and no phone number** on the contact record. There is no channel on which a
reply could reach any of them. The widget sessions are between 59 and 67 days cold.

**Consequence.** "Triage and respond where needed" is not an available option for these nine. The only
honest dispositions are *resolve with a recorded reason* or *leave open*. This removes the
customer-contact risk from R1B entirely and makes the containment decision purely about future traffic.

### F3 — The five outstanding invitations are still valid today.

`config.confirm_within` is **commented out** in `/app/config/initializers/devise.rb`, so Chatwoot places
no expiry on confirmation tokens. All five unconfirmed users still hold a `confirmation_token` and have
`confirmation_sent_at = 2026-07-14`.

**Consequence.** The original invitation emails from 22 days ago **still work**. The cheapest correct fix
for D3 involves **zero mutation of any kind** — the four staff and Phillip open the link they were
already sent. Every mutating path (delete-and-reinvite, rails-console confirm) is a fallback for people
who no longer have the email, not the primary plan.

---

## 1. Owner rulings as recorded

| # | Ruling | Recorded effect on the plan |
|---|---|---|
| **D1** | Remain on Community Edition. Do not block the roadmap on Enterprise. Foundation owns the initial substitutes for SLA clock/breach evidence, governed audit ledger, fine-grained role authorization, required resolution fields. A separate future Enterprise buy-vs-build decision is created. Do not purchase, enable or simulate Enterprise functionality. | R1E may configure only what CE actually implements. §6 defines the four Foundation substitutes as contracts. `dec-chatwoot-enterprise-buy-vs-build` created **Open**, not scheduled. |
| **D2** | Foundation owns escalation-team selection. Inbox 46: no auto team-1 assignment on creation; pending AI-owned conversations may stay unassigned; on escalation Foundation selects team or operator; Chatwoot may add `human_takeover`; no account-wide automation may overwrite Foundation's assignment with team 7. | R1D: rule 1 deactivated; rule 3 loses `assign_team 7`, keeps `add_label human_takeover`, gains an explicit inbox scope. Exact rollback JSON in §4.4. |
| **D3** | Phillip's administrator account confirmed through the supported process. Dezy, Hakeem, Kimberly, Joann individually verified as active employees **before** confirmation. | R1A. Employment verification is a gate, not a formality — §4.1 names the authority and the negative test. |
| **D4** | Stop future traffic into inbox 17 after preserving and triaging the nine open conversations. | R1B. F2 means triage resolves to a records decision, not a response decision. |
| **D5** | Retire webhooks 72, 73, 74 because their inboxes are retired. | R1C, **split by F1**. 72/73 proceed as ruled. 74 is held pending producer identification and returned to the owner. |
| **D6** | Defer CSAT on inbox 46 behind seven entry conditions. | R1E records CSAT as deliberately-off with the seven conditions as a checklist. No inbox 46 CSAT change in R1. |
| **D7** | Captain remains unused. Clawith is the sole reasoning runtime. | R1E asserts no Captain feature is enabled and adds a standing check. Captain is premium and absent from the image, so this is a policy record, not a configuration change. |
| **D8** | The PlatformApp token-harvest P0 closes before Customer 360 backend API access, internal-agent Dashboard App access, or any new Chatwoot API consumer. The future integration uses a narrow supported Application API identity, never the broad PlatformApp credential. | R1F is a hard predecessor of R1G. §5 defines the entry gate. |

---

## 2. C1–C8 reconciliation

Method: no historical statement is deleted or rewritten. Each stale claim gets a dated correction block
prepended to the field that carries it, with the original text preserved verbatim beneath. Provenance
and original timestamps are retained.

| # | Stale Port statement | Live replacement fact | Disposition |
|---|---|---|---|
| **C1** | `xp-chatwoot-operator-console-completion` §1.3: rule 1 is scoped `inbox_id in {3,40}`, "does NOT apply to inbox 46, no race". | Rule 1 conditions are `filter_operator: equal_to, values: [3, 40, 46]`. Inbox 46 **is** in scope. Two competing automation writes per escalation, not one. Note the operator is `equal_to` over a value array, not `in` — R0 recorded it as `in`. | **Correction prepended to `plan`.** Original §1.3 text retained. The rule-3 race analysis in that section stands; the "no race from rule 1" premise does not. Superseded by D2 + R1D. |
| **C2** | `dec-inbox46-processor-ownership-contract-2026-07-29`: webhook id 2, `inbox_id NULL`, fans out to all five inboxes at `bff.epic.dm` with no app-layer auth. | Webhook 2 no longer exists. Replaced by inbox-scoped 72/73/74, each with a secret set. The account-wide unauthenticated fan-out is **closed**. | **Correction prepended to `decision_text`.** The ownership law and the exposure analysis are retained as the historical record of a real closed exposure. The consumer table is marked superseded. The decision's exit condition ("webhook 2 retires when Foundation assumes forwarding") is **satisfied for 3/36 and unresolved for 38** — see F1. |
| **C3** | Automation rule 1 references `inbox_id 40`. | Inbox 40 does not exist on account 5. | Resolved by R1D: rule 1 is deactivated in full, so the dangling reference stops being reachable. Recorded in the R1 packet, not a separate entity. |
| **C4** | `xp-chatwoot-human-handoff-maximization` plan body: AgentBot 6 "has no secret and an unreachable loopback outgoing URL". | AgentBot 6 → `https://hooks.isola.epic.dm/v1/chatwoot/agentbot/events`, binding 18 active on inbox 47. | **Already superseded by that packet's own 2026-08-02 acceptance note**, which proved a real Chatwoot-originated HMAC-verified delivery to that URL. The plan body was never updated. **Correction prepended to `plan`.** |
| **C5** | CW00/CW01: "retained launch inboxes share Chatwoot account 5 … an event from one tenant can be resolved using another tenant's binding." | Exactly one account exists (5). No second tenant account is provisioned. | **Reclassified prospective, not current.** Correction appended to `xp-chatwoot-wp01-access-model.evidence_needed`. The strict `(account_id, inbox_id)` routing law is **not** relaxed — `defect-chatwoot-webhook-account-only-tenant-resolution-2026-07-25` (P0) stays open and must land **before** tenant 2. Reclassifying the blast radius is not closing the defect. |
| **C6** | `xp-chatwoot-human-handoff-maximization.evidence_needed` requires "SLA / capacity settings" as acceptance evidence. | SLA and advanced assignment are premium and absent from the CE image. The two SLA policies on account 5 can never apply (`applied_slas = 0`). | **Unsatisfiable criterion re-authored, not dropped.** Per D1 the obligation moves to Foundation: the evidence becomes *Foundation SLA timer + breach ledger entries*, and *team + saved-folder load distribution* in place of capacity. Original wording preserved in the correction block. |
| **C7** | "Chatwoot does NOT natively suppress the bot on human ownership — suppression MUST BE BUILT in Foundation." | Reconfirmed in 4.16.1 CE. `AgentBotListener` gates only on `agent_bot_inbox.active?` and `webhook_sendable?`. | **Holds. No change.** Recorded as reconfirmed so a later session does not re-derive it. |
| **C8** | Resolve silently hands back to AI; the Clawith session outlives the Chatwoot conversation. | Structural in Chatwoot. Not fixable by configuration. | **Holds. No change.** `def-chatwoot-resolve-acts-as-handback-clawith-session-survives-2026-07-30` (P1) stays open and is owned by R2, not R1. |

---

## 3. Universal execution rules for every R1 action

These apply to every step in §4 and are not repeated per action.

1. **Before-state capture is a precondition, not a courtesy.** No mutation runs until its exact
   before-state row is captured to the packet evidence. The rollback in this document is only valid
   against the before-state recorded here; if live state has drifted, re-capture and re-plan.
2. **One action, one verification, one evidence record.** No batching of unrelated mutations.
3. **Required role.** Every action in R1 requires Chatwoot `administrator` on account 5. Today that is
   Eric (user 1) alone in practice — see F5. R1A is therefore a predecessor of comfortable execution
   for everything else, though not a technical blocker.
4. **Edition.** Every action below is verified available in Community Edition 4.16.1. Nothing in R1
   depends on a premium feature. Where CE cannot do a thing, §6 assigns it to Foundation rather than
   configuring a decoy.
5. **No Platform API.** Every mutation uses the Application API (`api_access_token`, user-scoped) or the
   admin UI. The PlatformApp credential is not used for any R1 step (D8).
6. **Audit evidence.** Chatwoot CE writes **no audit log** (`audits` = 0 rows, premium absent). The audit
   of record for every R1 action is the Port evidence entity plus the before/after readback captured by
   the operator. No acceptance may cite a Chatwoot audit entry.
7. **Owner gate.** Every mutating step below carries an explicit owner gate. None may be executed from
   this plan alone.

---

## 4. The R1 change plan

### 4.1 R1A — staff access restoration (D3)

**Current state.** Ten memberships on account 5. Five are unconfirmed and cannot log in. Confirmation
is not the only access problem — two more findings sit underneath it:

| user | name | role | confirmed | conf. sent | token held | sign-ins | last sign-in | teams | inbox members |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Eric Giraud | administrator | yes | 2026-04-05 | yes | **53** | 2026-08-02 | 1, 7 | 46, 47 |
| 3 | Eric Giraud | administrator | yes | — | no | 0 | never | — | — |
| 131 | Phillip | **administrator** | **no** | 2026-07-14 | yes | 0 | never | 1, 5, 7 | 46 |
| 46 | Isola AI | agent | yes | — | no | 0 | never | — | — |
| 129 | Veronica | agent | yes | 2026-07-14 | no | **0** | **never** | 1 | 46 |
| 130 | Dezy | agent | **no** | 2026-07-14 | yes | 0 | never | 1, 5 | 46 |
| 132 | Hakeem | agent | **no** | 2026-07-14 | yes | 0 | never | 1, 5 | 46 |
| 133 | Kimberly | agent | **no** | 2026-07-14 | yes | 0 | never | **6 only** | **none** |
| 134 | Joann Polydore | agent | **no** | 2026-07-14 | yes | 0 | never | **6 only** | **none** |
| 135 | QA Staff | agent | yes | 2026-07-15 | no | 1 | 2026-07-15 | 1 | 46 |

Three separate problems, not one:

- **(a) Unconfirmed.** Five seats, including administrator Phillip. Cannot log in at all.
- **(b) Confirmed but never used.** Veronica (129) is confirmed with **zero** sign-ins. Confirming the
  other five will not by itself produce a working console; adoption is a separate outcome.
- **(c) Confirmed access would still show nothing.** Kimberly (133) and Joann (134) hold **no inbox
  membership**. They are in team 6 (finance & billing) only. If confirmed today they would log in to an
  empty workspace. Confirmation without inbox membership is a non-delivery.

**Target state.** Phillip operable as administrator. Each of Dezy, Hakeem, Kimberly, Joann either
operable with a correct team + inbox assignment, or disabled as a stale seat. Veronica's seat resolved
(used or disabled). Eric's duplicate SuperAdmin row (user 3) dispositioned.

**Step R1A-0 — employment verification (gate, no mutation).**
Verify Dezy, Hakeem, Kimberly and Joann individually against the authoritative HR record before any
confirmation. Authority: Odoo `hr_employee` under Foundation tenant `43b006e4` — the roster read on
2026-08-04 returned 8 active records, 7 real staff plus one synthetic "AI Ops Manager" which must be
excluded. Chatwoot membership is **not** evidence of employment; it is the thing being justified.
Output: a four-row verified/not-verified table. Anyone not verified goes to R1A-4 (disable), not R1A-2.
**Owner gate:** owner confirms the four-row result before proceeding.

**Step R1A-1 — mailer health check (diagnostic, no mutation).**
Establish whether Chatwoot's outbound mail works at all before choosing a confirmation path. Evidence
that it worked at least once: Veronica (129) was confirmed at 14:32:34 on 2026-07-14, one minute before
Dezy's invitation was sent. Evidence that something is wrong: five of six invitations from that batch
were never completed.
Check SMTP configuration presence and validity through an approved path. *This session could not read
the mailer environment — the production-safety hook correctly blocked the command as a secret dump, so
SMTP configuration is **unverified**, not verified-good.* Do not skip this: if mail is broken, every
"resend" path silently fails and the fallback in R1A-3 becomes mandatory rather than optional.
**Owner gate:** none (read-only), but the result gates the choice below.

**Step R1A-2 — confirmation, in strict order of preference.**

| Path | Mechanism | Mutation | When to use | Rollback |
|---|---|---|---|---|
| **A (primary)** | Recipient opens the original invitation email from 2026-07-14 and follows the confirmation link. Valid indefinitely — `confirm_within` is unset (F3). | **None by us.** Devise sets `confirmed_at` on the user's own action. | Always try first. Zero risk, zero admin action, fully supported. | Not applicable — nothing was changed on our side. To revoke: R1A-4. |
| **B (fallback)** | Re-issue the invitation: `DELETE /api/v1/accounts/5/agents/{id}` then `POST /api/v1/accounts/5/agents {name, email, role}` → Chatwoot sends a fresh invitation. | **Destructive.** Removes the `account_users` row and with it that user's `team_members` and `inbox_members` rows. | Only when the original email is unrecoverable **and** R1A-1 proved mail works. | Re-add the agent and **re-apply team + inbox membership from the table above** — the memberships do not come back on their own. This is the whole risk of path B. |
| **C (last resort)** | Rails console on the running container: confirm the specific user record. | Direct runtime mutation of production state. | Only when A is impossible and B's membership loss is unacceptable (i.e. Phillip, who holds three team memberships). | Clear `confirmed_at` for that user. Must be captured before and after. |

Path C is emergency containment, not the operating model (repo law §7 of `CLAUDE.md`): if it is used, it
must be followed by a recorded state model and a UI-manageable path, not left as the procedure.

**Owner gate:** required per user, and separately required to authorise path B or C at all.

**Step R1A-3 — role and membership assignment after confirmation.**

| user | role | teams (target) | inbox members (target) | action needed |
|---|---|---|---|---|
| 131 Phillip | administrator | 1, 5, 7 | 46 | none beyond confirmation |
| 130 Dezy | agent | 1, 5 | 46 | none beyond confirmation |
| 132 Hakeem | agent | 1, 5 | 46 | none beyond confirmation |
| 133 Kimberly | agent | 6 | **46 — must be added** | `PATCH /api/v1/accounts/5/inbox_members {inbox_id: 46, user_ids: […]}` |
| 134 Joann | agent | 6 | **46 — must be added** | same |

⚠ **`PATCH /inbox_members` removes every agent not in `user_ids`.** The documented behaviour is "All
agents except the one passed in params will be removed." The call must therefore carry the **full**
target member list for inbox 46, not just the additions. Current inbox-46 members: 1, 129, 130, 131,
132, 135. Target after adding Kimberly and Joann: **1, 129, 130, 131, 132, 133, 134, 135**. Passing a
partial list would silently strip the existing six. *Rollback: re-issue with the original six.*

**Step R1A-4 — stale-seat disable.**
For any seat that fails R1A-0, or that the owner elects not to restore: `DELETE
/api/v1/accounts/5/agents/{id}` removes the account membership (and team/inbox membership) while leaving
the `users` row. Capture the full membership set before deletion — that capture *is* the rollback.
Candidates to consider explicitly: Veronica (129, confirmed but never signed in), Eric user 3 (duplicate
SuperAdmin, never signed in — disposition only, do **not** delete without confirming nothing references
it), and any of the four who fail employment verification.

**Step R1A-5 — negative test (mandatory).**
Prove that an unconfirmed or disabled user cannot operate:
1. Attempt sign-in as a still-unconfirmed account → must be refused with the unconfirmed response, not
   a session.
2. Attempt an Application API call with a token belonging to a disabled membership → must return 401/403.
3. Confirm a disabled user cannot appear as an assignee on inbox 46.
This test must run **before** the owner accepts R1A, because it is the only proof that the access model
is closed rather than merely tidy.

| | |
|---|---|
| **Customer-visible effect** | None. |
| **Outage risk** | Path B only: temporary loss of that agent's assignments during the delete/re-add window. Path A/C: none. |
| **Message-loss risk** | None. No path touches conversations or messages. |
| **Audit evidence** | Per-user before/after `confirmed_at`, membership snapshot, negative-test transcript. Port evidence entity. No Chatwoot audit exists (§3.6). |

---

### 4.2 R1B — inbox 17 containment and triage (D4)

**Current state.** Inbox 17 `Isola Web`, `Channel::WebWidget`, channel id 1,
`website_url https://epic.isola.epic.dm`, `enable_auto_assignment = true`,
`working_hours_enabled = true`, `csat_survey_enabled = false`, `hmac_mandatory = false`,
**zero inbox members**. Nine open conversations, nobody assigned, nobody notified.

**The nine conversations** (all `status = open`, no priority, no assignee, no team):

| conv id | display | created | last activity | msgs | in | out | contact | email | phone |
|---|---|---|---|---|---|---|---|---|---|
| 46 | 15 | 2026-06-07 | 2026-06-07 | 5 | 2 | 3 | `restless-pond-…` | none | none |
| 24 | 11 | 2026-05-31 | 2026-05-31 | 2 | 1 | 1 | `quiet-cloud-148` | none | none |
| 23 | 10 | 2026-05-30 | 2026-05-30 | 2 | 1 | 1 | `quiet-shape-160` | none | none |
| 22 | 9 | 2026-05-30 | 2026-05-30 | 2 | 1 | 1 | `still-mountain-669` | none | none |
| 21 | 8 | 2026-05-30 | 2026-05-30 | 4 | 3 | 1 | `small-voice-836` | none | none |
| 20 | 7 | 2026-05-30 | 2026-05-30 | 14 | 1 | 13 | `spring-butterfly-…` | none | none |
| 19 | 6 | 2026-05-30 | 2026-05-30 | 3 | 1 | **0** | `dark-thunder-737` | none | none |
| 18 | 5 | 2026-05-30 | 2026-05-30 | 3 | 1 | **0** | `fragrant-sun-307` | none | none |
| 17 | 4 | 2026-05-30 | 2026-05-30 | 3 | 1 | **0** | `weathered-meadow-…` | none | none |

Contact names are Chatwoot's auto-generated pseudonyms for anonymous visitors — they are not PII and no
message content is reproduced here.

**Does any require a human response?** **No — and none can receive one.** Every contact lacks both email
and phone (F2), so there is no channel on which a reply could be delivered. The widget sessions ended
between 59 and 67 days ago. Conversations 17, 18 and 19 each received an inbound message and got zero
replies; that is a real (if now unrecoverable) service failure, and it should be recorded as the reason
the widget must not stay open unstaffed — not papered over.

**Target state.** No new conversation can be created in inbox 17. The nine are dispositioned with a
recorded reason. The record of the three unanswered contacts survives.

**Step R1B-1 — preserve (no mutation).** Export the nine conversations with their messages, timestamps
and contact references to the packet evidence. This is the archive; it must exist before any status
change, because Chatwoot CE has no audit log to reconstruct from.

**Step R1B-2 — disposition the nine.**
Recommended: `POST /api/v1/accounts/5/conversations/{id}/toggle_status {status: "resolved"}` for all
nine, each preceded by a private note recording *why* (unreachable anonymous visitor, session expired,
no reply channel). Resolve is reversible — `toggle_status {status: "open"}` restores it.
⚠ **Do not** treat resolve here as a handback signal. C8 is live: on inbox 46, resolve functions as an
implicit silent handback. Inbox 17 has no AgentBot bound, so no bot can resume — but the operator
running this step must understand the distinction so the habit does not migrate to inbox 46.
Alternative, if the owner prefers zero conversation writes: leave all nine open and rely on R1B-3 to stop
new traffic. This is defensible and is the lower-risk option.

**Step R1B-3 — stop future traffic.** Two supported mechanisms, in order of reversibility:

| Option | Path | Effect | Reversal | Recommendation |
|---|---|---|---|---|
| **1 (recommended)** | Remove the widget script from `https://epic.isola.epic.dm`. | No visitor can start a conversation. The inbox stays intact. | Re-add the script. | Preferred — the change is outside Chatwoot, instantly reversible, and destroys nothing. |
| **2** | `PUT /api/v1/accounts/5/inboxes/17` with `enable_auto_assignment: false` and a truthful `out_of_office_message`, working hours closed all day. Discard the response body — `-o /dev/null -w '%{http_code}\n'` — the status code is the only thing to check, and a raw inbox response carries `provider_config`. | Widget still accepts messages; visitors are told nobody is there. | Restore the captured flags. | Use **with** option 1 as an honest fallback if the script cannot be removed immediately. Alone, it does not stop traffic — it only stops pretending. |
| **3** | Delete the inbox. | Irreversible; destroys the nine conversations. | **None.** | **Rejected.** Precedent: `defect-chatwoot-49-conversations-deleted-unrecovered-2026-07-27` — 49 conversations deleted on an "inert" assessment and still unrecovered. Do not repeat it. |

**Reactivation requirements (must be met before inbox 17 is ever reopened):** at least two confirmed
inbox members; a saved folder covering it; a named owner; working hours that match reality; and a
decision on whether an AgentBot is bound. Reopening it unstaffed recreates the exact failure above.

| | |
|---|---|
| **Customer-visible effect** | Option 1: the widget disappears from the site. Option 2: visitors see an out-of-office message. Neither sends anything to the nine. |
| **Outage risk** | None — the inbox has no staff and no bot; there is no service to interrupt. |
| **Message-loss risk** | **Zero under options 1 and 2.** Certain and total under option 3, which is rejected. |
| **Audit evidence** | The R1B-1 export, the before-state flags, per-conversation status change with its private-note reason. |
| **Owner gate** | Required for R1B-2 (choice of disposition) and R1B-3 (choice of option). |

---

### 4.3 R1C — stale webhook retirement (D5, **split by F1**)

**Current state** — exact, captured 2026-08-05. All three are account 5, all carry a secret, all created
2026-07-29 15:32:53 UTC, all subscribed to
`["message_created", "conversation_status_changed", "conversation_updated"]`:

| id | inbox | url | secret set | inbox lifetime convs |
|---|---|---|---|---|
| 72 | 3 | `https://bff.epic.dm/api/chatwoot/webhook?inbox=3` | yes | **0** |
| 73 | 36 | `https://bff.epic.dm/api/chatwoot/webhook?inbox=36` | yes | **0** |
| 74 | 38 | `https://bff.epic.dm/api/chatwoot/webhook?inbox=38` | yes | **1, last activity 2026-08-04** |

Secret values were not read or recorded — only their presence.

**R1C-1 — webhooks 72 and 73: proceed as the owner ruled.**

*Proof no valid consumer depends on them:* inboxes 3 and 36 have **zero conversations in their entire
history**, therefore zero `message_created`, `conversation_status_changed` or `conversation_updated`
events have ever been produced for either. A webhook that has never had an event to deliver cannot have
a consumer that depends on delivery. This is a stronger proof than "the inbox looks retired."

- **Before-state capture:** `curl -sS -H "api_access_token: $CHATWOOT_TOKEN" "$CW/api/v1/accounts/5/webhooks" | jq '[.payload[] | {id, url, name, subscriptions, account_id}]'`
  → record those five fields for 72 and 73. The projection is the point: the raw response carries each
  webhook's `secret`, and this drops it rather than printing it and trimming afterwards.
  **If a secret must be retained for rollback, read it straight into the secure store — never to stdout,
  Port, git, logs or this transcript.**
- **Mutation:** `curl -sS -X DELETE -o /dev/null -w '%{http_code}\n' -H "api_access_token: $CHATWOOT_TOKEN" "$CW/api/v1/accounts/5/webhooks/72"`,
  then the same for `73`. One at a time. The body is discarded deliberately — the status code is the only
  thing worth reading, and a delete response echoes the webhook it deleted.
- **Verification:** `curl -sS -H "api_access_token: $CHATWOOT_TOKEN" "$CW/api/v1/accounts/5/webhooks" | jq '[.payload[] | {id, url, name, subscriptions, account_id}]'`
  no longer lists 72 or 73; 74 unchanged; inbox 46 and 47 traffic unaffected; AgentBot bindings 15 and 18
  untouched. Same projection as the before-state capture — an abbreviated path is still a credential-bearing
  read, and eliding the account prefix only hid it from the scanner.
- **Rollback:** `curl -sS -X POST -H "api_access_token: $CHATWOOT_TOKEN" -H "Content-Type: application/json" -d @webhook-72.json "$CW/api/v1/accounts/5/webhooks" | jq '{id, url, name, subscriptions, account_id}'`
  with the captured values. The create response carries the newly minted secret; the projection drops it,
  so read that secret into the secure store directly if a consumer needs it.
  ⚠ **The recreated webhook gets a new id and a new secret.** Rollback restores the *function*, not the
  identity. If any consumer ever pins webhook id or secret, rollback is not transparent — which is
  another reason to prove the consumer set first.
- **Alternative considered:** Chatwoot's `PATCH /webhooks/{id}` cannot disable a webhook (there is no
  `active` field on the resource; only `url`, `name`, `subscriptions`). A soft-disable would mean
  repointing the URL at a sink, which is worse than deletion — it leaves a live row pointing somewhere
  unowned. Deletion with a captured recreate payload is the correct reversible action.

**R1C-2 — webhook 74: HELD. Returns to the owner.**

D5's stated reason ("its inbox is retired") is **false for inbox 38**. Conversation 215 was created
2026-08-04 14:42:06 UTC — four days after the retirement rename — with an incoming message
`[📞 voice call — permission granted, call incoming]` from contact 49, an internal contact with a phone
number. Inbox 38 is `Channel::Api`, so that message arrived through an authenticated API POST: something
is actively writing to this inbox.

**Required before 74 may be deleted:**
1. Identify the producer that created conversation 215 (the voice-call permission flow — likely the
   bff-v2 / Magnus voice path, unconfirmed).
2. Determine whether that producer, or `bff.epic.dm`, depends on receiving the resulting webhook event.
3. Confirm the retirement of inbox 38 was intended to include this path, or was an oversight.

Until then, deleting 74 is a silent severance of a live path with no failure signal — exactly the class
of change that CLAUDE.md law 5 exists to prevent. **This is a flagged deviation from D5, not a refusal:
the owner ruled on a premise the substrate contradicts, and the ruling should be re-made on the corrected
facts.**

| | |
|---|---|
| **Required role** | administrator |
| **Edition** | Webhooks are core CE. |
| **Customer-visible effect** | None for 72/73. Unknown for 74 until the producer is identified — which is the reason for the hold. |
| **Outage risk** | Nil for 72/73 (zero lifetime events). Unquantified for 74. |
| **Message-loss risk** | None — webhooks are outbound notifications; deleting one does not affect Chatwoot's own message store. |
| **Owner gate** | Ruled for 72/73 (D5 stands). **Re-decision required for 74.** |

---

### 4.4 R1D — automation rule correction (D2)

**Current state — exact JSON for rollback.**

Rule 1 — `Route EPIC WhatsApp to Epic Support Team`, `conversation_created`, `active: true`:
```json
{
  "conditions": [
    { "attribute_key": "inbox_id", "filter_operator": "equal_to",
      "values": [3, 40, 46], "query_operator": null }
  ],
  "actions": [ { "action_name": "assign_team", "action_params": [1] } ]
}
```

Rule 3 — `Escalation - route to human`, `conversation_updated`, `active: true`:
```json
{
  "conditions": [
    { "attribute_key": "status", "filter_operator": "equal_to",
      "values": ["open"], "query_operator": null, "custom_attribute_type": "" }
  ],
  "actions": [
    { "action_name": "add_label",   "action_params": ["human_takeover"] },
    { "action_name": "assign_team", "action_params": [7] }
  ]
}
```

**What actually happens today on inbox 46.** A conversation is created → rule 1 assigns team 1. Foundation
escalates: private note, assign the chosen operator/team, `toggle_status → open` → rule 3 fires, adds
`human_takeover` **and reassigns to team 7**, overwriting whatever Foundation just set. Two automation
writes race the governed escalation contract
(`dec-chatwoot-escalation-contract-inbox46-2026-07-29` step 4). D2 ends both.

**Target state.**

| Rule | Change | Why |
|---|---|---|
| **1** | `active: false` | D2 forbids auto team-1 assignment on creation for inbox 46. After removing 46, the remaining scope is inbox 3 (**zero lifetime conversations**) and inbox 40 (**does not exist**) — the rule would have nothing left to do. Deactivating is one reversible boolean and preserves the row, its id and its history. It also resolves C3. |
| **3** | Remove the `assign_team [7]` action. Keep `add_label ["human_takeover"]`. Add an explicit `inbox_id` condition scoping it to 46. | D2: Chatwoot may add the label; no account-wide automation may overwrite Foundation's assignment. The inbox scope stops it firing for inboxes 17, 38 and 47, where it is currently firing account-wide with no purpose. |

**Mutation.** `PUT /api/v1/accounts/5/automation_rules/{id}` — the endpoint requires a full body
(`name`, `event_name`, `conditions`, `actions`, `active`), so both calls resend every field.

Rule 1 → identical body with `"active": false`.

Rule 3 → 
```json
{
  "name": "Escalation - route to human",
  "event_name": "conversation_updated",
  "active": true,
  "conditions": [
    { "attribute_key": "status", "filter_operator": "equal_to",
      "values": ["open"], "query_operator": "AND", "custom_attribute_type": "" },
    { "attribute_key": "inbox_id", "filter_operator": "equal_to",
      "values": [46], "query_operator": null }
  ],
  "actions": [ { "action_name": "add_label", "action_params": ["human_takeover"] } ]
}
```

**Verification.** Drive one controlled escalation on a test conversation in inbox 46: Foundation assigns
team 5 (or a named operator) → `toggle_status → open` → read back. Pass = assignee/team is **still what
Foundation set**, label `human_takeover` present, exactly one assignment write. Fail = team 7 present.
Also verify a `conversation_created` in inbox 46 results in **no** team assignment.

**Rollback.** Re-`PUT` both rules with the exact JSON captured above. Fully reversible; no data involved.

**⚠ Residual risk this change introduces, and its mitigation.** Removing `assign_team 7` removes the
implicit safety net that put *every* escalated conversation somewhere visible. If Foundation escalates
without completing its assignment step, the conversation becomes open **and unassigned** — visible to
nobody in particular. Mitigations, both required:
1. The `Escalated & unassigned` saved folder in R1E-4 must exist **before** this change lands, not after.
2. Foundation's escalation contract already mandates an explicit assignment (step 4) and mandates that
   on assignment failure it keeps AI suppressed and records a truthful operational failure rather than
   proceeding. That behaviour must be confirmed present, not assumed, before R1D executes.

Note also that team 7 currently has exactly **two** members — Eric (1) and Phillip (131, unconfirmed) —
so the "safety net" being removed was in practice a queue with one operable person in it (F6). R1A
materially improves this regardless of R1D.

| | |
|---|---|
| **Customer-visible effect** | None directly. Indirectly: escalations reach the right team faster. |
| **Outage risk** | Low. The failure mode is a misrouted or unassigned escalation, not a dropped message. |
| **Message-loss risk** | None. |
| **Owner gate** | D2 ruled. Owner confirms the R1E-4 folder exists and the Foundation assignment step is verified before execution. |

---

### 4.5 R1E — CE-native workspace configuration (prepared, not applied)

Everything here is verified present in CE 4.16.1. Nothing depends on a premium feature.

**R1E-1 Teams and memberships.** Keep the four teams: 1 `epic support`, 5 `technical support`,
6 `finance & billing`, 7 `escalations`. Team 7's membership (2) is the constraint on the escalation
model; after R1A it should be reviewed — a queue that only Eric and Phillip can serve is not a queue.

**R1E-2 Inbox memberships.** Inbox 46 target membership listed in R1A-3 (8 users). Inbox 47 stays at
Eric only — it is the internal Lane-2 test door, not a staffed inbox. Inbox 17 gets none (R1B).
Remember the `PATCH /inbox_members` full-list semantics warned about in R1A-3.

**R1E-3 Labels.** 23 exist with three competing conventions. Normalise to one — `snake_case`, prefixed by
domain: `intent_*`, `human_takeover`, `ai_handled`, `escalated`, `service_outage`, `needs_review`,
`new_customer`. ⚠ `human_takeover` is written by automation rule 3 and read by Foundation; renaming it is
a breaking change across two systems. **Do not rename it** — normalise the others around it, retire the
unused duplicates (`human-requested`, `human_owned`, `ai-uncertain`) only after confirming no automation,
macro or Foundation code path references them. Deleting a label removes it from every conversation that
carries it; that is not reversible by re-creating the label.

**R1E-4 Saved folders (`custom_filters`).** Zero exist. Highest config ROI in R1.
`POST /api/v1/accounts/5/custom_filters {name, type: "conversation", query: {…}}`.
Minimum set: `My open` · `Unassigned > 15m` · **`Escalated & unassigned`** (prerequisite of R1D) ·
`Team backlog` · `intent-billing` · `intent-support` · `intent-sales` · `awaiting-customer` ·
`service_outage`. Purely additive; rollback is `DELETE` of the created filter.

**R1E-5 Priorities.** Native `priority` (`urgent|high|medium|low|none`) via
`PATCH /conversations/{id} {priority}`. Free, unused, adopt. Note the same endpoint's `sla_policy_id`
parameter is Enterprise-only — do not send it.

**R1E-6 Canned responses.** 19 exist. Review for accuracy against current offers; no structural change.

**R1E-7 Macros.** Three exist; macro 3 `Escalate to Human` hard-codes `assign_agent 1` (Eric personally).
Replace with `assign_team 7` — or, better under D2, with nothing, leaving assignment to Foundation.
Add `Hand back to AI` and `Resolve — billing / technical / sales`. ⚠ A macro is **not** enforcement: CE
cannot require a field before resolve (`conversation_required_attributes` is premium and absent). A
"required" resolution field is a Foundation obligation — see §6.4 — and the macro is only its operator
affordance. Do not describe macros as enforcement in any acceptance text.

**R1E-8 Custom attributes.** 35 defined, 5 ever written. Two honest options: prune the 30 unwritten
definitions, or make Foundation actually write the correlation keys (`correlation_id`,
`clawith_session_id`, `foundation_customer_id`, `handoff_state`). The second is worth more —
`correlation_id` in particular is what makes cross-system audit possible without a Chatwoot audit log.
Recommend: keep and write the correlation set; prune the rest. Deleting a definition does not delete data
already written under that key, but re-creating a definition does not restore its UI history either —
capture the full definition list before pruning.

**R1E-9 Automation rules.** §4.4. No rules beyond 1 and 3 in R1.

**R1E-10 Working hours.** Inbox 47 has hours defined but disabled — either enable or clear, so the state
stops being ambiguous. Inbox 46 keeps its hours. Inbox 17 per R1B.

**R1E-11 Reports.** CE reports cover conversation volume, first response time, resolution time, agent,
team, label and inbox. That is the reporting baseline. It does **not** include SLA attainment or an audit
trail — §6.1 and §6.2 own those.

**R1E-12 CSAT — deliberately deferred (D6).** `csat_survey_enabled = false` on every inbox today; leave it.
Record the seven entry conditions as an explicit checklist so a later session does not read "disabled" as
an oversight: AI suppression proven · human escalation proven · human response proven · explicit handback
proven · queue staffed · survey wording approved · reporting owner assigned. Conditions 1–4 are R2 work.

**R1E-13 AgentBot attachment.** Unchanged in R1: bot 4 → inbox 46 (binding 15), bot 6 → inbox 47
(binding 18). Exactly one `agent_bot_inboxes` row per inbox — verify this invariant still holds
immediately before and after every R1 step that touches an inbox. No new binding in R1.

**R1E-14 External vs internal agent boundary.** Unchanged in R1 and enforced by Foundation, not Chatwoot.
PUBLIC agents may serve inbox 46; INTERNAL agents (Atlas, Scout) are reachable only through the future
Dashboard App panel or Foundation staff chat. Unclassified = INTERNAL, fail closed
(`dec-clawith-single-org-foundation-owns-agent-exposure-2026-07-31`).

**R1E-15 Captain (D7).** Remains unused. Premium and absent from the image, so there is nothing to
disable — this is a standing policy check: no Captain feature is enabled, and no second reasoning path
is created. Clawith remains the sole runtime.

**What CE does NOT provide, and must never be claimed:** native SLA enforcement · audit logs · custom
roles · required resolution attributes · capacity-based assignment. Two SLA policies exist on account 5
with `applied_slas = 0`; they are inert decoration and should be deleted or clearly labelled inert so no
future session mistakes them for an active clock.

---

### 4.6 R1F — credential-hardening prerequisite (D8)

**Current state.** `defect-chatwoot-platformapp-token-harvest-path-2026-07-25` (P0) is **Open and
completely unmitigated**. One `platform_apps` row (`1 — EPIC BFF`) holds 270
`platform_app_permissibles` — roughly 148 Account grants (most referencing accounts that no longer
exist), ~121 User grants, and **AgentBot 4**. One PlatformApp token can retrieve 130 user tokens and the
AgentBot 4 token. The owning packet `xp-chatwoot-credential-hardening` is **Blocked, RAG Red, 0%**.

**Target state.** The harvest capability is eliminated or reduced to approved least privilege; the old
PlatformApp credential is revoked after all legitimate consumers migrate; retirement is proven by
demonstrating the retired credential can no longer retrieve tokens.

**Why this is a gate and not a parallel task.** The Customer 360 backend must re-read conversations
server-side (design §6.1) — that means a new Chatwoot API consumer. Adding a consumer to a credential
surface with a live unmitigated harvest path increases the blast radius of the exact P0 that is open.
D8 sequences it correctly.

**Entry conditions for R1G** (all four, no partial credit):
1. `defect-chatwoot-platformapp-token-harvest-path-2026-07-25` is **Verified**, not Fixed-by-assertion.
2. A **narrow Application API identity** exists for the Customer 360 backend: a dedicated Chatwoot user
   or bot, member of **only** the inboxes it must read, holding an `api_access_token` — **not** the
   PlatformApp credential, and not a shared super-admin token.
3. That identity's token lives only in the Foundation runtime secret store. Never in Port, git, logs or
   chat.
4. A negative test proves the identity **cannot** read an inbox outside its membership.

R1F is not scheduled by this plan — it is owned by `xp-chatwoot-credential-hardening`, which is blocked
behind its own predecessor. R1A–R1E do not depend on it and may proceed.

---

### 4.7 R1G — Customer 360 entry gate

**Not started, not scheduled.** R1G is the R3 phase of the design roadmap and is listed here only so its
gate is unambiguous. It may begin when **all** of the following hold:

| # | Gate | Owner | Current state |
|---|---|---|---|
| 1 | R1A–R1E accepted | this packet | not started |
| 2 | R1F entry conditions 1–4 met (§4.6) | `xp-chatwoot-credential-hardening` | **Blocked, 0%** |
| 3 | R2 accepted — AI suppression gate, escalation write path, explicit handback, session lifecycle link | `xp-chatwoot-human-handoff-maximization-2026-07-30` | **In Progress, escalation write path absent for every result type** |
| 4 | Trust boundary implemented as specified: Foundation session authenticates the employee; `Membership.role` and tenant resolved server-side; only `conversation.id` + `account_id` taken from the frame; conversation re-read server-side; deny on mismatch | Foundation | not started |
| 5 | Negative test: a forged `conversation_id` from another account returns 403; an unauthenticated frame returns 401 | Foundation | not started |

Gate 3 is the substantive one. Per the 2026-08-02 contract audit recorded in that packet, the Lane-2
adapter drops `needsHandoff` in `toResultRecord()` and **has no human-escalation write path at all** —
no conversation assignment, no team assignment, no private note, for any result type. A Customer 360
panel showing "AI / human mode" with **Take over** and **Hand back** actions would be rendering a control
surface over a mechanism that does not yet exist. Build order matters here.

---

## 5. Rollback package (consolidated)

Every R1 mutation and its exact reversal. This table is the rollback contract.

| Step | Mutation | Reversal | Reversible? |
|---|---|---|---|
| R1A-2 path A | none (user self-confirms) | R1A-4 disable | n/a |
| R1A-2 path B | `DELETE` + `POST /agents` | re-add agent **and re-apply team + inbox membership** (they do not return) | yes, with manual membership restore |
| R1A-2 path C | rails-console confirm | clear `confirmed_at` for that user | yes |
| R1A-3 | `PATCH /inbox_members {inbox_id: 46, user_ids: [1,129,130,131,132,133,134,135]}` | re-issue with `[1,129,130,131,132,135]` | yes |
| R1A-4 | `DELETE /agents/{id}` | `POST /agents` + restore captured team/inbox membership | yes, with manual restore |
| R1B-2 | `toggle_status → resolved` ×9 | `toggle_status → open` ×9 | yes |
| R1B-3 opt 1 | remove widget script from site | re-add script | yes |
| R1B-3 opt 2 | `PUT /inboxes/17` flags | restore captured flags | yes |
| R1C-1 | `DELETE /webhooks/72`, `/73` | `POST /webhooks` with captured url + subscriptions — **new id, new secret** | function yes, identity no |
| R1C-2 | **held — no mutation** | n/a | n/a |
| R1D | `PUT /automation_rules/1` `active:false`; `PUT /automation_rules/3` scoped, `assign_team` removed | re-`PUT` both with the exact JSON in §4.4 | yes, fully |
| R1E-4 | `POST /custom_filters` | `DELETE /custom_filters/{id}` | yes |
| R1E-3 label deletion | `DELETE /labels/{id}` | **re-creating the label does not restore its assignment to past conversations** | **no** — treat as one-way |
| R1E-8 attribute pruning | `DELETE` definition | re-create definition; written data survives but UI history does not | partial |

**One-way steps: R1E-3 label deletion and R1B-3 option 3 (rejected).** Everything else in R1 is fully
reversible. No R1 step deletes a conversation, a message or a contact.

---

## 6. Foundation gap contracts — the minimum CE substitutes

D1 accepts CE, which makes these eight contracts obligations rather than options. Each states what CE
cannot do and what Foundation must own instead. These are specifications for later packets; no code is
written by this plan.

**6.1 SLA timer and breach ledger.** *CE gap:* `sla` is premium; the two policies on account 5 can never
apply. *Foundation owns:* a clock started on first inbound and on escalation; first-response, next-
response and resolution targets per policy; a persisted breach record with `(tenant, conversation,
policy, target, breached_at)`; business-hours awareness matching the inbox's own working hours. Breach
evidence lives in Foundation and is the only SLA evidence that may be cited (this is the re-authored C6
criterion).

**6.2 Governed action audit.** *CE gap:* `audit_logs` premium, `audits` table 0 rows. *Foundation owns:*
`AuditLog` as the sole record of governed actions, with actor (from the Foundation session, never from a
Chatwoot payload), tenant, conversation, action, parameters, outcome, operation reference and
correlation id. Every governed write returns both an operation reference and an audit reference. **No
acceptance criterion anywhere may cite a Chatwoot audit entry.**

**6.3 `Membership.role` authorization.** *CE gap:* two tiers only (`administrator`, `agent`);
`custom_roles` premium; `custom_role_id` null on every row. *Foundation owns:* `Membership.role` per
`role-model-manager-tenant-scoped-2026-07-14` as authoritative for every governed action, resolved
server-side from the Foundation session. Chatwoot `User.role` gates only Chatwoot's own settings screens
and is never an authorization input. Chatwoot team + inbox membership + saved folder express the finer
distinctions *operationally*; they are not a security boundary.

**6.4 Resolution form and required fields.** *CE gap:*
`conversation_required_attributes` premium. *Foundation owns:* a resolution action that validates the
required set (resolution label, resolution code, and per-domain fields) server-side and refuses to
resolve without them. The Chatwoot macro is the operator affordance; the Foundation action is the
enforcement. An operator can still resolve natively in Chatwoot and bypass the form — that residual gap
must be stated in acceptance, not hidden.

**6.5 Customer 360 Dashboard App trust boundary.** *CE gap:* none — Dashboard Apps are core. The gap is
that the `appContext` payload is browser-supplied and unsigned. *Foundation owns:* authenticate the
employee with its own session; resolve `Membership.role` and tenant server-side; take **only**
`conversation.id` and `account_id` from the frame; re-read the conversation server-side through a narrow
Application API identity; confirm the conversation's account/inbox resolve to the employee's tenant;
deny explicitly on mismatch. No panel accepts a `tenant_id`, `customer_id` or `odoo_partner_id` from the
browser.

**6.6 Internal-agent panel trust boundary.** *Foundation owns:* internal agent directory filtered to
`exposure = INTERNAL`, unclassified = INTERNAL (fail closed); Clawith session keyed by
`(tenant, employee, agent)` and **never** by customer phone; internal agents reach systems only through
Foundation governed actions and may *propose*, never *perform*, a customer-visible action; results
render in the panel with "Save as private note" as an explicit operator action.

**6.7 Human escalation assignment.** *CE gap:* after R1D no automation assigns an escalation — by design
(D2). *Foundation owns:* selecting team or operator; one atomic claim on
`(tenant, conversation, escalation episode)`; exactly one assignment, exactly one private context note,
at most one customer-facing handoff message; on assignment failure, keep AI suppressed and record a
truthful operational failure rather than telling the customer a human is engaged. Per
`dec-chatwoot-escalation-contract-inbox46-2026-07-29`.

**6.8 AI suppression and explicit handback.** *CE gap:* structural and confirmed (C7) — `AgentBotListener`
forwards every incoming message regardless of status or assignee. *Foundation owns:* suppression gated on
`status != 'pending'` **or** `assignee_type == 'User'`; explicit handback distinct from resolve (C8);
a Chatwoot↔Clawith session lifecycle link so resolve does not silently resume the AI against a stale
session; exactly-once resumption carrying the human outcome. Per
`dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29`.

---

## 7. Owner gates — consolidated

| Gate | Decision required | Blocking |
|---|---|---|
| **G1** | Accept the four-row employment verification result for Dezy, Hakeem, Kimberly, Joann (R1A-0). | R1A |
| **G2** | Authorise confirmation path B (destructive re-invite) or C (rails console), if path A fails. | R1A |
| **G3** | Choose the inbox-17 disposition: resolve-with-reason, or leave open. | R1B |
| **G4** | Choose the inbox-17 containment option: remove widget script (recommended) and/or out-of-office. | R1B |
| **G5** | **Re-decide D5 for webhook 74** on the corrected facts — inbox 38 took live traffic on 2026-08-04. | R1C-2 |
| **G6** | Confirm the `Escalated & unassigned` saved folder exists and Foundation's assignment step is verified, before rule 3 loses `assign_team 7`. | R1D |
| **G7** | Approve label deletions (one-way — removes the label from every conversation carrying it). | R1E-3 |
| **G8** | Confirm R1F entry conditions before any new Chatwoot API consumer is created. | R1G |

---

## 8. What this plan deliberately does not claim

- It does not claim Chatwoot CE provides SLA, audit logs, custom roles, required resolution attributes or
  capacity-based assignment. Each is assigned to Foundation in §6.
- It does not claim webhook 74 is safe to delete. F1 contradicts D5's premise for that one row.
- It does not claim the nine inbox-17 conversations can be triaged into responses. F2 says none can be
  answered by anyone.
- It does not claim SMTP is healthy. The check was blocked as a secret-dump and is recorded as
  **unverified** in R1A-1.
- It does not claim confirming five users restores a working console. Veronica is confirmed with zero
  sign-ins; Kimberly and Joann would log in to an empty workspace without R1A-3.
- It does not claim any R1 step is complete. Nothing here has been executed.
