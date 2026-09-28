# Post 1 of 3 — Core Proposition (revised against Port's marketing_claim gate)

## Status: Ready for review. Do not publish until Delivery PM confirms Open Question 1 (see 06-open-questions).

## Revision note
The first draft of this post asserted "own Dominica number," "no SIM swap needed" and "Wi-Fi or mobile
data, from anywhere" as established fact. Checking Port's existing `marketing_claim` register (prior art
found, not created new) shows those specific claims are still **Draft, pending UAT**:
`mc-personal-line-no-sim-second-number-2026-09-02`, `mc-personal-line-data-wifi-2026-08-30`,
`mc-personal-line-works-abroad-same-plan-2026-09-02`. Only `claim-call-home-dominica` ("Call home to
Dominica from the app") is **Approved / Verified-and-Sellable**, and `mc-personal-line-voice-only-disclosure-2026-08-30`
(Approved) is a **mandatory** disclosure for any ad/signup copy. Capability `cap-lite-calling` is
**Conditional / "LIVE NOW"**, but explicitly **assisted/managed onboarding only** (concierge provisioning +
manual wallet credit) — self-serve signup is Future. This version is rewritten to stay inside that gate.

## Audience
Primary: people abroad who want to call home to Dominica (USA/Canada diaspora).
Secondary cut (same structure, swap line 2): people in Dominica.
Not for the hotspot on-site audience as-is — no Wi-Fi mention.

## Claim basis / evidence
- "Call home to Dominica from the app" — Approved, Verified-and-Sellable (`claim-call-home-dominica`).
- Onboarding today is concierge-assisted (message-and-we-set-you-up), not instant self-serve
  (`cap-lite-calling` condition). Copy says "we'll get you set up," not "sign up instantly."
- Mandatory disclosure included per `mc-personal-line-voice-only-disclosure-2026-08-30` (Approved,
  "must appear in the advertisement... may never be hidden behind support documentation").
- Does NOT claim: a Wi-Fi/data-only, no-SIM, works-abroad experience — those remain Draft pending device
  UAT. Does NOT claim universal cellular coverage, roaming, SMS, emergency calling, or unlimited calling.

## Copy — Facebook / Instagram feed

**Headline:** Your Dominica number. Wherever life takes you.

**Body:**
Call home to Dominica from the EPIC app. Message us on WhatsApp and our team will get your line set up.

**Required disclosure (small print, always visible, not link-only):**
Voice calling service only. SMS and emergency calling are not supported.

**CTA:** Message EPIC on WhatsApp → wa.me/17678180001 (**0001, the deterministic bff-v2 concierge —
deliberately not 3742**, which is a different brain: Chatwoot → gateway → Paperclip, per
`ev-whatsapp-brain-topology-measured-2026-09-22`). Pending AGENT's in-progress verification of what 0001
actually says about eligibility, price, app install, callback-vs-app calling, trial limits and human
support — see updated Q1.

**Visual direction:** Simple phone-in-hand mockup showing a call in progress to a Dominica number, labelled
as a product illustration (not a live screenshot) until the Day-4 asset dependency clears. EPIC logo,
unaltered, bottom-corner placement per brand asset rules.

## Copy — WhatsApp Status

**Line 1:** Call home to Dominica, from the EPIC app 🇩🇲
**Line 2:** Message us and we'll set you up.
**Line 3 (small print):** Voice calling only — no SMS or emergency calls.

## What this post does NOT say
No mention of free calls, trial minutes, hotspot, self-serve instant signup, Wi-Fi/data specifics, or
using the number abroad — those are either paused (trial) or still Draft in Port's claim register
(device/UAT pending). See 07-marketing-claim-register-findings.md for the full reconciliation.
