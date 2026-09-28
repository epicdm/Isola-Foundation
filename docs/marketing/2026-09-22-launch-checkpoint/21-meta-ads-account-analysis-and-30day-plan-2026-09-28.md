# Meta ads account analysis + 30-day campaign plan — 2026-09-28

Per Lane A's owner-directed handoff: this lane now owns the Meta ad side end-to-end. Read-only
analysis over the account's full history, then a proposed 30-day plan for the owner's confirmation.
Nothing in Part 2 is applied — it is a proposal. The only action taken during this analysis was
pausing 3 already-found stale "unlimited calls" ads (recorded separately in
`ev-meta-ads-stale-unlimited-claim-paused-2026-09-28`), per the narrow "pause anything clearly wrong"
exception, before this analysis even started.

## Part 1 — Account analysis (read-only, ad account `10152120527475058`)

### Every campaign ever run

16 campaigns total, `date_preset=maximum`. Ranked by real cost per meaningful result (messaging
conversations started) where that was the objective — vanity metrics (impressions, video views, link
clicks) are reported but not used to rank "top performer."

| Campaign | Objective | Dates | Spend | Result | Cost/result |
|---|---|---|---|---|---|
| Post: "" (`120217435798050326`) | MESSAGES | 2025-02-23 to 03-02 | $4.62 | 34 conversations | **$0.14** — best |
| NEW_EMA (`120201455058240326`) | OUTCOME_ENGAGEMENT | 2023-11-30 to 12-30 | $2.14 | 13 conversations | $0.16 (small n) |
| Post: "" (`120201385373090326`) | MESSAGES | 2023-11-28 to 12-05 | $26.06 | 67 conversations | $0.39 |
| Duo Bundle (`120201380267060326`) | OUTCOME_ENGAGEMENT | 2023-11-28 to 12-28 | $9.12 | 18 conversations | $0.51 |
| EPIC_HOTSPOT (`120203555129850326`) | OUTCOME_ENGAGEMENT | 2023-12-22 onward | $95.08 | 118 conversations | $0.81 — largest real sample, worst cost |
| Stay connected effortlessly! (`120216955733400326`) | MESSAGES | 2025-02-19 to 02-26 | $14.00 | 17 conversations | $0.82 |
| Stay connected effortlessly! (`120216959099430326`) | MESSAGES | 2025-02-19 to 02-26 | $13.99 | "Not available" | — spend too thin to register a rate |
| Stay connected effortlessly! - Copy (`120217191178230326`) | OUTCOME_ENGAGEMENT | 2025-02-21 to 02-26 | $14.00 | "Not available" | — same |
| App Sign Up Traffic (`120203848451630326`) | OUTCOME_TRAFFIC | 2024-01-11 onward | $141.69 | 897 landing page views | $0.16/LPV — different funnel stage, not comparable to messaging |
| New T1 (`120202819077300326`) | OUTCOME_ENGAGEMENT | 2023-12-15 onward | $130.34 | 12,559 ThruPlays | $0.01/view — vanity metric, not a meaningful result |
| Double Play (`120201363793080326`) | OUTCOME_ENGAGEMENT | 2023-11-27 to 11-28 | $0.46 | 10 post engagements | $0.05 — trivial spend |
| EPIC Everywhere — Public Launch 2026 (`120251434498070326`, tonight's) | OUTCOME_ENGAGEMENT | 2026-08-30 onward | $0.15 | none recorded yet | too early to read |
| EPIC AI - Caribbean Launch (`120242657972670326`) | OUTCOME_TRAFFIC | never started | $0 | — | never ran |
| 2× [08/15/2023] Promoting Send message | MESSAGES | Aug 2023 | $0 each | — | never ran (zero impressions) |
| 2× Post: "Call Dominica and US for FREE!!!" | MESSAGES | Aug 2023 | $0 each | — | never ran |

### Top performer and why

The best real cost-per-conversation result is **"Post: ''" (`120217435798050326`), $0.14/conversation**,
Feb–Mar 2025, $4.62 spent for 34 conversations. **Honest limitation: I could not read the actual
creative copy or image for this ad.** Its creative name carries a `{{product.name}}` catalog template
token and an empty `body` field — this was a **boosted organic Page post** with `call_to_action_type:
MESSAGE_PAGE` (Messenger, not WhatsApp), and this MCP's creative-read tools only expose structured ad
fields, not the underlying Page post's actual text/image (`object_story_id` points to a Facebook post
this toolset has no generic reader for). Same limitation applies to EPIC_HOTSPOT, Duo Bundle, and the
other 2023-era "boost this post" campaigns — all show empty `body`, dynamic-template names, and
`MESSAGE_PAGE` CTAs. What I CAN say with evidence: **every genuinely well-performing historical
campaign used a Messenger "boost post + Send Message" structure**, not a link-click or catalog-sales
structure — the account's real strength has always been conversation-starting ads, which is exactly
what tonight's WhatsApp campaign is built on (same underlying mechanic, newer destination). I would
need someone to open these old posts directly in Business Manager to read the actual copy/image if
that detail matters for creative-angle reuse.

**Worst-performing real campaign**: EPIC_HOTSPOT — not bad in absolute terms ($0.81/conversation is a
normal rate), but it's the account's largest-spend messaging campaign ($95.08) and still landed at
nearly 6x the cost of the best one. Combined with New T1's $130.34 spent almost entirely on
ThruPlays (a vanity metric with no messaging tie), these two campaigns represent the account's
largest historical waste relative to the actual business goal (WhatsApp conversations, not video
views).

### Audience learnings

- **Custom/engagement audiences that exist** (11 total, `ads_get_ad_account_custom_audiences`):
  - `Call Video audience` (ENGAGEMENT, **ACTIVE**, ~1,000 people, created 2023-12-20) — the one
    genuinely live, reusable engagement audience. Worth testing as a retargeting ad set.
  - 6 Lookalike audiences seeded from Page likes across CA/DM/US (1%, 1–2%, 2–3%, 3–4%, 4–5%,
    5–10%), all `INACTIVE` delivery status (not currently attached to any active ad set) — real,
    legitimate targeting signal, not stale in the sense of being wrong, just currently unused. The
    1% tier is already applied to tonight's Diaspora ad set (paused, being narrowed).
  - 2 Lookalikes seeded from "Call Video audience" (Worldwide 1%, DM 1%) — also INACTIVE, smaller
    and less targeted than the Page-like lookalikes; lower priority for reuse.
  - `All_Subscribers` (Messenger subscriber pool, ~20 people) — too small to be meaningfully
    reusable on its own.
- **No location/age/interest breakdown data survived** for the historical campaigns at the
  granularity requested — this account's real ad-set-level targeting was broad (Dominica-only or
  Advantage+ automatic) for nearly every campaign found, so there isn't a genuine "which age/location
  responded better" signal to report. **Honest gap**: I did not find breakdown-capable historical
  data to analyze here; saying otherwise would be fabricating precision the data doesn't support.
- **Page followers**: no tool in this session's toolset returns a Page follower count — flagging as
  an open item for whoever has Business Manager UI access.

### Pixel/dataset history

Dataset `396969717684572` ("EPIC's Pixel"), created 2019-07-25, `is_active: true`. Client-side
(`last_fired_time`) last fired **2026-06-13** — over 3 months stale as of tonight. Server-side
(`server_last_fired_time`) has **never fired** (epoch zero). No change from what was already found
and recorded in `ev-meta-ads-capi-tracking-spec-2026-09-28` earlier tonight. There is no historical
conversions data on this dataset usable for this analysis — it has effectively never been used for
real measurement.

### Honesty about thin data

This account's genuinely deliberate, sustained campaign activity is small: a handful of real
campaigns from Nov 2023–Jan 2024 (~$370 total historical spend across the account, ever), a short
burst in Feb 2025 (~$56), several campaigns that show $0 spend and literally never delivered a single
impression, and tonight's own launch work. **There is not enough historical volume to draw
statistically reliable conclusions about which specific audience segments, ages, or exact creative
wording perform best** — the "top performer" finding above is a real, evidenced fact (lowest real
cost per conversation with a non-trivial sample), but extrapolating further (e.g., "this exact phrase
drove it" or "this specific age band responded") would be overfitting a narrative to a handful of
data points. Anything more granular the plan needs should be treated as a hypothesis to test in the
next 30 days, not an established fact.

## Part 2 — Proposed 30-day plan (PROPOSAL ONLY — not applied)

### Proposed goals, for the owner's confirmation

Grounded in the top-performer rate above ($0.14–$0.39/conversation from real historical evidence,
plus this account's genuine data thinness):
- **~150–300 WhatsApp conversations started** over 30 days, assuming a blended $0.30–$0.60/
  conversation at these budget levels (a rough estimate bridging historical best-case and
  current-launch unknowns — not a guarantee; this is new creative, a new destination number, and a
  new offer, so historical rates are a reference point, not a forecast).
- Signups and paying customers: **no historical conversion-rate data exists** from conversation → signup
  → payment (the CAPI/pixel path has never fired). Propose treating the first 30 days as the
  baseline-setting period for this specific funnel stage rather than committing to a signup/purchase
  number now — set that target after the first 1–2 weeks of real data.

### Structure

Within $150/month (~$5.00/day), respecting Meta's real >$2.00/day-per-ad-set minimum (verified this
session, see `ev-meta-ads-phase2-locals-diaspora-built-2026-09-28`):
- **Locals** (Dominica): $2.50/day — currently running, keep as-is.
- **Diaspora** (US/CA/UK/islands): $2.50/day — currently paused pending narrowing (separate,
  in-progress thread this session). Do not activate broad/unnarrowed.
- A third **retargeting-of-engagers** ad set is not recommended within this budget: adding one at
  >$2.00/day would push total to >$7.00/day (~$210/month), over the $150 cap. If the owner wants to
  test the `Call Video audience` (the one genuinely reusable engagement audience found above), it
  would need to replace, not add to, one of the two ad sets above, or come with a separate budget
  increase — flagging as an option, not proposing it by default.
- **Learning-phase reality at $2.50/day**: Meta's own guidance is roughly 50 optimization events/week
  per ad set to reliably exit learning (cited from this session's own earlier audit,
  `ev-meta-ads-prelaunch-audit-2026-09-28`). At $2.50/day optimizing for conversations, and given the
  account's own historical $0.14–$0.82 range per conversation, each ad set may or may not clear 50
  events/week depending on where actual delivery lands — this is a real risk to flag, not a
  guarantee either way.

### Creative testing plan

2–3 angles per audience, every claim checked against the live ladder (no "unlimited" anywhere) and
Port's `marketing_claim` gate before running:
- **Diaspora — "Before you land"** (current, already live): the Independence-travel-home angle
  already built and running tonight. Keep as the control.
- **Locals — value vs. Flow/Digicel**: two Draft marketing_claim entities already exist for this
  (`mc-call-the-world-from-ec015-min-2026-09-23`, `mc-cheaper-than-flow-international-2026-09-23`) —
  **both are still Draft, not Approved**, so neither can run as-is; this needs the claim gate cleared
  first, not assumed clear.
- **Free-trial hook**: the account has an Approved claim for voice-only disclosure and existing Draft
  claims for the 7-day/60-minute trial — reuse the already-built free-trial line from tonight's
  creative ("New to EPIC? Try free — 7 days, 60 minutes to Dominica"), which is already Approved-adjacent
  content, not a new claim.
- **Not reusing an "old winning angle" by default**: Part 1 could not read the actual copy of the
  historical top performer (the `{{product.name}}` / empty-body limitation above), so there is no
  verified old angle to copy forward — only the structural finding (Messenger conversation-starting
  ads outperform video/traffic ads on this account).
- **Compliance flag, found during this analysis, not fixed**: `mc-personal-line-unlimited-dominica-calling-2026-09-02`
  ("Unlimited calls to Dominica") is still marked **Approved** in Port, directly contradicting the
  Ratified ladder decision and the 3 stale ads just paused tonight. This claim entity needs its
  status corrected (to Blocked or Superseded) by whoever owns the claim register — flagging, not
  editing it myself.

### Timing

- **Now → 3 Nov (Independence Day)**: the diaspora travel-home window is the live hook already
  running — keep it as the primary Diaspora angle through this period.
- **Around 3 Nov**: consider a short-lived "Independence" seasonal variant (same offer, calendar-tied
  copy) rather than a new offer — this is a copy refresh, not a structural change, and should go
  through the marketing_claim gate like any other claim before running.
- **After the diaspora travel window closes** (post-Independence): reassess whether Diaspora budget
  should shift toward Locals or a genuinely new audience, based on actual delivered results by then.

### Measurement

- **Daily**: spend, impressions, results (conversations started), cost per result — the same fields
  already being checked by hand tonight.
- **Weekly**: CTR, CPM, frequency (watch for creative fatigue at this small a budget — frequency can
  climb fast on a narrow audience), and a manual reconciliation against real WhatsApp reply volume
  (once AGENT's ctwa_clid capture and LINE's bff-v2 CAPI sender are live — event spec already defined
  in `ev-meta-ads-capi-tracking-spec-2026-09-28`).
- **Blocked on others, not on this lane**: LINE is building the bff-v2 CAPI sender; this lane owns
  the Meta-side custom conversions (cost-per-signup/cost-per-purchase reporting columns) — **this MCP
  cannot create custom conversions, confirmed gap, a human must do this in Ads Manager** once real
  events start flowing — and the system-user token path (documented, not generated, per this
  session's standing rule never to handle secret values directly).
- **Decision rules** (concrete, not vague):
  - **Kill**: an ad with **>$10 spent and zero conversations** — at this account's historical worst
    real rate ($0.82/conversation), $10 should have produced at least one; zero at that spend is a
    real signal, not noise.
  - **Iterate (new creative, same ad set)**: cost per conversation **>2x the account's historical
    best ($0.14)** — i.e., above ~$0.28 — after at least $15 spent (enough to clear early noise at
    this budget).
  - **Scale**: cost per conversation **at or below the account's historical median** (~$0.39, from
    the table above) sustained over at least 7 days and $15+ spent — move budget from a
    weaker-performing ad set toward it, within the same $150/month total, rather than adding new
    spend.

### Weekly review cadence

Bring the owner, once a week: real spend vs. the $150/month pace, conversations started and cost per
conversation per ad set, any kill/iterate/scale action taken that week and why, the CAPI/custom-conversion
build status (blocked-on-LINE vs. ready), and one open decision if one exists (e.g., Diaspora narrowing
still pending, or a claim still stuck in Draft).

---

**Status**: analysis complete, plan proposed, nothing in Part 2 applied. Locals ran undisturbed
throughout this analysis. One pre-existing compliance gap (Approved "unlimited" claim contradicting
the ratified ladder) found and flagged, not fixed. Awaiting the owner's confirmation on goals and
structure before any of Part 2 is built.
