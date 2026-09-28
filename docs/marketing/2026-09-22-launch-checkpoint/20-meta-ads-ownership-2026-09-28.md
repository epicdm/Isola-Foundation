# Meta ads — full ownership handoff, 2026-09-28

Per Lane A's dispatch and `dec-owner-launch-night-approvals-2026-09-28` (Ratified, checked directly) /
`ev-personal-line-ads-support-execution-gap-2026-09-28` (checked directly — detailed, specific, credible:
exact object IDs, exact statuses, exact timestamp). Creative, US$3/day and the 3742 CTA are already
approved — not re-asking for those.

## Access re-checked just now, not assumed from last week

Called `devtools_app_list` fresh: still only `EPIC_BFF`/`EPIC_BFF_test` app-inspection access, same as every
prior check this week. **No Ads Manager publishing access exists for this lane today.** Per Lane A's own
framing, that means the owner performs the clicks — steps below are written for him, refined against the
evidence entity's exact object IDs rather than guessed.

## Current Meta state, as read by the Senior PM (not re-verified by me — no access to verify with)

- Campaign `120251434498070326`.
- Ad set `120251434778270326` — paused, US$3/day configured, targeting Dominica only.
- Ad `120251435084370326` — paused, creative `2888278648196166` still promises 15 free minutes. **Must not
  run as-is.**

## Phase 1 — stop the wrong creative, get the approved one live (do this first, it's the urgent fix)

Uses the existing single ad set, Dominica-only targeting, unchanged for now — Phase 2 below restructures
targeting afterward, same session.

1. Open Ads Manager → campaign `120251434498070326` → ad set `120251434778270326` → ad `120251435084370326`.
2. **Remove creative `2888278648196166`** (the 15-free-minutes one) from this ad — edit the ad and replace
   its creative rather than leaving the old one attached anywhere.
3. **Set the new creative:**
   - Destination: **WhatsApp** (not Website).
   - WhatsApp number: **+1 767 818 3742**.
   - Prefilled message, exactly: `Hi — I'd like my own Dominica number with Isola.`
   - Media: the two PNGs at the **current branch head** —
     `docs/marketing/2026-09-22-launch-checkpoint/creative/diaspora-feed-1080x1080.png` (feed) and
     `diaspora-story-1080x1920.png` (story) — these carry the corrected "1,000 minutes to Dominica &
     US/Canada" wording from the last update, not an older version.
   - Primary text: the caption from checkpoint 18 §2 ("Your Dominican number. Before you land. After you
     leave. 🇩🇲 Get set up before you travel home for Independence...").
   - Headline (short field): **"Your Dominican number. Before you land."**
   - Button: **"Send WhatsApp message"**.
4. **Confirm budget still reads US$3/day** before publishing — stop and check with Lane A if it doesn't;
   this does not authorize any change to it.
5. Publish, then toggle the ad (and ad set, if it's the one paused) to Active.
6. **Check:** delivery status shows "In review" (normal, not an error); ad preview opens WhatsApp to 3742
   with the message intact; the old 15-minute creative is genuinely gone, not paused alongside the new one.

## Phase 2 — audience fix, same total budget, same session

**Do not increase total spend, and do not claim the Dominica-only audience already reaches the diaspora —
it doesn't, that's exactly the gap being fixed.**

1. Duplicate ad set `120251434778270326` (now carrying the corrected Phase-1 ad) to create two ad sets:
   - **Ad set A — "Locals":** keep targeting Dominica, age 18+. Budget **US$1.50/day**.
   - **Ad set B — "Diaspora":** new targeting —
     - Locations: United States (New York, New Jersey, Massachusetts, Florida), Canada (Toronto, Montreal),
       United Kingdom (London), and the nearby islands (US Virgin Islands, Antigua and Barbuda, St. Maarten).
     - Detailed targeting: try **"Lived in Dominica"** (sometimes labelled "Expats – Dominica" in Meta's
       targeting browser) if it's offered for this ad account. **If it isn't available** (targeting options
       vary by account/region and I can't confirm it's offered without access), fall back to interest
       targeting on **Dominica** and/or **Roseau**.
     - Budget **US$1.50/day**.
2. Both ad sets carry the same Phase-1 ad (creative/destination/copy) — duplicate the ad into each ad set
   rather than building a new one.
3. **US$1.50 + US$1.50 = US$3.00/day total — same as before, not additional.** Confirm this before
   publishing either.
4. Once both are confirmed correctly configured, pause the original single Dominica-only-at-$3 ad set
   rather than deleting it — keeps it reversible if something needs rolling back.
5. Publish both new ad sets.

## State tracking — record only what Meta actually shows, per Lane A's instruction

Three distinct, real states — not assumed from one another:

| State | What it actually means | Evidence needed before recording it |
|---|---|---|
| **Prepared** | Creative + targeting configured in Ads Manager, not yet published | Owner/Lane A confirms the ad/ad sets are set up as above |
| **Submitted** | Owner clicked publish/activate | Meta shows "In Review" (or equivalent) status — not just "I clicked publish" |
| **Delivering** | Review passed, ad is actually serving | Meta shows "Active"/delivering status **and** first real delivery numbers (impressions/clicks/results) |

**Will not record "delivering" on the strength of "submitted"** — per the evidence record's own discipline
("absence of receipt is not proof execution did not happen," applied here in reverse: a submitted ad is not
proof it's delivering either). Waiting on real Meta-shown status at each step, reported by whoever is
actually looking at the account.

## Support-side note — held, not acted on

3742 is moving to Tiledesk tonight per Lane A. **Not updating the staff script in checkpoint 18 until Lane A
confirms it's actually live** — the script still assumes the current bff-v2 concierge path until told
otherwise.

## Status

Nothing published, no ad activated, no spend changed by this checkpoint. Ready for the owner to execute
Phase 1 then Phase 2 in one session; reporting back with real Meta-shown status at each state, not before.
