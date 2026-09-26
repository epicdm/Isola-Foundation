# EC$10 welcome voucher — cost validation, 2026-09-26 (round 7: full contribution + breakeven)

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6. Validates the checkpoint-13 proposal; does not
re-approve anything. Round 7 adds the owner-supplied non-minute costs and answers the headline breakeven
question directly.

## HEADLINE: customer count at which the EC$35 plan breaks even, EC$5 vs EC$10 voucher

| Dominica usage assumption | Full price (no voucher) | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min/month (assumed) | ~21 customers | ~25 customers | ~31 customers |
| 250 min/month (assumed) | ~23 customers | ~28 customers | ~36 customers |
| 500 min/month (assumed) | ~28 customers | ~35 customers | ~48 customers |
| **1,000 min/month (worst case, hard-limit cap)** | **~47 customers** | **~74 customers** | **~178 customers** |

**Read this as: below the stated count, the plan doesn't cover its fixed costs at that usage level; above
it, it does — before VAT, Fiserv fee and support/CAC, which are still unknown and would only push these
numbers higher, never lower.** The EC$10 voucher needs roughly 2.4x the customers of the EC$5 voucher to
reach breakeven at every usage level, because it removes a much bigger share of a plan whose fixed-cost
allocation is already the main lever here.

## Numbers used, labelled by source

| Number | Value | Status |
|---|---|---|
| Dominica wholesale, mobile | EC$0.0193/min | **VOICE-verified** |
| US/Canada termination, flat | EC$0.0265/min | **VOICE-verified** |
| Acrobits platform | US$134/mo → EC$361.80 | **Owner-supplied** |
| Acrobits per device | US$0.20/device (assumed monthly) | **Owner-supplied**, period assumed |
| DID block 1767818XXXX | EC$450/yr → EC$37.50/mo | **Owner-supplied** |
| Server | US$50 (assumed monthly) → EC$135.00 | **Owner-supplied**, period assumed |
| Electricity | EC$100.00/mo | **Owner-supplied** |
| AI tokens | Variable | **Owner-flagged, not quantified — placeholder** |
| **Fixed total** | **≈ EC$634.30/month** + EC$0.54/device | Sum of the above |
| Fixed cost per customer | 50 cust → EC$13.23; 200 cust → EC$3.71; 500 cust → EC$1.81 | Owner-supplied total ÷ N, + EC$0.54 device fee |
| Dominica usage: 100/250/500 min | **Assumed** (stated scenarios, not measured — real 30-day sample was 3 accounts/5 calls/0.8 min, VOICE flagged as too small to model) | **Assumed** |
| Dominica usage: 1,000 min | **Worst case**, backstopped by the ratified hard limit (`dec-unlimited-dominica-fair-use-in-terms-hard-limit-2026-09-26`) | Relayed allowance figure (knowledge v1), capped by design |
| US/CA allowance, full use | 60 min (EC$35 plan) → EC$1.59; 200 min (EC$55 plan) → EC$5.29 | **VOICE-verified rate** × plan allowance (allowance itself from knowledge v1, relayed) |
| VAT, Fiserv card-fee %, support/CAC | Unknown | **Still placeholders** — not supplied yet, not guessed |

## EC$35 Personal Line — full contribution (revenue − Dominica cost − US/CA cost − fixed cost/customer)

**At 50 customers (fixed cost EC$13.23/customer):**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$18.25 | EC$13.25 | EC$8.25 |
| 250 min | EC$15.35 | EC$10.35 | EC$5.35 |
| 500 min | EC$10.53 | EC$5.53 | EC$0.53 |
| 1,000 min (worst case) | EC$0.88 | **−EC$4.12** | **−EC$9.12** |

**At 200 customers (fixed cost EC$3.71/customer):**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$27.77 | EC$22.77 | EC$17.77 |
| 250 min | EC$24.87 | EC$19.87 | EC$14.87 |
| 500 min | EC$20.05 | EC$15.05 | EC$10.05 |
| 1,000 min (worst case) | EC$10.40 | EC$5.40 | EC$0.40 |

**At 500 customers (fixed cost EC$1.81/customer):**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$29.67 | EC$24.67 | EC$19.67 |
| 250 min | EC$26.77 | EC$21.77 | EC$16.77 |
| 500 min | EC$21.95 | EC$16.95 | EC$11.95 |
| 1,000 min (worst case) | EC$12.30 | EC$7.30 | EC$2.30 |

All figures still before VAT/Fiserv-fee/support-CAC — every number above is a ceiling, not final.

## EC$55 plan — full contribution (200 min US/CA allowance, EC$5.29 at full use)

**At 50 customers:**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$34.55 | EC$29.55 | EC$24.55 |
| 250 min | EC$31.65 | EC$26.65 | EC$21.65 |
| 500 min | EC$26.83 | EC$21.83 | EC$16.83 |
| 1,000 min (worst case) | EC$17.18 | EC$12.18 | EC$7.18 |

**At 200 customers:**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$44.07 | EC$39.07 | EC$34.07 |
| 250 min | EC$41.17 | EC$36.17 | EC$31.17 |
| 500 min | EC$36.35 | EC$31.35 | EC$26.35 |
| 1,000 min (worst case) | EC$26.70 | EC$21.70 | EC$16.70 |

**At 500 customers:**

| Dominica usage | Full price | EC$5 voucher | EC$10 voucher |
|---|---|---|---|
| 100 min | EC$45.97 | EC$40.97 | EC$35.97 |
| 250 min | EC$43.07 | EC$38.07 | EC$33.07 |
| 500 min | EC$38.25 | EC$33.25 | EC$28.25 |
| 1,000 min (worst case) | EC$28.60 | EC$23.60 | EC$18.60 |

The EC$55 plan never goes negative at any tested combination — its higher revenue absorbs the same fixed
and minute costs far more easily than the EC$35 plan does.

## What this means, plainly

- **The EC$35 plan is the one that can actually go negative** — specifically at low customer counts (≤50)
  combined with high Dominica usage (≥500 min) and a voucher applied. That combination is exactly the
  worst-case-meets-early-pilot scenario: few customers (fixed costs not yet spread thin) and heavy usage.
- **The EC$55 plan has real headroom** at every tested combination — even worst case at 50 customers with a
  EC$10 voucher still leaves EC$7.18.
- **VAT, Fiserv fee and support/CAC are still missing** and will only make every number in this file smaller,
  never larger — the breakeven customer counts above are optimistic floors, not final answers.

## Recommendation, updated

For an early pilot (50-customer scale per Lane A's original cohort recommendation), **the EC$35 plan with a
EC$10 voucher is genuinely risky** if usage lands anywhere near the worst case — it's the only cell in
either table that goes solidly negative. EC$5 stays non-negative across every EC$35 scenario except the
worst case at 50 customers (barely, −EC$4.12). Once the pilot scales past ~200 customers, the fixed-cost
allocation shrinks enough that even EC$10 stays positive except at the worst-case usage extreme.

## Still open
1. VAT treatment, Fiserv card-processing fee %, support/CAC — owner/finance inputs, still placeholders.
2. AI token cost — flagged by the owner as variable and not quantified; not in any total above.
3. The owner's actual cohort-size and voucher-size decision, informed by the breakeven table above.
