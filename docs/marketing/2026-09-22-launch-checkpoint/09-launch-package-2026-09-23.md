# Launch package — Personal Line paid-plan campaign, 2026-09-23

Prepared per Lane A's dispatch under `dec-concierge-proactive-contextual-help-and-recommendations-2026-09-23`
(Ratified, owner). **Content preparation only — not published, not scheduled, no spend.** Waits on the
fresh-customer demo the decision itself requires (one signup, one recoverable problem, one human
escalation) before anything here goes live.

## 1. Ad preview — text + creative spec

**Headline:** Your Dominica number. Wherever life takes you.

**Body:**
Call home to Dominica from the EPIC app. Message us on WhatsApp — we'll set up your line and get you
calling in minutes.

**Required disclosure (visible, not link-only):** Voice calling service only. SMS and emergency calling are
not supported.

**What's deliberately NOT in this ad**, per dispatch scope and the current claim register: no free-callback
mention, no "unlimited," no AI receptionist/missed-call feature, no hero pricing line (`mc-personal-line-plans-from-ec5-2026-09-02`
is Draft and explicitly restricted to "the plan selector or visitor retargeting," not the hero ad message).

**Creative spec:** Real UI illustration of the app mid-call or showing the Dominica number — labelled as a
product illustration, not presented as a live screenshot, until an approved capture exists (still the same
open asset dependency from the first checkpoint). EPIC logo, unaltered, standard placement. Large,
legible mobile type; light background; no generated people presented as customers.

**Audience:** diaspora (USA/Canada) and Dominica-resident cuts, same structure as Package 1 in the first
checkpoint — swap only the "away from home" vs. "at home" framing line.

## 2. Destination

**Primary: `https://wa.me/17678180001`** — no prefill, no query parameter, no `(campaign:<id>)` attribution.
`dec-wame-prefill-may-carry-nonsecret-campaign-attribution-id-2026-09-21` is still **Open** (not ratified)
and is scoped specifically to the `/free-call` page anyway — no ratified attribution mechanism exists for
this destination, so per the dispatch's own rule ("otherwise none"), the link stays bare.

- **Verification:** a wa.me link isn't independently content-checkable by curl — it just opens WhatsApp
  with the target number. 0001 is documented as the live Personal Line Concierge (protected number,
  ratified `dec-concierge-number-0001-ratified-2026-08-28`). The actual content check that matters —
  whether 0001 answers accurately about this exact offer — is AGENT's in-progress verification pass,
  **still open** since I first asked about it (checkpoint file 06, Q1). Not resolved yet.

**Secondary reference, NOT usable yet: `https://test.epic.dm/lite/plans`.** Re-checked just now
(2026-09-23): still HTTP 200, still the same 63,707-byte bundle, and still contains "unlimited" and
"missed call" in the served content — **AGENT's fix has not deployed yet.** Do not point any ad at this URL
until it's redeployed and I re-verify the content check passes.

## 3. Concierge introduction line, for someone arriving from the ad

Proposed (a PR request for AGENT — bff-v2, not edited by this lane):

> "Hi! 👋 Welcome to EPIC. I'll get your own Dominica number set up — it only takes a few minutes. Voice
> calls only (no SMS or emergency calling). First, is this the WhatsApp number you'd like to use for your
> line?"

Notes: puts the mandatory disclosure early, before any commitment step; makes no plan/price promise up
front (plans come up contextually per the new decision, once the concierge knows the customer's actual
need); doesn't claim instant/self-serve completion, consistent with `cap-lite-calling`'s "assisted/managed
onboarding only" condition.

## 4. Supported offer summary, with Port claim/offer ids

| Element | Claim/offer id | Status | Note |
|---|---|---|---|
| "Call home to Dominica from the app" | `claim-call-home-dominica` | Approved / Verified-and-Sellable | Core ad claim |
| Voice-only disclosure | `mc-personal-line-voice-only-disclosure-2026-08-30` | Approved | Mandatory, must stay visible |
| Concierge-assisted onboarding (message → set up → install app → call) | `cap-lite-calling` | Conditional, "LIVE NOW — assisted/managed onboarding only" | Self-serve is Future; don't imply instant signup |
| Day Pass — EC$5, 24h | `offer-personal-line-day-pass-2026-09-02` | Managed pilot, price Ratified | `agent_recommendable` still reads false in Port — decision says this should now read "recommendable contextually"; flagging as a pending Port housekeeping item, not mine to flip |
| Week Pass — **EC$15**, 7d | `offer-personal-line-week-pass-2026-09-02` | **Price corrected 2026-09-23** — Lane A measured the live catalogue (`lite_plans`, what checkout actually charges, control: recent debits of -5) as EC$15, matching the original pricing decision, NOT the EC$18 the `epic_offer` entity records. Quoting the live price per Lane A's instruction; same `agent_recommendable` flag note applies |
| 30-Day — EC$35/30d | `offer-personal-line-30d-2026-09-02` | Managed pilot, price Ratified | Matches both sources — no conflict here |
| ~~Plus — EC$60/30d~~ **HELD** | `offer-personal-line-plus-2026-09-02` | **Do not quote a price or a name for this tier yet.** Live catalogue charges EC$55, not EC$60 — but the tier's own name ("Unlimited+") and its Dominica-allowance framing are the subject of the unresolved unlimited-vs-Blocked-claim conflict (checkpoint 10, item 1), now with the owner. Holding this row entirely — no price, no name, no copy — until that answer lands. |

**Deliberately excluded from this ad**, per dispatch scope: `offer-personal-line-trial-7d-15min-2026-09-02`
(the older Personal Line trial — a different product from the held free-callback, per LINE's own
reconciliation note on 2026-09-22, but not in the dispatch's approved list for this ad and not independently
re-verified as operational by this lane) and anything AI-receptionist/missed-call/unlimited-related.

## Status: HELD by Lane A, 2026-09-23 — updated same day with a pricing correction

Package received and confirmed correct (bare wa.me/17678180001, no prefill). Held until three gates clear:
AGENT's plans-page copy PR is live, PR #215 + the hand-off note are live, and the fresh-customer demo
passes (one signup, one recoverable problem, one human escalation). The `agent_recommendable` housekeeping
went to the Senior PM as owner of those `epic_offer` entities — not mine to chase further. **No action from
this lane until Lane A reports the gates cleared**, at which point: re-verify the destination and the 0001
intro line live, then owner approves publication and spend.

**Same-day correction:** Lane A measured the live catalogue and confirmed it matches
`dec-personal-line-launch-pricing-and-pay-rail-2026-09-02` (Day Pass EC$5, Week Pass EC$15, 30-Day EC$35,
top tier EC$55), not the `epic_offer` entities this package originally quoted (EC$18, EC$60). Corrected
Week Pass to EC$15 above. The top tier ("Plus"/"Unlimited+") is held entirely — no price, no name — until
the owner rules on the unlimited-vs-Blocked-claim conflict (checkpoint 10). Nothing in this package is
publishable in the meantime regardless.

## 5. Remaining approvals and gates — none of them mine to clear

- **Publication and spend — owner-only.** No engineering lane holds a Facebook/Instagram Page or Ads
  Manager credential (`ev-meta-publishing-and-ads-access-measured-2026-09-22`); this has to run through the
  owner's own Meta connector or a deliberately granted scoped Page token.
- **The fresh-customer demo required by the ratifying decision itself** — one authorized fresh signup, one
  recoverable problem, one human escalation — hasn't happened yet as far as I know. Not something I can run
  (real customer/test transaction, outside this lane).
- **AGENT's fix to `/lite/plans`** must actually deploy and get re-verified before that page is usable as
  any destination.
- **AGENT's 0001 accuracy pass** (eligibility, price, app install, plan mentions) is still the open
  precondition for trusting the wa.me/0001 destination's actual conversation content, not just its identity.
- **Port's `agent_recommendable` flags** on the four paid offers technically still read false, per the
  ratifying decision's own text — a housekeeping update for whoever owns `epic_offer` entities, flagged not
  fixed by me.
