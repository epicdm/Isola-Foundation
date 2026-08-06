# 02 — Component inventory

Every reusable part of Isola Workspace. Property names are indicative — **adapt them to the
repository's conventions**; the contract is the behaviour, states and visual result, not the
identifiers.

Conventions used below:
- *Tokens* refer to `tokens/isola-tokens.css`.
- "Panel" = the 384px Isola column inside a Chatwoot conversation.
- "Workspace" = the full-width Isola view (Today, onboarding).

---

## 1. `IsolaWorkspaceShell`

**Purpose.** The single Isola application mounted inside Chatwoot. Owns tenant identity,
module registry, module navigation, the scrolling body and the fixed primary-action footer.
There is exactly one of these — new services never mount their own shell.

**Variants.** `context="conversation-panel"` (384px column) · `context="workspace"`
(full width, used by Today and onboarding).

**States.** `ready` · `loading` · `unauthorized` · `empty` · `stale` · `degraded` · `offline`.
Shell-level states replace the module body but never the header or footer — the operator can
always see which tenant they are in and always has a way out.

**Properties.**

| Prop | Type | Notes |
|---|---|---|
| `tenant` | `{ id, name, accent?, logo? }` | Name is shown under the Isola wordmark |
| `context` | `'conversation-panel' \| 'workspace'` | |
| `conversationRef` | `{ accountId, inboxId, conversationId }` | Opaque to the UI; used for binding only |
| `modules` | `ModuleDescriptor[]` | From the registry, already filtered by entitlement + permission |
| `activeModuleId` | `string` | |
| `onModuleChange` | `(id) => void` | |
| `state` | shell state above | |
| `primaryAction` | `{ label, note, onInvoke, disabled? }` | Rendered in the footer |
| `secondaryAction` | `{ label, onInvoke }` | Optional, outline |

**Layout.** Column flex. Header (`--iso-surface`, bottom border): Isola mark 18×18 accent,
wordmark 12.5/600, tenant name 10.5/fg-3 truncating. Then module tabs. Then a scroll container
(`flex:1; overflow:auto; padding:10px 11px 16px`) whose direct child is a
`display:flex; flex-direction:column; gap:9px` stack — **the scroller must not be the flex
container itself, or children shrink instead of scrolling.** Then the fixed footer
(`flex:none`, top border).

**Responsive.** In `conversation-panel` the shell is `width:384px; min-width:340px`. Below
~850px total width it becomes the whole viewport (`width:100%`) and gains a back-to-conversation
bar. The footer never scrolls away.

**Accessibility.** `<aside aria-label="Isola Workspace">`. Header is a landmark sibling of the
tab list. Shell-state changes announce via `role="status"`. The footer's primary button is the
last tab stop in the panel.

**Example.**
```
IsolaWorkspaceShell
  tenant={id:'epic', name:'EPIC Communications'}
  context="conversation-panel"
  activeModuleId="customer"
  primaryAction={label:'Prepare follow-up', note:'Due tomorrow · nothing sent yet.'}
```

---

## 2. `ModuleNavigation`

**Purpose.** Switch between modules without ever growing the top-level navigation.

**Variants.** `tabs` (four pinned modules + a *More* affordance) · `sheet` (the full list,
opened from *More*).

**States.** Per tab: `active` · `inactive` · `with-count`. Sheet: `open` · `closed`.
Locked modules appear in the sheet with a "Managers only" note and `fg-3` label.

**Properties.**

| Prop | Type | Notes |
|---|---|---|
| `modules` | `ModuleDescriptor[]` | Order = registry priority |
| `pinnedIds` | `string[]` | Exactly four: `customer`, `work`, `ai`, `today` |
| `activeId` | `string` | |
| `counts` | `Record<id, number>` | Renders a warn pill on the tab |
| `onSelect` | `(id) => void` | |

**Behaviour.** The four pinned tabs are **permanent and identical for every tenant**. Anything
else — Phone, Billing, and every future service — is reachable only through *More*, which opens
a bottom sheet listing all installed modules with their purpose and why they are available
("Always shown" / "Added by your plan" / "Managers only"). The *More* badge shows the count of
non-pinned modules and is hidden when zero. Selecting from the sheet sets the active module and
closes the sheet; the *More* tab then carries the active underline.

**Responsive.** Tabs are `flex:1` and shorten their labels ("AI Team" → "AI") rather than
scrolling. The sheet is bottom-anchored and full-width in every context.

**Accessibility.** `role="tablist"` with `aria-label="Isola modules"`, `role="tab"` +
`aria-selected` on each. The sheet is a modal dialog: focus trapped, `Esc` closes, focus
returns to *More*. Backdrop click closes.

---

## 3. `CustomerSummary`

**Purpose.** Say who this is and who owns them, in two lines.

**Variants.** `panel` (32px avatar, two lines) · `compact` (inline, used in lists).

**States.** `ready` · `loading` (skeleton) · `no-match` · `multiple-matches` · `unauthorized`.

**Properties.** `name` · `initials` · `avatarColor` · `statusLabel` (e.g. "Active customer") ·
`ownerName` · `subtitle` · `onOpenRecord`.

**Layout.** Avatar 32×32 pill, `#C9B6FF` on `#3A1B8C` (a fixed identity colour, not the tenant
accent). Name 14.5/600/−0.01em. Second line 11.5px `fg-2`: `"Active customer · Eric Giraud
looks after them"`. No card chrome — it sits directly on the panel background.

**Multiple matches.** Renders as a choice list: each candidate is a full-width button showing
name plus a disambiguating line ("Retail · Roseau · last contact today"). The operator must
pick before any customer data is used.

**Accessibility.** The avatar is decorative (`aria-hidden`); the name is the accessible label.

---

## 4. `StatusBadge`

**Purpose.** State an action's real status in words plus colour.

**Variants.** `proposed` · `awaitingApproval` · `running` · `done` · `blocked` · `failed` ·
`unconfirmed`.

**States.** Static, except `running` which pulses a 5px dot at `iso-pulse 1s infinite`.

**Properties.** `variant` · `label` (defaults per variant) · `icon?`.

**Visual.** `display:inline-flex; gap:4px; padding:2px 7px; border-radius:pill; font:10px/600;
border:1px solid`. Family per variant from §7 of the foundation. `blocked` carries a padlock
glyph; `unconfirmed` uses `border-style:dashed` on `surface-3`.

**Rules.** Never `done` without a readback. Never invent a variant for a new integration.
The label is always present — colour is never the only signal.

**Accessibility.** Plain text content, no `aria-label` needed. The pulsing dot is
`aria-hidden` and honours `prefers-reduced-motion`.

---

## 5. `SourceBadge`

**Purpose.** Say where a fact came from, in operator language.

**Variants.** `conversation` · `salesRecords` · `phoneSystem` · `billing` · `messaging`.
Add new values by adding a **plain-English label**, never a vendor name.

**States.** Static. Optionally `withTimestamp` → "Sales records · read at 09:14".

**Properties.** `source` · `readAt?` · `href?` (opens the authoritative record).

**Visual.** `padding:2px 8px; border-radius:sm; font:10px/500; background:surface-2;
border:1px solid border; color:fg-2`. **Source badges never get their own colour** — colour is
reserved for what the operator must act on.

---

## 6. `ActionCard`

**Purpose.** One unit of work, with its true state and what to do about it.

**Variants.** `todo` · `overdue` · `blocked` · `failed` · `unconfirmed` · `done`.

**States.** Matches the seven action states. `failed` and `blocked` expose a recovery action;
`unconfirmed` deliberately exposes none.

**Properties.**

| Prop | Type | Notes |
|---|---|---|
| `title` | string | Written as an outcome, not a system call |
| `subtitle` | string | Customer + timing |
| `status` | action state | Drives `StatusBadge` |
| `assignee` | `{ name, initials, kind: 'human' \| 'ai' }` | |
| `priority` / `dueLabel` | string | "high priority", "due tomorrow", "2 days late" |
| `explanation` | string | **Required for blocked/failed/unconfirmed** |
| `customerImpact` | string | **Required for failed** |
| `actions` | `{ label, onInvoke, variant }[]` | At most one accent |

**Layout.** `surface` card, `radius-lg`, `padding:10px 12px`, `gap:6–7px`. Overdue, blocked and
failed cards gain a 3px left border in their semantic colour. The explanation renders in a
soft-tinted inset block of the same family.

**Copy rules.** Failed says what did *not* change and what the customer still believes —
*"The phone system did not accept the change, so nothing was changed. The café is still on the
daytime menu — tell them today if it cannot be fixed."* Blocked says nothing was attempted.
Unconfirmed says *"Do not tell the customer it arrived yet."*

**Responsive.** Actions wrap below the text under ~330px. Titles wrap; they never truncate.

---

## 7. `ApprovalCard`

**Purpose.** Let a human authorise a governed action, having been told exactly what will change.

**Variants.** `awaiting` · `executing` · `completed`. (A declined card is removed, not greyed.)

**States.** Drives a three-step machine: awaiting → executing → completed-with-readback.

**Properties.** `title` · `summary` · `requestedBy` (`{name, kind:'ai'|'human'}`) ·
`consequence` (**required**) · `onApprove` · `onDecline` · `readback` (`ReadbackResult`) ·
`state`.

**Layout.** `surface` card with a **3px warn left border** while awaiting. Body order: title →
one-line summary → status badge + "Prepared by Atlas · AI assistant" → a `surface-2` inset
headed *"What will happen if you approve"* → actions.

**Rules.**
- The consequence block is mandatory and must state whether anything reaches the customer.
  In the reference design: *"Nothing is sent to the customer."*
- On approve the card moves to `executing` and shows *"This is not finished until the sales
  system confirms it."* — never a success state.
- `completed` renders a `ReadbackResult`, never a bare "Done".

**Accessibility.** Approve is the accent button and the first action in DOM order. State
changes announce via `role="status"`.

---

## 8. `AIEmployeeCard`

**Purpose.** Show an AI colleague, their job, and the limits of what they may do alone.

**Variants.** `available` · `onDuty` · `approvalOnly` · `paused`.

**States.** `paused` renders at 75% opacity with a `block`-coloured status word and a reason.

**Properties.** `name` · `role` (plain English: "Front desk · WhatsApp, after hours") ·
`initials` · `availability` · `limitation?` · `onConsult?`.

**Layout.** Row: 28×28 `radius-md` avatar (accent-soft + accent-ring for Atlas, neutral for
others) → name 12.5/600 + role 11/fg-3 → availability word, right-aligned, in its semantic
colour with a 5px dot.

**Rule.** An AI employee card never implies autonomy it does not have. `approvalOnly` reads
*"every action needs approval"*; `paused` says why — *"paused, phone service down"*.

---

## 9. `Alert`

**Purpose.** A short, actionable notice inside a module.

**Variants.** `warning` · `stale` · `degraded` · `error` · `neutral`.

**States.** Static; may carry one recovery action.

**Properties.** `variant` · `title` · `body` · `action?` · `timestampNote?`.

**Layout.** `radius-md`/`lg`, soft background + 1px border of the family, 15px icon at
`flex:none`, 11.5px text in the family's strong colour. Bold lead sentence, then explanation.

**Copy contract — every alert answers four questions:**
1. What happened.
2. Whether what you are seeing may be out of date.
3. What you can do next.
4. Whether customer-facing work is affected.

Reference: *"**Showing information from 09:02.** The sales system has not answered since then,
so the opportunity value and next action may have changed. Replies to the customer are not
affected."* + a *Try again* button.

**Accessibility.** `role="status"` (polite). Never `alert` — these are not interruptions.

---

## 10. `Timeline`

**Purpose.** Recent contact or governed activity, newest first.

**Variants.** `contact` (interactions) · `activity` (governed actions).

**States.** `ready` · `empty` ("No contact in the last 30 days") · `loading`.

**Properties.** `items: { title, meta, emphasis?: 'current' | 'past' }[]` · `variant`.

**Layout.** 1.5px left rail in `--iso-border`, 12px left padding, 8px dots. The newest dot is
`--iso-accent`; older dots are `--iso-border-strong`. Each item: 12/500 title, 11/fg-3 meta.
11px gap between items.

---

## 11. `ReadbackResult`

**Purpose.** Prove that a change actually exists in the owning system. **This is the only
component allowed to declare success.**

**Variants.** `confirmed` (ok family) · `pending` (info, "waiting for confirmation").

**States.** `confirmed` animates in with `iso-rise .25s`.

**Properties.** `system` (plain English) · `statement` (what the system now holds, quoted) ·
`readAt` · `href?`.

**Layout.** `ok-soft` background, `ok-border`, `radius-md`, `padding:8px 9px`. Check glyph +
*"Confirmed by the sales system"* in 11.5/600 ok. Then the quoted state in 11.5 `fg-2`. Then an
optional "Open the record" link.

**Contract.** The statement must be the **system's own words about its own state**, plus a
timestamp: *"Reminder 'Follow up on package pricing' now exists on the Joss Boutique record,
assigned to Eric Giraud, due 7 Aug 2026. Read back at 09:31 AST."* Never "Action completed
successfully".

---

## 12. `ExpandableDetails`

**Purpose.** Progressive disclosure. Everything that is not needed for the next decision.

**Variants.** `section` (bordered card header) · `nested` (inside an open section) ·
`quiet` (used for *Technical details*, `fg-2` label, no bold).

**States.** `collapsed` · `expanded`.

**Properties.** `title` · `summary` (shown while collapsed — must carry enough to decide
whether to open) · `defaultOpen` · `onToggle`.

**Layout.** Full-width header button, `padding:10px 12px`, title 12.5/600 + summary
11.5/fg-2, 13px chevron rotating 0° → 180°. Expanded content sits under a 1px top border.

**Rule.** The collapsed summary always states what is inside — *"Connectivity and AI Front Desk
Package · EC$4,850"*, never just "Details".

**Accessibility.** `aria-expanded` on the button; content follows in DOM order. Chevron is
`aria-hidden`.

---

## 13. `EmptyState`

**Purpose.** Explain an absence and offer the next step. **Never a blank panel.**

**Variants.** `nothing-to-do` · `no-customer-match` · `multiple-matches` ·
`not-configured` · `no-data-in-plan`.

**Properties.** `title` · `body` · `actions?` · `reassurance`.

**Layout.** `surface` card or a `border-strong` dashed box, `padding:12–16px`, optional 30px
icon tile, title 12.5–13.5/600, body 11.5–12/fg-2.

**Copy contract.** Every empty state says *nothing is wrong* where that is true:
*"This customer has no follow-ups. Nothing is wrong and nothing is waiting on you."*
`no-customer-match` adds: *"You can still reply normally."*

---

## 14. `DegradedState`

**Purpose.** A service is not answering. Say what still works.

**Variants.** `banner` (inline, above module content) · `module` (fills the module body) ·
`offline` (the browser lost connection).

**Properties.** `service` (plain English) · `since` · `whatStillWorks` · `whatIsPaused` ·
`lastGoodRead` · `retrying`.

**Layout.** `block-soft` + `block-border`, warning-triangle glyph, 11.5px `block` text.

**Copy contract.** *"**The phone service is answering slowly.** Calls are working normally.
Changes to lines or menus are paused until it recovers, so what you see below was read at
08:58."* Offline adds: *"Nothing you do now will reach a customer until the connection comes
back. Your typed reply is kept."*

**Rule.** Degraded is never rendered as failure. Nothing was attempted and lost.

---

## 15. `LoadingSkeleton`

**Purpose.** Show shape while data arrives, and say what is loading.

**Variants.** `line` (9–11px bar) · `avatar` (34px circle) · `block` (30px) ·
`customerPanel` (composed preset).

**Properties.** `variant` · `width` · `count`.

**Layout.** `background: var(--iso-skeleton); background-size:200% 100%;
animation: iso-shimmer 1.3s infinite linear; border-radius:4px`.

**Contract.** A skeleton is always accompanied by a sentence naming the source and reassuring
the operator: *"Loading customer record from Chatwoot and Odoo…"* — **in production copy that
must read "…from the conversation and your sales records"** (the prototype string is the one
place a system name leaked; do not carry it over). Plus: *"You can keep replying in the
conversation while this loads."*

**Accessibility.** Container carries `aria-busy="true"`; skeleton bars are `aria-hidden`.
Honours `prefers-reduced-motion`.

---

## 16. `OnboardingStage`

**Purpose.** One step of setup, with an honest state.

**Variants / states — six, and they are not interchangeable:**

| State | Mark | Family | Means |
|---|---|---|---|
| `notStarted` | `·` | neutral | Nothing has been done |
| `setup` | `•` | warn | Configured but never tested |
| `proved` | `✓` | ok | A real test passed and the owning system confirmed it |
| `accepted` | `✓` | accent | Proved, then signed off by the customer |
| `blocked` | `−` | block | Waiting on a named person |
| `failed` | `×` | err | Tried for real and did not work |

**Properties.** `name` · `note` (what is outstanding, in one line) · `state` · `isCurrent` ·
`responsible` · `onSelect`.

**Layout.** Left-rail button, `padding:8px 9px`, `radius-md`. 19px state dot → name 12.5/500 →
note 11/fg-3 → an uppercase state chip (9.5/600, `white-space:nowrap`). The current step gets
an `accent-soft` fill with an `accent-ring` border.

**Rule.** `setup` and `proved` must never share a colour or a mark. "Connected" is not "working"
— the stepper and the step body must agree; if the body shows connected systems the stage
cannot read *Not started*.

---

## 17. `VerificationChecklist`

**Purpose.** Prove the tenant actually works, with real messages, logins and changes.

**Variants.** `full` (11 acceptance checks) · `inline` (a subset inside a step).

**States per row.** `passed` · `failed` · `notRun` · `running`.

**Properties.** `checks: { name, note, status }[]` · `summaryLabel` · `onRetry`.

**Layout.** Bordered list, one row per check: 17px status mark → name 12.5/500 + note 11/fg-3 →
status word right-aligned in its semantic colour. A footer row states the tally and, when a
check has failed, the reason plus a single accent *Run the check again* button.

**The eleven checks (do not reduce this list):** administrator can sign in · staff can sign in
and see only their inboxes · a real message from outside arrives · the AI front desk answers it ·
a person can take over mid-conversation · a person can reply and the customer receives it · the
AI can be handed the conversation back · the customer panel shows the right customer · an
approved action reaches the real system · the system confirms the change back to us · one
business cannot see another business.

**Rule.** Creating an account or an integration never counts as a pass. Each `note` records the
evidence — *"Test reminder created on a sales record"*, *"Second test tenant saw nothing of
EPIC"*.

---

## 18. Supporting parts

| Component | Purpose | Notes |
|---|---|---|
| `ModuleSheet` | Bottom sheet listing every installed module | Modal; focus-trapped; `shadow-3` |
| `InternalSuggestion` | AI output container | Plum `accent-soft` + **dashed** `accent-ring`; persistent "Not sent to customer" badge; never chat-bubble styling |
| `DraftChain` | Where a draft currently sits | Pills: AI suggestion › Your draft › Sent to customer, with the reached stage filled |
| `Toast` | Transient confirmation | `fg` background, `bg` text, `shadow-3`, `role="status"`, ~3.2s |
| `MetricLine` | Today's decision counts | Number in a semantic colour + a sentence; never a bare KPI tile |
| `AttentionRow` | One item in "Needs attention now" | Severity dot + title + consequence + owner + one action |
| `KeyValueGrid` | Two-up facts | Only where a decision needs both; otherwise a sentence |
