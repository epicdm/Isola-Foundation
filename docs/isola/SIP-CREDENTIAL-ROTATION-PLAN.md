# SIP credential rotation plan — ready for authorization

**Governing packet:** `xp-personal-line-cohort` · defect `defect-sip-credential-browser-exposure-2026-08-12`
**Date:** 2026-08-12
**Status:** PLAN ONLY. No credential has been rotated, read, printed, exported or hashed.

> **Why rotation is required, not optional.** Historical exposure cannot be disproven.
> nginx logs query strings, and log retention begins 29 Jul 2026 — *after* the last
> activation on 14 Jul. Absence of matches in the retained window is not evidence of
> absence before it.

---

## 0. Correction to a figure I reported earlier

I previously reported **3 registered devices**. That count was taken by scanning the
`ema_` / `ep_` / `lt_` prefixes. **It missed `Donald_17678181502`** — a live Lite account
whose Magnus alias follows none of those three conventions, and which **is registered and
has recent call activity**.

Corrected: **4 registered devices** across the exposure-relevant space — 2 in the sets
below, plus 2 `ep_` business accounts outside them. The lesson is recorded because it
generalises: prefix conventions are not a reliable enumeration key on this Magnus
instance, so every count below is taken from the account roster itself.

## 1. Redaction scheme

Full SIP usernames and DIDs are not reproduced. Each account has a stable alias
`R-NN`, plus its account class and the last four digits of its DID — enough for an
operator to locate the row in the Magnus grid without this document being a target.
**No password value, and no hash of one, appears anywhere.** The `R-NN` → account map is
held in the Magnus roster and can be produced to the owner on request.

## 2. Exposure sets, and what is enumerable

| Set | Path | Enumerable here? |
|---|---|---|
| **S1** | Foundation consumer — `/api/consumer/voice/line` + softphone page. Secret returned on **every page view** | **Yes** — 9 accounts |
| **S2** | Foundation operator — `/api/voice/line` + owner page. Same defect, business tenants | **NO — see §5** |
| **S3** | bff-v2 `/go/{code}` — accounts that had a `csc:` activation link minted | **Yes** — 11 references, 7 resolvable |

**Deduplicated, confirmed unique accounts: 15.** Plus **4 unresolved orphan references**
(§4). "Up to 20" was the un-deduplicated upper bound and is superseded by this.

## 3. The inventory

Registration from Magnus `sip show peers`; CDR activity from `mbilling.pkg_cdr`;
activation history from `AgentActivity` (`type='lite_activation'`).

### Class A — currently registered or recently used (2)

| Alias | Class | DID | Registered | Last CDR | CDRs | Activations | Expected interruption | Reactivation |
|---|---|---|---|---|---|---|---|---|
| R-01 | Lite (legacy alias) | …1502 | **YES** | 2026-07-13 | 10 | 4 | Calls stop until re-provisioned | **None available** — assisted only |
| R-02 | Foundation consumer | …2212 | **YES** | 2026-07-12 | 2 | 0 | Calls stop until re-provisioned | **None available** — assisted only |

> R-02 is the account previously recorded as `completed/ok` and hash-matching under
> `bt-foundation-wallet-topup-502`. It is the one genuinely live Foundation consumer line.

### Class B — not registered, but with real call history (4)

| Alias | Class | DID | Last CDR | CDRs | Activations | Notes |
|---|---|---|---|---|---|---|
| R-03 | Lite | …5035 | 2026-07-09 | 7 | 4 | Most-activated Lite account |
| R-04 | Lite | …5029 | 2026-07-06 | 2 | 1 | |
| R-05 | Lite | …5026 | 2026-06-27 | 11 | 3 | Highest Lite call volume |
| R-06 | Tenant (`ep_`) | …6649 | 2026-04-02 | 3 | 1 | 4 months idle |

### Class C — dormant (9)

Zero CDRs, not registered. **Every one of these has also never been consumed through
secure provisioning** — see the note below, which applies to the whole estate.

| Alias | Class | DID | Activations |
|---|---|---|---|
| R-07 | Lite | …5030 | 4 — links minted, never a single call |
| R-08 | Foundation consumer | …2209 | 0 |
| R-09 | Foundation consumer | …2210 | 0 |
| R-10 | Foundation consumer | …2211 | 0 |
| R-11 | Foundation consumer | …2213 | 0 |
| R-12 | Foundation consumer | …2214 | 0 |
| R-13 | Foundation consumer | …2216 | 1 |
| R-14 | Foundation consumer | …2218 | 0 |
| R-15 | Foundation consumer (test) | …2215 | 0 — `teststartergrant` fixture |

### Class D — duplicate references, already collapsed

| Duplicate | Resolution |
|---|---|
| R-13 appears in **both** S1 and S3 | Counted once. It is a Foundation consumer seat that *also* had a Lite activation link minted |
| Several `pkg_sip` rows are duplicated per alias in Magnus (e.g. two rows for one `ep_` name) | Collapsed by alias + `id_user`. Flagged separately — duplicate SIP rows are a Magnus hygiene issue in their own right |

> **Estate-wide fact:** across all 39 activation rows ever issued, **zero** were consumed
> through the secure XML path and **zero** were OTP-verified. No account in this
> inventory has ever been provisioned through the secure mechanism. Class C's "never
> consumed through secure provisioning" is therefore not a distinguishing property — it is
> universal, and it is the reason the secure path is unproven.

## 4. The four orphan references — unresolved

Four distinct `liteAccountId` values appear in activation history whose `lite_accounts`
row no longer exists. An activation link was minted for each — so a credential was
rendered for each — and the account they referred to has since been removed or replaced.

**These cannot be classified without the owner.** Each is one of:

- a retired account whose Magnus credential still exists and is still valid (**rotate**);
- an account replaced by a current row already counted (**class D, no action**);
- a genuinely removed account with no live Magnus credential (**no action**).

Resolving them requires matching historical `liteAccountId` values against the Magnus
roster — a read-only reconciliation, but one that needs the owner to confirm which
retirements were deliberate. One is already known: `+17672859610` was retired on purpose
as EPIC's own Meta test number and **must not be re-provisioned**.

## 5. The gap that must be closed before rotation is complete

**S2 — the Foundation operator/business exposure set is not enumerable from this lane.**

`/api/voice/line` and the owner voice page leaked the credential for any tenant with a
Foundation `VoiceLine` row (`owner_kind='business'`). That set lives in Foundation's
Neon production database, for which no engineering lane holds a read path — the local
`.env` targets a local `isola_dev_v2`, not production.

Magnus shows ~190 `ep_`-prefixed accounts, but that is **not** the exposure set: most
predate Foundation and were created by the BFF. Treating 190 as the rotation scope would
be wrong in the expensive direction.

**Exact read-only query for the owner (or a Replit-side run):**

```sql
SELECT magnus_sip_username, magnus_did_number, provisioning_state, tenant_id
FROM "VoiceLine"
WHERE owner_kind = 'business' AND magnus_sip_username IS NOT NULL;
-- Deliberately does NOT select magnus_sip_password.
```

Row count and aliases are all that is needed. Until this returns, the rotation scope is
**15 confirmed + 4 unresolved + S2 unknown**.

## 6. Proposed sequence

Ordered so that the reversible, zero-impact work happens first and nothing that can
strand a customer happens at all until it can be undone.

### Phase 1 — dormant, no customer impact (9 accounts: R-07 … R-15)

Rotate via `enforceSipSecret()`. No registration to break, no calls to interrupt. R-15 is
a test fixture and can go first as a live rehearsal of the mechanism.

**Safe to authorize now.** Rotating a credential that no device holds cannot strand
anyone, and it removes 9 of 15 known-exposed secrets immediately.

### Phase 2 — inactive but real (4 accounts: R-03 … R-06)

Rotate **after** each account's owner is identified and contactable, because the holder
may still have a configured device that simply is not registered right now. An
unregistered device is not the same as an absent one.

**Precondition:** support contactability confirmed per account (see §7).

### Phase 3 — the two registered devices (R-01, R-02) — **HELD**

**Must not be rotated until a tested reactivation path exists.** Rotating either one
today strands a working phone with no self-service way back, because new activation is
deliberately unavailable under the containment.

Unblocked by **either**:
- the secure activation flow shipping and being proven (depends on Acrobits A-6); **or**
- an approved, tested, operator-assisted manual recovery path for these two specific
  devices, executed with the customer on the line.

### Standing rule

> No credential rotation while new activation is unavailable, **unless** that specific
> customer and device has an approved manual recovery plan.

Phase 1 satisfies this vacuously (no device). Phase 2 satisfies it per account. Phase 3
cannot satisfy it yet — which is precisely why it is held.

## 7. What is still needed before Phases 2 and 3

| # | Item | Owner |
|---|---|---|
| N-1 | S2 business exposure set — run the §5 query | Owner / Replit |
| N-2 | Resolve the 4 orphan references | Owner |
| N-3 | Entitlement/customer owner per account — Magnus `id_user` gives the billing account, not the human. Contactability is not derivable from any system I can read | Owner |
| N-4 | Tested reactivation path for R-01 and R-02 | Engineering + owner |
| N-5 | Confirm which accounts are test fixtures vs. real customers (R-15 is clearly a fixture; others are less obvious) | Owner |

## 8. Rollback

Rotation is not reversible in the usual sense — the previous secret is gone by design,
which is the point. What is reversible:

- **Per account**, before rotation: nothing to undo; simply do not proceed.
- **After rotation**, if a device is stranded: re-issue via the same assisted path used to
  rotate. Record the alias, the timestamp and the operator on every rotation so a
  stranded device can be traced to its rotation event rather than guessed at.
- **Abort the campaign**: stop after any phase. The phases are independent and ordered by
  increasing risk precisely so that stopping is always a valid outcome.

Magnus, trunks, routing and DIDs are untouched throughout. Rotation changes one secret on
one SIP account and nothing else.
