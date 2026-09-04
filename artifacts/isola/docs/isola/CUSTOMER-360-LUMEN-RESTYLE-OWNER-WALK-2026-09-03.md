# Customer 360 — Lumen restyle + phone resolution fix, owner walk

**Commit:** *(fill in after push — see the SHA line at the end of this session's report)*
**Authorised by:** owner dispatch 2026-09-03 ("Owner restated your lane"), item 3,
under `dec-c360-convergence-spec-approved-panel-map-2026-08-30`.

## What changed, in one sentence each

1. `CustomerWorkspaceView` (`components/customer/workspace-view.tsx`) is
   restructured into **identity bar → tab row → body** (Sales, Billing,
   Tickets, Open work, Activity, Services), styled from a new
   `workspace-view.module.css` that consumes this app's own already-shipped
   design tokens (`--card`, `--sidebar`, `--primary`, `--border`, etc.) — no
   new palette, no parallel stylesheet, same component in both mounts
   (Portal's `customerRecord.component.tsx` and Chatwoot's existing tab).
2. `findCustomerByPhone` (`engines/odoo.ts`) now falls back to the raw
   `phone` field when `phone_sanitized` is `false` — confirmed live on
   production Odoo for the entire 767-818 exchange — while keeping
   refuse-on-ambiguity: more than one strict match still returns nothing
   rather than guessing.

## What this walk does NOT cover

The richer reference screenshot (dark rail, AI insights, live-conversations
rail, tabbed pipeline) named in `dec-c360-milestone1-walk-data-pass-design-gap-2026-08-30`
was shared with the owner directly and was not accessible in this session —
it is not committed to any repo this session could reach. What is built here
is the RATIFIED structure (identity bar → tab row → body) and the RATIFIED
panel scope, using this app's real tokens. AI insights is separately ruled
DROPPED (no Foundation data source) and Deals/Files/Calls are DEFERRED —
neither is built. If the restyle does not visually match the reference
screenshot, that is expected; if the STRUCTURE or the panel contents are
wrong, that is a real finding — please say so.

## Before you start

Sign in as `epic.owner` (the same separate Isola sign-in the existing S8-W1
walkthrough describes) and open the Customer 360 view for each customer
below — either via the Portal (`Customers → customer`) or via the Chatwoot
Customer-360 tab on the matching conversation. Both mounts render the exact
same component; if one looks different from the other, that is a real
finding.

## 1. Conversation #15 — Yvonne Armour (the one already walked for milestone-1)

Open `inbox.epic.dm`, account 2, conversation #15, Customer 360 tab.
Expect: **Patricia Yvonne Armour**, phone `+17672951770`, a real quotation
**S00670** (draft, $4,272.60) under the **Sales** tab. This customer's phone
is NOT in the 767-818 range, so this checks the identity bar + tab
structure on a customer path unaffected by the phone_sanitized fix.

- [ ] Identity bar shows the name and "Active in the system of record"
- [ ] Sales tab shows quotation S00670
- [ ] Switching tabs (Billing, Tickets, Open work, Activity, Services)
      changes the visible panel without a page reload

## 2. A UISP-linked customer

Odoo partner id **31**, "Accessories Plus" (`ref: uisp:227`, phone
`440-6073`). Open this customer's workspace (Portal: `/customer/31`, or via
whatever conversation is bound to this partner in Chatwoot).

- [ ] Identity bar renders the name
- [ ] Services tab shows this customer's UISP-sourced sections
      (services/devices/pbx) if the underlying context API resolves them

## 3. A Personal Line customer

Odoo partner id **2944**, `+15165260004` (tagged category 9, "Personal
Line"). This phone is NOT in the 767-818 range, so it renders via the
EXISTING phone_sanitized path — a control confirming Personal Line
customers render as ordinary Odoo customers, no separate panel.

- [ ] Renders like any other customer — no distinct "Personal Line" UI,
      per the ruling that line status stays in the operator console
- [ ] Identity bar and tabs behave the same as customer #1 and #2

## 4. A 767-818 customer — the one this fix is FOR

Odoo partner id **611**, "Candia Alleyne", phone `+17678185999`,
`phone_sanitized` confirmed **`false`** live on production Odoo (not a
string — the exact bug this fix closes). Before this fix, no lookup path in
`findCustomerByPhone` could ever resolve this customer by phone, regardless
of whether she exists. Proven live (this session, read-only): searching
`phone_sanitized = '+17678185999'` on production Odoo returns **zero**
rows for this partner; the new raw-`phone` fallback (`ilike` on the last 4
digits, then a strict full-10-digit match) returns **exactly one** —
Candia Alleyne, id 611 — matching the same refuse-on-ambiguity discipline
the existing stages use.

- [ ] This customer resolves and renders at all (before this fix, she would
      not have, via a phone-based lookup)
- [ ] Identity bar shows her name correctly
- [ ] Nothing about her workspace looks different from customer #1's, #2's
      or #3's — the fix is invisible once it works

## What to tell us afterwards

- Did all four customers resolve and render?
- Does the tab row (Sales / Billing / Tickets / Open work / Activity /
  Services) make sense as a grouping, or would you split/merge anything?
- Is the identity-bar → tab-row → body structure close enough to what you
  had in mind, or does the un-replicated screenshot detail (dark rail, etc.)
  matter enough that it should come back as a dedicated follow-up?
