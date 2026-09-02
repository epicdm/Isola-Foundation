# Isola Personal — current-state gap matrix

**Governing packet:** `xp-personal-line-cohort` (Port). Build tasks `personal-line-01-product-truth` · `-02-epic-assistant` · `-03-controlled-cohort` · `-04-wallet-ai-upgrade`. No competing execution packet exists or will be created.


**Status:** DISCOVERY OUTPUT. Read-only; no production mutation performed.
**Date:** 2026-08-12

Classification: **EXISTS** = code-verified in a repository · **LIVE** = additionally
verified against a running system by a dated probe · **PARTIAL** · **ABSENT** ·
**BROKEN** = exists and is wrong.

> **Repository code is not evidence of deployed behaviour.** Every EXISTS row below is a
> repository claim. Only rows marked LIVE carry a dated live probe, and the probe date is
> given. Several are months old.

---

## 1. Where the parts live

| System | Location | Branch / version at inspection |
|---|---|---|
| Foundation (consumer app + assistant + provisioning) | `epicdm/Isola-Foundation` → `artifacts/isola`; deployed on Replit | worktree `feat/isola-runtime-svc-2026-08-11` @ `186f607`. Trunk is `foundation/lane-reorientation-2026-07-31`, **not** `main` |
| BFF Lite (money, activation, callback, voicemail) | `/opt/bff-v2` on deepseek `66.118.37.12` | local checkout is `fix/chatwoot-strict-account-inbox-routing` @ `53fede7e` — **not** the deployed commit; real trunk is `fix/bffv2-retire-dashboard-reseller-campaigns-broadcast` |
| Isola portal (identity/signup, WS4 state machine) | `epicdm/isola-portal`, Apptension saas-boilerplate 5.0.0 | `isola/portal-5.0.0-snapshot`; runs on host03 as `isola-portal-{web,api,db,redis}` + staging |
| NocoBase control plane | host03 EasyPanel project `isola`, service `nocobase` | v2.0.48 |
| Activepieces | host03, service `activepieces`, project `HCNdJEYRAscCVKekNHmgM` | CE — **no per-project roles** |
| MagnusBilling / Asterisk | `voice00.epic.dm` = `157.245.83.64` | 5060 UDP/TCP, 5061 TCP (probed 2026-07-02) |
| Acrobits Cloud Softphone | cloudsoftphone.com, Cloud ID `EPIC.VOICE.LITE` | **not inspectable from this lane** |

---

## 2. The thirteen MVP capabilities

| # | Capability | State | Evidence | Gap |
|---|---|---|---|---|
| 1 | Signup + authentication | **PORTAL AUTHORITATIVE; Foundation realm transitional** | Foundation: `lib/consumer-session.ts`, `/api/consumer/auth/{request-otp,verify-otp,logout}`, `/consumer/{landing,login}`. Portal: Apptension SSO/users apps | D-1 DECIDED 2026-08-12: portal authoritative. Foundation realm is transitional compatibility infrastructure — see `ISOLA-PERSONAL-FOUNDATION-CONSUMER-REALM-TRANSITION.md` |
| 2 | Personal Line entitlement | **ABSENT** | No entitlement record; `provisionConsumerVoice()` gates only on `isMagnusConfigured()` and a ConsumerAccount existing | Entitlement must gate provisioning. NocoBase-owned |
| 3 | +1-767 number issuance | **EXISTS** | `magnus-voice.ts`: `drawAvailableDid`, `claimDid`, `createDidDestinationToSip`, `FORBIDDEN_DIDS`. BFF: `mintNextFreeDID`, `generateIsolaDID`, `provisionAndRoutePoolDid` | Pool size and draw policy are Eric-gated. Canonical 11-digit `17678XXXXXX` format rule must be honoured |
| 4 | Secure Acrobits activation | **BROKEN** | See `ACROBITS-PROVISIONING-AND-SECURITY-DESIGN.md` F-1, F-2 | Secret rendered to browser, QR and public HTML; no one-time consumption; OTP removed |
| 5 | Incoming calls | **LIVE (wrong client)** | Eric UAT 2026-06-17, `ep_qrtest01`, DID `17678189796`, **Groundwire** → Magnus@voice00; probe 4/4 | Never proven on **Cloud Softphone**. `bt-acrobits-readiness-probe` UNKNOWN(2) still open |
| 6 | Outgoing calls | **LIVE (wrong client)** | as above; plus web-800 callback path `lite-callback.ts` proven | as above |
| 7 | Push / background call | **ABSENT / UNKNOWN** | No push config visible anywhere in the estate; Acrobits-side | A-5. Cannot be designed without the Acrobits account |
| 8 | Balance | **EXISTS** | `/api/consumer/wallet/balance`; `toolGetBalance` reads Magnus live then caches to `balance_minor` | Needs a live re-probe |
| 9 | Call history / CDRs | **EXISTS** | `/api/consumer/voice/calls` → `engines/magnus.getCalls`; BFF `getMagnusUserCallsEnriched`, `hangupCauseLabel` | Missed-call classification not surfaced to the consumer assistant |
| 10 | Manual confirmed top-up | **PARTIAL / defect open** | `/api/consumer/wallet/topup/bff/{options,start}` → BFF → Fiserv (card) or NBD MoBanking. Session-gated; creds injected server-side | `bt-foundation-wallet-topup-502` **In Progress**: item 4 merged (PR #48), items 1–3 drafted, *not confirmed relayed* |
| 11 | Personal AI assistant | **EXISTS, narrower than the brief** | `lib/consumer-agent.ts`, `lib/consumer-agent-tools.ts`; 5 tools; trusted-account-id trust boundary is correct | Missing: missed-call ID, callback prep, activation help, rate explanation, reminders, support escalation |
| 12 | Human support escalation | **PARTIAL** | Chatwoot handoff exists platform-wide (`lib/chatwoot-handoff.ts`, escalation-claim/card/intent/ref) | **Not wired into the consumer assistant or the consumer app** |
| 13 | Suspension / revocation / reinstall recovery | **ABSENT** | Grep for suspend/revoke/reinstate across `artifacts/isola/lib` returns only `consumer-session.ts` and an unrelated test. `provisioning_state` has completed/pending/failed/retired — no suspend verb, no API, no UI | Whole capability. Also the compensation actions in `WS4-IDEMPOTENCY-AND-ROLLBACK-CONTRACTS.md` are specified but not implemented |

---

## 3. Control-plane gap — WS4 has no voice

`WS4-PROVISIONING-STATE-MACHINE.md` and the portal's
`packages/backend/apps/isola_provisioning/constants.py` define **six** steps:

```
company_profile → nocobase_tenant → paperclip_company → paperclip_employee
                → chatwoot_workspace → gateway_binding
```

Steps 2–6 are **HELD** pending the NocoBase gate. Step 1 is the only runnable one.

**None of the six is a voice step.** There is no `magnus_user`, no `sip_account`, no
`did_allocation`, no `acrobits_activation`. Confirmed independently: a GitHub code search
across `epicdm/isola-portal` returns **0 hits** for `magnus` and **0** for `acrobits`.

The journey is built for the AI-employee product, not for Personal Line. Personal Line
needs either additional steps in the same machine, or a parallel journey sharing the same
state-machine primitives. The primitives are good — the three invariants
(`SUCCEEDED` requires an `external_ref` from the target system; `BLOCKED` requires a
reason; explicit transition table, `SUCCEEDED` terminal) are exactly right for
provisioning that spans Magnus and Acrobits, and should be reused rather than reinvented.

Additionally: the NocoBase permission matrix is entirely **`UNRESOLVED`** — no collection
or field name has been inventoried, and no NocoBase credential is held by any engineering
lane. The role `isola-provisioner` must not be created from that document.

---

## 4. Cross-cutting risks

| Risk | State | Reference |
|---|---|---|
| Magnus admin credential acts across accounts | **Open.** Ownership-assertion slice written (`feat/magnus-assert-ownership` @ `29d9490e`, 15 tests, PM APPROVE-WITH-NITS) but **never pushed, merged or deployed** | `bt-magnus-assert-ownership-slice` (In Progress), `bt-magnus-tenant-isolation-mitigation` (Ready) |
| `callerid/save` has no ownership check — cross-account reassignment succeeds silently | Open | prior finding, still current |
| ISOLA_LITE plan 51 sells UK `44` and Pakistan `92` with **no reachable carrier** | Open | `MAGNUS-COVERAGE-GAPS.md` §2b |
| All Dominica termination on plan 51 is **single-trunk** per network | Open | ibid §3 |
| `failover_trunk` NULL on every trunk — a 503 dead-ends | Open | `MAGNUS-RATE-TRUNK-ASSESSMENT.md` §4 |
| VITELITY ASR ≈16% (12,447 attempts → 2,054 connected) | Open | ibid §1 |
| Two `tenant_id`-nullable auth realms share no code; XOR not enforced in schema | Standing | `CLAUDE.md` §5 |
| Foundation deploy is Replit **manual publish of workspace files**, not a git SHA | Standing | prior finding |
| Two live PM2 processes on deepseek absent from the resurrect snapshot | Open | `PLATFORM-CONSOLIDATION-MIGRATION-MATRIX.md` D-1 |
| host03 has **no SSH** for this lane — target plane not fully auditable | Open | ibid G-1 |
| EasyPanel: a clean `exit 0` strands a service until manual redeploy | Open | ibid §7 |

---

## 5. What must be built vs. reused

### Reuse — do not rebuild

- Magnus client and all telephony operations (`artifacts/isola/lib/magnus-voice.ts`,
  `/opt/bff-v2/app/lib/magnus.ts`)
- Consumer OTP auth realm and session (`lib/consumer-session.ts`)
- Consumer app shell and five screens
- The assistant trust boundary in `lib/consumer-agent-tools.ts`
- Wallet read + governed top-up proxy
- The one-time XML activation primitives `cloudsipUri()` / `consumeForXml()`
- The WS4 state-machine invariants and transition table
- The proven telephony recipes in `GOLDEN-TELEPHONY-ROUTINES.md` — DID canonical format,
  inbound `voip_call=0` forward, outbound web-800 callback, and the pre-test checklist

### Build — the real delta

| # | Item | Size |
|---|---|---|
| B-1 | Credential broker: remove `sip_password` from all read paths; single-use activation code; rotate-on-emission | M |
| B-2 | Branded activation page on `go.epiccomm.dm` + `InitialProvisioningUrl` endpoint | M — **gated on Acrobits unknown A-6** |
| B-3 | Personal Line entitlement record and the gate that reads it | M — gated on D-1 and NocoBase |
| B-4 | Voice steps in the provisioning journey (magnus_user, sip_account, did_allocation, activation) | M |
| B-5 | Suspend / revoke / reinstate: state, API, audit, operator UI | L |
| B-6 | Assistant extension: missed calls, callback-prep + confirm, activation help, rates, reminders, support escalation | L |
| B-7 | Support escalation wiring into the consumer surface | S |
| B-8 | Acrobits custom web tabs with ticket-exchange auth | M — gated on A-7 |
| B-9 | Two-user synthetic acceptance harness | M |
| B-10 | Land the Magnus ownership-assertion slice | S — code exists |
