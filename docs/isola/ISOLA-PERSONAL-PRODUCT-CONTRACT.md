# Isola Personal — product contract v1

**Governing packet:** `xp-personal-line-cohort` (Port). Build tasks `personal-line-01-product-truth` · `-02-epic-assistant` · `-03-controlled-cohort` · `-04-wallet-ai-upgrade`. No competing execution packet exists or will be created.


**Status:** DISCOVERY OUTPUT. Not ratified. No production mutation was performed to produce it.
**Date:** 2026-08-12
**Port authority:** project `isola-personal-line-ai`; packet `xp-personal-line-cohort`; build tasks
`personal-line-01-product-truth` … `personal-line-04-wallet-ai-upgrade`.

> **Packet — RESOLVED 2026-08-12.** The originally-named
> `xp-isola-signup-to-calling-v1-2026-08-11` does not exist in Port and **will not
> be created**. Owner ruling: this lane uses and updates the existing
> `xp-personal-line-cohort` and the four established `personal-line-*` build
> tasks. No competing execution packet.

---

## 1. The offer, in one line

**Isola Personal — your 767 number, calling and a personal AI assistant in one app.**

An individual signs up, is entitled to a Personal Line, receives an EPIC-issued
`+1-767` number, activates a branded SIP endpoint on their phone, makes and takes
calls billed against a prepaid wallet, and can ask an own-account-scoped assistant
about their number, plan, balance, calls and rates.

Acrobits Cloud Softphone is **only the endpoint**. It owns no customer, tenant,
number, balance, rate, route or CDR.

## 2. Authority map for this lane

| Concern | Authority | Never |
|---|---|---|
| Customer identity, authentication, tenant membership, product entitlement, customer-facing signup and account experience | **Isola portal (Apptension, `epicdm/isola-portal`) — authoritative.** Ruled 2026-08-12 | Foundation owning a second independent consumer identity |
| Entitlement, provisioning lifecycle, external mappings | NocoBase (host03 `nocobase`) | Foundation inventing a second control plane |
| Provisioning orchestration | Activepieces (host03 `activepieces`, project `HCNdJEYRAscCVKekNHmgM`) | Ad-hoc scripts writing to Magnus |
| Extensions, SIP credentials, DIDs, routing, rates, balance, CDRs | MagnusBilling/Asterisk @ `voice00.epic.dm` (157.245.83.64) | Rebuilding rating or CDR in Isola |
| Branded SIP endpoint, push, embedded assistant surface | Acrobits Cloud Softphone (Cloud ID `EPIC.VOICE.LITE`) | Treating the app as system of record |
| Personal assistant and approved tools | Isola runtime / Foundation | Assistant reaching EPIC staff systems |
| Wallet funding, confirmed top-ups | EPIC payment service (Fiserv card / NBD MoBanking, via BFF) | Auto-charge without explicit confirmation |
| Evidence, decisions, defects, acceptance | Port.io | Declaring done on a green build |

**One SIP endpoint per voice-entitled member.** A portal account alone does not
provision an extension. Entitlement is the gate.

## 3. MVP boundary — the thirteen

| # | Capability | Current state | Owner system |
|---|---|---|---|
| 1 | Customer signup and authentication | **Exists twice** — portal (Django/Apptension) and Foundation consumer OTP realm | see §9 D-1 |
| 2 | Personal Line entitlement | **Absent** — no entitlement record gates provisioning today | NocoBase |
| 3 | EPIC-issued +1-767 number | Exists — `drawAvailableDid` / `claimDid` (Foundation), `mintNextFreeDID` (BFF) | Magnus |
| 4 | Secure Acrobits activation | **Exists but insecure** — see `ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md` | Foundation |
| 5 | Incoming calls | Proven 2026-06-17 (Groundwire) — **not proven on Cloud Softphone** | Magnus |
| 6 | Outgoing calls | Proven 2026-06-17 (Groundwire) — **not proven on Cloud Softphone** | Magnus |
| 7 | Push / background-call proof | **Unproven.** Push config is Acrobits-side and uninspected | Acrobits |
| 8 | Balance | Exists — `/api/consumer/wallet/balance` reads Magnus live, falls back to ledger | Magnus |
| 9 | Call history / CDRs | Exists — `/api/consumer/voice/calls` → Magnus `getCalls` | Magnus |
| 10 | Manual, explicitly confirmed top-up | Exists, **defect open** (`bt-foundation-wallet-topup-502`, In Progress) | EPIC payment service |
| 11 | Personal AI Assistant | Exists, own-account-scoped, 5 governed tools | Foundation |
| 12 | Human support escalation | Exists as a platform capability (Chatwoot handoff); **not wired into the consumer assistant** | Chatwoot |
| 13 | Suspension, revocation, reinstall recovery | **Absent** — no suspend verb, no revoke, no re-activation path | NocoBase + Magnus |

Verified-vs-assisted-vs-future classification is required by
`personal-line-01-product-truth`. Rows marked *Exists* above are code-verified only.
**Code is not evidence of deployed behaviour** — each must be re-proved on the live
substrate before it appears in customer-facing copy.

## 4. Personal Assistant — the allowed set

Own-account scoped. `lib/consumer-agent-tools.ts` already enforces the correct trust
shape: every tool takes a **trusted** `consumerAccountId` supplied by the chat route
from `getConsumerSession()`. **No tool input schema contains an account id**, so the
model cannot name or influence which account it acts on. Keep that property.

| Brief requires | Today | Delta |
|---|---|---|
| Explain number, plan, balance | `toolGetBalance`, `toolGetLineStatus` | Add plan/rate-plan read |
| Own recent call history | `toolGetRecentCalls` (cap 20) | none |
| Identify missed calls from authorised CDR | partial — CDRs returned raw | Add missed-call classification (reuse `getMissedCallsForDID`, `hangupCauseLabel`) |
| Prepare a callback for explicit confirmation | **absent** | New: propose-only tool + confirm step; execution via the proven web-800 callback |
| Help activate / troubleshoot the softphone | **absent** | New: read-only activation-state tool; must not return credentials |
| Explain rates before a call | **absent** | New: rate-lookup tool. Blocked on rate-truth — see §7 |
| Prepare a top-up for explicit confirmation | `toolInitiateTopup` — validates, audits, returns a **navigation action**; never moves money | none |
| Create reminders and personal follow-up tasks | **absent** | New |
| Escalate to EPIC support | **absent in the consumer assistant** | Wire to the existing Chatwoot handoff contract |

**Must not** — and each needs a test, not a prompt instruction:

- access another customer's data → enforced structurally today; keep, and add a
  two-account negative test;
- reveal SIP credentials → **currently violable**: the underlying route
  `/api/consumer/voice/line` returns `sip_password`. Remediate before the assistant
  is given any line-status surface a model can quote;
- place chargeable calls without confirmation;
- complete a top-up or charge automatically → held today by construction;
- **change routing, DIDs or account ownership** → **conflict**: the existing
  `set_call_forwarding` tool performs a real Magnus routing write. Either the brief's
  prohibition is narrowed to *DID/ownership* and forwarding stays (recommended — it is
  reversible, audited and user-owned), or the tool is withdrawn. **Owner decision.**
- act as an unrestricted agent creator;
- access EPIC staff systems;
- answer live calls as an AI receptionist → separate gated capability. Note
  `bt-fix-ema-voice-ai-fabrication-2026-07-18` (Ready, P0) exists precisely because
  this capability was previously overstated. Present AI+ as waitlist, honestly.

## 5. Customer experience — phone-first structure

```
┌──────────┬───────────┬─────────┬─────────┬──────────────────┐
│  Phone   │ Assistant │ Recents │ Balance │ Account/Support  │
└──────────┴───────────┴─────────┴─────────┴──────────────────┘
```

Today's Foundation consumer shell is `app/consumer/(app)/` with
`page` · `call` · `assistant` · `wallet` · `settings` · `softphone` — a close but not
identical five. Mapping:

| Tab | Surface | Today |
|---|---|---|
| Phone | native Acrobits dialer | app-side; nothing to build |
| Assistant | Acrobits **custom web tab** → authenticated Isola assistant | `consumer/(app)/assistant` exists as a web page |
| Recents | native Acrobits recents, plus Isola CDR view | `consumer/(app)/call` |
| Balance | web tab → `/wallet` | `consumer/(app)/wallet` exists |
| Account/Support | web tab → settings + escalation | `consumer/(app)/settings` exists; escalation absent |

**Custom web tab authentication — the rule.** Do not put a durable portal bearer token
in the tab URL. Acrobits substitutes account variables into web-tab URLs and those URLs
are persisted in app config and appear in logs. The pattern that satisfies both sides:

1. tab URL carries only a **non-secret account handle** (the SIP username) plus a
   short-lived, single-use `tab_ticket` minted per launch;
2. the Isola endpoint exchanges the ticket for a normal consumer session cookie
   (`consumer_sid`, already `domain=.epic.dm`, HMAC-signed — `lib/consumer-session.ts`);
3. thereafter the tab is an ordinary authenticated browser session, and the ticket is
   dead.

`softphone` disappears as a customer-facing tab: activation becomes a one-time flow,
not a standing screen that displays credentials.

## 6. Activation flow (contract summary)

The agreed secure pattern, restated as the contract. Full design, including what is
wrong today, is in `ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md`.

1. Portal/app calls a backend activation endpoint (authenticated, entitlement-checked).
2. Backend returns a short-lived, one-use branded HTTPS URL
   `https://go.epiccomm.dm/s/{opaque-code}`.
3. The branded page validates expiry **and** one-time use.
4. It launches the Acrobits handoff with a visible fallback.
5. Acrobits calls the controlled `InitialProvisioningUrl`.
6. The backend resolves the authorised Voice seat and returns SIP configuration.
7. SIP credentials are generated or retrieved server-side and **never** rendered in the
   portal, the URL, logs or any browser response.

Magnus/Asterisk remains authoritative for telephony throughout.

## 7. Commercial truth that gates customer-facing copy

- **ISOLA_LITE (Magnus plan 51) sells UK `44` and Pakistan `92` with `NO_BUYRATE`** —
  no reachable termination. `MAGNUS-COVERAGE-GAPS.md` §2b. An assistant that "explains
  rates before a call" would quote a rate for a destination that cannot connect.
- All Dominica traffic on plan 51 is **single-trunk per network** (groups 7/8/9,
  provider 6). One SIP registration drop takes out Dominica calling.
- `failover_trunk` is NULL on every trunk; a 503 dead-ends rather than rolling on.
- Price for the Personal Line is **unresolved** —
  `personal-line-01-product-truth` explicitly requires reconciling a price conflict
  before customer-facing publication.

Rate/plan truth must be settled before capability 9 (rate explanation) or any published
price. This is an owner decision plus a Magnus rating-layer fix, not an app change.

## 8. Out of this lane

Phone 6737 · the Meta credential and webhook · the Chatwoot Compose migration · the
PUBLIC Sales & Front Desk agent · `GATEWAY_BINDINGS_JSON` · production SIP routes and
existing customer numbers · the host03 reboot programme.

Protected numbers, never drawn or repurposed: 3742 · 9043 · 6737 · 0001 · 9525 ·
17678183742 · 17678180001 · 17678188326 · 17678180000 (live public demo line).

No unrestricted public signup. First release is an EPIC-managed controlled cohort
(`personal-line-03-controlled-cohort`).

## 9. Decisions this document cannot make

| # | Decision | State |
|---|---|---|
| D-1 | Which surface owns consumer identity and signup | **DECIDED 2026-08-12 — the Apptension portal is authoritative** for identity, authentication, tenant membership, entitlement and the customer-facing signup/account experience. Foundation's consumer realm is reclassified as **transitional compatibility infrastructure**: not deleted abruptly, and governed by `ISOLA-PERSONAL-FOUNDATION-CONSUMER-REALM-TRANSITION.md`. |
| D-5 | Packet identity | **DECIDED 2026-08-12** — use `xp-personal-line-cohort`; create no competing packet. |
| D-2 | Price and plan for the Personal Line | Open. Owner-only, and blocked on Acrobits per-user charge (C-2) and real carrier rates. |
| D-3 | Whether the assistant may change call forwarding | Open. Product scope vs. the routing prohibition. |
| D-4 | Branded Acrobits app vs. generic Cloud Softphone for the pilot | Open. Commercial — cost, store submission, timeline. |

---

*Companion documents:* `ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md` ·
`SIGNUP-TO-CALLING-V1-ACCEPTANCE.md` · `ISOLA-PERSONAL-CURRENT-STATE-GAP-MATRIX.md` ·
`ISOLA-PERSONAL-COMMERCIAL-READINESS.md` · `ISOLA-PERSONAL-PILOT-ROLLBACK-AND-SUPPORT.md`
