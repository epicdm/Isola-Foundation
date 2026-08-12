# Isola Personal — commercial readiness check

**Governing packet:** `xp-personal-line-cohort` (Port). Build tasks `personal-line-01-product-truth` · `-02-epic-assistant` · `-03-controlled-cohort` · `-04-wallet-ai-upgrade`. No competing execution packet exists or will be created.


**Status:** DISCOVERY OUTPUT. Every cost marked **VERIFY** is unverified by this lane.
**Date:** 2026-08-12

---

## 1. Acrobits — costs that must be verified before any pilot commitment

This lane holds **no Acrobits credential**. The Cloud Softphone provisioning portal is
visible only to the account owner (Port `r01-acrobits-evidence`). Everything below is
therefore a question, not a finding.

| # | Item | What we know | VERIFY |
|---|---|---|---|
| C-1 | Cloud Softphone account tier and contract | Cloud ID `EPIC.VOICE.LITE` exists and points at `voice.epic.dm` | Plan name, term, renewal date, notice period |
| C-2 | **Per-user / per-seat charge** | Unknown | The exact per-active-user monthly charge and how "active" is counted. **This is the single number that decides unit economics.** |
| C-3 | Minimum commitment | Unknown | Minimum seats or minimum monthly spend |
| C-4 | Branded (white-label) app | Never built; recorded as a fast-follow | One-off build fee, annual maintenance, store-submission handling, per-platform cost |
| C-5 | Push notification service | Unknown whether configured | Whether push is included or metered; APNs/FCM cert ownership and expiry |
| C-6 | Custom web tabs | Unknown whether enabled on this bundle | Whether the feature requires a higher tier |
| C-7 | Feature bundle | Unknown | Which features are enabled today vs. paid add-ons |
| C-8 | Overage / burst behaviour | Unknown | What happens when the cohort exceeds the seat count mid-month |

> Until C-2 is known, **no price for Isola Personal can be set**, because the endpoint
> cost per member is unknown. `personal-line-01-product-truth` already requires
> reconciling a price conflict; C-2 is a precondition for that reconciliation, not a
> detail of it.

## 2. Telephony cost and route health

Verified from `MAGNUS-COVERAGE-GAPS.md` (2026-06-20) and
`MAGNUS-RATE-TRUNK-ASSESSMENT.md` (2026-06-21). These are dated; re-verify before
publishing rates.

| Finding | Commercial consequence |
|---|---|
| ISOLA_LITE (plan 51) sells UK `44` and Pakistan `92` with **`NO_BUYRATE`** — no provider in group 36 can terminate them | The product markets destinations it cannot deliver. A published rate card containing them is a false claim |
| All Dominica termination on plan 51 is **single-trunk** per network (groups 7/8/9, provider 6 EPIC_Wholesale) | One SIP registration drop removes Dominica calling for every member. No redundancy to sell against |
| `failover_trunk` is **NULL on every trunk**; the LCR did not roll past a 503 | A carrier fault becomes a customer-visible outage rather than a slower connect |
| VITELITY ASR ≈ **16%** (12,447 attempts → 2,054 connected) | If VITELITY is on any Personal Line route, support cost and churn follow |
| Starter grant is hard-coded `STARTER_FREE_EC = 2.05` = 15 min at EC$0.135/min (plan 34 EMA_Basic, prefix 1767) | The free-minutes promise is tied to a rate on a *different* plan than 51. Reconcile before publishing "15 free minutes" |

**Rate truth is a launch gate, not a nice-to-have.** The assistant capability *"explain
rates before a call"* cannot ship honestly while a sold prefix has no reachable carrier.

## 3. Payments

| Item | State |
|---|---|
| Card | Fiserv, via BFF Lite `topup/start`. Foundation proxies; BFF owns the money movement |
| Bank transfer | NBD MoBanking QR + auto-credit via the BFF's own email loop |
| Confirmation model | Correct by construction — the assistant's `initiate_topup` validates, audits and returns a **navigation action**; the human completes on the governed page |
| Open defect | `bt-foundation-wallet-topup-502` — **In Progress**. Item 4 merged (PR #48, provisioning_state gate hardening + 8 tests). Items 1–3 drafted, **not confirmed relayed** |
| Related | `bt-isola-wallet-raw-card-route-remediation` (Ready, P1) — raw-card route to be removed. `bt-isola-wallet-hosted-payment-boundary` (Backlog) |
| Gap | Return-URL behaviour after a live top-up previously landed on the wrong host; fix is Foundation-side, but whether the Fiserv page honours `returnUrl` is outside Foundation's control |

**No automatic charge** is a stated acceptance requirement and is currently satisfied by
design. Preserve it — it is also the cheapest control against a runaway-AI class of
incident.

## 4. Cost of the cohort itself

| Line | Basis | Note |
|---|---|---|
| Acrobits seats × cohort size | **VERIFY C-2** | Dominant per-member cost |
| DIDs × cohort size | Magnus pool; monthly DID rental | Pool size and draw are Eric-gated |
| Termination minutes | Per the plan-51 rate card | Subject to §2 |
| Starter grant | EC$2.05 per member, one-time, idempotent | `STARTER_GRANT_TXN_TYPE` guarantees once per identity lifetime |
| AI assistant inference | Per-message model cost | Metering exists as a *backlog* item — `bt-replit-09-ai-wallet-metering` is **Blocked**, P0 |
| Support effort | `personal-line-03-controlled-cohort` explicitly requires recording **operating effort** before broad access | The point of the cohort |

**`bt-replit-09-ai-wallet-metering` being Blocked matters commercially**: without metering
and spend limits, the included assistant has an uncapped marginal cost per member. That is
tolerable for a small managed cohort and not tolerable at open signup.
`personal-line-04-wallet-ai-upgrade` (Backlog) is where metering, spend limits,
low-balance behaviour, consent and audit are specified — it is correctly sequenced after
the MVP, but it gates *scale*, not the pilot.

## 5. What is safe to say to a customer today

| Claim | Safe? |
|---|---|
| "Your own +1-767 number" | Yes, once the line is provisioned and verified |
| "Make and receive calls from the app" | **Not yet** — proven on Groundwire, unproven on Cloud Softphone |
| "Calls ring your phone even when the app is closed" | **No** — push is unverified |
| "See your balance and call history" | Yes |
| "Top up by card or bank transfer" | Yes, with the open defect disclosed |
| "An assistant that knows your account" | Yes, within the current five tools |
| "The assistant can answer your calls for you" | **No** — explicitly gated. Say waitlist |
| "Call the UK / Pakistan" | **No** — no reachable carrier on plan 51 |
| Any specific price | **No** — unresolved, and blocked on C-2 |

Marketing claims are Port-governed (`marketing_claim` blueprint, with a
`capability_truth_status` mirror). Publish nothing that is not backed by a `capability`
with `truth_status` set from evidence.

## 6. Owner / Acrobits authorisation required

| # | Action | Who |
|---|---|---|
| O-1 | Provide the Acrobits account inventory (C-1…C-8) or delegated read access | Owner |
| O-2 | Confirm whether `InitialProvisioningUrl` is configurable on this account | Owner / Acrobits |
| O-3 | Decide branded app vs. generic Cloud Softphone for the pilot | Owner |
| O-4 | Configure push, or accept that background-call proof is BLOCKED | Owner / Acrobits |
| O-5 | Authorise two pool DID draws for the synthetic slice | Owner |
| O-6 | Set the Personal Line price, after C-2 | Owner |
| ~~O-7~~ | ~~Decide the identity surface~~ **DECIDED 2026-08-12: portal authoritative** | — |
| O-8 | Approve the NocoBase permission matrix and complete the security sequence before any key is minted | Owner |
| O-9 | Authorise the rate-card correction on Magnus plan 51 | Owner |
