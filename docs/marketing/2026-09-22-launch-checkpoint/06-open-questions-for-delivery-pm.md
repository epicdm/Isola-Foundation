# Open questions for Delivery PM — 2026-09-22 marketing checkpoint

## Q1 — RESOLVED which brain, still open whether it answers correctly
Lane A measured (`ev-whatsapp-brain-topology-measured-2026-09-22`) that 0001 and 3742 are different
brains — 0001 reaches bff-v2's deterministic concierge directly; 3742 goes through Chatwoot → gateway →
Paperclip. This checkpoint's copy now deliberately targets **0001 only**. Still open: AGENT is in progress
testing what 0001 actually says about eligibility, price, app install, callback-vs-app calling, trial
limits and human support, and fixing wrong answers (per Lane A's relay) — that verification is the actual
precondition for approving the trial claim and for sending organic reach at 0001 for the core-proposition/FAQ
posts too. Please tell me when that verification pass completes.

## Q2 — RESOLVED: no engineering lane can publish; need the owner's route
Lane A measured (`ev-meta-publishing-and-ads-access-measured-2026-09-22`): the only Meta credential any
engineering lane holds is a WhatsApp-scoped system user with zero Pages, zero ad accounts, zero businesses —
it can't even read Page 1614928515392749. The Senior PM reached that Page and ad accounts through the
owner's own Meta Ads connector, a different identity; and Ads access does not grant organic Page posting
(different permission/token — `pages_manage_posts` via a Page-holder's CREATE_CONTENT task, plus App
Review for a non-owned app). So: publication has to run through the owner directly, or through a
deliberately granted scoped Page token. This is now a decision for the owner/Delivery PM, not an open
technical question — please tell me which route you want, and I'll prepare content to fit it (I already
have three packages ready either way).

## Q3 — Interest-capture destination for the "Call Dominica for Free" preview
The upcoming-feature post (Package 02) deliberately carries no CTA because there is no verified working
destination to send interest to (the campaign page is broken and flagged off; the trial engine is paused).
If you want a "notify me" mechanism for that post, what should it be — a waitlist form, a WhatsApp
keyword, something else — and can it be built/verified independent of the paused trial flags?

**Update 2026-09-22 ~13:15Z:** a candidate destination was proposed (`isola-lumen-prod.saas00.epic.dm/en/personal-line-plan`)
and I tested it myself before accepting it — it is not actually anonymous-public: its content APIs return
401 without auth; it rendered for me only because this browser already carried an operator token for that
domain. See checkpoint §6a and `evidence/ev-personal-line-plan-page-not-public-measured-2026-09-22`. Sent
back to Lane A/LINE for re-verification in a logged-out context. Still no working destination confirmed
for either the trial preview or, pending that re-check, the core proposition either.

## Q4 — Day 4 / Day 6 content gaps
- Day 4 needs a real screen recording or screenshot of the live app or a live WhatsApp concierge exchange.
  I will not fabricate one or present a design mockup as a real screenshot. Can Design or Delivery supply
  an approved capture, or authorize a specific, bounded capture session?
- Day 6 exact question, sent to Lane A 2026-09-22: "After I message EPIC on WhatsApp, what actually
  happens — how long does setup take, and what does the customer need to provide?" Chosen because it's
  answerable today (concierge-assisted onboarding is live per `cap-lite-calling`) without touching any
  Draft claim, unlike the original Wi-Fi/network-mechanics idea.

## Q5 — Release-timing coordination
When `CALLBACK_TRIAL_GRANTS_PAUSED` flips to false and the `/free-call` route fix ships, please tell this
lane so Package 02 can be revised from "coming soon" to a real launch post using the same underlying,
already-ratified offer terms — no new copy strategy needed, just a status flip once the destination is real.

## Q6 — Two device/UAT claims block the fuller product story, and one existing claim is stale
Port's `marketing_claim` register already gates this precisely — three Draft claims
(`mc-personal-line-data-wifi-2026-08-30`, `mc-personal-line-no-sim-second-number-2026-09-02`,
`mc-personal-line-works-abroad-same-plan-2026-09-02`) need iPhone/Android UAT before I can say "Wi-Fi or
mobile data," "no SIM required," or "works abroad" in public copy. Whoever owns device UAT — please run it
and move these to Approved (or Blocked) when there's evidence; I'll expand Package 1/3 the same day.
Separately, `mc-personal-line-real-767-number-15-free-minutes-2026-08-30` (2026-08-30) still says trial
minutes may reach US/Canada, which the newer ratified decision (2026-09-21) contradicts — destination is
Dominica only now. I didn't touch that claim's status since I don't own that register's write authority
outside this new entry; whoever does (looked like Product Marketing on the existing records) should
reconcile or retire it.
