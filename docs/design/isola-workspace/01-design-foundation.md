# 01 — Design foundation

The approved visual contract for Isola Workspace. Machine-readable copies live in
`tokens/isola-tokens.css` and `tokens/isola-tokens.json`. This document explains the
reasoning so you apply the tokens correctly rather than only literally.

---

## 1. Principles the tokens encode

1. **An operator never learns a system name.** No token, label, badge or string names Odoo,
   Clawith, Foundation, MagnusBilling, PBX or Meta. Sources are described by what they hold:
   *sales records*, *phone system*, *billing*, *messaging*.
2. **Colour is scarce and means something.** Five semantic families and one accent. A new
   integration never gets its own colour.
3. **Confirmed ≠ submitted.** Green is reserved for a change the owning system has read back.
4. **One accent-filled button per view.** Everything else is outline or quiet.
5. **Dark is a value swap, never a component branch.**

---

## 2. Typography

Family: **IBM Plex Sans** (400 / 500 / 600). **IBM Plex Mono** (400 / 500) appears in exactly
one place — identifiers inside *Technical details*. Never use mono for UI copy.

| Role | Size | Weight | Tracking | Colour | Used for |
|---|---|---|---|---|---|
| display | 24px | 600 | −0.025em | fg | Page titles: "Today", "Components" |
| title | 18px | 600 | −0.02em | fg | Onboarding step headings |
| section | 14px | 600 | — | fg | Card group headings: "Needs attention now" |
| card title | 12.5px | 600 | — | fg | Every card heading |
| body | 12.5px | 400 | — | fg / fg-2 | All explanatory copy |
| meta | 11px | 400 | — | fg-3 | Owner, timestamps, counts |
| label | 10px | 600 | 0.07em, uppercase | fg-3 | "RECOMMENDED NEXT ACTION", "STATUS" |
| badge | 10px | 600 | — | semantic | Status and source badges |
| tab | 12px | 500 | — | fg-3 / accent-fg | Module navigation |
| mono | 11px | 400 | — | fg-2 | Identifiers, correlation reference |

Base line-height 1.45. `text-wrap: pretty` on body copy. **10px is the floor** — nothing smaller
ships, including badges.

Panel headline sizes are deliberately small: this is a 384px column an operator reads dozens of
times an hour, not a marketing page. Do not scale type up "for readability" — scale information
down instead.

---

## 3. Spacing

Scale: **2 · 4 · 6 · 8 · 11 · 14 · 20 · 26**px. Density level 7/10.

| Context | Value |
|---|---|
| Gap between panel cards | 9px |
| Card padding (panel) | 10–12px |
| Card padding (full workspace) | 11–14px |
| Row padding inside a list card | 8–9px vertical, 12–14px horizontal |
| Section gap (full workspace) | 14px |
| Page padding (full workspace) | 14px 20px |
| Inline gap (icon → text) | 6–8px |
| Badge padding | 2px 7px |

**Always use flex/grid `gap`.** Never margin-per-child and never whitespace text nodes — gap
survives reorder and delete; the others do not.

---

## 4. Breakpoints

The design switches on **available width for the workspace frame**, not on device class.

| Name | Frame width | What is shown |
|---|---|---|
| `desktop` | ≥ 1090px | Chatwoot rail (52) + conversation list (274) + thread (≥380) + Isola panel (384) |
| `laptop` | ≥ 850px | Rail + thread + Isola panel. **Conversation list is dropped first.** |
| `panel` | ≤ 420px | Isola panel only, full width. No Chatwoot chrome. |
| `mobile` | ≤ 420px | As `panel`, plus a dark "← Joss Boutique / Back to chat" bar above the module tabs. |

Rules for the narrow panel — these are not optional:

- **One column.** No grids wider than 2 cells, and the 2-cell grid only for the Today
  mini-metrics.
- **No horizontal scrolling, ever.** Long values truncate with ellipsis or wrap; they never
  push width.
- **Most important information first**, in this order: identity → alert → what they need →
  next action → everything else behind disclosure.
- **The primary action is in a fixed footer**, outside the scroll container, so it is reachable
  at any scroll position.
- **No dashboard grids.** The Today module inside the panel is a 2×2 count grid and a link to
  the full workspace — nothing else.
- Hit targets ≥ 44px.

The workspace frame owns the viewport height via `calc(100dvh - var(--iso-topbar))`; the
top bar publishes its measured height into `--iso-topbar` at runtime (it wraps on narrow
viewports). Do not hardcode a bar height.

---

## 5. Radii

| Token | Value | Used for |
|---|---|---|
| sm | 4px | Source badges, small inline chips |
| md | 6px | Buttons, inputs, inset blocks, inline alerts |
| lg | 8px | Cards, modules, sections |
| xl | 12px | The workspace frame, the module sheet |
| pill | 999px | Status badges, avatars, filter chips |

---

## 6. Elevation

| Token | Light | Dark | Used for |
|---|---|---|---|
| shadow-1 | `0 1px 2px rgba(18,18,32,.06)` | `0 1px 2px rgba(0,0,0,.5)` | Cards that need slight lift |
| shadow-2 | `0 2px 8px rgba(18,18,32,.09)` | `0 2px 8px rgba(0,0,0,.55)` | The workspace frame |
| shadow-3 | `0 12px 32px rgba(18,18,32,.16)` | `0 12px 32px rgba(0,0,0,.6)` | Module sheet, toast |

Most cards use **border only, no shadow**. Elevation marks "this floats above the page", not
"this is important".

---

## 7. Status colours

Five families. Every one carries a **text label**; colour is redundant reinforcement, never the
only signal.

| Family | Token set | Means | Rule |
|---|---|---|---|
| Confirmed | `ok` / `ok-soft` / `ok-border` | Done and confirmed | Only after the owning system reads the change back |
| Needs attention | `warn` / `warn-soft` / `warn-border` | Awaiting approval, due soon, stale, configured-not-tested | — |
| Failed | `err` / `err-soft` / `err-border` | Did not happen; a customer may be affected | Must state whether the customer is affected |
| In progress | `info` / `info-soft` / `info-border` | Running now, outcome unknown | Pairs with a pulsing dot |
| Blocked / degraded | `block` / `block-soft` / `block-border` | Deliberately stopped: no permission, or a service is not answering | Distinct from failure — nothing was attempted |
| Not confirmed | `surface-3` + **dashed** `border-strong` | Accepted downstream, delivery unconfirmed | Dashed border is the signal |

The seven action states, and the exact words the design uses:

| State | Badge text | Family |
|---|---|---|
| proposed | `To do` | neutral |
| awaiting approval | `Awaiting your approval` | warn |
| executing | `Running now` | info + pulse |
| completed | `Done and confirmed` | ok |
| blocked | `Blocked` (+ lock glyph) | block |
| failed | `Did not work` | err |
| unconfirmed | `Not confirmed` | dashed neutral |

**"Request submitted" is never rendered as completed.** An executing card explicitly says
*"This is not finished until the sales system confirms it."*

---

## 8. Tenant branding

Tenants may replace: **logo, business name, and the accent family**.
Tenants may never replace: **any status colour, border, text colour, or the focus ring's
contrast**.

Given one brand hex `A`, derive the rest:

```
accent       = A
accentHover  = color-mix(in oklab, A, black 18%)     /* dark: white 18% */
accentRing   = color-mix(in oklab, A, white 28%)
accentFg     = color-mix(in oklab, A, black 22%)     /* dark: white 32% */
accentSoft   = color-mix(in oklab, A, white 90%)     /* dark: #0D0D12 82% */
```

Guardrails to implement:

1. Reject or auto-correct a brand accent whose `accentFg` fails 4.5:1 on `--iso-surface`.
2. Never allow a brand accent into a status badge, alert, checklist mark or readback result.
3. The accent has no meaning of its own. It marks: the active module, the single primary
   action, links, and selection. Nothing else.

---

## 9. Light and dark

Dark mode is applied by setting `data-iso-theme="dark"` on `<html>`. Every token name is
identical; only values change. **No component may branch on theme.**

Dark is not an inversion:

- Surfaces step `#0D0D12 → #16161D → #1B1B24 → #22222D` so nesting still reads.
- The accent **lightens** (`#6F3DF4 → #9575FB`) and `on-accent` becomes near-black `#120A28`.
- Status colours lighten to hold contrast (`ok #0B7A4B → #5BD69C`), soft fills become deep
  tints rather than pale ones (`ok-soft #E6F5EE → #0F2620`).
- Borders remain visible (`#2B2B37`, `#3C3C4B`) — dark mode does not lose structure.
- Shadows become near-opaque black; elevation is carried by surface step + border, not glow.
- The AI "internal suggestion" surface stays a **plum tint with a dashed edge** in both themes.
  That separation must survive theming.

---

## 10. What the design deliberately avoids

Gradients (except the functional skeleton fill) · glassmorphism · a colour per integration ·
decorative charts · oversized marketing cards · futuristic AI styling · emoji · icon-only
controls without a label or `aria-label` · vanity metrics · technical infrastructure language
anywhere an ordinary operator can see.
