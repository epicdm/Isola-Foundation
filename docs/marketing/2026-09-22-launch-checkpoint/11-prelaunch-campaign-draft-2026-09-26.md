# Prelaunch campaign draft — hotspot → Personal Line, 2026-09-26

Per `dec-epic-wifi-personal-line-growth-prelaunch-2026-09-26`, "Prelaunch campaign" section. Uses the
currently working customer route (0001 live concierge) — Tiledesk is not cut over, no custom Agno work.

## Transition message (on-site signage + digital)

**Headline:** You already use our Wi-Fi. Something more is coming.

**Body:** EPIC's free Wi-Fi isn't going away — but it's about to come with a real Dominica phone number
attached, for the people who want one. Message EARLY ACCESS to be first in line and help us get it right.

**Why this framing:** explicitly preserves the existing free tier (decision requires "do not abruptly
replace all existing open Wi-Fi"), frames the ask honestly as early access / feedback partnership rather
than a finished product, and doesn't promise specific terms that aren't ratified yet (no price, no minute
figure, no "unlimited").

## Attributed CTA

**Mechanism:** reuse the existing, already-proven `(source:X)` WhatsApp prefill convention (`app/lib/contacts.ts`
`extractSource`, live today) rather than inventing a new attribution scheme — this is the same rule the
`/free-call` campaign page's own unratified `(campaign:<id>)` proposal was checked against; `(source:X)`
doesn't need fresh ratification because it's already live and consumed by the webhook handler.

**Link:** `https://wa.me/17678180001?text=EARLY%20ACCESS%20(source%3A<sitecode>)`

- `<sitecode>` is a short, non-secret site/channel identifier (e.g. `hotspot-downtown`, `hotspot-market`,
  `flyer-sept26`) — never a customer identifier, never anything that grants or unlocks anything on replay.
- QR codes at each hotspot site encode this exact link with that site's code baked in, so the same creative
  works everywhere and attribution comes from which QR was scanned.
- No customer phone number appears in any link.

**Verification needed before this goes live (not done by this lane):** confirm 0001's concierge actually
parses `EARLY ACCESS (source:X)` today the same way it parses other `(source:X)` messages — this lane
cannot test that without customer contact; asking AGENT to confirm as part of its 0001 accuracy pass.

## Creative spec

- Hotspot signage: simple card, large type, QR code prominent, EPIC logo unaltered. Headline + body above,
  QR + "Message EARLY ACCESS" below.
- Digital (Facebook/Instagram, once publication is authorized): same headline/body, static image of the
  actual hotspot location style (labelled illustration until an approved photo/capture exists — same asset
  dependency as the first checkpoint).
- No specific plan, price or minute allowance anywhere in this creative — it's an interest/waitlist ask,
  not an offer presentation. The offer itself lives in the welcome-offer comparison (checkpoint 13) and is
  disclosed at invitation time, not in the initial ad.

## What this draft deliberately excludes

No mention of the paid-plan ladder, the free-callback trial, "unlimited," AI receptionist, or any specific
Wi-Fi tier (welcome/full/bonus) — those are still being costed (checkpoint 13) or held pending owner
rulings (checkpoint 09/10). This is purely the interest-capture step of the funnel.
