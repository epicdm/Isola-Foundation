# Diaspora launch creative — final image assets, 2026-09-28

Two PNG files for campaign `120251434498070326`, per the copy approved at commit `bd2aba0` and the
destination update at commit `08733cc`/`9fe8612` (checkpoint 18):

- `diaspora-feed-1080x1080.png` — 1:1 feed creative.
- `diaspora-story-1080x1920.png` — 9:16 Reels/Status creative, includes visible number + `wa.me` link as
  text (no clickable link assumed on WhatsApp Status, per Lane A's confirmation).

## How these were produced

Rendered as HTML/CSS to PNG via headless Chromium (Playwright, downloaded into a scratch user cache — no
system packages touched), run **on deepseek**, never on the laptop, per standing instruction. Built in an
isolated scratch directory (`/home/epicdm/_scratch-marketing-creative-2026-09-28`), never in a live checkout.

**Brand assets used, existing-first, per Lane A's instruction:**
- Logo: fetched directly from EPIC's own live public site (`https://www.epic.dm/`), not a local copy —
  the actual current logo Odoo's website module serves today, at full 1080×1080 resolution.
- Colors: extracted from `.checkpoint-out/lite-live.html` in this repo (an existing app-reference file,
  since the paused campaign's actual ad creative wasn't reachable — no Ads Manager/creative-library access
  exists for this lane). Primary green `#5cb22e`/`#3f8a1c`, dark text `#0f1a0c`, cream background `#f6f4ec`.

**Text is exactly the approved copy** (checkpoint 18, §1/§2): headline, EC$35/30 days/1,000 minutes (with
the required US$ equivalent), the 60-minute free-trial line, the "internet required" disclosure, and the
3742 WhatsApp CTA. No text beyond what's approved. No stock photos, no people — logo, typography and brand
color only.

**Legibility/margins:** checked visually at full render size; both keep all text well clear of the edges.
The 9:16 version reserves ~240px top / ~260px bottom as an explicit safe zone against Reels/Status UI
overlays (profile bar, caption, reply field).

**One thing to flag:** the paused campaign's actual current ad creative was never retrieved for
layout/brand reference (no Ads Manager or Meta creative-library access exists for this lane) — these
designs are built from the logo + this repo's own existing brand reference instead. If the old creative
looks meaningfully different, that's why.

Source HTML lives on deepseek at `/home/epicdm/_scratch-marketing-creative-2026-09-28/` (not committed here
— only the final rendered PNGs are). Not deleted from deepseek in case a re-render is needed; it's a scratch
directory, not a live service path.
