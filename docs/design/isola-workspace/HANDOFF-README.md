# Handoff: Isola Workspace inside Chatwoot

**Status:** approved for implementation planning · **Design version:** 2.0.0 ·
**Fidelity:** high-fidelity

---

## Overview

Isola Workspace is **one modular application embedded inside Chatwoot**. It gives operators
customer context, AI employees, work, approvals and management information without opening any
of the systems behind them.

- **Chatwoot** owns conversations, inboxes, contacts, assignment, teams, labels, priorities,
  replies and human takeover. Isola does not replace or duplicate any of it.
- **Foundation** is the identity, permission, governance, approval and integration control
  plane. It is the only authority for entitlement and permission.
- **Clawith** runs the AI employees.
- **Odoo, the PBX, billing and connected services** remain authoritative for their own data.

The interface hides all of that. An operator sees *Customer · Work · AI · Today*, and sources
described as *the conversation*, *sales records*, *the phone system*, *billing*. No operator
ever needs to know which product answered.

**The central rule this design exists to protect:** one Isola Workspace application with
permission-aware modules. Future services appear as modules inside the same shell. They never
add top-level navigation and never mount a second embedded app.

---

## About the design files

The files in `prototype/` are **design references written in HTML**. They demonstrate the
intended look, copy and behaviour. They are **not production code and must not be copied into
the repository**.

Your task is to **recreate these designs inside the existing Isola/Foundation repository**,
using its established framework, component library, state management and styling conventions.
If a component already exists that does the job, use it and adapt its styling to the tokens in
`tokens/`. If the repository has no suitable pattern, follow the specs here.

The written specifications (`01`–`06`) are authoritative where they differ from the prototype;
one such difference is flagged explicitly in `06-inventories.md`.

---

## Instructions for Claude Code

Read these before writing any code.

1. **Inspect the repository before implementation.** Map the existing component library, design
   tokens, routing, permission layer, Chatwoot embedding mechanism and test conventions.
   Report what exists before proposing anything new.
2. **Reuse existing components and tokens.** Do not introduce a parallel design system. Where
   the repository already has a button, badge, card, modal, skeleton or disclosure, extend it to
   satisfy this spec rather than creating a second one. Map `tokens/isola-tokens.css` onto the
   repository's token layer instead of shipping a competing stylesheet.
3. **Treat this bundle as the approved visual and interaction contract.** Layout, hierarchy,
   states, status vocabulary and copy are decided. Raise a question rather than reinterpreting.
4. **Adapt implementation to repository conventions.** Property names, file layout, typing style
   and testing approach in this bundle are indicative. The contract is behaviour and appearance.
5. **Do not fork Chatwoot.** Everything here is achievable as an embedded application plus
   Chatwoot's existing extension points. If something appears to require a core change, stop
   and report it.
6. **Do not create a second conversation inbox.** Isola never lists, threads or replies to
   conversations. It reads the active conversation for context and hands composition back to
   Chatwoot's own composer.
7. **Do not add production credentials.** No tokens, keys, account identifiers or real customer
   data in code, fixtures, tests or comments. `sample-data.json` is invented and must stay that
   way.
8. **Begin with fixtures and typed adapters.** Build every screen against `sample-data.json`
   behind a typed adapter interface per source. Only once the UI is complete and the states are
   exercised should adapters be pointed at real systems. This is what makes the ten required
   states testable.
9. **Implement the module registry and the shared shell first.** `03-module-framework.md` then
   `IsolaWorkspaceShell` + `ModuleNavigation`. Every module — including Customer — must be a
   registry entry from day one. Do not special-case the first four.
10. **Preserve the Foundation authorization boundary.** Entitlement filtering happens
    server-side before the module list reaches the client. Permission produces a rendered
    `unauthorized` state. Every governed action is re-authorized server-side at execution;
    client-side gating is a courtesy, never a control.
11. **Stop before deployment.** Deliver the implementation, the fixture-backed states and the
    tests. Do not deploy, do not run migrations against a live tenant, do not connect a real
    integration without explicit instruction.

### Non-negotiable behaviours

- **Never show a request as completed.** An action is `Done and confirmed` only after the owning
  system reads the change back, and the UI quotes that system's own statement plus a timestamp.
- **Never render an unexplained blank panel.** Every state answers: what happened, whether the
  data may be stale, what to do next, whether customer-facing work is affected.
- **Never let AI output look like a customer message.** Internal suggestions live on a plum
  dashed surface with a persistent "Not sent to customer" badge. Nothing reaches a customer
  without an explicit operator Send.
- **Never show a system name to an operator.** Not in labels, tooltips, `aria-label`s or error
  text.
- **One accent-filled action per view.**

---

## Fidelity

**High-fidelity.** Colours, typography, spacing, radii, elevation, copy and interaction states
are final. Recreate the UI faithfully using the repository's libraries. Where a repository
component differs cosmetically (e.g. a 7px radius instead of 8px), prefer the repository's
value and note the divergence — consistency inside the codebase beats pixel identity with the
prototype. Do not diverge on **information hierarchy, status vocabulary, state coverage or
copy**.

---

## What is in this bundle

```
design_handoff_isola_workspace/
├── README.md                        ← you are here
├── 01-design-foundation.md          tokens, type, spacing, breakpoints, radii, elevation,
│                                    status colours, tenant branding, light & dark
├── 02-component-inventory.md        24 components: purpose, variants, states, props,
│                                    responsive, accessibility, examples
├── 03-module-framework.md           the module registration contract for future services
├── 04-screen-specifications.md      10 screens: layout, hierarchy, spacing, behaviour,
│                                    responsive, interactions, errors, data, acceptance
├── 05-interaction-flows.md          10 flows + the keyboard contract
├── 06-inventories.md                screen index, component index, status vocabulary
├── sample-data.json                 the complete fixture set (two tenants)
├── tokens/
│   ├── isola-tokens.css             drop-in custom properties, light + dark
│   └── isola-tokens.json            machine-readable, with semantics and branding rules
├── assets/
│   └── icons.svg                    the complete icon set (16px stroke sprite)
└── prototype/
    ├── Isola Workspace v2.dc.html   editable design — the approved version
    ├── Isola Workspace v1.dc.html   earlier version, kept for reference only
    ├── support.js                   runtime required by the .dc.html files
    └── isola-workspace-standalone.html   single-file offline export; open in any browser
```

**There are no raster assets.** Every icon is an inline 16px stroke SVG; the Isola mark is a
rounded accent square containing the letter "I". If the repository has a real Isola logo, use
it — the mark in the prototype is a placeholder.

---

## Driving the prototype

Open `prototype/isola-workspace-standalone.html` in any browser. The dark bar at the top is
**prototype chrome, not product** — it exists so you can reach every state.

| Control | What it changes |
|---|---|
| Conversation / Today / Onboarding | The three real contexts |
| Components / States / Tokens | Reference sheets |
| Tenant | `EPIC · phone + billing` (full plan) ↔ `Marché Créole · no phone` (messaging only, partly onboarded) |
| Role | Operator / Manager / Tenant admin |
| Width | Desktop / Laptop / Side panel only / Mobile |
| Dark | Theme toggle |
| The chip beside "Isola Workspace" in the panel | Cycles Live → Loading → Stale → Degraded → No access → Empty |

Flows worth walking before you start:

1. **Ask Atlas → Put in the reply box → Send.** Watch the draft change appearance at every step.
2. **Work → Approve.** Awaiting → Running now → Done and confirmed, with the readback.
3. **Work → the Rosalie Café failure → Try again.** Failure copy names the customer impact.
4. **Onboarding → Acceptance → Run the check again.** Unblocks Go live; progress moves 57% → 86%.
5. **Tenant = Marché Créole.** Phone and Billing vanish from *More*; every body changes; the
   four tabs and every layout stay identical.
6. **Role = Operator → More → Billing.** The permission-denied module.

---

## Suggested implementation order

1. Tokens mapped onto the repository's token layer; dark mode proven with no component branch.
2. Module registry + `IsolaWorkspaceShell` + `ModuleNavigation` + the four required state
   renderers. Register a throwaway module to prove the contract.
3. `StatusBadge`, `SourceBadge`, `Alert`, `ExpandableDetails`, `LoadingSkeleton`,
   `EmptyState`, `DegradedState` — the primitives every module depends on.
4. **Customer module** against fixtures, including no-match, multiple-match, stale, degraded,
   unauthorized, loading.
5. `ActionCard` + `ApprovalCard` + `ReadbackResult` and the full seven-state action lifecycle.
   Get this right before touching a real integration.
6. AI Team module and the five draft states.
7. Today workspace, with role gating.
8. Onboarding wizard, six stage states, the eleven acceptance checks.
9. Phone and Billing modules — as ordinary registry entries, proving nothing in the shell
   changes.
10. Narrow/mobile pass and the keyboard/accessibility contract.

---

## Acceptance for the whole implementation

- [ ] One embedded application. One shell. Four permanent tabs.
- [ ] Adding or removing an entitlement changes only module availability and content.
- [ ] No operator-visible string names Odoo, Clawith, Foundation, MagnusBilling, PBX or Meta.
- [ ] All fourteen required states are reachable and each answers the four questions.
- [ ] No action reaches `Done and confirmed` without an authoritative readback.
- [ ] AI output is never confusable with a customer-facing message, in either theme.
- [ ] The conversation panel renders at 340px with no horizontal scrolling and a reachable
      primary action.
- [ ] Dark mode required no component to branch on theme.
- [ ] WCAG AA contrast; visible focus ring on every control; full keyboard operation.
- [ ] Chatwoot is unforked; there is no second inbox.
- [ ] No production credentials anywhere in the diff.
