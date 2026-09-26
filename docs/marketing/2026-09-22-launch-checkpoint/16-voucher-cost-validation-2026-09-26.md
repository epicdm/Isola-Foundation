# EC$10 welcome voucher — cost validation, 2026-09-26 (round 4: knowledge-v1 terms, dropped the delta-patch)

Per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6. This validates the proposal from checkpoint 13 —
it does not re-propose or approve anything.

**Round 4 correction:** round 3 patched the historical ~EC$7.86 baseline by adding back one changed input
(the Dominica rate) while keeping its 400-min allowance. Lane A flagged that allowance as stale — the
current recommended terms (Tiledesk knowledge v1, `epic-personal-line-kb-v1-draft2`, pending owner approval,
**relayed by Lane A, not independently checked by this lane — no Tiledesk access**) use **1,000 min/30 days
fair-use**, not 400. Since the allowance itself changed, not just the rate, patching the old baseline is no
longer valid — a different allowance changes the whole calculation, not one line of it. This round drops
the patch approach and computes fresh from what's actually confirmed.

## Numbers used, labelled by source

| Number | Value | Status |
|---|---|---|
| Voucher face value | EC$10 (also costed at EC$5) | This lane's proposal (checkpoint 13), not yet approved |
| Redemption rule | Becomes EC$ wallet credit; spendable on calls/plans; **never on airtime** | **Measured** — matches `dec-bonus-value-as-vouchers-and-card-only-airtime-2026-09-26` |
| Dominica per-minute rate, Personal Line, voice03 (customer-facing/retail) | EC$0.135/min | **Measured** — Lane A, prior thread |
| Digicel/Flow mobile (Dominica), wholesale | ≈ **EC$0.0193/min** | **Measured** — VOICE, live from voice03 buy-side tables |
| Flow fixed (Dominica), wholesale | ≈ **EC$0.0104/min** | **Measured** — same source |
| On-net (EPIC↔EPIC) | EC$0/min | **Measured** — same source |
| Conservative wholesale rate (this file's default) | **EC$0.0193/min** (mobile) | Ceiling, not an expected average — real blended cost is lower once on-net/fixed traffic counts in |
| Blended call-mix / expected usage | Not yet available | **Pending** — VOICE asked, per Lane A |
| Personal Line plan (EC$35/30 days) Dominica term | **Unlimited, fair-use 1,000 min/30 days** | **Relayed by Lane A** from Tiledesk knowledge v1 draft2 — this lane cannot verify it directly (no Tiledesk connector). Supersedes the 400-min figure used in round 3, which was confirmed stale (August packet). |
| US & Canada per-minute termination cost | **Unknown — not asked for yet in this round** | Explicitly not assumed, per Lane A's instruction. Asking below. |
| Non-minute cost components (platform fee, Acrobits, VAT, processing, support/CAC, incoming reserve) | Unknown, itemized breakdown never provided | Only ever had the historical packet's top-line ~EC$7.86 *result*, which was built on the now-discarded 400-min allowance — that result no longer applies and this lane has nothing to replace it with yet |
| Unlimited-vs-fair-use-cap ruling | Owner-pending; Lane A's recommendation is fair-use 1,000/30 days, matching knowledge v1 | Still with the owner (checkpoint 14). Math below uses Lane A's recommended assumption, clearly labelled as an assumption, not a ruling |

## Path A — voucher spent as pay-per-minute Dominica calling (unchanged from round 3)

EC$10 ÷ EC$0.135/min (retail) = 74.07 min covered. Wholesale cost at the conservative mobile rate:
74.07 × EC$0.0193 ≈ **EC$1.43**.
EC$5 ÷ EC$0.135 = 37.04 min → 37.04 × EC$0.0193 ≈ **EC$0.71**.
This path doesn't depend on the plan's allowance, so it's unaffected by the round-4 correction.

## Path B — applied toward the EC$35 30-Day plan, computed fresh under the fair-use-1,000 assumption

**What I can compute cleanly:** the Dominica-minutes cost component, using the fair-use allowance Lane A
gave me and the measured mobile rate.
- **Worst case** (customer uses the full fair-use allowance): 1,000 min × EC$0.0193/min = **EC$19.30**.
- **Expected case:** pending VOICE's actual usage/call-mix data — likely well below worst case (fair-use
  ceilings are rarely fully used), but I have no number to put here yet.

**What I cannot yet compute:** the plan's full contribution. Two inputs are missing (US/CA per-minute cost,
and the non-minute cost components), and the round-3 workaround of patching the old ~EC$7.86 baseline no
longer applies now that the allowance underneath it changed. I'm not going to present a patched number this
round — asking for the real inputs instead (see below).

**What the worst-case Dominica cost alone already shows, before any other cost is even counted:**

| | Full price (no voucher) | EC$10 voucher | EC$5 voucher |
|---|---|---|---|
| Revenue | EC$35.00 | EC$25.00 | EC$30.00 |
| Worst-case Dominica cost alone | EC$19.30 | EC$19.30 | EC$19.30 |
| **Remaining before US/CA minutes, platform, Acrobits, VAT, processing, support/CAC, incoming reserve** | **EC$15.70** | **EC$5.70** | **EC$10.70** |

This is worst-case, not expected — but it's worth the owner seeing plainly: raising the fair-use allowance
from the old 400-min figure to 1,000 min nearly triples the worst-case Dominica cost exposure (EC$12.00 →
EC$19.30 at the same rate), which by itself leaves very little room for a EC$10 voucher discount once any of
the still-uncosted items (US/CA minutes, platform fee, Acrobits, VAT, processing, support/CAC, incoming
reserve) are added. Given the historical model's own first attempt landed *negative* before correction, I
would not want to tell the owner this is fine without the missing inputs — this table shows why.

## Question back to Lane A, as instructed — not assumed

**What is the actual US/Canada per-minute termination cost VOICE would read for this plan?** I need this
figure, plus the non-minute cost components (or an updated top-line contribution figure built on the
1,000-min allowance, if that's faster on your side), to finish Path B properly. Until then this file shows
Path A cleanly and Path B's worst-case Dominica exposure only — not a full contribution number.

## Sensitivity table — Path A only (Path B contribution withheld until the above lands)

| Signups | Voucher | Path A real cost (conservative mobile rate) |
|---|---|---|
| 50 | EC$10 | 50 × EC$1.43 ≈ **EC$71.50** |
| 200 | EC$10 | 200 × EC$1.43 ≈ **EC$286** |
| 50 | EC$5 | 50 × EC$0.71 ≈ **EC$35.75** |
| 200 | EC$5 | 200 × EC$0.71 ≈ **EC$143** |

Path B face-value exposure is unchanged by any of this (EC$10 or EC$5 × signups comes straight off plan
revenue regardless of cost inputs): 50×EC$10=EC$500, 200×EC$10=EC$2,000, 50×EC$5=EC$250, 200×EC$5=EC$1,000.
What's missing is the resulting **contribution**, not the exposure — withheld above rather than guessed.

## Two options for the owner — unchanged, per Lane A

**Option 1 — smaller voucher (EC$5).** Still no new engineering. Given the worst-case Dominica exposure grew
under the 1,000-min figure, this option matters more this round, not less — it leaves EC$10.70 before other
costs instead of EC$5.70.

**Option 2 — restrict the voucher to calls-only.** Still a real LINE/AGENT build item, not a copy change.
Removes Path B's risk entirely regardless of the allowance question, which — given this round's numbers
look tighter than round 3 suggested — may be worth the owner weighing more seriously now.

## Still open
1. **US/Canada per-minute termination cost** — asked above, not assumed.
2. The non-minute cost components (platform/Acrobits/VAT/processing/support-CAC/incoming reserve), or an
   updated top-line contribution figure built on the 1,000-min allowance.
3. VOICE's expected-usage/call-mix data, to move the Dominica-cost line from worst-case to expected-case.
4. The owner's ruling on unlimited-vs-fair-use-cap (Lane A's recommendation is fair-use 1,000/30 days,
   matching knowledge v1, but this is still pending, not decided).
5. The owner's cohort-size and voucher-size decision.
