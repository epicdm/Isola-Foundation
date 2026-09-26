# EC$10 welcome voucher — cost validation, 2026-09-26 (round 6: real US/CA rate + actual usage data)

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6. This validates the proposal from checkpoint 13 —
it does not re-propose or approve anything.

**What's new this round:** VOICE gave the real US/Canada termination rate and pulled actual Dominica usage
from voice03 CDRs. The usage sample turned out too small to model directly (3 accounts, 5 calls, 0.8 min
total) — VOICE's own call, not this lane's. Per Lane A, using **stated assumptions** (100/250/500 min/month)
for the expected case instead, clearly labelled as assumptions, with 1,000 min kept as the worst case (now
capped by the hard limit design from `dec-unlimited-dominica-fair-use-in-terms-hard-limit-2026-09-26`).

## Numbers used, labelled by source

| Number | Value | Status |
|---|---|---|
| Voucher face value | EC$10 (also costed at EC$5) | This lane's proposal (checkpoint 13), not yet approved |
| Redemption rule | Becomes EC$ wallet credit; spendable on calls/plans; never on airtime | **Measured** — matches `dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` |
| Dominica per-minute rate, Personal Line, voice03 (retail) | EC$0.135/min | **Measured** — Lane A, prior thread |
| Dominica wholesale, mobile (Digicel/Flow) | ≈ **EC$0.0193/min** | **Measured** — VOICE, voice03 buy-side tables |
| Dominica wholesale, Flow fixed | ≈ **EC$0.0104/min** | **Measured** — same source |
| Dominica on-net (EPIC↔EPIC) | EC$0/min | **Measured** — same source |
| **US & Canada termination, least-cost route (VITELITY)** | US$0.0098/min ≈ **EC$0.0265/min** | **Measured** — VOICE, voice03 CDRs/rate tables, 2026-09-26. Flat: no mobile/fixed split, same rate for US and Canada. (GM-Telecom alternate route: US$0.0125/min, not used — least-cost route applies) |
| Actual Dominica usage, last 30 days | Only 3 Personal Line accounts made any calls; 5 outbound calls, 0.8 min total; avg 0.24 min/active account, max 0.4 min | **Measured, but VOICE flags as too small to model** — EPIC's own DID block also starts 1767818, so inbound calls to customers' own numbers were excluded from this count by design, not an oversight |
| Expected-case Dominica usage | **Stated assumptions: 100, 250, 500 min/month** | Not derived from the (too-small) real sample — explicit stated scenarios, per Lane A, clearly labelled as assumptions, not measurements |
| Worst-case Dominica usage | 1,000 min/30 days (knowledge v1 fair-use figure) | **Relayed by Lane A**, no Tiledesk access to verify directly. Now backstopped by a hard limit VOICE is designing — see resolution below |
| Non-minute cost components (platform, Acrobits, VAT, processing, support/CAC, incoming reserve) | Still unknown | **Owner/finance input** — no engineering system holds these, per Lane A. Still placeholders, not guessed |

## Resolved since round 4: the unlimited-vs-cap question

`dec-unlimited-dominica-fair-use-in-terms-hard-limit-2026-09-26` (Ratified, owner) settles checkpoint 14's
open question: Dominica calling is marketed as unlimited; the fair-use figure lives only in signup terms;
economics are protected by a background monitor and a hard limit (mechanism TBD by VOICE, recommended:
overage bills per-minute from the wallet rather than blocking the call). This means the "worst case" below
is now a genuinely enforced ceiling once the hard limit ships, not just an unenforced policy number — a real
improvement for this analysis, separate from the rate/usage updates.

## Path A — voucher spent as pay-per-minute Dominica calling (unchanged)

EC$10 ÷ EC$0.135/min (retail) = 74.07 min covered. Wholesale cost at the conservative mobile rate:
74.07 × EC$0.0193 ≈ **EC$1.43**. EC$5 → 37.04 min → **EC$0.71**. Doesn't depend on plan allowance, unaffected
by anything else in this round.

## Path B — full plan contribution, now computable at three expected-case points plus worst case

**US/Canada minute cost, now measured (60-min allowance on the EC$35 plan):**
60 × EC$0.0265 = **EC$1.59** if fully used (VOICE's own figure, confirmed by this lane's recompute).
**200-min allowance on the top tier:** 200 × EC$0.0265 = **EC$5.29** (also VOICE's own figure, confirmed).

**Combined minute cost (Dominica + US/CA), EC$35 Personal Line plan, at each usage scenario:**

| Dominica usage scenario | Dominica cost | + US/CA cost (60 min, full use) | = Total minute cost |
|---|---|---|---|
| Worst case: 1,000 min | EC$19.30 | EC$1.59 | **EC$20.89** |
| Stated assumption: 500 min | EC$9.65 | EC$1.59 | **EC$11.24** |
| Stated assumption: 250 min | EC$4.83 | EC$1.59 | **EC$6.42** |
| Stated assumption: 100 min | EC$1.93 | EC$1.59 | **EC$3.52** |
| Actual measured sample (0.24 min avg/active account) | ~EC$0.005 | not in the sample | **negligible — but this lane is not treating a 5-call sample as a basis for planning, per VOICE's own "too small to model" flag** |

**Remaining revenue before non-minute costs (still placeholders), at each scenario:**

| | Full price (EC$35) | EC$10 voucher (EC$25) | EC$5 voucher (EC$30) |
|---|---|---|---|
| Worst case (1,000 min) | EC$14.11 | **EC$4.11** | **EC$9.11** |
| 500-min assumption | EC$23.76 | **EC$13.76** | **EC$18.76** |
| 250-min assumption | EC$28.58 | **EC$18.58** | **EC$23.58** |
| 100-min assumption | EC$31.48 | **EC$21.48** | **EC$26.48** |

All rows are still **ceilings**, not final contribution — the six non-minute cost lines (platform, Acrobits,
VAT, processing, support/CAC, incoming reserve) still reduce every number here once they land. But the range
from worst case to the 100-min assumption is now wide enough to be genuinely informative: even under a
fairly generous expected-usage assumption (500 min/month — the real measured sample suggests actual usage
is far below even 100 min, but that sample is too small to plan on), an EC$10 voucher redemption still
leaves EC$13.76 before other costs, which is a materially healthier number than the worst case's EC$4.11.

## Sensitivity table, Path A + Path B face-value exposure (unchanged mechanics)

| Signups | Voucher | Path A real cost | Path B face-value cost |
|---|---|---|---|
| 50 | EC$10 | ≈ EC$71.50 | EC$500 |
| 200 | EC$10 | ≈ EC$286 | EC$2,000 |
| 50 | EC$5 | ≈ EC$35.75 | EC$250 |
| 200 | EC$5 | ≈ EC$143 | EC$1,000 |

## Recommendation, updated for the wider range

Still leaning toward **Option 1 (EC$5 voucher)** as the lowest-effort protective choice — it widens the
remaining-before-other-costs margin at every usage scenario, worst case included (EC$9.11 vs EC$4.11).
**Option 2 (calls-only restriction)** remains available if the owner wants zero exposure to the plan-
purchase path regardless of usage scenario, at the cost of a real LINE/AGENT build item. Given the range now
spans EC$4.11 (worst case) to EC$21.48 (100-min assumption) for the EC$10 voucher, this lane's honest
position is: **the worst case alone shouldn't drive the decision** now that it's backstopped by a real hard
limit (not just a stated policy) — but the non-minute costs are still the piece that would turn any of these
numbers from "remaining before other costs" into an actual contribution figure, and those are still with the
owner.

## Still open
1. The six non-minute cost components — owner/finance input, per Lane A, still placeholders.
2. The owner's cohort-size and voucher-size decision.
3. VOICE's hard-limit mechanism design (recommended: per-minute billing from the wallet beyond the cap,
   rather than blocking the call) — once specified, worth confirming it doesn't change the worst-case math
   above (e.g. if overage is billed at a different rate than the plan's base minutes).
