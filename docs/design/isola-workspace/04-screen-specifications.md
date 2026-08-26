# 04 — Screen specifications

Ten screens. Each gives layout, hierarchy, spacing, behaviour, responsive changes,
interactions, empty/error behaviour, sample data and acceptance criteria.

The working fixture is shared across screens and is listed in full in `sample-data.json`.

---

## Screen 1 — Chatwoot conversation Customer panel

**Where.** The right-hand side panel of an open Chatwoot conversation. 384px wide
(`min-width:340px`). This is the flagship screen.

### Layout

```
aside[aria-label="Isola Workspace"]   position:relative; flex column; width:384px
├── (narrow only) back-to-conversation bar          rail bg, 9px 12px
├── header                                          surface, border-bottom
│    ├── row: Isola mark 18px · "Isola Workspace" 12.5/600 · tenant 10.5/fg-3 · state chip
│    └── tablist: Customer · Work[4] · AI · Today · More[n]
├── scroll container    flex:1; overflow:auto; padding:10px 11px 16px
│    └── stack          display:flex; flex-direction:column; gap:9px
└── footer              flex:none; surface; border-top; padding:9px 11px
     ├── note 10.5/fg-3
     └── [ primary accent button (flex:1) ] [ secondary outline ]
```

**The scroll container must not itself be the flex column.** If it is, its children shrink to
fit instead of overflowing, and every card clips. Wrap the stack in an inner div.

### Component hierarchy (Customer module, `ready`)

1. `CustomerSummary` — avatar 32px, "Joss Boutique" 14.5/600, "Active customer · Eric Giraud
   looks after them" 11.5/fg-2. No card chrome. Padding `1px 2px`.
2. `Alert variant="warning"` — clock glyph, *"**Reply due tomorrow.** They are deciding this
   week."* `radius-md`, `padding:7px 9px`.
3. **Decision card** — `surface`, 1px `accent-ring`, `radius-lg`, `shadow-1`, `padding:12px`,
   `gap:10px`:
   - label *THEY ARE ASKING FOR* → 12.5px sentence.
   - 1px top divider, `padding-top:10px`.
   - label *DO THIS NEXT* in `accent-fg` → 13/600 recommendation → 11.5/fg-2 timing line.
   - **No button here.** The action lives in the footer.
4. `ExpandableDetails` — *"More about this customer"*, summary *"Sales opportunity, services,
   history and past actions"*. Collapsed by default.
5. When expanded, five nested `ExpandableDetails`, each collapsed:
   *Sales opportunity* (summary carries the value: "Connectivity and AI Front Desk Package ·
   EC$4,850", plus a `SourceBadge`) · *Services in use* · *Recent contact* (`Timeline`) ·
   *Actions taken for this customer* (`ReadbackResult` + entries) · *Technical details* (quiet
   variant, mono).

### Information hierarchy rule

The initial view shows **only**: customer · current issue · status · owner · next action ·
due date · key alerts · primary action. Everything else is behind disclosure. Adding a
seventh top-level card to this panel is a regression.

### Spacing

9px between stack children · 10–12px card padding · 7px between grid cells · 6px icon-to-text.

### Behaviour

- Tab click switches module; scroll position resets to top.
- The disclosure header toggles `aria-expanded`; the chevron rotates 0° → 180°.
- The footer action for this module is *Prepare follow-up* → jumps to the AI module with an
  Atlas suggestion already produced. Secondary *Ask Atlas* → AI module in `thinking`.
- Raw identifiers (conversation 131, account 5, inbox 46, opportunity 1642, correlation
  `epic-cz-revenue-loop1-2026-08-06-conv131`) appear **only** inside *Technical details*, in
  mono, never on the initial view.

### Responsive

≥850px: 384px column beside the thread. ≤420px: full width, back-to-conversation bar appears,
tab labels shorten, footer unchanged. One column at every size. No horizontal scrolling.

### Empty / error

`no customer match` · `multiple matches` · `unauthorized` · `stale` · `degraded` · `loading` —
all specified in screens 7–9 and the state gallery. The panel is never blank.

### Sample data

Customer **Joss Boutique**, retail, Roseau, Dominica. Owner **Eric Giraud**. Due
**Friday 7 August 2026**. Opportunity *Connectivity and AI Front Desk Package*, **EC$4,850**
first year, stage *Proposal sent*, likelihood 60%, expected close 14 Aug 2026. Lines: business
internet 100/50 EC$185/mo · hosted phone 2 lines EC$120/mo · AI Front Desk EC$80/mo. Currency
`EC$`, timezone AST (UTC−4).

### Acceptance criteria

- [ ] Initial render shows at most 4 top-level elements above the disclosure.
- [ ] No system name (Odoo, Clawith, Foundation, MagnusBilling, PBX, Meta) appears anywhere,
      including `title` attributes and `aria-label`s.
- [ ] The panel body scrolls; `scrollHeight > clientHeight` with all sections expanded, and no
      child is clipped (`rect.height === scrollHeight` for every stack child).
- [ ] The footer primary button is visible at every scroll position and at 340px width.
- [ ] Exactly one accent-filled button is present.
- [ ] Every disclosure header exposes `aria-expanded`.
- [ ] Identifiers appear only under *Technical details*.

---

## Screen 2 — Work and Approvals

**Where.** The `Work` module in the panel; the same components reappear in the Today workspace.

### Layout

Filter chips row (This customer · Mine · Needs approval), then a vertical stack of cards, one
per work item, ordered: awaiting approval → overdue → to-do → blocked → failed → unconfirmed →
done.

### Component hierarchy

- `ApprovalCard` (awaiting) — 3px warn left border. Title *"Add a follow-up reminder on the
  sales record"*; summary; `StatusBadge awaitingApproval`; "Prepared by Atlas · AI assistant";
  consequence block *"What will happen if you approve"*; Approve (accent) / Decline (outline).
- `ActionCard todo` — *"Send the updated package price"*, due tomorrow, `EG` avatar, high
  priority.
- `ActionCard overdue` — *"Confirm the extension list"*, Bellevue Hardware, `2 days late`,
  3px err left border, owner Marie Joseph.
- `ActionCard blocked` — *"Apply an EC$250 goodwill credit"*, padlock badge, block-tinted
  explanation, *Send to a manager*.
- `ActionCard failed` — *"Change call routing to the evening menu"*, Rosalie Café,
  `Did not work`, err explanation naming the customer impact, *Try again*.
- `ActionCard unconfirmed` — dashed border, *"Price list message to 12 customers"*,
  *"Do not tell customers it was sent yet."* **No retry offered.**
- `ActionCard done` — *"Call notes saved to the customer record"*, "Confirmed on the record as
  note #318."

All seven states are visible simultaneously by design — this screen is the reference for the
status vocabulary.

### Behaviour

Approve → `executing` (info badge, pulsing dot, indeterminate bar, *"not finished until the
sales system confirms it"*) → after the platform confirms, `completed` with a `ReadbackResult`
that animates in and a toast. Decline → toast, card removed. Try again on the failed card →
`executing` → `completed` with a phone-system readback.

The footer primary action follows: *Approve the follow-up reminder* while one is awaiting,
otherwise *Open the oldest overdue item*.

### Responsive

One column at every width. Action buttons wrap under the text below ~330px.

### Acceptance criteria

- [ ] All seven states are visually and textually distinct.
- [ ] No card can reach `Done and confirmed` without a readback string and timestamp.
- [ ] `executing` never uses the ok family.
- [ ] Blocked copy states that nothing changed and the customer was not told.
- [ ] Failed copy states the customer impact.
- [ ] Unconfirmed offers no action that implies success.

---

## Screen 3 — AI Team

### Layout

1. Notice card: *"Your AI team works inside Isola only. Nothing they write reaches the customer
   until you put it in the reply box and press Send."*
2. Four `AIEmployeeCard`s: Atlas (assistant, available) · Nova (front desk, on duty) ·
   Ledger (billing, approval only) · Echo (follow-ups, paused).
3. *Ask Atlas* card with five chips: Summarise this customer · Prepare a response ·
   Investigate an issue · Suggest a next action · Prepare an action for approval.
4. Output region: `idle` (dashed empty box) → `thinking` (spinner + skeleton) →
   `result` (`InternalSuggestion`).
5. `DraftChain` once a draft exists.

### The internal/external separation — the hard rule

`InternalSuggestion` is **never** styled as a chat bubble:

- Background `--iso-accent-soft`, border **1px dashed** `--iso-accent-ring`, `radius-lg`.
- Header strip: 22px Atlas tile · *"Internal suggestion"* 11.5/600 accent-fg · *"Atlas ·
  assistant"* 10.5/fg-2 · a persistent pill *"Not sent to customer"* on `surface` with an
  accent-ring border.
- The draft text sits on a plain `surface` card inside, so it reads as a document, not a message.
- Provenance chips: *Based on: price list v4* · *Opportunity record* · *Confidence: high*.
- Actions: **Put in the reply box** (accent) · Ask for approval · Create a follow-up · Discard.

Customer-facing replies keep Chatwoot's own bubble styling and composer. The two must never be
confusable.

### Five draft states, visibly different

| State | Where it lives | Signal |
|---|---|---|
| AI suggestion | AI module | Plum dashed card, "Not sent to customer" |
| Operator draft | Chatwoot composer | Accent chip above the composer: *"Operator draft, started from an Atlas suggestion. Nothing is sent until you press Send."* |
| Approval requested | AI module | `DraftChain` note: *"Waiting for a manager to approve this wording. Nothing has been sent."* |
| Approved | Composer | *"A manager approved this wording. It is in your reply box and still not sent."* |
| Sent | Conversation thread | Normal outbound bubble, "09:26 · sent" |

### Acceptance criteria

- [ ] AI output shares no styling with a conversation message.
- [ ] "Not sent to customer" is present whenever a suggestion is on screen.
- [ ] Inserting a draft changes the composer's appearance and adds the provenance chip.
- [ ] Nothing sends without an explicit operator Send.
- [ ] The paused AI employee states *why*.

---

## Screen 4 — Manager / Today

**Where.** Full-width Isola workspace, Chatwoot rail retained on the left.

### Layout

```
header        surface, 14px 20px 12px — Isola mark + tenant, "Today" 21/600, date line, Refresh
decision bar  surface, 10px 20px — three numbers + a quiet activity line
[operator]    role notice strip
body          grid  minmax(0,1.6fr) minmax(0,1fr)  gap:14px  padding:14px 20px 22px
  left  ── "Needs attention now" (5 rows)  +  "Sales that need a push" (3 rows)
  right ── Approvals waiting · Who is carrying what · AI team today · Service problems
```

### Decision bar — not a KPI strip

Three numbers, each with a sentence, each actionable:
`2` customers waiting on a promise we broke (err) · `3` approvals waiting, oldest 40 min (warn) ·
`EC$14,050` of sales waiting on us to reply. Then one quiet line: *"24 conversations today · 11
answered by the AI team · 14 actions confirmed"*. Vanity metrics are deliberately demoted to
that line.

### Needs attention now

Ordered by business harm. Each row: 6px severity dot · title · consequence · owner/age · one
button. **Only the first row's button is accent** — one obvious primary action per screen.

Rows: failed call-menu change (err, *Fix it*) · customer waiting on a price (warn, *Open
conversation*) · approvals ageing (warn, *Review*) · unanswered conversations (warn, *Assign*) ·
service degradation (block, *Details*).

The badge count must be derived from the rows that actually render — tenant gating changes it.

### Role behaviour

`operator` sees a notice — *"You are seeing your own work. Team workload and service problems
are shown to managers."* — and the workload / AI / service-problem cards are hidden.
`manager` sees everything. `admin` lands on onboarding instead.

### Responsive

≥850px two columns; below that a single column, right-hand cards after the left ones. No
horizontal scroll. Not a dense monitoring dashboard at any size.

### Acceptance criteria

- [ ] Exactly one accent button in the whole view.
- [ ] Attention rows are ordered by consequence, not by time.
- [ ] Every row names the customer impact.
- [ ] Operator role hides team-level cards.
- [ ] No chart is rendered anywhere.
- [ ] Counts match rendered rows.

---

## Screen 5 — Onboarding wizard

### Layout

```
header    progress bar + "n of 7 proved" + Save and continue later
[saved]   ok-tinted resume strip
grid      236px | 1fr
  aside   7 × OnboardingStage  +  legend  +  "Who is doing this"
  main    step body (18/600 heading + one-line purpose + cards)  ·  footer nav
```

### The seven stages

Business · Workspace · Channels · AI Team · Business systems · Acceptance · Go live.

Each carries one of six states (see component 16). The legend in the left rail explains all six
— an administrator must be able to tell *set up* from *proved* without training.

**The stepper and the step body must agree.** If the stage says *Not started*, the body may not
show connected systems.

### Step bodies

- **Business** — company details (name, country/timezone, currency), administrator with a
  Verified badge, opening hours, plan chips, branding (logo slot + accent swatch).
- **Workspace** — staff list with per-person sign-in state, teams, labels, who can see the
  Isola panel and who can see money details.
- **Channels** — one card per channel with `Tested` / `Set up, not tested` / `Not connected` /
  `Waiting on us`. Telephone renders only for telephony-entitled tenants; otherwise a dashed
  card explains it is not part of the plan and that adding it later changes nothing else.
- **AI Team** — templates chosen, name/role, inbox responsibility, knowledge, allowed actions,
  and *"Always hands to a person"* rules.
- **Business systems** — one row per system in plain English, each with its verification state,
  plus the warning *"**Connected is not the same as working.**"*
- **Acceptance** — `VerificationChecklist`, 11 checks, tally, retry.
- **Go live** — blocker banner if any check is unpassed, four summary tiles, plain-English
  description of what switching on does, single accent *Switch … on*.

### Behaviour

Stage click jumps. *Save and continue later* → ok strip + toast; *Carry on now* dismisses.
*Run the check again* → the failed check passes, progress moves 57% → 86%, the Go-live blocker
clears. Back/Next; Next is hidden on the last step.

### Acceptance criteria

- [ ] Six stage states are visually distinct; `setup` and `proved` never share colour or mark.
- [ ] Stepper note and step body never contradict.
- [ ] Acceptance lists all 11 checks; each records evidence.
- [ ] Go live is blocked while any check is unpassed, with an explicit partial-go-live option.
- [ ] Save/resume works from any step.
- [ ] The customer never sees more than one product being configured.

---

## Screen 6 — Narrow / mobile panel

**Frame.** 390–400px. Chatwoot chrome hidden.

### Changes from desktop

- A dark back-to-conversation bar above the header: `←` · customer name 12.5/600 ·
  "WhatsApp · conversation open" 10.5 · a "Back to chat" pill.
- Panel becomes `width:100%`.
- Tab labels shorten; *More* keeps its badge.
- Footer action bar unchanged — this is why it exists.
- Module sheet is full-width, bottom-anchored.

### Acceptance criteria

- [ ] `document.body.scrollWidth === clientWidth` — no horizontal scrolling.
- [ ] One column throughout; no grid wider than 2 cells.
- [ ] Footer primary button `rect.bottom <= innerHeight`.
- [ ] Hit targets ≥ 44px.
- [ ] Text wraps; nothing truncates a decision-critical value.

---

## Screen 7 — Loading state

**Layout.** A sentence naming what is loading and reassuring the operator, then a skeleton that
matches the shape of the real content (avatar + two lines, then a card with a heading bar and a
block), then *"You can keep replying in the conversation while this loads."*

Production copy: *"Loading customer record from the conversation and your sales records…"*

**Acceptance criteria**

- [ ] Container carries `aria-busy="true"`.
- [ ] Skeleton geometry matches the loaded layout (no jump).
- [ ] A source is named in plain English.
- [ ] Shimmer stops under `prefers-reduced-motion`.
- [ ] The conversation remains fully usable.

---

## Screen 8 — Degraded integration

**Layout.** A `block`-tinted banner at the top of the module body, above all content, with a
warning triangle. Content below still renders, from the last good read.

**Copy.** *"**The phone service is answering slowly.** Calls are working normally. Changes to
lines or menus are paused until it recovers, so what you see below was read at 08:58."*
Plus *"Last successful check 08:58 · retrying automatically"*.

Stale is the sibling case (warn family): *"**Showing information from 09:02.** …Replies to the
customer are not affected."* with a *Try again* button.

**Acceptance criteria**

- [ ] Degraded is never rendered as failure.
- [ ] The banner names what still works and what is paused.
- [ ] A last-good-read timestamp is shown.
- [ ] Other modules are unaffected.
- [ ] Dependent AI employees show `paused` with the same reason.

---

## Screen 9 — Unauthorized module

**Two distinct cases.**

1. **Shell-level** (`pstate: unauthorized`) — the operator cannot see this customer's commercial
   detail. Padlock tile, *"You cannot see this customer's details"*, the reason in role terms,
   an explicit *"Data may be out of date: not applicable — nothing was loaded."*, and
   *Ask a manager for access*. The conversation is explicitly unaffected.

2. **Module-level** (Billing as an operator) — *"Billing is for managers"*, the reason, an
   inset explaining that nothing was loaded so there is no stale-data risk, and the escalation
   path: *"If a customer asks about a bill, hand the conversation to a manager."*

The module remains **listed** in the sheet with a "Managers only" note — the operator learns the
capability exists. An unentitled module is absent entirely; a forbidden one is visible and
explained.

**Acceptance criteria**

- [ ] Entitlement-absent and permission-denied render differently.
- [ ] No customer data is fetched or present in the DOM.
- [ ] The conversation is stated to be unaffected.
- [ ] An escalation path is offered.
- [ ] Wording is in role terms, never policy or system terms.

---

## Screen 10 — Partial onboarding

**Fixture.** Second tenant *Marché Créole* — grocery and delivery, messaging only, no telephony
or billing entitlement. Owner **Claudette Régis**.

**State.** 1 of 7 proved (14%). Business `proved` · Workspace `setup` (1 of 4 signed in) ·
Channels `setup` (WhatsApp only) · AI Team `blocked` (waiting on opening hours) · Business
systems `notStarted` · Acceptance `notStarted` (1 of 11 passed, 10 not run) · Go live
`notStarted`.

**Every body must match.** Workspace lists Claudette plus three invited staff; Channels shows
`marchecreole.example` and `hello@marchecreole.example` and a dashed *Telephone — not part of
your plan*; Business systems shows two not-started rows plus *"Marché Créole runs on messaging
only for now."*; Today shows a delivery-customer attention row instead of the call-menu one, no
billing approval, and a *"No sales to chase yet"* empty state.

**Acceptance criteria**

- [ ] No string from the other tenant appears anywhere (assert on rendered text).
- [ ] Blocked stages name the person and what is needed.
- [ ] Not-run checks are visually distinct from failed ones.
- [ ] Resume returns to the correct step.
- [ ] Removing telephony/billing entitlement changes only module availability and content —
      never navigation or layout.
