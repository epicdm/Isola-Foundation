# EC$10 welcome voucher — cost validation, 2026-09-26

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6: "The EC$10 welcome voucher is a proposal, NOT
approved. Validate its cost against actual redemption and rating rules, eligible destinations, expected
usage and the maximum campaign exposure." This validates the proposal from checkpoint 13 — it does not
re-propose or approve anything.

## Numbers used, labelled by source

| Number | Value | Status |
|---|---|---|
| Voucher face value | EC$10 | This lane's proposal (checkpoint 13), not yet approved |
| Redemption rule | Becomes EC$ wallet credit; spendable on calls/plans; **never on airtime** | **Measured** — Lane A, this thread, matches `dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` |
| Dominica per-minute rate, Personal Line, voice03 | EC$0.135/min | **Measured** — given directly by Lane A this thread |
| Dominica wholesale/interconnect cost | **EC$0.03/min — labelled "Port-sourced 2026-09-02, unverified"** | Lane A is asking the VOICE lane for the current measured figure. Per Lane A's instruction (2026-09-26), keep this label on the number until VOICE answers rather than treat it as confirmed. Source: `mc-personal-line-unlimited-dominica-calling-2026-09-02`'s own rationale. |
| Early-access signup cap | **50 (primary), 200 (sensitivity range)** | Lane A's recommendation, replacing the illustrative/non-authoritative 500 this lane used originally. Sized to what support can handle and to the 12-device Wi-Fi pilot cap. Still an owner decision, not final — shown as a two-point sensitivity range per Lane A's instruction. |

## Two redemption paths, costed separately (both are "spendable on calls/plans")

**Path A — spent as pay-per-minute Dominica calling (no plan purchase):**
EC$10 ÷ EC$0.135/min = **74 minutes** of Dominica calling covered, at the customer-facing rate.
Real wholesale cost to EPIC, if the EC$0.03/min figure above is confirmed current: 74 min × EC$0.03/min ≈
**EC$2.22 per redeeming customer** — about 22% of face value.

**Path B — applied toward a plan purchase (e.g., the EC$35 30-Day plan):**
This is the path this lane considers the more realistic risk, since Personal Line's business model is
plan-based, not pay-per-minute. If a customer applies the EC$10 voucher toward a EC$35 30-Day plan, EPIC
receives EC$25 cash instead of EC$35 for that plan. The historical packet's own revised contribution
estimate for a full-price 30-Day plan is ~EC$7.86 before support/CAC/incoming reserve. Subtracting the
EC$10 voucher from that revenue: **≈ –EC$2.14 contribution per redeeming customer** — i.e. this redemption
path could make the acquisition **loss-making before support/CAC**, not just lower-margin. This is the
number that most needs the owner's attention, more than Path A's wholesale-cost framing.

## Maximum campaign exposure — sensitivity at 50 and 200 signups

Confirmed by Lane A: the wallet-credit path is real — a redeemed voucher can go toward calls **or** a plan
purchase (never airtime), so Path B (plan discount) isn't a hypothetical, it's how the mechanism actually
works today. Two voucher sizes shown, since a smaller voucher is one way to remove Path B's loss-making risk
without new engineering.

| Signups | Voucher | Path A (calls only) — real cost | Path B (plan-purchase redemption) — real cost | Plan contribution after Path B redemption |
|---|---|---|---|---|
| 50 | EC$10 | 50 × EC$2.22 ≈ **EC$111** | 50 × EC$10 = **EC$500** | ~EC$7.86 − EC$10 = **−EC$2.14/customer (loss-making)** |
| 200 | EC$10 | 200 × EC$2.22 ≈ **EC$444** | 200 × EC$10 = **EC$2,000** | same per-customer result: **−EC$2.14/customer** |
| 50 | EC$5 | 50 × EC$1.11 ≈ **EC$56** | 50 × EC$5 = **EC$250** | ~EC$7.86 − EC$5 = **+EC$2.86/customer (still positive)** |
| 200 | EC$5 | 200 × EC$1.11 ≈ **EC$222** | 200 × EC$5 = **EC$1,000** | same per-customer result: **+EC$2.86/customer** |

(Path A real-cost figures use the unverified EC$0.03/min wholesale label above — treat as an estimate until
VOICE confirms.)

## Two options for the owner, beyond just picking a cohort size

**Option 1 — smaller voucher (EC$5 instead of EC$10).** No new engineering. Keeps the plan-purchase
redemption path solidly positive-contribution (+EC$2.86 vs the EC$10 voucher's −EC$2.14). Halves both
exposure columns. This lane's preference if the goal is removing the loss-making risk with the least work.

**Option 2 — restrict the voucher to calls only (no plan-purchase redemption).** Removes Path B's risk
entirely regardless of voucher size, but **this is not how the mechanism works today** — per
`dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` and Lane A's confirmation, the wallet credit
currently spends on calls **or** plans, with no scope restriction. Choosing this option means asking
LINE/AGENT to add that restriction before launch — a real build item, not a copy change. Flagging the
dependency rather than assuming it's a quick flag flip.

## What this validation recommends

Not a yes/no on the EC$10 figure — that's the owner's call. But: **Option 1 (EC$5, no new engineering) is
the lowest-effort way to remove the one genuinely dangerous number in this analysis** (Path B going
loss-making). Option 2 is cleaner in principle but costs a build item this pilot's own order-of-work
sequence (currency → vouchers → testimonial) doesn't currently include.

## Still open
1. VOICE's confirmation of the current Dominica wholesale/interconnect rate (Path A numbers move if it
   differs from EC$0.03/min).
2. The owner's actual cohort-size decision (50 vs 200 vs something else) and voucher-size/scope choice.
