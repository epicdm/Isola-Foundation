# EC$10 welcome voucher — cost validation, 2026-09-26 (round 8: reconciled cost sets, processing fee, expected-redemption forecast, final recommendation)

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6. Validates the checkpoint-13 proposal; still no
voucher amount is approved until the owner decides.

## 1. Reconciling two cost sets — today's used as primary, per Lane A's instruction

**Today's set was confirmed by the owner directly in chat as monthly**, and independently matches Port
evidence `ev-personal-line-cost-inputs-owner-2026-09-26` (checked before use, same as every other figure in
this file). **The "earlier set" is relayed by Lane A as cited in a Senior PM directive — I searched Port's
`decision` blueprint for it directly and could not locate the exact figures** (Acrobits US$140/US$0.30-per-user,
platform US$250, DID US$500+US$100/yr); the closest related record I found,
`dec-personal-line-cost-inputs-2026-08-30`, shows Acrobits and Stripe/Fiserv rates as explicitly UNSOURCED at
that time, and a payment-processing figure modeled at "~4% blended (EC$1.40 on EC$35)" as a *target, not a
contracted rate* — consistent with, but not identical to, the "4-5%" Lane A relayed. Flagging this
explicitly rather than presenting the earlier set as independently verified by this lane.

| Item | Today's (primary, owner-confirmed, matches Port evidence) | Earlier (relayed by Lane A, not independently located in Port) | Reconciliation note |
|---|---|---|---|
| Acrobits platform | US$134/mo | US$140/mo | Today's is ~4% lower — possible supplier-price change or just a different quote. Not resolved; using today's. |
| Acrobits per-unit | US$0.20/**device**/mo | US$0.30/**active user**/mo | **Different denominator, not just a different number** — a customer can have multiple devices, so these aren't directly comparable 1:1. Using today's device-based figure as primary. |
| Server + electricity | US$50/mo (server) + EC$100/mo (electricity) = **EC$235.00/mo combined** | "Platform US$250/mo" = **EC$675.00/mo** | **Flagged, not resolved: is "platform US$250" meant to be the same thing as server+electricity, or does it bundle more (e.g. Acrobits, DID, overhead all together)?** The two readings differ by nearly 3x. I'm not guessing which is right — presenting both. |
| DID/number infrastructure | EC$450/yr → EC$37.50/mo (specific to the 1767818XXXX block) | "US$500 + US$100 annually" (currency and structure both ambiguous — could be a US$500 one-time setup + US$100/yr recurring, or US$600/yr combined) | **Flagged, not resolved.** Under an additive US$600/yr reading: EC$1,620/yr ≈ EC$135/mo — 3.6x today's figure. Under a one-time-setup reading: EC$100/yr ≈ EC$22.50/mo — closer to today's but still not identical. |
| Payment processing | Not quantified in today's set | **4-5%**, closest match to the 2026-08-30 record's "~4% blended (EC$1.40 on EC$35)" modeled target | **Using the earlier set's figure here specifically, since today's set didn't cover it** — see §2 below. This is a deliberate exception to "today's as primary," not an oversight. |

**Sensitivity, directional only (not fully re-tabulated below to keep this file readable):** if the earlier
set's higher figures are the real ones instead of today's, combined fixed costs could run close to double
today's ~EC$634.30/month (roughly EC$1,075-1,188/month depending on which DID reading applies) — which would
roughly double every breakeven customer count in §3. This is a big enough swing that I'd want the "platform
US$250 vs server+electricity" and "DID US$500+US$100" ambiguities resolved before either number is treated
as settled, not just noted as a footnote.

## 2. Payment processing (4-5%) applied to plan revenue and card top-ups

Applied to the **actual card-charged amount** — i.e. revenue *after* a voucher is applied, not the sticker
price, since a voucher reduces what the customer's card is actually charged. Shown at 4%, 4.5% (primary,
midpoint), and 5%.

| Plan / scenario | Card-charged amount | Fee at 4% | Fee at 4.5% (primary) | Fee at 5% |
|---|---|---|---|---|
| EC$35, full price | EC$35.00 | EC$1.40 | **EC$1.575** | EC$1.75 |
| EC$35, EC$10 voucher | EC$25.00 | EC$1.00 | **EC$1.125** | EC$1.25 |
| EC$35, EC$5 voucher | EC$30.00 | EC$1.20 | **EC$1.35** | EC$1.50 |
| EC$55, full price | EC$55.00 | EC$2.20 | **EC$2.475** | EC$2.75 |
| EC$55, EC$10 voucher | EC$45.00 | EC$1.80 | **EC$2.025** | EC$2.25 |
| EC$55, EC$5 voucher | EC$50.00 | EC$2.00 | **EC$2.25** | EC$2.50 |

**Card top-ups** (separate from plan purchase, if a customer tops up their wallet by card): same 4.5%
primary rate applies to whatever amount is charged. Voucher redemption itself is **not** a card transaction
— it's an internal wallet credit — so a voucher redemption alone doesn't trigger this fee; only the actual
card-charged plan purchase or top-up does.

## 3. Headline breakeven, updated to include the processing fee (4.5% primary)

**EC$35 plan — customer count at which contribution reaches zero, now including processing fee:**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min (assumed) | ~22 (was ~21 before fee) | ~26 (was ~25) | ~32 (was ~31) |
| 250 min (assumed) | ~24 (was ~23) | ~30 (was ~28) | ~38 (was ~36) |
| 500 min (assumed) | ~30 (was ~28) | ~38 (was ~35) | ~53 (was ~48) |
| **1,000 min (worst case)** | **~53 (was ~47)** | **~88 (was ~74)** | **~260 (was ~178)** |

**Worth flagging:** the fee's effect is small at full price and the EC$5 voucher (roughly +5-20% more
customers needed), but it's disproportionate at the EC$10-voucher-worst-case cell — 178 → 260, a 46% jump —
because that scenario already had the thinnest margin in round 7, and the fee eats a much larger *relative*
share of what little contribution was left.

## 4. Voucher incremental cost, separated from platform allocation

**These are two different things and shouldn't be blended:** the platform fixed-cost allocation above
(Acrobits/DID/server/electricity, spread over the *total* active customer base) is a business-wide, ongoing
cost. The voucher's incremental cost is specific to *this campaign's* registrants, and should be shown
separately.

**Campaign cap:** 50 registrations approved (per Lane A). **Expected redemption rate: no measured figure
exists yet — proposing 60% as a labelled assumption** (30 of 50 registrants actually activate a line and
redeem), with 40%/80% shown as sensitivity. This is this lane's proposal, not a measured or owner-confirmed
number — flagging clearly since the task asked for the assumption to be stated, and I don't have a real one
to report.

**Main forecast (expected redemption, 60% assumption) vs. maximum permitted exposure (100% redemption) —
kept as separate lines, voucher face value ≠ cash cost:**

| | Path A — spent as calls (wholesale cost) | Path B — applied to a plan purchase (face-value cost) |
|---|---|---|
| **EC$10 voucher, expected (60% of 50 = 30 redemptions)** | 30 × EC$1.43 = **EC$42.90** | 30 × EC$10 = **EC$300** |
| EC$10 voucher, max exposure (100% of 50 = 50 redemptions) | 50 × EC$1.43 = EC$71.50 | 50 × EC$10 = EC$500 |
| **EC$5 voucher, expected (60% of 50 = 30 redemptions)** | 30 × EC$0.71 = **EC$21.30** | 30 × EC$5 = **EC$150** |
| EC$5 voucher, max exposure (100% of 50 = 50 redemptions) | 50 × EC$0.71 = EC$35.75 | 50 × EC$5 = EC$250 |
| Sensitivity: 40% redemption (20 of 50) | EC$10: 20×1.43=EC$28.60 / EC$5: 20×0.71=EC$14.20 | EC$10: 20×10=EC$200 / EC$5: 20×5=EC$100 |
| Sensitivity: 80% redemption (40 of 50) | EC$10: 40×1.43=EC$57.20 / EC$5: 40×0.71=EC$28.40 | EC$10: 40×10=EC$400 / EC$5: 40×5=EC$200 |

At a 50-registration campaign cap, even the maximum-exposure, worst-redemption-path numbers (EC$500 for
EC$10, EC$250 for EC$5) are small in absolute terms next to the plan's own breakeven-scale economics in §3 —
the real risk in this analysis was never the campaign's total voucher spend, it's the **per-customer
contribution margin** once a voucher is redeemed against a plan purchase, which is what §3's breakeven table
actually measures.

## 5. One recommended voucher amount, for owner approval — none is approved yet

**Recommendation: EC$5.** Reasoning:
- At every tested Dominica-usage scenario in §3, EC$5 keeps the breakeven customer count meaningfully lower
  than EC$10 (e.g. worst case: ~88 vs ~260 — nearly 3x fewer customers needed to break even).
- At the actual 50-registration campaign cap, EC$5's maximum exposure (EC$250 face value, EC$35.75 wholesale
  if spent on calls) is modest in absolute terms either way — the campaign-level cost isn't really what
  distinguishes the two options; the per-customer margin is.
- EC$10 is the only amount that pushes the EC$35 plan's worst-case breakeven past a plausible pilot scale
  (~260 customers) — a number this lane would not want the owner to discover only after committing to EC$10.

**Separate, more fundamental point this lane wants on record, not conflated with the voucher-size
decision:** even at full price with *no* voucher at all, the EC$35 plan needs ~22-53 customers just to
break even depending on Dominica usage (§3). If the pilot's total active base stays near 50 customers for a
while (plausible, given the Wi-Fi pilot's own 12-device cap), the EC$35 plan's unit economics are fragile at
that scale regardless of what voucher is chosen — that's a base-plan-economics question, not a voucher
question, and this lane isn't the right place to resolve it, but it's worth the owner seeing plainly rather
than only seeing it through the voucher lens.

## Still open
1. The "platform US$250 vs server+electricity" and "DID US$500+US$100/yr" reconciliation ambiguities in §1
   — not resolved, flagged for whoever owns those two supplier relationships.
2. A real expected-redemption-rate figure, once early-access actually runs — 60% here is this lane's
   labelled proposal, not a measurement.
3. The owner's approval of EC$5 (or a different amount) — nothing is approved yet.
