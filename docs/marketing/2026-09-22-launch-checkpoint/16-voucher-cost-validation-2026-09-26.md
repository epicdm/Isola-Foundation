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
| Dominica wholesale/interconnect cost | EC$0.03/min | **Measured, but from a different source and not re-confirmed fresh today** — read directly from Port entity `mc-personal-line-unlimited-dominica-calling-2026-09-02`'s own rationale ("EPIC pays EC$0.03 for each local/incoming minute"). Flagging this explicitly: it's a real Port-sourced figure, not a memory guess, but it's from a different write than today's EC$0.135 figure and I haven't had it re-confirmed as current for voice03 specifically. **Asking Lane A to confirm or correct before this number is relied on.** |
| Expected pilot cohort / signup cap | Not given | **Missing — needed to compute total exposure, not assumed.** The pilot's own constraints (≤12 simultaneous calling devices, isolated invited-device segment, 1hr/day free tier) suggest a small initial cohort, but I don't have an actual planned signup count. Asking Lane A for this rather than guessing a number as I did in the original checkpoint 13 draft (which used an illustrative, non-authoritative 500-signup figure — flagging that figure as unconfirmed and not to be used further). |

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

## Maximum campaign exposure

**Cannot be computed without the signup cap.** Formula, ready as soon as a number exists:
- Face-value ceiling = signup cap × EC$10.
- Real-cost ceiling, Path A only = signup cap × ~EC$2.22 (pending wholesale-rate confirmation).
- Real-cost ceiling, Path B (plan-purchase redemption) = signup cap × ~EC$10 (full face value comes off
  plan revenue directly; no wholesale discount applies to a cash-price reduction).
Requesting the expected/planned cohort size from Lane A to finish this.

## What this validation recommends

Not a yes/no on the EC$10 figure — that's the owner's call per the decision. But: **if the owner is
weighing Path A's framing (a `~78% wholesale discount makes this cheap`) against Path B's reality (a
plan-purchase redemption could turn a redeeming customer loss-making before support/CAC), Path B should be
the one the exposure cap is sized against, not Path A** — it's the less forgiving and, given Personal
Line's plan-based model, the more likely actual use case.

## Two things needed back from Lane A before this is complete
1. Confirm (or correct) that EC$0.03/min is still the current Dominica wholesale/interconnect cost on
   voice03 — it's from a different Port write than today's EC$0.135 figure.
2. The expected/planned early-access signup cap or cohort size, to finish the maximum-exposure calculation.
