# Diaspora launch creative — 5 deliverables, 2026-09-27

Per Lane A's dispatch under `dec-owner-pl-launch-ladder-included-minutes-2026-09-27` /
`ev-pl-launch-ladder-live-production-2026-09-27`. **Verification note:** at the time this checkpoint was
first drafted, the decision entity had no status/text/rationale — a title-only stub. Cross-checked instead
against the evidence entity's raw Magnus offer durations (3600/12000/36000/60000/90000 seconds → exactly
60/200/600/1000/1500 minutes, matching the stated ladder). **Lane A has since filled in the decision entity
— now Ratified, full decision text matches everything used below, including the "supersedes... the 1,500/2,500
proposal" line and the Week Pass economics caveat.** Re-verified directly before this update.

**Also carried from the evidence entity, relevant to staff-facing material below:** "NOT YET PROVEN IN
PRODUCTION: a real signup on this build, a real purchase, a real top-up, overage behaviour." First real
customers on this build are the actual test — staff script below reflects that.

**Destination changed, owner direction, 2026-09-27 (later same session):** the front door is **not**
`app.isola.epic.dm` — it's a direct WhatsApp message to the sole public front door, **+1 767 818 3742**:

`https://wa.me/17678183742?text=Hi%20%E2%80%94%20I'd%20like%20my%20own%20Dominica%20number%20with%20Isola.`

(decoded: "Hi — I'd like my own Dominica number with Isola.") 3742 is documented in this repo's own
operating rules as the sole public front door — a live, protected product surface, not something I'm taking
on Lane A's word alone. **Everything below is updated to use this link.** The `app.isola.epic.dm` check
below is left for history/context only — it is no longer the CTA anywhere in this file.

**Superseded destination check (history only):** `https://app.isola.epic.dm` returned HTTP 200, a small SPA
shell (4,068 bytes) — same pattern as the isola-lumen-prod page found broken two weeks ago; full
anonymous-content verification was not completed before this destination was replaced.

**Two different numbers, roles refined 2026-09-28** (`dec-owner-whatsapp-number-roles-3742-conversation-0001-transactional-2026-09-28`,
Ratified — checked directly, this supersedes the narrower "0001 = existing-customer support" framing this
file used earlier): **+1 767 818 3742** carries ALL conversations — new-customer front door (this campaign's
CTA), sales, support, **and opted-in announcements** — new or existing customer, doesn't matter. **+1 767
818 0001** carries only automatic **transactional** messages (OTP, invoice/payment reminders, balance/plan
alerts); it is not a general support channel even for existing customers, though replies to it still route
to a human during the transition. **0001 does not appear anywhere in this new-customer creative, and any
future announcement/broadcast content must use 3742 with opted-in contacts only, not 0001.**

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

**CTA:** Message us on WhatsApp → `wa.me/17678183742` (prefilled: "Hi — I'd like my own Dominica number with
Isola.")

**Creative preview — 1:1 feed:**
- Top third: headline, large legible type, EPIC logo unaltered (standard corner placement).
- Middle: phone-in-hand product illustration showing a call in progress to a Dominica number — labelled as
  an illustration, not presented as a live screenshot (same open asset dependency as every prior checkpoint;
  no approved real capture exists yet).
- Bottom third: price/allowance badge "EC$35 / 30 days / 1,000 min", CTA button "Message us on WhatsApp"
  linking to the wa.me/3742 URL above. No 0001 anywhere on this creative — that's existing-customer support
  only.

**Creative preview — 9:16 (WhatsApp Status / IG Reels):**
- Top third: headline.
- Middle: same illustration, full-bleed.
- Bottom third: price badge + CTA. IG Reels supports a tappable link sticker to the wa.me/3742 URL directly
  (click-to-WhatsApp works the same as any other link there). **WhatsApp Status:** no clickable link at all
  — show the number **+1 767 818 3742** and the `wa.me/17678183742` link as visible text, per Lane A's
  confirmation.

## 2. Caption

> Your Dominican number. Before you land. After you leave. 🇩🇲
> Get set up before you travel home for Independence — call regular Dominican mobiles and landlines on your
> existing Wi-Fi or data. Personal Line: EC$35 (≈US$12.96)/30 days, 1,000 minutes included.
> Internet required. Voice only — no SMS or emergency calls.
> 👉 Message us on WhatsApp: wa.me/17678183742

## 3. Staff/agent setup + objection script

**Setup, given this build has no proven real signup yet:**
1. Customer arrives via ad/QR and messages **+1 767 818 3742** (the prefilled text is already their
   opening line). **This is the only new-customer entry point in this campaign — not 0001, not
   app.isola.epic.dm.** 0001 sends automatic transactional messages only (OTP, invoices, alerts) — it's not
   a support channel to direct anyone to; if a prospect somehow reaches 0001, redirect them to 3742.
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
> travel? Message us here or on WhatsApp: wa.me/17678183742 — happy to help you finish in a couple of
> minutes.

## 5. Meta campaign replacement — campaign `120251434498070326`

- **Replace creative:** the old 15-minute-trial ad → the diaspora creative in §1/§2 above. **The old
  15-minute creative must not run** (matches the live ladder having replaced that trial framing entirely).
- **Destination:** `https://wa.me/17678183742?text=Hi%20%E2%80%94%20I'd%20like%20my%20own%20Dominica%20number%20with%20Isola.`
  — this is a **click-to-WhatsApp ad**, not a link-to-website ad; the destination field in Ads Manager
  should be the WhatsApp business phone connection (+1 767 818 3742) with this prefilled message, not a URL
  field pointing at app.isola.epic.dm.
- **Budget:** Lane A stated the currently configured budget as US$3/day. **I have no Ads Manager access to
  verify this myself** — no engineering-held credential can reach Meta Ads (confirmed earlier this week,
  `ev-meta-publishing-and-ads-access-measured-2026-09-22`) — so this figure is relayed, not independently
  checked. **Not proposing any budget change** — the existing US$3/day, whatever it actually is, is not a
  new authorization per Lane A's own framing.
- **Exact activation action, as a procedure for whoever holds Ads Manager access** (not something I can
  execute): open the paused ad under campaign `120251434498070326`, confirm it's set as (or convert it to) a
  click-to-WhatsApp ad type connected to +1 767 818 3742, replace the ad creative/copy with §1/§2 above, set
  the prefilled message to "Hi — I'd like my own Dominica number with Isola.", leave the daily budget
  unchanged, then the account holder (owner or delegate) clicks to reactivate. **Nothing here activates
  anything by itself.**

## Recorded through the marketing_claim gate

New entity `mc-diaspora-launch-creative-2026-09-27` created for this batch — see Port. No existing claim
was overwritten; the diaspora brief's 1,500-shared proposal (`mc-personal-line-diaspora-price-comparison-2026-09-27`)
stays as its own Draft record, not touched, since today's live ladder is a separate, later ratification.

## Nothing published or activated by this checkpoint

No ad reactivated, no spend authorized, no message sent to a real customer. Owner approval required for
every one of the five items above before anything goes live.

## Status: HELD, with the owner

Lane A has passed this pack to the owner for approval. No action from this lane until an answer comes back.
