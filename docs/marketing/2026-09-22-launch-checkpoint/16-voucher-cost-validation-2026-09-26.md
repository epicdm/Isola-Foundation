# EC$10 welcome voucher — cost validation, 2026-09-26 (round 3: real VOICE rates)

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6. This validates the proposal from checkpoint 13 —
it does not re-propose or approve anything. **Round 3 replaces the EC$0.03/min placeholder with real rates
VOICE read live from voice03's buy-side tables**, and the conclusion on Path B changes as a result — see
below, flagged carefully rather than just asserted.

## Numbers used, labelled by source

| Number | Value | Status |
|---|---|---|
| Voucher face value | EC$10 (also costed at EC$5) | This lane's proposal (checkpoint 13), not yet approved |
| Redemption rule | Becomes EC$ wallet credit; spendable on calls/plans; **never on airtime** | **Measured** — matches `dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` |
| Dominica per-minute rate, Personal Line, voice03 (customer-facing/retail) | EC$0.135/min | **Measured** — Lane A, prior thread |
| Digicel mobile (Dominica) | US$0.007148/min ≈ **EC$0.0193/min** | **Measured** — VOICE lane, read live from voice03 buy-side tables, 2026-09-26 |
| Flow mobile (Dominica) | US$0.007148/min ≈ **EC$0.0193/min** | **Measured** — same source |
| Flow fixed (Dominica) | US$0.003852/min ≈ **EC$0.0104/min** | **Measured** — same source |
| On-net (EPIC↔EPIC) | EC$0/min | **Measured** — same source |
| Conservative wholesale rate (this file's default) | **EC$0.0193/min** (mobile) | Used until VOICE sends the actual call mix (mobile/fixed/on-net split) — this is a ceiling, not an expected average; real blended cost is likely lower once on-net and fixed-line traffic is counted in |
| Blended call-mix cost | Not yet available | **Pending** — VOICE asked, per Lane A |
| Early-access signup cap | 50 (primary), 200 (sensitivity range) | Lane A's recommendation, still an owner decision |
| Dominica minute allowance on the 30-Day plan | 400 min/30 days (historical packet) **or genuinely unlimited/uncapped** (original 2026-09-02 pricing decision + Lane A's own earlier measurement that Magnus rates Dominica at 0/min with no enforced cap) | **Unresolved** — this is checkpoint 14's open conflict, not settled by today's rate update. The 400-min figure is used below only because it's the one concrete allowance number on record; if the owner rules "unlimited," this whole calculation needs a usage-based model instead of an allowance-based one. |

## Path A — voucher spent as pay-per-minute Dominica calling, recomputed

EC$10 ÷ EC$0.135/min (retail) = 74.07 min covered. Wholesale cost at the conservative mobile rate:
74.07 × EC$0.0193 ≈ **EC$1.43** (down from the prior placeholder estimate of EC$2.22, which used the
unverified EC$0.03/min figure).
EC$5 ÷ EC$0.135 = 37.04 min → 37.04 × EC$0.0193 ≈ **EC$0.71**.

## Path B — applied toward the EC$35 30-Day plan, recomputed **with a real caveat**

**What changed and what didn't:** the voucher's face-value reduction from plan revenue is unchanged by this
rate update (EC$10 or EC$5 comes straight off the EC$35 price regardless of wholesale cost). What changes is
the plan's own **cost side**, which determines what contribution is left after that discount.

**Dominica-cost component, recomputed:**
- Old assumption (round 2, unverified): 400 min × EC$0.03/min = EC$12.00.
- New (measured, conservative mobile rate): 400 min × EC$0.0193/min = **EC$7.72** — EC$4.28 cheaper per
  plan-month than the old placeholder assumed.

**Directional effect on the plan's contribution:** the historical packet's own top-line estimate was ~EC$7.86
contribution before support/CAC/incoming reserve. I don't have that estimate's full itemized breakdown (the
US-CAN minute cost, platform fee, Acrobits, VAT, processing, support/CAC and incoming-reserve components
weren't given to me individually — only the final ~EC$7.86 result). **I can't fully rebuild that number from
scratch**, but I can apply the one input that changed: adding back the EC$4.28 Dominica-cost improvement to
the old baseline gives a **directional estimate of ~EC$12.14** contribution before a voucher discount — flagged
as directional, not a verified recomputation, since the other cost inputs are assumed unchanged, not re-confirmed.

**This reverses round 2's conclusion, with that caveat attached:**
- EC$10 voucher against ~EC$12.14: **≈ +EC$2.14/customer — positive, not loss-making** (round 2 said −EC$2.14,
  using the unverified EC$0.03/min figure).
- EC$5 voucher against ~EC$12.14: **≈ +EC$7.14/customer.**

**Why this isn't a clean "all clear":** it depends on (1) the 400-min allowance assumption, which is itself
unresolved against the "unlimited" reading of the original pricing decision, and (2) the other cost
components in the ~EC$7.86 baseline being accurate and unchanged, which I haven't independently re-verified.
If Dominica calling is genuinely uncapped, a heavy-usage customer's real cost could exceed the 400-min
figure this estimate relies on — the historical packet's own framing ("at full stated use") only makes sense
for a plan with a stated allowance, not an unlimited one.

## Sensitivity table, recomputed

| Signups | Voucher | Path A real cost (conservative mobile rate) | Path B face-value cost (unchanged) | Plan contribution after Path B redemption (directional, see caveat above) |
|---|---|---|---|---|
| 50 | EC$10 | 50 × EC$1.43 ≈ **EC$71.50** | EC$500 | **+EC$2.14/customer** |
| 200 | EC$10 | 200 × EC$1.43 ≈ **EC$286** | EC$2,000 | **+EC$2.14/customer** |
| 50 | EC$5 | 50 × EC$0.71 ≈ **EC$35.75** | EC$250 | **+EC$7.14/customer** |
| 200 | EC$5 | 200 × EC$0.71 ≈ **EC$143** | EC$1,000 | **+EC$7.14/customer** |

## Two options for the owner — updated status

**Option 1 — smaller voucher (EC$5).** Still valid, still no new engineering, still the more conservative
choice — now shown to widen an already-positive margin rather than rescue a negative one.

**Option 2 — restrict the voucher to calls-only.** Still a real LINE/AGENT build item, not a copy change, per
round 2. With Path B now directionally positive, this option is less urgent than it looked in round 2, but
still removes the residual uncertainty from the 400-min/unlimited allowance question entirely if the owner
wants a number with no caveats attached.

## What this validation recommends, updated

Round 2 flagged Path B as the most dangerous number. With the real VOICE rate, that specific concern is
substantially reduced — but **not eliminated**, because the directional contribution estimate still rests on
an unconfirmed allowance assumption and an unverified non-Dominica cost baseline. This lane's honest
position: the EC$10 voucher no longer looks clearly loss-making, but "no longer looks loss-making" is weaker
than "confirmed profitable" — the owner's ruling on unlimited-vs-capped Dominica calling (checkpoint 14) is
still the one thing that would make this a clean number instead of a directional one.

## Still open
1. VOICE's blended call-mix cost (mobile/fixed/on-net split), to replace the conservative mobile-only rate
   with an expected-average figure.
2. The unlimited-vs-400-min-cap ruling (checkpoint 14) — this is what turns "directional" into "confirmed"
   for the Path B numbers above.
3. Independent confirmation of the non-Dominica cost components in the historical ~EC$7.86 baseline (US-CAN
   minute cost, platform/Acrobits/VAT/processing/support-CAC/incoming-reserve) — this lane only has the
   top-line result, not the itemized inputs, and hasn't rebuilt them from scratch.
4. The owner's cohort-size and voucher-size decision.
