# Foundation consumer realm — transitional compatibility infrastructure

**Governing packet:** `xp-personal-line-cohort` (Port). No competing execution packet.
**Authority:** owner ruling D-1, 2026-08-12.
**Status:** design + inventory. Nothing deprecated yet, nothing removed.

---

## 0. What was decided

The **Apptension/Isola Portal** (`epicdm/isola-portal`, host03 `isola-portal-*`) is
authoritative for customer identity, authentication, tenant membership, product
entitlement, and the customer-facing signup and account experience.

Foundation does **not** own a second independent consumer identity. Its existing consumer
realm is reclassified as **transitional compatibility infrastructure**: it keeps working,
it is not deleted abruptly, and it acquires an explicit exit.

This is a reclassification, not a rewrite. Nothing in this document authorises removing a
route, a table or a session mechanism today.

## 1. What the Foundation consumer realm actually is

Two auth realms exist in Foundation and **deliberately share no code**: `lib/session.ts`
(operator, Replit OIDC, carrying the `act_as_tenant_id` impersonation override) and
`lib/consumer-session.ts` (consumer OTP, HMAC cookie). Only the second is in scope here.

### 1.1 Identity and session

| Component | Path | Role |
|---|---|---|
| Consumer session | `lib/consumer-session.ts` | Issues/validates `consumer_sid`, an HMAC-signed cookie scoped `domain=.epic.dm` |
| OTP issuance | `lib/consumer-otp.ts`, `lib/consumer-whatsapp-otp.ts` | Phone-anchored one-time codes |
| Identity anchor | `lib/identity.ts` — `getOrCreateIdentityByPhone()` | Phase C: the **Identity** is the anchor, not `ConsumerAccount.id` |
| Routes | `/api/consumer/auth/{request-otp,verify-otp,logout}`, `/api/consumer/session` | Sign-in surface |
| Pages | `/consumer/{landing,login}` | Public signup/sign-in |

### 1.2 What depends on it

Everything below resolves the caller through `getConsumerSession()`. Each is a dependency
that must be re-pointed, proxied, or retired before the realm can go.

| Dependency | Path |
|---|---|
| Voice line read | `/api/consumer/voice/line` |
| Call history | `/api/consumer/voice/calls` |
| Call routing / forwarding | `/api/consumer/voice/{routing,forward}` |
| Click-to-call | `/api/consumer/voice/callback`, `.../call-state/[callId]` |
| Wallet balance / transactions | `/api/consumer/wallet/{balance,txns}` |
| Top-up | `/api/consumer/wallet/topup/bff/{options,start}` |
| Assistant | `/api/consumer/assistant/chat`, `lib/consumer-agent.ts`, `lib/consumer-agent-tools.ts` |
| Lead capture | `/api/consumer/lead`, `lib/consumer-lead.ts` |
| App shell | `/consumer/(app)/{page,call,assistant,wallet,settings,softphone}` |

Data: `ConsumerAccount`, `Identity`, `VoiceLine` (`owner_kind='consumer'`, anchored by
`identity_id`), `Wallet` (`consumer_account_id`), `WalletTxn`.

**Live scale, measured from the Magnus substrate 2026-08-12:** 9 `ema_`-prefixed consumer
SIP seats, 1 currently registered. This is small — which is what makes an orderly
transition realistic rather than aspirational.

### 1.3 The nullable-tenant hazard that transition must not worsen

Five `tenant_id String?` columns rely on an "exactly one of `tenant_id` /
`consumer_account_id`" XOR that **the schema does not enforce**. `api/voice/*` and
`api/wallet/*` each have an `api/consumer/*` twin — one per realm. Any mapping work that
writes across the two realms is operating exactly where that unenforced invariant lives.
The P0 credential defect existed in *both* twins for the same reason. Treat every
cross-realm write as a tenant-isolation review target.

## 2. Migration mapping — Foundation consumer → portal member

| Foundation concept | Portal concept | Mapping rule |
|---|---|---|
| `Identity` (phone-anchored) | Portal member identity | Phone number is the natural key. It is already Foundation's anchor, so this is the join column |
| `ConsumerAccount` | Portal member profile | One-to-one via `Identity` |
| — | Portal **tenant membership** | New. Foundation has no tenant for consumers; the portal must issue one |
| — | **Personal Line entitlement** | New, NocoBase-owned. Today nothing gates provisioning; the portal/NocoBase entitlement becomes the gate |
| `VoiceLine` (`owner_kind='consumer'`) | Voice seat | Stays in Foundation. Voice is not portal-owned; the portal owns *who is entitled to* a seat, not the seat's telephony state |
| `Wallet` / `WalletTxn` | — | Stays. Magnus remains balance authority; the portal does not become a billing system |
| `consumer_sid` cookie | Portal session + exchange ticket | See §3 |

**The dividing line:** the portal owns *who you are and what you are entitled to*.
Foundation owns *what your line and wallet are doing*. Magnus remains authoritative for
telephony throughout. Nothing here moves Magnus, and nothing creates a second billing or
provisioning authority.

## 3. Session-exchange boundary

The portal authenticates; Foundation surfaces must trust that without minting a second
independent identity, and without a durable bearer token ever sitting in a URL.

```
  Portal (authoritative)          Foundation                     Acrobits web tab
        │                              │                                │
   1.   │ member authenticated         │                                │
   2.   ├── POST /internal/exchange ──►│  verify portal assertion       │
        │   (short-lived, single-use,  │  resolve Identity by phone     │
        │    audience-bound ticket)    │  issue consumer_sid            │
   3.   │◄── session established ──────┤                                │
   4.   │                              │◄── tab opens with ticket ──────┤
   5.   │                              ├── exchange → Set-Cookie ──────►│
        │                              │   ticket now dead              │
```

Rules, each of which exists because of something already learned here:

1. **The ticket is single-use and short-lived** (≤60 s, one consumption). Anything
   longer-lived in a URL is a bearer token, which is the class of mistake the P0
   containment just removed.
2. **The ticket is not the session.** It is exchanged for `consumer_sid` via
   `Set-Cookie`; it never becomes a standing credential.
3. **Audience-bound.** A ticket minted for the Acrobits tab is not valid for the portal
   API, and vice versa.
4. **Foundation verifies, never trusts.** The assertion is signature-verified against the
   portal; a decoded-but-unverified claim is not authentication.
5. **Phone is the join key**, and the phone must come from the *verified* portal identity —
   never from a request parameter. This is the same discipline as the assistant's tool
   catalogue, where no tool input schema accepts an account id.
6. **No durable portal bearer token in the tab URL** — the explicit requirement. Acrobits
   substitutes account variables into web-tab URLs, and those URLs persist in app config
   and appear in logs.
7. **Both realms stay separate in code.** The exchange endpoint is a new, narrow surface;
   it does not merge `lib/session.ts` and `lib/consumer-session.ts`.

**Not yet built.** This is the design, and it is sequenced after the P0 containment and
after the Magnus ownership boundary lands.

## 4. Deprecation conditions

Foundation's independent consumer signup may be retired only when **all** hold:

| # | Condition |
|---|---|
| C-1 | Portal signup is live and creates a usable member identity |
| C-2 | Personal Line entitlement exists in NocoBase and gates provisioning |
| C-3 | Session exchange is implemented, tested, and proven for both the browser and the Acrobits tab |
| C-4 | Every dependency in §1.2 resolves its caller through an exchanged session |
| C-5 | All existing consumer identities are mapped to portal members, with a reconciliation report showing zero orphans in either direction |
| C-6 | Two-user isolation acceptance passes **against the portal identity** |
| C-7 | Suspension/revocation works through the portal→Foundation path |
| C-8 | A cohort member can complete signup → calling → assistant → support without touching Foundation's own login |

**Order of retirement**, once the conditions hold: (1) Foundation consumer *signup* is
closed to new registrations first — the smallest, most reversible step; (2) Foundation
consumer *login* is closed once every existing member can reach the portal; (3) the OTP
issuance path is retired; (4) `consumer-session.ts` becomes exchange-only.

**Data is never erased.** `ConsumerAccount` and `Identity` rows are retired, not removed —
the same rule as the WS4 compensation contract, where the provisioner holds no delete on
any collection.

## 5. Rollback

| Level | Trigger | Action |
|---|---|---|
| R-1 | Exchange failing for some members | Re-open Foundation consumer login; exchange and native login coexist — they are additive by design |
| R-2 | Mapping wrong for a member | Correct the mapping; Foundation rows were retired, not erased, so the prior state is recoverable |
| R-3 | Portal signup not fit for purpose | Re-open Foundation signup. Nothing has been removed at that point — only closed |
| R-4 | Exchange endpoint compromised | Revoke all outstanding tickets, disable the endpoint; existing sessions and existing calling are unaffected |

The property that makes all four cheap: **every step closes a path before removing it, and
removes nothing until the closure has held.** Foundation's consumer realm keeps working
throughout; that is the whole point of calling it transitional rather than deprecated.

## 6. What this does not authorise

- Deleting any Foundation consumer route, table or session mechanism today.
- Moving voice, wallet, CDR or rating authority. Magnus stays authoritative.
- Creating a second billing or provisioning authority.
- Touching the operator realm (`lib/session.ts`) or `act_as_tenant_id`.
- Any change to 6737, Meta, Chatwoot Compose, the PUBLIC Front Desk agent,
  `GATEWAY_BINDINGS_JSON`, production routing, gateway bindings, or the reboot programme.
