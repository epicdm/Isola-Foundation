# Offer/configuration discrepancies — 2026-09-23 (Lane A measurement, read-only)

Added to the offer-verification table per Lane A's request. Nothing changed — proposal only for item 1,
notes only for items 2 and 3, plus one additional discrepancy this lane found while checking Lane A's
evidence against Port.

## Item 1 — Plan named "Unlimited+" carries a Blocked claim in its own customer-facing name

**Evidence, and a real conflict between two Port records that a rename alone doesn't resolve:**
- `mc-personal-line-unlimited-dominica-calling-2026-09-02` — **Blocked**: "Do not publish. EPIC pays
  EC$0.03 for each local/incoming minute; a hard 1,000-minute cap is not unlimited and makes the
  EC$35/EC$55 plans loss-making at cap use."
- `dec-personal-line-launch-pricing-and-pay-rail-2026-09-02` — **Ratified** (same day): names the plan
  ladder itself as "EC$5 day / EC$15 week / EC$35 month / **EC$55 Unlimited+**," states "unlimited Dominica
  calling on every plan... fair-use 1,000 Dominica min per 30 days *stated on the offer*," and records that
  Magnus plans 53-56 rate Dominica at **0.000000/min by design** — i.e., the original decision intended
  genuinely unrated Dominica calling with a fair-use *term* disclosed to the customer, not a technically
  enforced cap.

These two Port records contradict each other on the same subject, dated the same day. I'm not resolving
which one is current — that's a product/pricing call, not mine — but a plan **rename** is safe under either
reading, since it removes the word "unlimited" from customer-facing UI regardless of which interpretation
of the underlying policy wins.

**Proposed corrected name: "Plus."** Matches the existing Port `epic_offer` title ("Personal Line Plus — 30
Day") and the plain-label pattern already used for the other tiers (Day Pass, Week Pass, 30 Day). No claim
implied beyond the plan being the higher tier.

**Separate, unresolved, flagged for the owner/Senior PM, not decided here:** is Dominica calling meant to
ship genuinely unlimited (as the original pricing decision designed and Lane A's measurement confirms is
what's actually running), or capped (as the later marketing_claim entry asserts)? Whichever is true changes
more than the plan's name — it changes what the offer summary in my launch package (checkpoint file 09) can
honestly say about Dominica minutes at all. I used the Blocked-claim framing (no "unlimited" anywhere) in
that package as the conservative default; if the owner confirms the original design stands, that package's
offer table would need a different, less restrictive Dominica line.

## Item 2 — "Fair-use 1,000 min/30 days" is stated policy, not enforced configuration; the per-day numbers are unratified

Lane A's measurement: no plan has a minute cap configured; nothing enforces a cap or fair use; Magnus rates
Dominica at 0/min on plans 53-56. The "fair-use 1,000 Dominica min per 30 days" language does appear in the
original ratified decision as a customer-facing *term*, but it is not a system-enforced limit today. The
derived per-day figures cited in the plan schema's docs (34 min/day, 3600s/call) are, per Lane A, **not
ratified anywhere** — nobody decided those specific numbers; they look like a documentation author's own
arithmetic.

**Customer-copy implication:** any Dominica allowance language must match what's actually approved (the
original decision's "unlimited... fair-use 1,000 min/30 days stated on the offer" framing, if that's still
current per the owner's answer to Item 1) — never the unratified 34 min/day figure, and never implying the
fair-use term is technically enforced when it isn't.

## Item 3 — US rating: Day Pass charges 4x the documented rate

Day Pass's Magnus plan 53 rates US number 1212 at **EC$0.99/min**, while the plan docs (and the original
pricing decision) say **EC$0.25/min** for US/Canada. Worth noting: the original decision also states Day
Pass has "no intl minutes" as part of its design, so a US call on Day Pass may not be an intended use case
at all — but if a customer places one, they'd be charged roughly 4x the documented rate either way. Pricing
correction is an owner decision; noted here as a discrepancy only, not acted on.

## Additional discrepancy found while checking Lane A's evidence: the price ladder itself doesn't match between two Port sources

My launch package (checkpoint 09) used the `epic_offer` entities' prices: Day Pass EC$5, Week Pass **EC$18**,
30-Day EC$35, Plus **EC$60**. The original pricing decision (`dec-personal-line-launch-pricing-and-pay-rail-2026-09-02`)
states Day Pass EC$5, Week Pass **EC$15**, Personal Line (30-day) EC$35, Unlimited+ **EC$55**. Week Pass and
the top tier disagree by EC$3 and EC$5 respectively between the two records. The `epic_offer` entities are
individually marked `price_status: Ratified` and are the more recent, structured commercial-offer objects,
so I used them in the launch package as the more likely-current source — but I have not confirmed which
record actually superseded the other, and I'm flagging that gap rather than assuming my choice was right.

## What I'm doing with this
Not changing any code, plan name, or Port entity myself. Sending this table addition to Lane A. The Item 1
name proposal ("Plus") is a suggestion for whoever owns that customer-facing string, not applied by me.
