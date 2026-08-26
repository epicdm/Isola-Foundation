# 05 — Interaction flows

Ten flows, each written as: trigger → steps → states → what must never happen → acceptance.

Timings in the prototype are simulated (`setTimeout`). In implementation they are real
round-trips; the **state sequence** is the contract, not the durations.

---

## Flow 1 — Opening Isola Workspace from a Chatwoot conversation

**Trigger.** An operator opens conversation 131 in Chatwoot; the Isola panel is present in the
right sidebar, or is opened from the Isola item in the Chatwoot rail.

**Steps.**
1. Shell mounts with tenant identity resolved and the module list already filtered by
   entitlement (server-side).
2. `conversation` binding resolves immediately from Chatwoot context.
3. `customer` binding resolves asynchronously → `loading` renders with a named source and the
   reassurance that replying still works.
4. Resolution branches: one match → `ready`; zero → `no customer match`; many →
   `multiple matches`; forbidden → `unauthorized`; upstream slow → `stale` or `degraded`.
5. `ready` renders the Customer module with the footer primary action *Prepare follow-up*.

**Must never happen.** A blank panel; a spinner with no explanation; the conversation being
blocked while Isola loads; raw identifiers on the initial view.

**Acceptance.** Panel reaches a described state within one frame of mount, and every
intermediate state answers the four questions.

---

## Flow 2 — Changing modules

**Trigger.** Tab click, or selection from the *More* sheet.

**Steps.**
1. Tab click → `onModuleChange(id)`; `aria-selected` moves; the underline moves; the body
   swaps; scroll resets to top.
2. The footer's primary action **changes with the module**: Customer → *Prepare follow-up*;
   Work → *Approve the follow-up reminder* (or *Open the oldest overdue item*); AI → *Ask Atlas
   about this customer*; Today → *Open the full Today workspace*; Phone → *Call this customer
   back*; Billing → *Prepare a credit for approval*.
3. *More* opens the module sheet: modal, focus trapped, `Esc` and backdrop close, focus returns
   to the *More* tab.
4. Selecting a non-pinned module sets it active, closes the sheet, and the *More* tab takes the
   active underline. **No new top-level tab is created.**
5. Selecting a permitted-but-unentitled module is impossible — it is not listed. Selecting an
   entitled-but-forbidden module renders `unauthorized`.

**Must never happen.** Navigation growing when a service is added; a module opening a separate
embedded app; module state leaking between customers.

**Acceptance.** Adding or removing an entitlement changes only sheet contents and module bodies;
the four pinned tabs and every layout are unchanged.

---

## Flow 3 — Expanding customer details

**Trigger.** Click on *More about this customer*.

**Steps.**
1. Group expands (`aria-expanded=true`, chevron 0°→180°), revealing five collapsed sections.
2. Each nested section expands independently. Collapsed summaries already carry the decisive
   value, so the operator opens deliberately, not to find out what is inside.
3. *Technical details* is the last section, styled quiet, and is the **only** place raw
   identifiers appear: conversation 131 · account 5 · inbox 46 · opportunity 1642 · last sync ·
   correlation `epic-cz-revenue-loop1-2026-08-06-conv131`.
4. Expansion state is per-conversation and resets on customer change.

**Must never happen.** A summary that says only "Details"; identifiers promoted above the fold;
the panel losing its scroll or its footer while expanding.

**Acceptance.** With everything expanded the panel scrolls and no section is clipped.

---

## Flow 4 — Asking Atlas

**Trigger.** Footer *Ask Atlas*, a chip in the AI module, or the Customer module's
*Prepare follow-up*.

**Steps.**
1. Module switches to AI; output region enters `thinking`: spinner + *"Atlas is reading the
   conversation and the sales record…"* + two skeleton bars.
2. On completion the region renders `InternalSuggestion` with `iso-rise`.
3. The suggestion carries provenance chips and a confidence indicator.
4. Atlas is read-only: it may summarise, draft, investigate, suggest, and **prepare** an action
   for approval. It may not execute or send.

**Must never happen.** AI output styled as a message; output reaching the customer; a suggestion
without the *"Not sent to customer"* badge; Atlas approving anything.

**Acceptance.** At every moment from `thinking` to `result` the operator can see that nothing
has been sent.

---

## Flow 5 — Reviewing an AI suggestion

**Trigger.** A suggestion is on screen.

**Four exits.**

| Action | Result |
|---|---|
| **Put in the reply box** | Draft moves to the Chatwoot composer, which gains an accent provenance chip: *"Operator draft, started from an Atlas suggestion. Nothing is sent until you press Send."* Send becomes accent-enabled. Toast: *"Wording placed in your reply box. Not sent yet."* |
| **Ask for approval** | Draft state → `approval`. `DraftChain` reads *"Waiting for a manager to approve this wording. Nothing has been sent."* |
| **Create a follow-up** | Switches to Work with a new `ApprovalCard` in `awaiting`. Toast names where it went. |
| **Discard** | Output returns to `idle`; the empty state explains what would appear here. |

`DraftChain` — *AI suggestion › Your draft › Sent to customer* — shows exactly how far the
wording has travelled, with only the reached stages filled.

**Must never happen.** Sending as a side effect of any of the four; the composer looking
identical to a plain draft; losing the operator's edits.

**Acceptance.** Five draft states (suggestion, operator draft, approval requested, approved,
sent) are visually distinguishable without reading the label.

---

## Flow 6 — Requesting approval

**Trigger.** Atlas prepares a governed action, or an operator escalates one they cannot perform.

**Steps.**
1. An `ApprovalCard` appears in Work in `awaiting`, with *"Prepared by Atlas · AI assistant"*.
2. The card states the consequence in full, including that nothing is sent to the customer.
3. Approve is the accent action and is mirrored by the shell footer.
4. Decline removes the card and records the decision against the named human.
5. Actions beyond the operator's authority (a credit over EC$100) render `blocked` instead,
   with *Send to a manager* — they are never silently approved.

**Must never happen.** An AI approving; approval without a stated consequence; a blocked action
appearing to have been attempted.

**Acceptance.** Every approval is attributable to a named human and re-authorized server-side.

---

## Flow 7 — Viewing action progress

**Trigger.** Approve, or Retry on a failed action.

**Steps.**
1. State → `executing`: info badge *Running now* with a pulsing dot, an indeterminate bar, and
   the sentence *"Sending the request to the sales system. This is not finished until the sales
   system confirms it."*
2. The footer's primary action becomes non-committal (*Running…*).
3. Terminal states: `completed` (with readback) · `failed` (with customer impact) ·
   `unconfirmed` (accepted but not confirmed — dashed, no retry, *"Do not tell the customer it
   arrived yet."*).

**Must never happen.** Green during execution; the word "completed" before a readback; a
progress indicator that implies determinate progress it does not have.

**Acceptance.** `executing` uses only the info family; no ok token appears until readback.

---

## Flow 8 — Viewing authoritative readback

**Trigger.** The owning system confirms a change.

**Steps.**
1. `ReadbackResult` replaces the progress block with `iso-rise .25s`.
2. It quotes the owning system's own statement of its own state plus a timestamp:
   *"Reminder 'Follow up on package pricing' now exists on the Joss Boutique record, assigned to
   Eric Giraud, due 7 Aug 2026. Read back at 09:31 AST."*
3. An *Open the record* link points at the authoritative source.
4. A toast confirms; the badge becomes `Done and confirmed`.
5. The entry is appended to *Actions taken for this customer* with its readback preserved.

**Must never happen.** "Action completed successfully"; a readback without a timestamp; a
readback paraphrased from the request rather than read from the system.

**Acceptance.** Every `done` item in the audit trail carries a system statement and a timestamp.

---

## Flow 9 — Resuming failed onboarding

**Trigger.** An administrator returns to a partly-complete setup, or a check has failed.

**Steps.**
1. *Save and continue later* → ok strip: *"**Saved.** You can close this and come back. We will
   email a link to carry on from step n."* + *Carry on now*.
2. On return, the wizard opens at the saved step with every stage state intact.
3. A failed acceptance check shows the reason — *"Isola changed a call menu but the phone system
   did not confirm it. Nothing else is affected."* — and one accent *Run the check again*.
4. Retry success → the check passes, the tally moves 10/11 → 11/11, progress 57% → 86%, the
   stage moves `failed` → `proved`, and the Go-live blocker clears.
5. Go live while a check is unpassed offers an explicit partial: switch on messaging and sales,
   leave phone changes off until it passes.
6. Blocked stages name the person and what is needed — *"Waiting on opening hours"*, Claudette
   Régis.

**Must never happen.** A stage advancing on configuration alone; "verified" for something never
tested; a blocker without a named owner.

**Acceptance.** Retrying a single check changes only that check, its stage, the tally, the
progress figure and the Go-live blocker.

---

## Flow 10 — Switching between operator and manager contexts

**Trigger.** Role changes (in production: the signed-in actor's role; in the prototype, the Role
selector).

**Steps.**
1. `operator` → conversation-panel context. Today shows own work with a notice that team
   workload and service problems are shown to managers. Billing is listed but renders
   `unauthorized`. Credits above threshold render `blocked` with *Send to a manager*.
2. `manager` → Today workspace. Team workload, AI workload and failures, service problems and
   approvals authority all appear. Billing renders content.
3. `admin` → onboarding. Setup, verification and go-live.
4. Role changes what is **rendered**, never what is **navigable** — the four pinned tabs are
   identical in all three.

**Must never happen.** Role-gated data reaching the client and being hidden with CSS;
client-side role checks acting as the control; navigation differing by role.

**Acceptance.** With operator role, no manager-only value is present in the DOM. Server-side
authorization is re-checked on every governed action regardless of role.

---

## Cross-cutting keyboard contract

| Surface | Behaviour |
|---|---|
| Module tabs | `Tab` to the list, `←/→` between tabs, `Enter`/`Space` selects |
| Module sheet | Focus trapped, `Esc` closes, focus returns to *More* |
| Disclosures | `Enter`/`Space` toggles; `aria-expanded` reflects state |
| Panel footer | Last tab stop; reachable at any scroll position |
| Approve / Decline | Approve first in DOM order |
| All controls | Visible `2px solid var(--iso-accent-ring)` focus ring, offset 2px |
| Announcements | `role="status"` on alerts, degraded/stale banners, state transitions and toasts |
