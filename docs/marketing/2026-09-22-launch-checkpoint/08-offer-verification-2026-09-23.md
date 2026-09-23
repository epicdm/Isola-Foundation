# Offer verification — 2026-09-23 (Lane A dispatch, Senior PM directive)

## Task
Verify the sellable Personal Line offer against Port's `marketing_claim`/`epic_offer` register: public
entry page(s), the 0001 concierge's upsell pitch, plan labels/prices, and destination links.

## Headline finding
The live public page (`https://test.epic.dm/lite/plans`, verified genuinely anonymous — HTTP 200, empty
localStorage, no auth token, unlike yesterday's isola-lumen-prod trap) is itself advertising two things
Port explicitly prohibits, independent of the 0001 concierge pitch that triggered this check:

1. **"Unlimited Dominica calls — Every plan includes unlimited calling to Dominica."** Contradicts
   `mc-personal-line-unlimited-dominica-calling-2026-09-02` (**Blocked** — "Do not publish... a hard cap is
   not unlimited... loss-making at cap use").
2. **"Make your line answer 24/7 — Turn Isola Lite into a full AI receptionist — same number"** / **"AI
   catches missed calls — It answers, takes a message, texts you."** Contradicts
   `offer-missed-call-recovery-not-offered` — an explicit negative record: "DARK in production... must not
   be sold, demoed or implied... Never demo it." Also doesn't match the one real, priced offer in that
   space (`offer-epic-ai-upgrade-existing-line`: EC$250 setup + EC$99/mo, existing-phone-customers only,
   "No voice AI," "No guaranteed missed-call recovery") — the page implies a free same-number upgrade with
   none of those conditions attached.

The 0001 concierge's separate upsell pitch ("Unlock unlimited Dominica minutes, extra lines, and a full
business AI agent on Isola 🚀") repeats the unlimited-calling problem, adds "extra lines" with **no backing
offer at all** (closest product `offer-epic-hosted-business-pbx` is status "Later," not recommendable, price
"Owner decision required"), and separately cross-sells the Smart Business Line product into a Personal Line
conversation.

**Also notable:** all five Personal Line paid-plan offers in Port (trial, day pass, week pass, 30-day,
plus) are `agent_recommendable: false`. The concierge proactively upselling at all is a separate question
from which specific claims it uses — flagged to AGENT as a PM-level call, not something I resolved by
rewriting one line.

**Could not verify:** an anonymously-reachable plan picker actually showing the ratified prices (Day Pass
EC$5/24h, Week Pass EC$18/7d, 30-Day EC$35/30d, Plus EC$60/30d, Trial EC$0) — none of these labels/prices
appeared in the page's DOM at initial load. Did not proceed into "Get my free number" to avoid starting a
real signup. Also could not locate the "See plans & pricing" string Lane A's dispatch referenced — asked
AGENT for its current literal destination since I have no way to see what 0001 sends without messaging it
as a test customer (not this lane's role).

## Actions taken
- Recorded `evidence/ev-lite-plans-page-and-0001-upsell-unapproved-claims-2026-09-23` in Port.
- Sent full verification table to Lane A (`agno-refine-bff-host03-cutover`).
- Sent a PR request with corrected concierge copy directly to AGENT (`isola-foundation-6d`) — did not edit
  bff-v2 myself, per the dispatch's own instruction.
- Did not touch `test.epic.dm/lite/plans` page copy myself in this pass — that's a PR + Codex review
  through my normal channel if/when I own that surface's source; flagged the exact corrected text in the
  table sent to Lane A first since ownership of that page's repo wasn't stated in the dispatch.

## Resolution, Lane A same day
Routed to AGENT: removes the blocked "unlimited" claim and the AI-receptionist/missed-call copy from
`/lite/plans`, adopts the corrected upsell string, and fixes "See plans & pricing" (confirmed a concierge
button — AGENT will report its current destination). Ships in the same deploy batch as the hand-off fix.
The `agent_recommendable: false` question (may the concierge proactively upsell plans at all, or only
answer when asked and route to a human) is going to the Senior PM/owner as a decision. Keeping a neutral
fallback string ready for either answer: **"Reply *plans* to see prices."** — no specific plan named, no
claim beyond directing to the (soon-to-be-verified) real picker. Labels will be checked against the
ratified EC$5/18/35/60 once AGENT's copy PR reaches staging (the price-labelled picker renders post-sign-in,
which is why it wasn't visible in my anonymous pass).

## Free-callback status
Confirmed untouched by any of this — not referenced on either surface checked, consistent with it staying
held (`FREE_CALLBACK_ENABLED=false`, grants paused).
