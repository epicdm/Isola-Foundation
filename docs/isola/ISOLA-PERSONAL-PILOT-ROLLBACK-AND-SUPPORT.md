# Isola Personal — pilot rollback and support plan

**Governing packet:** `xp-personal-line-cohort` (Port). Build tasks `personal-line-01-product-truth` · `-02-epic-assistant` · `-03-controlled-cohort` · `-04-wallet-ai-upgrade`. No competing execution packet exists or will be created.


**Status:** DISCOVERY OUTPUT. Not exercised.
**Date:** 2026-08-12
**Applies to:** the EPIC-managed controlled cohort (`personal-line-03-controlled-cohort`).

---

## 1. Blast radius

The pilot touches shared production substrate. Name it before starting.

| Shared thing | Who else depends on it | Containment |
|---|---|---|
| MagnusBilling / Asterisk @ `voice00.epic.dm` | Every EPIC voice customer, EMA, Isola Lite | New Magnus users + SIP accounts only. **No trunk, group, plan or rate change** during the pilot. Reload never restart |
| DID pool | All future draws | Only DIDs explicitly authorised per draw. Protected numbers are never candidates |
| Foundation deployment (Replit) | test.epic.dm + isola.epic.dm + isola-foundation.replit.app are **one deployment** | Any Personal Line change ships to all three at once. There is no per-domain rollout |
| BFF Lite `/opt/bff-v2` | Live customer surface | Deploys go through the single deploy owner; never hot-swap branches on the live checkout |
| Chatwoot (host03 `chat`, account 2) | Sales & Front Desk, staff | Support escalation must not create a second authoritative processor for any number |
| Wallet / Fiserv | Existing consumer wallets | Smallest amounts; no automated charge |

**Out of the blast radius, and must stay out:** 6737 · the Meta credential and webhook ·
the Chatwoot Compose migration · the PUBLIC Sales & Front Desk agent ·
`GATEWAY_BINDINGS_JSON` · production SIP routes and existing customer numbers · the
host03 reboot programme.

## 2. Pre-flight — capture before the first member is enrolled

| # | Snapshot | How |
|---|---|---|
| S-1 | Magnus: the exact set of users, SIP accounts, DIDs and destinations **before** the pilot | Read and file; this is the diff baseline |
| S-2 | The DID pool inventory and free count | `countAvailablePoolDIDs` |
| S-3 | Foundation deployed state — the workspace files actually published, not a branch name | Replit publishes files, not a SHA. Record the workspace HEAD *and* note the discrepancy if any |
| S-4 | BFF deployed commit, read from the serving process's exec cwd | Not from GitHub's default branch |
| S-5 | Plan-51 rate card as published | So a rate correction is reversible |
| S-6 | Chatwoot account-2 inbox and team configuration | Before any support routing is added |

Rollback is only as good as S-1. Take it.

## 3. Rollback ladder

Escalating, cheapest first. Each level is independently executable.

| Level | Trigger | Action | Reversible? |
|---|---|---|---|
| **R-0** | A single member has a bad experience | Support handles in-conversation. No system change | n/a |
| **R-1** | One member's line is misbehaving | Suspend that member's line. Service stops; state is retired, not erased | Yes — reinstate |
| **R-2** | Activation is leaking or failing | Revoke all unconsumed activation codes; disable the activation endpoint. Existing registered devices keep working | Yes |
| **R-3** | A credential is suspected exposed | Rotate the affected SIP secrets via `enforceSipSecret()`. Affected devices stop registering and must re-activate | Yes, at the cost of a re-activation for each member |
| **R-4** | The pilot is not working | Suspend the whole cohort: every line suspended, no new enrolment | Yes |
| **R-5** | Pilot cancelled | Retire the cohort: liberate DIDs back to the pool, retire SIP accounts and Magnus users, zero and close wallets. **Retire records; never erase them** | Partially — DIDs may not be re-obtainable |
| **R-6** | A code change caused it | Revert the change on its own branch and redeploy. Foundation: republish. BFF: through the deploy owner | Yes |

**R-1 through R-5 all depend on a suspension model that does not exist yet.** Until
capability 13 is built, the only available rollback below R-5 is manual Magnus
intervention — which the operating rules classify as emergency containment, not the
operating model. **Building suspension is therefore a pilot precondition, not a
follow-up.**

## 4. Stop conditions — halt the pilot and ask the owner

- Any member can see, read or act on another member's data.
- A SIP credential is found in a browser response, a URL, or a log.
- A call is charged that the member did not confirm.
- Money moves without a human click.
- A protected number is touched.
- Magnus routing, rating or trunk configuration changes as a side effect of the pilot.
- A second authoritative processor appears for any number.
- The assistant states a capability EPIC does not have.
- A production or customer-data change is discovered that cannot be reversed.

## 5. Support model

### Tier 0 — the assistant

Own-account scoped. Handles: what is my number, what is my balance, what did that call
cost, why did I miss a call, how do I set up the app, what does this destination cost,
how do I top up. **Every one of these must degrade honestly** — if a tool fails, say so;
never fabricate a balance or a rate.

### Tier 1 — human escalation via Chatwoot

The escalation contract already exists platform-wide (`lib/chatwoot-handoff.ts`,
escalation claim/card/intent/ref). It is **not wired into the consumer assistant** — that
is build item B-7.

Rules that carry over unchanged:

- Human takeover is a **governed escalation contract**, not a second webhook.
- One authoritative processor per number, always.
- A bot cannot list messages; reconcile via `conversations#show`.
- `source_id` is not unique — do not key on it.

### Tier 2 — engineering

For: registration failures, call-quality and routing faults, CDR or balance discrepancy,
activation faults, suspected exposure. Every Tier-2 event opens a Port `defect` or
`incident` with the symptom string, the exact number/ID, and the evidence — **search Port
for the symptom before investigating**, because this programme has repeatedly
re-investigated documented failure classes.

### Tier 3 — owner

Price, legal terms, material scope · Meta assets · real payment · broad launch · merging
to a protected branch · any Acrobits commercial change.

## 6. Support runbook seeds

| Symptom | First check | Known trap |
|---|---|---|
| "The app won't connect" | Registrar-side proof on voice00 — not the app's own status banner | An app success banner is not evidence |
| "Nobody can call me" | DID is canonical 11-digit, `activated=1`, no duplicate row under another user; `pkg_did_destination` present | The 9782 bug: a 10-digit record with the 11-digit on a different user |
| "My calls don't connect" | Place the call yourself first and read the SIP response — 200, not 503/486 | Route resolving proves nothing; the trunk must terminate |
| "The app doesn't ring when closed" | Push configuration | Acrobits-side; not fixable from Isola |
| "My balance is wrong" | The real CDR (`terminatecauseid`, `calledstation`), not the web-800 queue receipt | The queue receipt is not a call outcome |
| "I reinstalled and lost my line" | Issue a **new** activation code; the secret rotates | Never re-read and re-display the old secret |
| "I was charged and didn't approve it" | Immediate stop condition. Freeze, evidence, owner | — |

## 7. Communications

- Cohort members are told, in writing and up front: this is a managed pilot; specific
  destinations are unavailable; AI+ call answering is **not** included and is waitlist;
  service may be paused with notice.
- No claim ships without a Port `capability` whose `truth_status` is evidence-backed.
- If a member is affected by a rollback, they are told what happened, what it means for
  them, and what happens next — before they notice it themselves.
