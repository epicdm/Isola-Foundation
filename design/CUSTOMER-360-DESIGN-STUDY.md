# Customer 360 — Design Study

**Purpose of this document.** Two build passes on `CustomerWorkspaceView`
(2026-08-30 and 2026-09-03/04) reproduced the surface of the Lumen reference
design — panel names, a color palette, card shapes — without understanding
why the design is shaped the way it is. That produced two concrete mistakes,
both real and both shipped this session: list rows linked out to Odoo instead
of drilling in-app, and the "Chat" panel was gap-carded as unbuilt when the
design treats messaging as load-bearing, not optional. Per
`dec-c360-design-defines-the-target-find-the-data-2026-09-04`, this document
is the required checkpoint before another line of code: understand first,
build second. It is also, per that same decision's standing rule ("any lane
doing visual work sends a screenshot of the rendered result against the
design file before building"), the artifact that makes the next build
checkable against something written down, not against memory of a demo.

**Sources used, all primary.** `Lumen Unified Workspace (standalone)1a.html`
— opened locally, clicked through live for this document (every one of its 8
customer-record tabs; all 6 customers in the Customers fixture individually;
Pipeline/Kanban; Inbox; company-wide Call records; company-wide Invoicing).
`Odoo1.zip → design_handoff_isola/customer.jsx` — read in full (739 lines),
not grepped. `Odoo1.zip → app/msp.js` — an EPIC-specific data pack for the
same app, read directly. Five Port decisions: `dec-c360-scope-is-the-
customer-360-cockpit-2026-08-29`, `dec-lumen-portal-hosts-c360-cockpit-one-
shared-workspace-2026-08-29`, `dec-c360-convergence-spec-approved-panel-map-
2026-08-30`, `dec-c360-ai-insights-scope-definition-2026-08-30`, `dec-c360-
design-defines-the-target-find-the-data-2026-09-04`. My own current build:
`artifacts/isola/components/customer/workspace-view.tsx` + `.module.css`,
`lib/context/customer-context.ts`, `customer-sources.ts`, `context-bundle.ts`.

---

## 1. What the design is doing

### The identity bar

Avatar (initials, colored), name, company + phone, relationship tags
(Wholesale/VIP/Enterprise/Retail/Net-30 etc.), a search box scoped to *this
customer's* records, and two buttons: Call, Message. This is the only
element that never changes shape across all 6 fixture customers — it
answers "who am I looking at and how do I reach them" before anything else
loads, and the Call/Message buttons sit at the same reading position
regardless of what's below, so the fastest path to contact never moves.

### The Next Best Action banner

Full-width, directly under the identity bar, before any data card. One
sentence, one button. This is deliberately the single highest-priority
reading position in the whole layout — before money owed, before deals,
before the chat thread. Its color and copy change with the customer's state
(see §2 below) — this is not decoration, it is the same signal repeated in
color and in words.

### AI insights

A trend-icon bullet + a clock-icon bullet, in a tinted card, always the
first card in the left column. Two sentences: a synthesized read of account
health, and a "what to do about it" clock-bound observation (a reorder
cadence, a follow-up window). Per `dec-c360-ai-insights-scope-definition-
2026-08-30`, this is meant to be "aggregated + analyzed data across the
customer, historical data, forecasting, and contextualized reporting... WITH
action points" — a real synthesis panel, not a single field.

### Suggested next actions

Three fixed action rows: New order/quote, Send a WhatsApp, Create follow-up
task. Same three, every customer, only their click targets vary. This is the
generic, always-available action set — contrast with the Overview banner and
Inbox's suggested actions, which are specific and prioritized (see §4).

### Follow-ups

A short checklist: open items (AI-flagged or dated) and completed ones shown
struck through. This is the one card with a genuinely observed real empty
state in this fixture: Lucia Romano and Omar Haddad both render "No open
follow-ups for this customer." — plain text, no icon, no CTA.

### Account

Four stat rows: Lifetime value, Open orders, Open invoices, Customer since.
Pure aggregation — no per-customer variation in structure, only values. This
is the "how big is this relationship" card, deliberately unopinionated.

### Open deal

A circular AI score (0–100), a dollar amount, a pipeline-stage pill, and one
line of context ("Reorder ready to close today", "Hot — RFQ in progress").
This card and the Deals tab, in the reference's own implementation, draw
from the *same underlying array* — see §4 and §6 for why this matters.

### The right-rail card (top)

This is the panel that changes the most across customers, and it is the
clearest evidence of deliberate design thinking in the whole layout — see
§2 and §3.

### Chat with [Customer]

A compact, inline message thread (2–3 most recent messages) plus a compose
box, docked to the right rail, visible on every tab, not just Overview. The
channel icon and label change per customer (WhatsApp, Email, Live chat,
Instagram, SMS all observed across the 6 fixture customers) — this is a
single, channel-agnostic surface, not five different widgets.

### The 8 tabs: Overview, Timeline, Deals, Orders, Invoices, Tickets, Calls, Files

Confirmed by full source read: **Deals and Orders render from the identical
array** (`customer.jsx` lines 718–719, both call `CustMini` on `cOrders`,
just with `kind: 'deals'` vs `kind: 'orders'`) — the reference itself does
not distinguish a pre-conversion opportunity from a placed order. Invoices,
Tickets, Calls, Files are each their own list, same row shape, same
"Resolve/Handle/Collect/Documents"-style secondary card underneath, same
dark AI-command bar at the bottom of each ("I can quote, adjust pricing, and
chase open orders for Marisol. Try 'draft a reorder quote'.").

### The recurring pattern: list row → in-app sheet → stage tracker → sub-tabs → quick-message

This is the single most important pattern in the whole design, and the one
missed most badly in the previous two build passes. Clicking any row in
Deals/Orders/Invoices/Tickets calls `app.openSheet(kind, {id})` (line 245,
665) — **never** a link out. The sheet replaces the tab body in place with:
a breadcrumb (`Customer name → Record title`), a header (title, amount/
status, a green Message button, a Back button), a stage tracker specific to
the record's kind, sub-tabs inside the sheet itself, key-value fields, and
two actions at the bottom — one domain-specific, one that is *always* a
message action. Confirmed live for all three kinds:

| Kind | Sub-tabs | Stage tracker |
|---|---|---|
| Order | Overview, Line items, Fulfilment | Deal → Order → Fulfilled → Invoiced → Paid |
| Invoice | Overview, Lines, Payments | Draft → Sent → Due → Paid |
| Ticket | Overview, Diagnosis, Resolution | New → Diagnosing → In progress → Resolved |

One shared `NestedObject` shell (source lines 418–455) is parameterized by a
`SPECS` lookup per kind — this is a single component with a data table, not
three copy-pasted implementations. That is worth preserving exactly: the
*shape* is universal, only the stage list and sub-tab labels vary per kind.

### Reading order and priority

Top-to-bottom, left-to-right: identity (who) → Next Best Action (what
matters most right now, one line) → left column (insight, then generic
actions, then follow-ups) → middle column (account size, then the deal in
motion) → right rail (the one thing needing attention right now, then the
live conversation). The design's own priority order is: **relationship
identity, then the single most urgent action, then everything else** — no
card competes with the banner for top billing, and the right rail's
top card is the second attention-priority slot, distinct from and parallel
to the banner (see §4 for where these two disagree).

---

## 2. The intent behind it

**Belief 1: staff should never have to leave the customer record to act on
it, or to message the customer about what they're looking at.** Evidence:
every single record-detail sheet, across all three implemented kinds, ends
in a message action pre-filled with text naming the exact record
(`app.quickMessage(ct.id, 'About order '+obj.id+': ')`, confirmed at 5
separate call sites: lines 437, 510, 553, 584, 618). The right-rail chat
widget is visible on every tab, not just a "Messages" tab — it is treated as
ambient, not as a destination.

**Belief 2: the single most important thing to communicate is "what should
I do right now," and it should never require the reader to synthesize
several cards themselves.** Evidence: the Next Best Action banner exists as
its own full-width element, ahead of every data card, and it is the only
card whose color changes system-wide (purple/default vs red/at-risk) —
color as urgency, not decoration. Its exact sentence changes per customer
state (see §4 for the flaw in how this is actually computed).

**Belief 3: money at risk must be visually distinct from every other
signal, and a *positive* signal (an upsell/reorder opportunity) deserves
the same visual prominence, in a different register.** Evidence: the
top-right card is amber/orange for money owed (Marisol: "$980 owed",
Theo: "$14,200 owed"), green for a reorder opportunity with nothing owed
(Aria, Omar: "Likely due to reorder"), a neutral purple for "action needed
on a shipped order" (Lucia: "Order SO1052 · Shipped"), and red for a
service-risk (Kenji: "At risk — win them back"). Four states, one slot,
consistent left-edge color coding across banner AND right-rail together for
the at-risk case specifically — that pairing (both go red together) is
deliberate, not incidental.

**Belief 4: staff should be told what the AI looked at, not just what it
concluded.** Evidence from Inbox (not the customer record itself, but the
same design language): the AI summary panel names its sources explicitly —
"LOOKED AT: Order history (3) · VIP price list · Inventory" — and suggested
actions there carry a "NEEDS OK" gate, meaning even automatable actions are
shown as proposals requiring a human's approval, not silent execution.

**Belief 5: the record view and the inbox are two doors into the same
room.** Evidence: Inbox's right rail has an explicit **"360° view"** button
next to the mini customer card. The reference does not expect staff to
choose between "handle the conversation" and "look at the customer" — it
expects them to move between the two without losing context, and it labels
the exact door.

**Belief 6: never make staff hunt for the reorder rhythm.** Evidence: the
one non-generic AI-insight sentence in the entire fixture ("Reorders ~every
6 weeks. Due now — a draft reply is ready in Messages.") is reserved for
Marisol specifically — the busiest, most established wholesale account. The
designer clearly believes a repeat-purchase cadence, once known, is worth
surfacing above almost everything else. (Whether the *implementation*
lives up to this belief for every customer is a separate question — see §4.)

---

## 3. Where it is strong

**The right-rail card's 4-state design earns its place specifically because
it is legible without reading any other panel.** Remove it, and a staff
member has to open Invoices to learn there's $980 owed, or open Deals to
learn a reorder is likely — the banner and this card together are the only
elements that answer "what do I do about this customer today" without a
single click. This is the single highest-value pattern in the whole design
and the one most worth protecting exactly as designed.

**The shared `NestedObject` sheet shell (breadcrumb → header → stage tracker
→ sub-tabs → fields → actions) earns its place because it makes three very
different record types (a sale, an invoice, a support ticket) legible using
one learned interaction, not three.** Remove the stage tracker specifically,
and "Open" vs "In progress" vs "Resolved" collapse into a single status
word with no sense of what happens next or what already happened — the
tracker is the only element in the sheet that communicates *sequence*, and
without it a status pill alone cannot.

**The message action embedded in every sheet, not bolted onto a separate
tab, earns its place because it removes an entire class of "which tab do I
go to reply" decision.** Remove it, and every "Convert to invoice" /
"Re-register extension" / "Mark delivered" action becomes a dead end that
still requires a context switch to actually tell the customer anything
happened — which defeats the entire point of resolving something quickly.

**The channel-agnostic Chat widget (WhatsApp/Email/Live chat/Instagram/SMS,
confirmed across all 6 customers, same visual treatment) earns its place
because it means staff learn ONE reply surface regardless of how a customer
prefers to be reached — remove the abstraction and you're back to five
different apps for five channels, which is exactly the fragmentation this
whole cockpit exists to remove.

**The Inbox's "360° view" button earns its place because it is the one
concrete, findable answer to "how do I get from a conversation to the full
customer record" — without it, that navigation is a guess.

---

## 4. Where it is weak

**The AI insights panel is a fixture with almost no real computation
behind it, and this is verifiable, not a guess.** Source lines 87–107: it
is a two-branch boolean (`ct.healthy`) plus one hardcoded sentence reserved
for Marisol by literal ID check (`ct.id === 'marisol'`); every other
customer gets a generic "best reached on [channel] mornings" line derived
only from their first conversation's channel. **The consequence is visible
live**: Aria Sokolova — a brand-new lead, 0 open orders, $2,100 lifetime
value, opened in April 2026 — still shows "Healthy & growing — orders up
18% YoY. Strong upsell candidate for cups & decaf." This sentence is false
for her on its face; there is no YoY to compute from a customer who has
existed for weeks. Four of six fixture customers (Theo, Aria, Lucia, Omar)
show this exact identical sentence regardless of how different their actual
account states are. The panel's visual design is strong; its underlying
"intelligence" in the reference itself is closer to a placeholder than an
analysis.

**The stage tracker — the sheet pattern's best feature per §3 — is faked
for two of its three implemented kinds.** Source line 424: `stageIdx` is
`invoice ? (paid ? 3 : 2) : ticket ? 1 : 1` — for a ticket AND for an order,
the "current stage" pointer is a hardcoded `1`, never derived from the
object's actual state. Only the invoice branch genuinely computes its
position. This means a *Resolved* ticket and a brand-*New* ticket would
render the identical stage-tracker position in this reference build — the
pattern is right, the reference's own implementation of it is not
trustworthy as a copy target, only as a shape to reimplement correctly.

**Two Next Best Action implementations exist and do not reconcile.** The
top-level banner (lines 700–711) checks `!healthy` first, then the first
open order, then falls back to "no open thread." A *second*, more
money-aware ranking exists only inside the Deals tab (lines 197–206),
checking open invoices first, then an awaited order, then a non-Won deal.
A customer with both an overdue invoice and a healthy in-flight order could
see the banner say "confirm delivery, then invoice" while the Deals tab's
own internal logic would have prioritized collecting the money — two
answers to the same question, visible in two places, never compared against
each other.

**Tickets, Calls and Files data is itself close to fixture theater.**
Source line 380: a customer's ticket list is `ct.healthy ? [] : [one
hardcoded ticket]` — not filtered real records, a boolean gate. Calls and
Files (lines 383–389) render two unconditional rows for every single
customer, healthy or not — they are never actually empty in this build,
which means the reference has never demonstrated what its own "No calls
logged." / "No files shared." strings look like on screen, even though the
strings exist in code.

**No list anywhere paginates.** Every list in the reference is a bare
`.map()` over a full array — no `.slice()`, no cursor, no "load more." Every
fixture customer has ≤3 records of anything. **What happens with a customer
who has 300 invoices is genuinely undesigned** — not "designed but not
shown," undesigned. Same for Timeline: nothing in the fixture or the source
suggests any bound on the merged feed's length.

**A brand-new, same-day signup with *nothing yet* is not a tested state.**
Aria (the closest analog, "New" pipeline stage) still has a conversation,
an open deal, and a lifetime value — she is a slow-moving prospect, not a
customer who signed up an hour ago with zero of everything. Nothing in the
fixture shows all eight tabs simultaneously empty, and nothing shows what
happens to the Next Best Action banner, the right-rail card, or the AI
insights panel when there is no order, no invoice, no deal, no ticket, no
conversation at all to reason from.

**The design was measured, this session, live, against a narrow Chatwoot
iframe width and shows real strain.** At ~640–700px wide (approximating the
Chatwoot Dashboard App's actual mounted width), the 3-column Overview grid
(AI insights/Follow-ups | Account/Deal | Chat/Owed) has no defined
breakpoint below the 900px one already in this session's own CSS — at
narrower widths the reference's own 3-panel record view (list + record +
live-conversations rail, per the `04-customer-360.png` screenshot) simply
will not fit; the Chatwoot mount is correctly scoped to render *only* the
middle record panel with no chrome (per `dec-c360-design-defines-the-
target-find-the-data-2026-09-04`'s "no chrome" clause), but the record
panel's own internal 3-column Overview grid was never verified at that
narrower width in the reference itself — it was designed and demonstrated
at desktop width only.

**The reference's own fixture data is internally inconsistent in at least
one place** — Marisol Vega's invoice INV-2231 shows "$980" on the Invoices
list row and "$1,058" inside its own detail sheet for the same invoice.
Minor, but a reminder that a demo file is not a spec by default; every
number needs checking against the file, not assumed consistent within it.

---

## 5. Concrete improvements

Numbered, additive only — none of these remove a panel or a behavior the
design already has; each extends the design's own logic to cover ground it
left uncovered.

**1. Compute the stage tracker for every kind from real state, never a
hardcoded index.**
*Change:* map `sale.order.state`/`invoice_status`, `account.move.payment_
state`, and `helpdesk.ticket.stage_id` onto each kind's stage array
(already fully specified in §1's table) via an explicit lookup, exactly the
way this session's `readOrders`/`readInvoices` already label `state`.
*Cost:* small — one lookup table per kind, already 2/3 done in the existing
Foundation code (order/invoice state labels exist; ticket stage mapping
does not yet).
*Risk:* low. The only risk is a state value Odoo returns that isn't in the
lookup table — handle with a named "unrecognized stage" fallback, never a
silent wrong position.

**2. Unify the two Next Best Action implementations into one ranked
function, called from both the banner and the Deals/Orders tab.**
*Change:* one function, ranked money-first (overdue invoice > awaiting
order action > open deal > "log next step"), used everywhere a "what
matters most" sentence is shown.
*Cost:* small — this is a pure function over data this session's build
already fetches (orders + invoices + opportunities).
*Risk:* none functionally; the only design risk is picking the WRONG
priority order — money-first is the design's own implicit choice in the
Deals-tab version, and is the one to keep, since it protects revenue over
convenience.

**3. Give AI insights a real, evidence-gated computation before it ships,
per the ratified scope — never keep the reference's hardcoded/boolean
version.**
*Change:* per `dec-c360-ai-insights-scope-definition-2026-08-30`, build
this from real Odoo projections (orders, invoices, opportunities) plus the
Timeline/`mail.message` projection once it exists — a trend statement only
renders when there is enough history to support one (e.g. ≥2 orders across
≥60 days for a YoY-style claim), and a reorder-cadence statement only
renders when a real interval can be computed from ≥3 real order dates.
*Cost:* medium — this is genuinely new engineering (a small trend/cadence
computation), not a missing field, exactly as this session's checkpoint
render already gap-carded it.
*Risk:* the real risk is the ORIGINAL failure mode this design study exists
to prevent — showing a confident, wrong insight is worse than an honest
"not enough history yet" state. Every insight sentence needs a stated
minimum-evidence bar below which it renders the honest gap instead.

**4. Add pagination (or an explicit "showing N of M, load more") to every
list tab before a real high-volume customer is ever opened.**
*Change:* cap each list read at a fixed page size (this session's readers
already default to 25, capped at 50 — `MAX_SECTION_ROWS`), and render a
"Showing 25 of 340 — load more" footer the moment a section's real count
exceeds the page.
*Cost:* small on the read side (already bounded); the UI footer + a
"load more" fetch is a modest new piece.
*Risk:* low, but skipping it is the single most likely way this design
looks broken against a REAL long-tenured EPIC customer on day one — this
should ship with the very first real-data pass, not be deferred.

**5. Design and build the untested "brand-new signup, nothing yet" state
explicitly, in the design's own language.**
*Change:* every card that currently assumes at least one record (AI
insights, Next Best Action banner, the right-rail card, Account) needs an
explicit all-empty rendering: banner reads something like "New customer —
no history yet. Log the first interaction." (in the same purple/neutral
tone as a healthy customer, never red — a new customer is not "at risk"),
AI insights renders "Not enough history yet" rather than either fabricating
a trend or silently disappearing, and the right-rail top card is simply
absent (no owed, no opportunity, no risk) rather than forced into one of
the four existing states.
*Cost:* medium — touches every composite Overview card, but each change is
additive (a new conditional branch), not a rewrite.
*Risk:* low technically; the main risk is inventing a tone that reads as
punitive for a customer who has done nothing wrong — explicitly test this
copy against a real same-day Personal Line signup (this session already has
one: partner 2945) before shipping it.

**6. Add a sub-900px responsive collapse to the Overview grid, verified
against the actual Chatwoot iframe width, not assumed from the portal's
desktop width.**
*Change:* below ~700px, collapse the 3-column Overview grid to a single
column in a fixed priority order (banner → right-rail top card → AI
insights → Account → Open deal → Follow-ups → Chat), since that ordering is
already the design's own stated reading-priority per §1.
*Cost:* small — CSS-only, using the priority order this study has already
named rather than inventing a new one.
*Risk:* low. The main risk is treating this as cosmetic rather than
functional — the checkpoint screenshot for the Chatwoot-mounted case should
be taken at the iframe's REAL width, not the portal's.

**7. Wire the "Chat" panel to a real, phone-keyed Chatwoot conversation
resolver — this is not optional per §2 Belief 1, and was wrongly gap-carded
as an optional nice-to-have in the prior build pass.**
*Change:* the inverse of `findCustomerByPhone()` — given a resolved Odoo
customer's phone, resolve the matching Chatwoot contact/conversation
read-only, and surface its 2–3 most recent messages plus a send action.
*Cost:* medium — a genuinely new lookup, but a narrow one (one Chatwoot API
call keyed on a phone already in hand).
*Risk:* the send action is a real write with real customer-facing
consequences (an actual WhatsApp/Chatwoot message) — this needs the same
governed-action treatment (described-before-sent, read-back-confirmed) this
session's `ActionPlan`/`ActionResult` machinery already implements for
other writes; do not build a second, ungoverned send path.

### Easy wins found during this study, not built here

**A. The Pipeline (Kanban) view is a company-wide re-presentation of the
exact same `opportunities`/crm.lead data this session already fetches,
grouped by stage instead of by customer** — a stage-grouped board (New/
Qualified/Proposal/Won) with a per-lead AI score, channel badge, and a
"Hot" flag. This answers the earlier-Port-flagged "Deals pipeline... new UI
beyond a permission" concern with a concrete shape rather than a guess, and
costs little beyond what's already fetched, once crm.lead access is
confirmed live in production.

**B. The company-wide Invoicing dashboard's aging-bucket pattern (Current /
1–14 / 15–30 / 30+ days) is the direct, ready-made answer to "what does a
customer with many invoices need instead of a flat list"** — group the
per-customer Invoices tab by the same buckets once volume warrants it,
rather than inventing a new grouping scheme later.

**C. The company-wide Call records (CDR) view — extension performance, per-
agent answer rates, a filterable call log — is a stronger, more complete
target for a FUTURE company-wide "Calls" surface than anything in the
per-customer Calls tab, and it maps directly onto Magnus CDR data this
session's bff-v2 work (`getMagnusUserCallsEnriched`) already produces. Not
in scope for the per-customer record view itself, but worth naming now so
it isn't rediscovered later as a surprise requirement.

**D. `app/msp.js` (`window.MSP_DATA`) is a literal, already-built EPIC-
flavored data pack for this exact app** — "EPIC Networks (the operator's
own trade)," hosted PBX, SIP trunk, PC repair, using EPIC's own vocabulary
(SLA, DID, trunk channels) instead of a coffee-shop's. This is a stronger
north star for tone/copy than the Café Andino fixture and should be the
reference checked FIRST for any future copy/vocabulary question, since it
is closer to what EPIC's own staff will actually read.

---

## 6. Panel → data map

Every panel/field, its real source or exactly what would need to exist.
Reuses only what this session already proved works; names new engineering
plainly rather than implying it's a missing field.

| Panel / field | Source | Status |
|---|---|---|
| Identity (name, company, phone, tags) | Odoo `res.partner`: `name`, `parent_id`, `phone`, (tags: none yet — no `category_id` name-resolution built this session) | Real — `readCustomer()` in `customer-sources.ts`, minus tags |
| Call / Message buttons | Magnus (call), Chatwoot (message) — see Chat widget row below | Not wired — buttons are static UI in this session's build |
| Next Best Action banner | Computed (this session's `nextBestAction()`) from `orders` + `invoices` | Real, but implements only the banner's priority order, not the unified one recommended in §5.2 |
| AI insights | Per `dec-c360-ai-insights-scope-definition-2026-08-30`: `sale.order`, `account.move`, `crm.lead`, plus Timeline/`mail.message` once built, aggregated | **New engineering** — no trend/cadence computation exists anywhere in Foundation; this session correctly gap-carded it |
| Suggested next actions | Static UI, links to other tabs/actions | Real as navigation; not data-backed and doesn't need to be |
| Follow-ups | Odoo `mail.activity` (named directly in `dec-c360-design-defines-the-target-find-the-data-2026-09-04`'s source list) | **Not built** — `tasks`/`project.task` was proven UNSAFE this session (`TASKS_NOT_PROVEN_REASON`); `mail.activity` is a DIFFERENT, more promising candidate not yet tried |
| Account (lifetime value, open orders/invoices, customer since) | Odoo `account.move.amount_total` sum, `sale.order`/`account.move` counts, `res.partner.create_date` | Real — this session's `AccountCard`, built on real reads |
| Open deal | Odoo `crm.lead`: `expected_revenue`, `stage_id`, `user_id` | Real — `readOpportunities()`, confirmed working this session (contra an earlier Port claim of a 403 ACL block — not reproduced when tested) |
| Right-rail top card (owed / opportunity / shipped-order / at-risk) | Computed from `invoices` (owed), a reorder-cadence signal (**new engineering**, same as AI insights), `orders` (shipped/awaiting-invoice), and a service-risk signal (**new engineering** — no existing source for "sentiment dropped") | Partially real (owed, shipped-order) / partially new engineering (opportunity, at-risk) |
| Chat with [Customer] | Chatwoot, resolved by this customer's phone (inverse of `findCustomerByPhone`) | **Not built** — see Improvement 7 |
| Timeline | Odoo `mail.message` (the record's own chatter/log — per the AI-insights decision's own source list), merged with `orders`/`invoices`/`opportunities`/`issues` | Partially real — this session's `TimelineTab` merges 4 real sections but does NOT yet read `mail.message`, which is the design's actual likely intent for a genuine chronological log (not just business-object dates) |
| Deals tab | Odoo `crm.lead` (the reference's OWN implementation conflates this with Orders — see §1/§4; the correct real-world mapping keeps them distinct: Deals = pre-conversion `crm.lead`, Orders = post-conversion `sale.order`) | Real — `readOpportunities()` |
| Orders tab | Odoo `sale.order`: state, amount_total, date_order, commitment_date, invoice_status | Real — `readOrders()`, built this session |
| Invoices tab | Odoo `account.move` filtered `move_type='out_invoice'`, `state != draft` | Real — `readInvoices()`, built this session (previously had NO adapter at all despite an earlier Port record calling it "REAL/PROVEN") |
| Tickets tab | Odoo `helpdesk.ticket` filtered `partner_id` | Real — `readIssues()` (pre-existing before this session) |
| Calls tab | bff-v2's Magnus CDR read (`getMagnusUserCallsEnriched`, built and proven this same week for CDR-side minute metering), keyed on this customer's `magnusUserId` when one exists (Personal Line accounts only) | **Not built** — needs a server-to-server bff-v2 read endpoint; correctly gap-carded this session |
| Files tab | Odoo `ir.attachment`, `res_model='res.partner'` + `res_id=<customerId>` | **Not built** — no reader exists yet anywhere in this repo; straightforward, same shape as every other reader |
| Record detail sheet (order/invoice/ticket) | Same models as the parent tab, single-record read + the domain action's own write path | **Not built** — this session's list rows still link externally; see Improvement in "what I got wrong" below |
| Quick-message action inside every sheet | Chatwoot send, same resolver as the Chat widget | **Not built**, same gap as Chat widget — one resolver serves both |
| Pipeline / Kanban view | Odoo `crm.lead` grouped by `stage_id`, company-wide (not per-customer) | Easy win, not yet attempted — see §5.A |
| Company-wide Invoicing dashboard | Odoo `account.move`, company-wide, grouped by aging bucket | Easy win, not yet attempted — see §5.B |
| Company-wide Call records / CDR | bff-v2 Magnus CDR, company-wide | Easy win, not yet attempted — see §5.C |

---

## 7. What I got wrong the first time, and what I had misread

**Mistake 1 — list rows linked externally to Odoo instead of drilling
in-app.** I built every `ListRow` in Deals/Orders/Invoices/Tickets as
`<a href="...odoo.com/..." target="_blank">`. I had not clicked into a
single record in the reference before building against it — I inspected
only the top-level tab panels. The correct behavior, confirmed by clicking
into a real order and a real ticket live, and by reading the source's
`app.openSheet()` calls, is an in-app detail state within the same tab.

**Mistake 2 — "Chat" gap-carded as an optional, unbuilt nice-to-have.** My
build's Overview rendered a `GapCard` for Chat with the same visual weight
as AI insights or Follow-ups. Reading the design's actual intent (§2 Belief
1) shows this is wrong in kind, not just in priority: messaging is embedded
in *every* record's detail sheet, not a separate feature. It should have
been flagged as the single highest-priority gap to close, not one gap among
several of equal weight.

**Mistake 3 — inherited "Tickets = Chatwoot conversations" from an earlier
Port ruling without re-checking it against the actual file.**
`dec-c360-convergence-spec-approved-panel-map-2026-08-30` names Tickets as
"the live-conversations rail AND the reference's 'Tickets' tab (same
Chatwoot data)." Having now actually opened the Tickets tab for both a
healthy customer ("No open tickets — service healthy.") and an at-risk one
(a real support ticket about a phone registration fault, with device
diagnosis actions), this is unambiguously `helpdesk.ticket`-shaped data —
device/service issues, not message threads. This document corrects that
inherited misreading; `readIssues()` (helpdesk.ticket) was already the
right implementation for Tickets, by good fortune rather than by having
checked the source.

**Mistake 4 — assumed Deals should map to a real, distinct `crm.lead`
concept without checking whether the reference itself makes that
distinction.** It does not — see §1 and §4: Deals and Orders render from
one shared array in `customer.jsx`. This document's recommendation (§6) is
to keep `crm.lead`/`sale.order` as the real distinct sources anyway,
because that is what a real sales pipeline needs even though the demo took
a shortcut — but this is a considered correction, not something the
reference's own code confirms, and it should be named as a judgment call
if questioned later.

**Mistake 5 — never confirmed the stage tracker was real before treating
it as a design strength worth copying verbatim.** It looks fully
functional in a screenshot; only a full source read revealed `stageIdx` is
hardcoded for 2 of 3 kinds (§4). The visual pattern is still worth building
— computed correctly, per Improvement 1 — but I would have shipped the
reference's own non-functional version had this study not required reading
the source in full.

**Mistake 6 — treated the earlier Port record's "REAL/PROVEN: ... Billing
(account.move)" claim as fact without checking the actual adapter
registry.** There was no `account.move` adapter anywhere in
`customer-sources.ts` before this session — `invoices` was in
`UNIDENTIFIED_SECTIONS`, an explicit "not connected" refusal. The claim was
wrong, and I only discovered this by reading the code directly rather than
trusting the record it was written against.

**What this changes going forward:** every claim in this document about
either the reference design or Foundation's own code is traced to something
read this session — a live click, a source line, a Port entity, or an
actual file — not to a summary of an earlier pass. That discipline, more
than any specific finding above, is what the previous two build passes
lacked.
