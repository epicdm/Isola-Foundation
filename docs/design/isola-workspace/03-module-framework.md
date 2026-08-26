# 03 — Module framework

The rule the whole design is built to protect:

> **There is one Isola Workspace application inside Chatwoot.** Every current and future
> service — phone, billing, payments, field visits, insurance, anything — is a *module* inside
> that shell. A new service never adds top-level navigation, never mounts a second embedded
> app, and never requires a change to the shell.

This document is the contract a module must satisfy. It is written to be
implementation-neutral: map it onto whatever registry, DI container, feature-flag system or
plugin loader the repository already uses. Do not introduce a new plugin mechanism if one exists.

---

## 1. Module descriptor

Every module registers a descriptor with these fields.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | stable string, kebab-case | ✅ | `customer`, `work`, `ai-team`, `today`, `phone`, `billing`. Never renamed once shipped. |
| `version` | semver | ✅ | The shell may refuse a module whose major version it does not support. |
| `label` | short operator-facing noun | ✅ | ≤ 10 characters for a pinned tab. **Never a system name.** |
| `purpose` | one sentence | ✅ | Shown in the module sheet. Written for an operator, e.g. *"Lines, call menus and recent calls for this customer."* |
| `icon` | icon ref | ✅ | 16px stroke glyph, `currentColor`, no fill. Used in the sheet and in narrow layouts. |
| `contexts` | `('conversation-panel' \| 'workspace' \| 'onboarding')[]` | ✅ | Where the module may appear. A module that only makes sense with a customer in scope declares `conversation-panel` only. |
| `entitlements` | string[] | ✅ | Plan/product requirements. Absent entitlement ⇒ the module does not exist for that tenant — it is **not** rendered as locked. |
| `permissions` | string[] | ✅ | Role requirements. Present entitlement + missing permission ⇒ the module **is** listed, and renders `unauthorized`. This distinction is deliberate and must be preserved. |
| `bindings` | `Binding[]` | ✅ | What the module needs in scope to render (see §2). |
| `priority` | integer | ✅ | Sort order in the sheet, and order of consideration for the four pinned slots. |
| `pinned` | boolean | ✅ | Only `customer`, `work`, `ai-team`, `today` may be `true`. Enforce this. |
| `states` | `StateRenderers` | ✅ | Loading, empty, unavailable, unauthorized (see §3). |
| `primaryComponent` | component ref | ✅ | The module body. |
| `primaryAction` | `(ctx) => Action \| null` | ✅ | The single accent action for the shell footer while this module is active. |
| `governedActions` | `GovernedAction[]` | ✅ | Everything this module can ask the platform to change (see §4). May be `[]` for read-only modules. |
| `badgeCount` | `(ctx) => number \| null` | — | Renders a warn pill on the tab. |
| `sources` | `SourceRef[]` | — | Plain-English source labels the module will attribute facts to. |

### Reference registrations

```
{ id:'customer',  version:'2.0.0', label:'Customer', pinned:true,  priority:10,
  contexts:['conversation-panel'], entitlements:['core'], permissions:['customer.read'],
  bindings:[{kind:'conversation', required:true},{kind:'customer', required:false}],
  governedActions:[] }

{ id:'work',      version:'2.0.0', label:'Work',     pinned:true,  priority:20,
  contexts:['conversation-panel','workspace'], entitlements:['core'],
  permissions:['work.read'],
  governedActions:['work.approve','work.decline','work.retry'] }

{ id:'ai-team',   version:'2.0.0', label:'AI',       pinned:true,  priority:30,
  contexts:['conversation-panel'], entitlements:['ai-team'], permissions:['ai.consult'],
  governedActions:['ai.prepare-action'] }

{ id:'today',     version:'2.0.0', label:'Today',    pinned:true,  priority:40,
  contexts:['conversation-panel','workspace'], entitlements:['core'],
  permissions:['today.read'] }

{ id:'phone',     version:'2.0.0', label:'Phone',    pinned:false, priority:50,
  contexts:['conversation-panel'], entitlements:['telephony'],
  permissions:['phone.read'],
  governedActions:['phone.update-routing'] }

{ id:'billing',   version:'2.0.0', label:'Billing',  pinned:false, priority:60,
  contexts:['conversation-panel'], entitlements:['billing'],
  permissions:['billing.read'],
  governedActions:['billing.prepare-credit'] }
```

`phone` and `billing` are the proof case: the reference design ships two tenants, one with both
entitlements and one with neither. Switching between them changes **only** what the sheet lists
and what module bodies render. The four pinned tabs, the shell, the footer and every screen
layout are byte-identical.

---

## 2. Bindings

A binding is a piece of context a module needs before it can render.

| Kind | Meaning | Missing ⇒ |
|---|---|---|
| `conversation` | A Chatwoot conversation is open | Module hidden in `conversation-panel`, available in `workspace` |
| `customer` | A customer record is resolved | Module renders its `empty` state: *no customer match* or *multiple matches* |
| `tenant` | Always present | — |
| `actor` | The signed-in operator and their role | Module renders `unauthorized` |

Rules:

- A module **declares** its bindings; the shell resolves them. A module never reads Chatwoot
  state directly and never queries an integration for identity.
- `customer` may resolve to zero, one or many candidates. Many is a **first-class state**, not
  an error: the shell renders a disambiguation list and no module may use customer data until
  one is chosen.
- Binding failure is never a blank panel.

---

## 3. Required state renderers

Every module must supply all four. The shell will render them; a module that omits one is
rejected at registration.

| State | When | Must communicate |
|---|---|---|
| `loading` | Data in flight | What is being fetched (plain English), and that the operator can keep replying |
| `empty` | Resolved, nothing to show | That nothing is wrong; what would put something here; an action if one exists |
| `unavailable` | An upstream service is degraded or unreachable | Which capability is affected, what still works, what is paused, when the data was last good, that it is retrying |
| `unauthorized` | Entitled but not permitted | Why (in role terms, not policy terms), that the conversation is unaffected, and the escalation path |

Plus two the shell owns and every module inherits: `stale` (data older than its freshness
budget) and `offline`.

**The four questions.** Every state — module or shell — must answer:

1. What happened?
2. Might what I am seeing be out of date?
3. What can I do next?
4. Is customer-facing work affected?

If a state cannot answer all four, it is not finished.

---

## 4. Governed actions

Anything a module can change in an authoritative system.

| Field | Meaning |
|---|---|
| `id` | `phone.update-routing` |
| `label` | Operator-facing: *"Change call routing to the evening menu"* |
| `consequence` | **Required.** What will change if approved, and explicitly whether anything reaches the customer |
| `requiresApproval` | boolean or a role predicate |
| `approverRole` | e.g. `manager` for credits over EC$100 |
| `owningSystem` | Plain English: *"the phone system"* |
| `readback` | **Required.** How the platform confirms the change exists, and what it will quote back |
| `reversible` | boolean; drives whether a decline/undo is offered |

### The action lifecycle — the single most important behaviour in this design

```
proposed → awaiting approval → executing → completed (with readback)
                     ↓              ↓
                  blocked        failed
                                    ↓
                              unconfirmed
```

Non-negotiable rules:

1. **`executing` is not success.** The UI says *"This is not finished until the sales system
   confirms it."*
2. **`completed` requires a readback.** The result quotes the owning system's own statement of
   its own state plus a timestamp. No readback ⇒ the state is `unconfirmed`, rendered with a
   dashed border and the line *"Do not tell the customer it arrived yet."*
3. **`blocked` means nothing was attempted.** Distinct colour, distinct wording, and it says the
   customer has not been told anything.
4. **`failed` states what did not change and what the customer still believes.**
5. Approval is captured against a named human. An AI employee may *prepare* an action; it may
   never approve one.

---

## 5. Authorization boundary

- Foundation is the **only** authority for entitlement and permission. The shell asks; it never
  decides.
- Entitlement filtering happens **before** the module list reaches the client. A module the
  tenant is not entitled to should not be discoverable in the DOM.
- Permission filtering happens **at render**: the module is listed, and renders `unauthorized`.
  This is what lets an operator see that Billing exists and understand it is for managers.
- Every governed action is re-authorized server-side at execution. Client-side gating is a
  courtesy, never a control.
- Tenant isolation is an acceptance check, not an assumption (check 11).

---

## 6. Registration checklist

A module is ready to register when:

- [ ] `id`, `version`, `label`, `purpose`, `icon`, `priority` are set; `label` names an operator
      activity, not a vendor.
- [ ] `contexts` are declared and the module actually renders in each.
- [ ] `entitlements` and `permissions` are declared and distinguish *absent* from *forbidden*.
- [ ] `bindings` are declared; the module reads nothing outside them.
- [ ] All four state renderers exist and each answers the four questions.
- [ ] `primaryAction` returns exactly one action, or null. Never two accent buttons.
- [ ] Every `governedAction` has a `consequence` and a `readback`.
- [ ] The module renders correctly at 340px with no horizontal scroll.
- [ ] The module uses only tokens from `tokens/isola-tokens.css` — no new colours, no new
      radii, no per-integration palette.
- [ ] Dark mode required no component branch.
- [ ] Keyboard reachable end to end; focus ring visible on every control.
- [ ] No system name appears in any operator-visible string.
