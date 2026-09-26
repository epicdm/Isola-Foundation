# Testimonial / share v1 — Marketing's half, 2026-09-26

Per `bt-personal-line-feedback-testimonial-share-v1-2026-09-26`. Marketing owns wording, card template,
review queue/caption rules, channel/schedule, attribution. LINE builds the mobile form/record/wiring after
its currency checkpoint — this file is the handoff.

## Customer-facing wording, by step

**Step 1 — feedback prompt (available to everyone, positive and negative):**
> "How's EPIC working for you so far? 👍 / 👎" — optional free text: "Tell us more (optional)"

Negative response routes straight to an easy support link — never gated behind the testimonial flow.

**Step 2 — descriptor suggestions (only from what the customer actually said/chose):**
Checkbox-style short options, customer picks any that apply — nothing pre-selected, nothing implied:
- "Easy to set up"
- "Clear call quality"
- "Useful having Wi-Fi and my number together"
- "Good value"
(Only show options that make sense given the customer's own free text, where possible; never suggest a
descriptor the customer didn't imply, per the build task's own rule against inventing first-hand
experience, price superiority or savings claims from a bare thumbs-up.)

**Step 3 — editable preview, exact quote:**
> "Here's what we'd like to share, in your words: '[assembled quote from steps 1–2]' — attributed as: [First
> name only / Anonymous — customer picks]. You can edit this before deciding anything."

**Step 4 — two separate, explicit actions (never conflated):**
- **"Send privately to EPIC"** — feedback recorded, never published, no further action.
- **"Approve for EPIC to publish"** — shows exactly which channels ("Facebook, Instagram") and exactly what
  attribution will show, before the customer confirms. A tap on either of the two buttons above is the only
  thing that counts as one of these two states — a like, a generic "OK," or submitting Step 1/2 alone is
  never read as publication permission.

**Step 5 — share card, customer's own optional action:**
> "Want to share this yourself? Here's a card you can post or send." — native share sheet / copy link /
> download fallback. EPIC never auto-posts to the customer's own account or messages their contacts.

**Step 6 — attributed CTA on every card:**
Reuses the same `(source:X)` WhatsApp prefill convention as the prelaunch campaign (checkpoint 11) — e.g.
`wa.me/17678180001?text=EARLY%20ACCESS%20(source%3Atestimonial-share)`. No raw phone/credential in any URL.

## Share-card template spec

- Square (1:1) and story (9:16) variants for FB/IG.
- Layout: EPIC logo (unaltered, top or bottom corner) · the exact approved quote, large, legible type ·
  attribution line ("— [First name / Anonymous], EPIC customer") · the attributed CTA link/QR at the
  bottom, small but legible.
- No stock photos of people presented as the customer unless the customer supplied their own photo and
  explicitly approved its use (Step 3/4 already covers this — "photo optional").
- Background: EPIC brand colors/pattern, consistent with the first checkpoint's creative direction — no
  generated people, no fabricated testimonial ever appears on a card; only a real customer's own approved
  words.

## Review queue and caption rules, for Marketing

- Every "Approve for EPIC to publish" submission lands in a pending-review queue before anything is
  scheduled — marketing checks: (a) the quote matches what's stored verbatim, no edits beyond what the
  customer already approved; (b) no claim beyond the approved `marketing_claim` register appears, even
  implicitly, in the assembled quote (a customer saying "unlimited calls, no cap!" would need the caption
  and surrounding copy to avoid restating that as EPIC's own claim, given `mc-personal-line-unlimited-dominica-calling-2026-09-02`
  is Blocked); (c) attribution scope matches what was shown to the customer at approval time.
- Caption template: "[quote]" — real EPIC customer. [one-line CTA, e.g. "Want your own Dominica number?
  Message EARLY ACCESS →"] `wa.me/17678180001?text=...`
- Substantive edits to the quote require re-approval from the customer — never publish an edited version
  without that.
- Withdrawal: a simple link/reply lets the customer pull a pending or already-scheduled post; withdrawn
  material never re-enters the queue. Already-published EPIC-owned posts are removed where the platform
  supports it; a customer's own reshare of their own card can't be promised retractable, and the copy
  should say so plainly if this comes up.

## Channel/schedule proposal

- Channels: Facebook and Instagram feed, matching the first checkpoint's audience split (diaspora,
  Dominica-resident). WhatsApp Status as a lighter-weight option once a testimonial is approved, using the
  same card.
- Schedule: no fixed cadence yet — publish as approved testimonials accumulate, capped at roughly one per
  week per channel so it doesn't read as constant self-promotion, and never scheduled ahead of the actual
  approval (no "assume it'll be approved" pre-scheduling).

## Publishing integration — naming the actual dependency, not guessing

**No connected publisher exists.** Per this lane's earlier capability check
(`ev-meta-publishing-and-ads-access-measured-2026-09-22`): no engineering-held credential can post to a
Facebook or Instagram Page — the only Meta credential any lane holds is a WhatsApp-scoped system user with
zero Pages, zero ad accounts. **Exact missing dependency:** a Page access token carrying
`pages_manage_posts` (plus `pages_read_engagement`), obtained from whoever holds the CREATE_CONTENT task on
the EPIC Page — most likely the owner's own Meta Business identity — and, if that token is issued to a
non-owned app, App Review for that permission. Until one of those exists, this lane can prepare the
card/caption and hand it to the owner to post manually, or wait for a deliberately granted scoped token.
This isn't a new finding — restating it here because this specific task needs it named plainly rather than
assumed solved.

## What this does NOT do

No auto-posting to a customer's own account, no reward tied to a positive review (feedback rewards, if any,
stay independent of sentiment and publish permission per the build task's own rule), no aggregation
presented as an unbiased review average — these are testimonials, not survey data.
