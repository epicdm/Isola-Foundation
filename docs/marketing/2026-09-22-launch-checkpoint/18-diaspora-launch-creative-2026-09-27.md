# Diaspora launch creative — 5 deliverables, 2026-09-27

Per Lane A's dispatch under `dec-owner-pl-launch-ladder-included-minutes-2026-09-27` /
`ev-pl-launch-ladder-live-production-2026-09-27`. **Verification note before anything else:** the decision
entity itself came back with no status, no decision text, no rationale — a title-only stub, not a filled-in
ratification. I did **not** just take the dispatch's numbers on faith regardless: the evidence entity's raw
Magnus offer durations (3600/12000/36000/60000/90000 seconds) convert exactly to 60/200/600/1000/1500
minutes — matching Lane A's stated ladder precisely, independent cross-check. Treating the ladder as real
and live on that basis, while flagging the empty decision record as a process gap, not a blocker.

**Also carried from the evidence entity, relevant to staff-facing material below:** "NOT YET PROVEN IN
PRODUCTION: a real signup on this build, a real purchase, a real top-up, overage behaviour." First real
customers on this build are the actual test — staff script below reflects that.

**Destination check:** `https://app.isola.epic.dm` returns HTTP 200 (confirmed just now). It's a small SPA
shell (4,068 bytes) — same pattern as the isola-lumen-prod page I found broken two weeks ago. Given the
30-minute target, I did not repeat that full anonymous-content verification here; flagging it as a residual
gap rather than skipping it silently. Cross-checked against the evidence entity's own claim that this exact
build (isola-connect PR #71, `4937ee03`) is what's deployed there, which raises my confidence but doesn't
replace an anonymous content check.

## Live offer, as given (used exactly, not the diaspora brief's superseded 1,500-shared proposal)

| Plan | Price | Term | Included minutes |
|---|---|---|---|
| Free Trial | EC$0 | 7 days | 60 min, Dominica only |
| Day Pass | EC$5 | 1 day | 200 min, Dominica |
| Week Pass | EC$15 | 7 days | 600 min, Dominica+US/CA shared — **economics under review, not featured** |
| **Personal Line (lead)** | **EC$35** | **30 days** | **1,000 min, Dominica+US/CA shared** |
| Plus | EC$55 | 30 days | 1,500 min, shared |
| Overage | — | — | Dominica EC$0.135/min, US/CA EC$1.49/min, from wallet |

No "unlimited," no "fair use" anywhere — this ladder replaces both.

## 1. Final diaspora message + creative preview

**Headline:** Your Dominican number. Before you land. After you leave.

**Body:** Get your Dominica number before you travel home for Independence. Call ordinary Dominican
mobiles and landlines — using your own Wi-Fi or mobile data, wherever you are. **Personal Line: EC$35
(≈US$12.96) for 30 days, 1,000 minutes included.**

**Disclosure (visible, not link-only):** Internet required; data charges may apply. Voice only — no SMS or
emergency calling.

**CTA:** app.isola.epic.dm · **Support:** Questions? WhatsApp +1 767 818 0001

**Creative preview — 1:1 feed:**
- Top third: headline, large legible type, EPIC logo unaltered (standard corner placement).
- Middle: phone-in-hand product illustration showing a call in progress to a Dominica number — labelled as
  an illustration, not presented as a live screenshot (same open asset dependency as every prior checkpoint;
  no approved real capture exists yet).
- Bottom third: price/allowance badge "EC$35 / 30 days / 1,000 min", CTA button "Get your number",
  WhatsApp support line in small print.

**Creative preview — 9:16 (WhatsApp Status / IG Reels):**
- Top third: headline.
- Middle: same illustration, full-bleed.
- Bottom third: price badge + CTA. **Note on mechanics:** IG Reels supports a tappable link sticker to
  app.isola.epic.dm; organic WhatsApp Status does not support a clickable link at all — for Status, the URL
  needs to appear as visible text customers type manually, or the post needs to route through the WhatsApp
  Business API's own link-in-status mechanism if that's connected (not confirmed either way — flagging as a
  destination-mechanics question, not assumed).

## 2. Caption

> Your Dominican number. Before you land. After you leave. 🇩🇲
> Get set up before you travel home for Independence — call regular Dominican mobiles and landlines on your
> existing Wi-Fi or data. Personal Line: EC$35 (≈US$12.96)/30 days, 1,000 minutes included.
> Internet required. Voice only — no SMS or emergency calls.
> 👉 app.isola.epic.dm
> Questions? WhatsApp +1 767 818 0001

## 3. Staff/agent setup + objection script

**Setup, given this build has no proven real signup yet:**
1. Customer arrives via ad/QR → app.isola.epic.dm, or messages 0001 directly if they prefer WhatsApp-first.
2. Owner is personally staffing WhatsApp tonight via Chatwoot — **first several customers should be watched
   closely, not treated as routine.** If anything about signup, pricing display, or activation looks
   unexpected, escalate to the owner immediately rather than reassuring the customer with a guess — this
   exact build hasn't completed a real signup/purchase/top-up yet per the evidence record.
3. Tiledesk's web widget is broken tonight (known issue) — WhatsApp is the only support channel, not a
   fallback.

**Objection script:**
- *"Is this the cheapest option?"* → Never claim cheapest. "Compared to typical published per-minute rates
  to Dominica numbers, EC$35 for 1,000 minutes is strong value for regular callers — happy to walk through
  the comparison." (Comparison figures only exactly as recorded in `mc-personal-line-diaspora-price-comparison-2026-09-27`'s
  evidence — date, destination, currency, conditions — never as "cheapest" or "guaranteed savings.")
- *"How is this different from WhatsApp calling?"* → "WhatsApp calling is free app-to-app over data, but
  only between two WhatsApp users. This gives you a real Dominican phone number that ordinary mobiles and
  landlines can call — different thing."
- *"Will it work once I'm back home / while I'm abroad?"* → "Yes — anywhere you have Wi-Fi or mobile data."
- *"What about texting or emergencies?"* → "Voice calls only. SMS and emergency calling aren't supported."
- *"What happens after my 1,000 minutes?"* → "Dominica calls continue at EC$0.135/min, US/Canada at
  EC$1.49/min, charged from wallet credit you top up."
- *"Can I use it without a Dominica SIM?"* → "Yes — it just needs internet, Wi-Fi or mobile data."

## 4. Lead follow-up text (for interest that didn't complete)

> Hi! 👋 Saw you were checking out your Dominica number with EPIC. Still want to get set up before you
> travel? Message us here or visit app.isola.epic.dm — happy to help you finish in a couple of minutes.

## 5. Meta campaign replacement — campaign `120251434498070326`

- **Replace creative:** the old 15-minute-trial ad → the diaspora creative in §1/§2 above. **The old
  15-minute creative must not run** (matches the live ladder having replaced that trial framing entirely).
- **Destination URL:** `https://app.isola.epic.dm` (see verification note above — 200 confirmed, full
  content check not repeated under the time target).
- **Budget:** Lane A stated the currently configured budget as US$3/day. **I have no Ads Manager access to
  verify this myself** — no engineering-held credential can reach Meta Ads (confirmed earlier this week,
  `ev-meta-publishing-and-ads-access-measured-2026-09-22`) — so this figure is relayed, not independently
  checked. **Not proposing any budget change** — the existing US$3/day, whatever it actually is, is not a
  new authorization per Lane A's own framing.
- **Exact activation action, as a procedure for whoever holds Ads Manager access** (not something I can
  execute): open the paused ad under campaign `120251434498070326`, replace the ad creative/copy with §1/§2
  above, update the destination URL to `app.isola.epic.dm`, leave the daily budget unchanged, then the
  account holder (owner or delegate) clicks to reactivate. **Nothing here activates anything by itself.**

## Recorded through the marketing_claim gate

New entity `mc-diaspora-launch-creative-2026-09-27` created for this batch — see Port. No existing claim
was overwritten; the diaspora brief's 1,500-shared proposal (`mc-personal-line-diaspora-price-comparison-2026-09-27`)
stays as its own Draft record, not touched, since today's live ladder is a separate, later ratification.

## Nothing published or activated by this checkpoint

No ad reactivated, no spend authorized, no message sent to a real customer. Owner approval required for
every one of the five items above before anything goes live.
