# Welcome-offer comparison — costed, for owner decision, 2026-09-26

Internal costing for the owner's choice — not public copy. Figures marked "estimate" use wholesale/retail
rates already in this project's memory (Dominica wholesale ≈ EC$0.03/min; US/Canada wholesale ≈
EC$0.005–0.03/min; historical retail overage EC$0.15/min Dominica, EC$0.25/min US/Canada — that historical
ladder is itself unratified per checkpoint 14, used here only as a costing reference, not a claim). Currency
shown per `dec-card-currency-default-by-payer-number-2026-09-26` (EC$ = US$ × 2.70).

## Recommendation: (a) priority access + bonus voucher

**Why:** it directly reuses the mechanism the owner ratified and had built *today*
(`dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` — vouchers held in bff-v2, non-giftable,
30-day expiry, single redemption via the existing idempotent `addMagnusCredit`). No new payment rail, no
new reward ledger, smallest possible build for LINE.

**Proposal:** EC$10 (~US$3.70) bonus voucher per verified early-access signup who completes activation,
30-day expiry, single redemption into wallet, non-transferable.

**Cost, at a 500-signup pilot cohort, 100% activation and full redemption (worst case):**
- Gross face-value exposure: EC$5,000 (~US$1,852).
- Real wholesale-cost exposure *if fully spent on Dominica calls*: bonus credit draws down the wallet at
  whatever retail per-minute rate applies, but EPIC's real cash cost is the wholesale rate underneath it —
  roughly EC$0.03 ÷ EC$0.15 ≈ 20% of face value once spent, so **≈ EC$1,000 (~US$370) real cash cost**,
  before any breakage (unredeemed/expired vouchers, which only reduce this further).
- This is an estimate, not a ratified cost model — flagging for whoever owns the actual wholesale/retail
  rate reconciliation to confirm before the owner commits a cohort size.

## (b) Temporary full Wi-Fi access

**Cost:** near-zero marginal cash cost (existing infrastructure, no per-customer metering). Real cost is
hotspot capacity/congestion risk during the temporary-access window, which this lane cannot quantify —
**dependency on WIFI lane** for actual site capacity data before this can be costed responsibly. Simplest
to build (a policy flag on an existing gateway control), per the decision's own note that "the existing
WIFI lane chooses compatible supported gateway policy controls."

## (c) Fixed-duration percentage discount

**Proposal A — 20% off first 30-Day plan** (EC$35 → EC$28, EC$7 discount/redeemer). Per the existing
packet's own economics section, a full-price 30-Day plan already only contributes an estimated ~EC$7.86
before support/CAC/incoming reserve — a 20% discount would put a fully-used redeeming customer close to
break-even or slightly loss-making before those overheads. **Not recommended as primary** for that reason.

**Proposal B — 10% off first 30-Day plan** (EC$35 → EC$31.50, EC$3.50 discount/redeemer). Preserves roughly
half the plan's estimated contribution margin. Safer if a discount option is wanted at all.

## (d) Capped prepaid founders bundle

**Proposal:** EC$35 for 45 days of Personal Line access (30-Day plan terms, extended validity), capped at
the first 200 signups, purchasable within 60 days of invitation. **Terms required by the decision, drafted
here:**
- Price: EC$35 flat, no recurring charge.
- Entitlement: standard 30-Day plan minute allowance, valid 45 days instead of 30.
- Fulfilment trigger: line activation (existing onboarding flow) within 14 days of purchase.
- Delay/nonlaunch: full refund if EPIC fails to activate the line within 14 days of purchase.
- Cancellation: full refund before activation; no refund after activation begins (standard plan terms
  apply once active).
- Cap: 200 units this cohort — total exposure capped at 200 × 15 extra days of service, an estimated
  **≤ EC$262** in incremental wholesale cost (200 × 15 days × a per-day marginal-cost estimate derived from
  the packet's revised contribution figures) — this per-day figure is a rough estimate and should be
  confirmed by whoever owns the plan's real per-day cost breakdown before the owner commits to the cap.

## Sequencing (per decision, after the first complete loop)

Referral (both-party reward after a genuine qualifying paid purchase, replay-protected, capped) →
gamification (private milestones only, no forced contact access) → reseller/ambassador commission terms →
hotspot-venue-partner and diaspora-gift proposals. Not designed in this pass — the decision explicitly
sequences these after one complete pilot loop is proven.
