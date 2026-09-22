# Marketing claim register reconciliation — 2026-09-22

Port already holds a live marketing-claim gate (`marketing_claim` blueprint, ~17 entities) plus a
`capability` blueprint carrying `truth_status`. This is the existing register the initialization brief
asked me to search for before creating another — found, and used instead of inventing a parallel structure.

## Claims relevant to this campaign, as currently recorded

| Claim | Status | Truth | Usable now? |
|---|---|---|---|
| `claim-call-home-dominica` — "Call home to Dominica from the app" | Approved | Verified-and-Sellable | **Yes** |
| `mc-personal-line-voice-only-disclosure-2026-08-30` — voice-only disclosure | Approved | — | **Yes, mandatory in every ad/signup surface** |
| `mc-personal-line-data-wifi-2026-08-30` — Wi-Fi/mobile-data calling | Draft | — | No — pending iPhone/Android UAT |
| `mc-personal-line-no-sim-second-number-2026-09-02` — no EPIC SIM required | Draft | — | No — pending activation pass |
| `mc-personal-line-works-abroad-same-plan-2026-09-02` — works abroad | Draft | — | No — pending US/Canada UAT |
| `mc-personal-line-real-767-number-15-free-minutes-2026-08-30` — old 7-day/15-min trial framing | Draft | — | **Superseded in substance** — see below |
| `mc-personal-line-plans-from-ec5-2026-09-02` | Draft | — | No — not for hero ad copy |
| `mc-personal-line-unlimited-dominica-calling-2026-09-02` | Blocked | — | Never |
| `mc-personal-line-voicemail-whatsapp-alert-2026-09-02` | Blocked | — | Never |
| `cap-lite-calling` — 767 number + callback calling + PWA + wallet | — (capability) | Conditional, "LIVE NOW — assisted/managed onboarding only" | **Yes, framed as concierge-assisted, not self-serve** |

## A stale claim that needs Delivery PM's attention, not mine to fix

`mc-personal-line-real-767-number-15-free-minutes-2026-08-30` describes a 7-day/15-minute trial with "no
more than 5 trial minutes may reach US/Canada" and "one trial per eligible customer" — written 2026-08-30.
The freshly ratified offer (`dec-call-dominica-for-free-universal-whatsapp-signup-magnus-first-2026-09-21`)
has different, more specific terms: up to 2 calls / 15 min total / 10 min max per call / 7 days, leg A
(**correction, Lane A, 2026-09-22 later same day: the public/universal door's code enforces only the 15-min/
10-min-per-call time budget over 7 days, with no enforced call count — "2 calls" is arithmetic, not a
guarantee; only the separate hotspot door enforces an actual count of 2 — see checkpoint §6c**)
(caller) may be Dominica **or** USA **or** Canada, leg B (destination) is Dominica only — no US/Canada
destination minutes at all, which directly contradicts the older claim's "5 trial minutes may reach
US/Canada." I have not edited or superseded this Port claim myself — reconciling and re-ratifying a
marketing_claim status is a call for whoever owns that register's write authority (this looked, on the
existing entities, like Product Marketing), not something to silently overwrite from this initialization.
Flagged as Open Question 6.

## What I added to the register (extension, not duplication)

One new `marketing_claim` entity for the new trial proposition itself, status Draft, explicitly linked to
the governing decision, so the free-trial offer has a register entry to move to Approved once the runtime
flags flip — see `mc-call-dominica-for-free-trial-2026-09-22` (written this session).
