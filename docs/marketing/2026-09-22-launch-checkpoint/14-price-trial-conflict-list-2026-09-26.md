# Reconciled price/trial conflict list — for the owner, NOT public copy

Compiled from every pricing source this lane has touched over the past week. One-page version of a
week's worth of discrepancy-finding, so the owner sees the full picture in one place instead of piecemeal.

| Term | `dec-personal-line-launch-pricing-and-pay-rail-2026-09-02` (original decision) | Historical packet's "Commercial update 2026-09-02" (marked stale by the packet itself) | Live catalogue, measured by Lane A 2026-09-23 (real debits, control verified) | Current `epic_offer` Port entities (as of today) |
|---|---|---|---|---|
| Day Pass | EC$5/1 day | EC$5/24h, 40 Dominica min, no US-CAN | EC$5 | EC$5 — **agrees everywhere** |
| Week Pass | EC$15/7 days | **EC$18**/7d, 150 Dominica+30 US-CAN | EC$15 | EC$15 (corrected 2026-09-23 from EC$18) — **3-way agreement now; historical packet was the odd one out** |
| 30-Day / Personal Line | EC$35/30 days | EC$35/30d, 400 Dominica+60 US-CAN | EC$35 | EC$35 — **agrees everywhere** |
| Top tier ("Unlimited+"/"Plus") | EC$55/30 days | **EC$60**/30d, 750 Dominica+150 US-CAN | EC$55 | EC$55 (corrected 2026-09-23 from EC$60) — **3-way agreement now, but flagged today as "provisional" pending Knowledge v1** |
| Dominica calling | "unlimited... every plan," fair-use 1,000 min/30d **stated**, Magnus rates it 0/min **by design** | Explicitly "No public 'unlimited' claim" | No cap configured on any plan; Magnus still rates Dominica 0/min (matches the original decision's design, not the historical packet's caution) | `mc-personal-line-unlimited-dominica-calling-2026-09-02` is **Blocked** — asserts a hard 1,000-min cap exists and makes plans loss-making. **This directly contradicts the original decision and the live measurement.** Unresolved — the single biggest open conflict. |
| US/Canada overage rate | EC$0.25/min | EC$0.25/min | **Day Pass's Magnus plan 53 actually rates US at EC$0.99/min** — a ~4x live discrepancy, under verification as a charging bug (not a pricing decision) | — |
| Trial | Free number + 7-day/15-min, ≤5 US-CAN min | Same terms restated | Not independently re-verified by this lane | `offer-personal-line-trial-7d-15min-2026-09-02` — Ratified, but this is a **different product** from the newer universal free-CALLBACK trial (`dec-call-dominica-for-free-universal-whatsapp-signup-magnus-first-2026-09-21`), which is separately paused. Don't conflate the two in any copy. |
| Fair-use enforcement | "Fair-use 1,000 Dominica min/30 days **stated on the offer**" (policy language) | — | **No cap enforced on any plan today** — matches "stated, not enforced" reading of the original decision | The plan schema's own docs cite derived per-day figures (34 min/day, 3600s/call) that **nobody ratified** — don't use these numbers anywhere |

## The one decision that actually blocks copy

Everything above is either already resolved (the two EC$18/60 → EC$15/55 corrections) or is a pure
engineering/billing bug (the US rating discrepancy) that doesn't change what marketing can honestly say.
**The one real open question is whether Dominica calling is unlimited (as designed and as currently
running) or capped (as the Blocked claim asserts).** Until that's answered, this lane cannot write "Plus"
or any Dominica-minutes claim for the top tier, and the historical packet's own opening concierge script
("unlimited" is absent from it already, for what it's worth) can't be extended into new campaign copy
either.

## Recommendation

Ask the owner directly: does the top tier ship as genuinely unlimited Dominica calling (matching the
2026-09-02 pricing decision and what Magnus is actually configured to do), or was that always meant to be
capped and the configuration itself needs fixing before launch? Whichever answer, `mc-personal-line-unlimited-dominica-calling-2026-09-02`'s
status should then be updated to match — by whoever owns that entity, not this lane.
