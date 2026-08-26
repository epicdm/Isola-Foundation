# Isola Workspace — design package and implementation map

**Status:** design scaffold, fixture-driven. Not deployed. No Chatwoot Dashboard App registered.
**Branch:** `feat/isola-workspace-design-scaffold-2026-08-06`
**Packet:** `xp-isola-workspace-embedded-design-scaffold-2026-08-06`
**Design bundle:** `design_handoff_isola_workspace` v2.0.0

---

## 1. What this is

One modular application embedded inside Chatwoot. It gives an operator customer context, AI
employees, work, approvals and management information **without opening any of the systems
behind them**.

An operator sees *Customer · Work · AI · Today*, and sources described as *the conversation*,
*sales records*, *the phone system*, *billing*. No operator ever needs to know which product
answered — and by design, cannot find out from the interface.

The central rule the whole thing exists to protect:

> **One Isola Workspace application with permission-aware modules.** Future services appear
> as modules inside the same shell. They never add top-level navigation and never mount a
> second embedded app.

### Authority

| System | Owns |
|---|---|
| **Chatwoot** | Conversations, inboxes, contacts, assignment, teams, labels, priorities, replies, human takeover. Isola replaces none of it. |
| **Foundation** | Identity, permission, entitlement, governance, approval, audit. The **only** authority for entitlement and permission. |
| **Clawith** | The AI employees. |
| **Odoo / phone / billing** | Authoritative for their own records. |

---

## 2. The bundle, and where each part landed

| Bundle file | Status | Where it lives now |
|---|---|---|
| `01-design-foundation.md` | Implemented | `artifacts/isola/styles/isola-workspace.css` |
| `02-component-inventory.md` | Implemented | `artifacts/isola/components/isola-workspace/primitives/**` |
| `03-module-framework.md` | Implemented | `artifacts/isola/lib/isola-workspace/{contracts,registry,modules}.ts` |
| `04-screen-specifications.md` | Implemented | `artifacts/isola/components/isola-workspace/{shell,modules}/**` |
| `05-interaction-flows.md` | Partly — states and copy implemented; wiring is fixture-driven | as above |
| `06-inventories.md` | Reference | this package |
| `sample-data.json` | Implemented | `artifacts/isola/lib/isola-workspace/fixtures/sample-data.json` |
| `tokens/isola-tokens.css` | Mapped, with two documented divergences (§4) | `artifacts/isola/styles/isola-workspace.css` |
| `prototype/*.html` | **Reference only. Not copied into the repository.** | — |

---

## 3. Chatwoot: what is native, what we build

Verified read-only against the running substrate on 2026-08-06 — **Chatwoot 4.16.1,
Community Edition**, image `chatwoot/chatwoot:latest-ce`
(`sha256:87d1caa3982186479d529f9cf7baf6abd415ffede6c3ab5fe387bb689e6c1d2a`). Not from
documentation.

### Reuse natively — do not rebuild

Inbox and conversation list · contacts · assignment and teams · labels, priorities and
custom attributes · saved views and filters · macros and canned responses · the composer and
replies · human takeover · AgentBots · webhooks · native operational reports.

### Build in Isola — Chatwoot does not provide these

| Capability | Why it cannot be native |
|---|---|
| Customer 360 (identity, opportunity, services, owner, next action, due date) | Chatwoot holds none of it; it lives in the sales system and is read through Foundation. |
| Governed actions with approval + authoritative readback | No native concept of a change that must be proven in a third system. |
| Overdue opportunities / follow-ups | Confirmed gap — not covered by any native queue or report. |
| Approvals and risk | Confirmed gap — same. |
| Entitlement- and permission-aware module surface | CE has exactly two roles (agent, administrator) and no custom roles. |
| Governed audit ledger | CE ships the `audits` table but **not the code**; the route 404s. Foundation's `AuditLog` is the only audit of record. |
| SLA clock and breach evidence | Enterprise-only, and the code is absent from this image. |

### Community Edition limits — measured, not assumed

`Captain` (AI), `SLA policies`, `custom roles` and `audit logs` all have their **database
tables present but their code absent**; every route returns 404. Table presence is therefore
*not* evidence of feature availability on this deployment.

> **Anomaly for the owner:** `sla_policies` holds two rows on account 5
> (`EPIC Standard (business hours)`, `EPIC Urgent / Escalation (24x7)`, identical timestamps
> `2026-07-31 16:06:55`). This image cannot have created them — `SlaPolicy` does not exist
> in it. They were inserted out of band or an Enterprise image ran previously. They are
> inert. Flagged, not acted on.

### The global-view problem, and the answer

A Chatwoot Dashboard App renders as a **tab inside `ConversationBox`, and only when a
conversation is open**. There is no global, full-page extension surface in 4.16.1 CE.

So:

- **Conversation panel** → the embedded Dashboard App (384px, `min-width` 340px).
- **Full workspace** (Today, onboarding) → **Foundation-hosted, reached by one deep link.**

Both render from the **same shell, the same module registry, the same permissions and the
same tokens**. This is not a second product; it is one product in two frames. Patching the
Chatwoot sidebar is explicitly out of scope for this increment.

---

## 4. Token strategy, and two deliberate divergences

Tokens are copied verbatim from the bundle into `artifacts/isola/styles/isola-workspace.css`.
Two things were changed on purpose, both to avoid creating a second design system:

**1. Dark mode rides the repository's existing mechanism.** `globals.css` declares
`@custom-variant dark (&:is(.dark *))` and the theme boot script toggles `.dark` on `<html>`.
The bundle proposed a second attribute, `[data-iso-theme="dark"]`. Shipping that as the
primary switch would mean two theme mechanisms that could disagree. `.dark` is primary; the
attribute is retained **only** as an escape hatch so a host can force a theme on an embedded
iframe that cannot see the host's class.

**2. The `--iso-*` scale is not promoted to Tailwind utilities.** It is deliberately absent
from `@theme inline`, so there is no `bg-iso-surface`. Exposing it would invite this closed,
semantic vocabulary into the rest of the Foundation app — exactly the "parallel design
system" the handoff forbids. Consume it with arbitrary properties:
`bg-[var(--iso-surface)]`. Everything is scoped under `.iso-root`; the bundle's bare
`body`/`button`/`a` base rules were scoped rather than shipped globally.

The repository's own tokens (`--primary`, `--background`, …) are untouched and still govern
every surface outside Isola Workspace.

### Tenant branding

Brandable: **logo, business name, accent family** — applied by setting `--iso-accent` and its
derivatives on the shell root.

Never brandable: **any status colour, border, text colour, or the focus ring's contrast.** A
tenant accent cannot reach a status badge, an alert, a checklist mark or a readback result. A
brand accent whose derived foreground fails 4.5:1 on `--iso-surface` must be rejected or
auto-corrected.

---

## 5. The module contract

`artifacts/isola/lib/isola-workspace/contracts.ts` is the full contract; `registry.ts` is the
mechanism. Adding a service should mean:

1. one adapter (implementing a port in `adapters/ports.ts`),
2. one registry entry in `modules.ts`,
3. entitlement + permission declarations,
4. tests.

**Nothing in the shell changes.** `phone` and `billing` are the proof case: ordinary registry
entries with no special handling anywhere.

### The two-stage filter — the most important behaviour

| Stage | When | Effect |
|---|---|---|
| **Entitlement** | Server-side, before the list reaches the browser | Module is **removed**. Not listed, not in the DOM. Which products a business has not bought is that business's information. |
| **Permission** | At render | Module is **kept and listed**, and renders `unauthorized`. The operator learns Billing exists and is for managers, so they can escalate rather than be stuck. |

Collapsing these breaks one guarantee whichever way it is collapsed. Both directions are
asserted in `registry.test.ts`.

### Registration is enforced, not advised

`assertValidDescriptor` rejects: a label too long for a tab; a non-reference module trying to
pin itself; a governed action with no `consequence`; a governed action with no `readback`. A
new service **physically cannot** add a top-level tab.

---

## 6. The action lifecycle

```
proposed → awaitingApproval → executing → completed (with readback)
                  ↓               ↓
               blocked          failed
                                  ↓
                            unconfirmed
```

Enforced in `action-lifecycle.ts`, asserted in `action-lifecycle.test.ts`:

1. **`executing` is not success.** Info family, never ok. The card says *"This is not finished
   until the sales system confirms it."*
2. **`completed` cannot be constructed without a readback** carrying the owning system's own
   statement of its own state **and** a timestamp. A UI rendering "Done and confirmed"
   therefore cannot be lying — the state it renders could not otherwise exist.
3. **`blocked` means nothing was attempted**, and says the customer has not been told.
4. **`failed` states what did not change and what the customer still believes.**
5. **An AI may prepare an action. It may never approve one.** Enforced by invariant.
6. **`unconfirmed` is terminal and offers no retry** — we do not know whether the effect
   landed, so retrying risks doing it twice.

`overdue` is deliberately **not** a state: it is a `proposed` action whose due date has
passed. Lateness is a fact about the clock, not about the request.

---

## 7. Roles and permissions

| | operator | manager | admin |
|---|---|---|---|
| Customer | ✅ | ✅ | ✅ |
| Work (read) | ✅ | ✅ | ✅ |
| Work (approve) | — | ✅ | ✅ |
| AI Team | ✅ | ✅ | ✅ |
| Today (own work) | ✅ | ✅ | ✅ |
| Today (team workload, service problems) | — | ✅ | ✅ |
| Phone (read) | ✅ | ✅ | ✅ |
| Phone (change routing) | — | ✅ | ✅ |
| Billing | **listed, unauthorized** | ✅ | ✅ |
| Onboarding | — | — | ✅ |

Role changes what is **rendered**, never what is **navigable**. The four pinned tabs are
identical for every tenant and every role.

Manager-only data is **omitted server-side**, never hidden with CSS.

### The authority chain

```
Membership.role (owner|admin|staff) → resolveWorkspaceAuthz → owner|manager|denied → WorkspaceRole
```

Chatwoot's own `User.role` is **never** an authorization input, and neither is anything in the
Dashboard App payload — including `currentAgent`.

`lib/permissions.ts`'s `can()` is deliberately **not** used: it short-circuits on
`isAdmin || isOwner`, and `User.role` defaults to `'owner'` for every normal user, so it would
authorize essentially everyone. `lib/workspace/authz.ts` exists precisely to close that hole
(`defect-isola-workspace-tenant-role-authorization-missing-2026-07-25`, Verified). Building on
`can()` here would silently reopen a closed P1.

---

## 8. The trust boundary

**The Chatwoot Dashboard App payload is an untrusted hint. It carries no authority.**

Verified against the served bundle: Chatwoot posts `{event:'appContext', data:{conversation,
contact, currentAgent}}` as a **JSON string**, with `targetOrigin: '*'`, and does **not**
validate the origin of the inbound `chatwoot-dashboard-app:fetch-info` request. Nothing is
signed — no HMAC, no nonce, no timestamp.

The flow:

1. Chatwoot opens Isola Workspace in an iframe.
2. The app receives the payload and extracts **exactly three integers**: account id, inbox id,
   conversation **display** id. Everything else is discarded.
3. Foundation authenticates the employee through its **own** session.
4. Foundation resolves tenant and `Membership.role` **server-side**.
5. Foundation **re-reads** the conversation through a narrow Application API identity.
6. Foundation verifies account, inbox, conversation and tenant membership. Any mismatch is an
   explicit deny, not a best-effort filter.
7. Foundation authorizes every returned field and every action.
8. Protected effects pass through approval, policy, idempotency and audit.
9. The UI receives a safe projection and an authoritative readback.

`ChatwootContextHint` has **no field** for a tenant, a role or a permission — the type system
refuses to carry them, which is stronger than a convention a future edit could forget.

Never exposed to the browser: the broad Chatwoot token · the PlatformApp token · Odoo or
phone-system credentials · tenant id as authority · a caller-selected role · any raw connector
response · raw AI memory or system prompt.

Origin checking is **hygiene, not a control**, and says so in the code: an attacker with a
foothold on the expected origin passes it. Authorization is always the Foundation session.

---

## 9. Required states

Every principal surface implements: loading · empty · unavailable · unauthorized · degraded ·
stale · blocked action · approval required · execution in progress · success with authoritative
readback · failed execution · offline/retry · partial configuration.

**Every state answers four questions:**

1. What happened?
2. Might what I am seeing be out of date?
3. What can I do next?
4. Is customer-facing work affected?

A state that cannot answer all four is not finished.

Two absolutes: **never an unexplained blank panel**, and **never a success label before an
authoritative readback**.

### Known copy correction carried from the prototype

The prototype's loading string reads *"Loading customer record from Chatwoot and Odoo…"* —
the one place a system name leaked into operator-visible copy. Production copy is
**"Loading customer record from the conversation and your sales records…"**. The spec, not
the prototype, is authoritative.

---

## 10. Fixtures

Everything is built against `fixtures/sample-data.json` behind typed adapter interfaces. This
is not a shortcut:

- The live read path is **gated**. Owner ruling D8 requires
  `defect-chatwoot-platformapp-token-harvest-path-2026-07-25` (P0, **Open**) to close before
  **any** new Chatwoot API consumer exists. Fixtures are the only lawful way to make progress.
- Against a healthy live system, most of the fourteen required states are unreachable and
  would ship untested. `FixtureHealthOverrides` makes every one of them reachable on demand.

`sample-data.json` is invented. It contains no real credential, token, phone number or
customer data, and must stay that way.

Fixture rows are validated through the **same invariants** a live action must satisfy — a
fixture that could not exist in production is worse than none, because it makes the UI look
correct while encoding a state the product forbids.

### The first vertical slice

The Revenue Loop case: conversation 131 · account 5 · inbox 46 · opportunity 1642 · owner
Eric Giraud · due 2026-08-07 · correlation
`epic-cz-revenue-loop1-2026-08-06-conv131`. Those identifiers render **only** inside
*Technical details*, in mono, never on the initial view.

---

## 11. What was NOT done, and why

- **No Chatwoot Dashboard App registered.** `dashboard_apps` is still 0 rows. Registration
  requires an administrator token and is gated behind D8.
- **No Chatwoot API call anywhere in this diff.**
- **No protected write, no customer message, no production mutation.**
- **No credential added.**
- **No Chatwoot fork.** Nothing here needs one.
- **No second inbox.** Isola never lists, threads or replies to conversations; composition
  hands back to Chatwoot's own composer.
- **No schema migration.** Entitlements are derived from existing tenant state rather than
  inventing an `Entitlement` table, which would be guesswork about an unratified commercial
  model.
- **The Chatwoot sidebar is not patched** — explicitly out of scope for this increment.

---

## 12. Open questions for the owner

1. **`operator` role has no live source.** `resolveWorkspaceAuthz` emits only
   `owner|manager|denied`. Until `Membership.role === 'staff'` is mapped to an `operator`
   level, no live actor receives the operator permission set — so the narrowest tier is
   defined and tested but not yet reachable. Mapping it is the next authorization step.
2. **Entitlement derivation is provisional.** It reads real tenant state because no
   entitlement model exists. If the commercial model should gate on `Tenant.plan` instead,
   `deriveEntitlements` is the single site to change.
3. **IBM Plex is not bundled.** The token file names it and degrades to the system stack. A
   webfont is a network and licensing decision, not a design one.
4. **The two inert `sla_policies` rows on account 5** (§3) are unexplained.
5. **`latest-ce` is a moving tag.** The running digest is recorded above; any future
   `docker compose pull` changes the deployment with no config change. Pin the version before
   depending on the Dashboard App payload shape.
6. **Dashboard App URLs are a trusted-party decision.** Chatwoot posts full conversation and
   contact PII to *any* iframe URL configured, with `targetOrigin: '*'`. Whoever may register
   a Dashboard App can exfiltrate conversation content.

---

## 13. Verifying

```bash
pnpm --filter @workspace/isola exec vitest run lib/isola-workspace   # framework
pnpm --filter @workspace/isola exec vitest run components/isola-workspace
pnpm --filter @workspace/isola typecheck
pnpm --filter @workspace/isola build
```

Tests run under vitest's **`node`** environment. This app has **no jsdom and no
testing-library**, so components follow the repository's established split: a pure
presentational `*-view.tsx` asserted with `renderToStaticMarkup`. Any new UI must keep that
split or it cannot be tested without adding a dependency.
