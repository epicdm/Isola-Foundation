# Prelaunch campaign draft — hotspot → Personal Line, 2026-09-26

Per `dec-epic-wifi-personal-line-growth-prelaunch-2026-09-26`, "Prelaunch campaign" section. Uses the
currently working customer route (0001 live concierge) — Tiledesk is not cut over, no custom Agno work.

## Revised 2026-09-26 per `dec-wifi-personal-line-pilot-approval-2026-09-26` §6

Two corrections applied to the original draft below:
1. **Priority access only, no amounts.** The original body's "help us get it right" softly implied a
   reciprocal reward for registering — removed. No bonus, voucher amount, or benefit of any kind appears in
   this copy; the EC$10 voucher is still an unapproved proposal (checkpoint 16), and the decision is
   explicit that "first-access registration can proceed without promising an unsettled bonus."
2. **No Wi-Fi specifics, no implied upgrade.** The original headline/body ("something more is coming... a
   real Dominica phone number attached") blurred into implying the Wi-Fi experience itself was about to
   change. Per §1/§4 of the pilot decision, nothing Wi-Fi-specific (the 1-hour/day, 1/2 Mbps pilot terms,
   the paid-plan hotspot tier, "always available," "unlimited WhatsApp") goes public until the pilot proves
   it. Revised to mention Wi-Fi only as audience context (today's real, unchanged, existing service) — never
   as a promise of something new.

## Transition message (on-site signage + digital) — REVISED

**Headline:** You already use EPIC Wi-Fi. Get early access to your own Dominica phone number.

**Body:** EPIC is opening early access to Personal Line — a real Dominica number, usable from the EPIC app.
Message EARLY ACCESS on WhatsApp to register your interest. Priority access only — no purchase, no
commitment, and no promised bonus at this stage.

**Why this framing:** "priority access" is the entire ask — no amount, no reward, no reciprocal promise.
Wi-Fi appears only as context for who's seeing the sign (today's existing, unchanged free service), never
as a claim about what the Wi-Fi itself is becoming. No price, no minute figure, no "unlimited," no specific
Wi-Fi tier or pilot term.

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

**Not published yet, per the pilot decision itself:** "before publishing the call to action, demonstrate
that a message reaches the correct agent and creates or updates the intended Odoo record." AGENT is running
that check now. This creative is prepared, not live.

## Creative spec

- Hotspot signage: simple card, large type, QR code prominent, EPIC logo unaltered. Headline + body above,
  QR + "Message EARLY ACCESS" below.
- Digital (Facebook/Instagram, once publication is authorized): same headline/body, static image of the
  actual hotspot location style (labelled illustration until an approved photo/capture exists — same asset
  dependency as the first checkpoint).
- No specific plan, price, minute allowance, bonus amount, or Wi-Fi tier/speed/time anywhere in this
  creative — it's a pure interest/waitlist ask.

## What this draft deliberately excludes

No mention of the paid-plan ladder, the free-callback trial, "unlimited" (calling or WhatsApp), "always
available," any Wi-Fi pilot term (1hr/day, 1/2 Mbps, device caps), AI receptionist, or any bonus/voucher
amount — all either held pending owner rulings or explicitly barred from public copy until the pilot proves
itself (checkpoint 09/10/16). This is purely the interest-capture step of the funnel.
