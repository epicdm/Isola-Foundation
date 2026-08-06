# 06 — Inventories

Two index tables so nothing is missed, plus the status-vocabulary reference.

---

## Screen inventory

| # | Screen | Context | Spec | Where in the prototype |
|---|---|---|---|---|
| 1 | Conversation Customer panel | conversation-panel, 384px | [04 §1](04-screen-specifications.md) | *Conversation* view, Customer tab |
| 2 | Work and Approvals | conversation-panel | 04 §2 | *Conversation* → Work tab |
| 3 | AI Team | conversation-panel | 04 §3 | *Conversation* → AI tab |
| 4 | Manager / Today | workspace, full width | 04 §4 | *Today* view |
| 5 | Onboarding wizard (7 stages) | onboarding, full width | 04 §5 | *Onboarding* view |
| 6 | Narrow / mobile panel | ≤420px | 04 §6 | Width selector → *Side panel only* / *Mobile* |
| 7 | Loading | any module | 04 §7 | Panel state chip → *Loading* |
| 8 | Degraded integration | any module | 04 §8 | Panel state chip → *Degraded* / *Stale* |
| 9 | Unauthorized module | any module | 04 §9 | Role *Operator* → More → Billing; state chip → *No access* |
| 10 | Partial onboarding | onboarding | 04 §10 | Tenant *Marché Créole* → Onboarding |
| — | Component sheet | reference | 02 | *Components* view |
| — | State gallery (15 states) | reference | 02, 04 | *States* view |
| — | Token sheet | reference | 01 | *Tokens* view |

Supporting views in the prototype: Chatwoot chrome (rail, conversation list, thread, composer)
is **mocked for context only** — it is not part of the build. Reuse Chatwoot's real chrome.

---

## Component inventory

| # | Component | Purpose | Variants | States |
|---|---|---|---|---|
| 1 | `IsolaWorkspaceShell` | The single embedded app | conversation-panel, workspace | ready, loading, unauthorized, empty, stale, degraded, offline |
| 2 | `ModuleNavigation` | Switch modules without growing nav | tabs, sheet | active, inactive, with-count, locked; sheet open/closed |
| 3 | `CustomerSummary` | Who this is and who owns them | panel, compact | ready, loading, no-match, multiple-matches, unauthorized |
| 4 | `StatusBadge` | An action's real status | proposed, awaitingApproval, running, done, blocked, failed, unconfirmed | static; running pulses |
| 5 | `SourceBadge` | Where a fact came from | conversation, salesRecords, phoneSystem, billing, messaging | static, withTimestamp |
| 6 | `ActionCard` | One unit of work | todo, overdue, blocked, failed, unconfirmed, done | matches the 7 action states |
| 7 | `ApprovalCard` | Authorise a governed action | awaiting, executing, completed | 3-step machine |
| 8 | `AIEmployeeCard` | An AI colleague and their limits | available, onDuty, approvalOnly, paused | static |
| 9 | `Alert` | Short actionable notice | warning, stale, degraded, error, neutral | static, with-action |
| 10 | `Timeline` | Recent contact / governed activity | contact, activity | ready, empty, loading |
| 11 | `ReadbackResult` | Proof a change exists | confirmed, pending | animates in |
| 12 | `ExpandableDetails` | Progressive disclosure | section, nested, quiet | collapsed, expanded |
| 13 | `EmptyState` | Explain an absence | nothing-to-do, no-customer-match, multiple-matches, not-configured, no-data-in-plan | static |
| 14 | `DegradedState` | A service is not answering | banner, module, offline | static |
| 15 | `LoadingSkeleton` | Shape while data arrives | line, avatar, block, customerPanel | animating, reduced-motion |
| 16 | `OnboardingStage` | One setup step, honestly | — | notStarted, setup, proved, accepted, blocked, failed |
| 17 | `VerificationChecklist` | Prove the tenant works | full (11), inline | passed, failed, notRun, running |
| 18 | `ModuleSheet` | List every installed module | — | open, closed |
| 19 | `InternalSuggestion` | AI output, never a message | — | thinking, result |
| 20 | `DraftChain` | Where a draft sits | — | suggestion, draft, approval, approved, sent |
| 21 | `Toast` | Transient confirmation | — | visible, hidden |
| 22 | `MetricLine` | A decision count | err, warn, neutral | static |
| 23 | `AttentionRow` | One "needs attention" item | err, warn, block | static |
| 24 | `KeyValueGrid` | Two-up facts | — | static |

Components 1–17 are the required minimum; 18–24 are the supporting parts the screens depend on.

---

## Status vocabulary — the words the design uses

Use these strings. They were chosen for Caribbean small-business operators and reviewed for
plainness. Do not "improve" them into product language.

| Concept | The words | Never |
|---|---|---|
| Action proposed | *To do* | "Draft", "Queued" |
| Waiting on a human | *Awaiting your approval* | "Pending" |
| Running | *Running now* | "Processing", "In flight" |
| Confirmed by the owning system | *Done and confirmed* | "Completed", "Success" |
| Deliberately stopped | *Blocked* | "Denied", "Rejected" |
| Tried and did not work | *Did not work* | "Error", "Failed operation" |
| Accepted but unconfirmed | *Not confirmed* | "Sent", "Delivered" |
| Setup exists but untested | *Set up* | "Configured", "Provisioned" |
| Tested for real | *Proved* | "Verified", "Validated" |
| Customer signed off | *Accepted* | "Approved", "Complete" |
| Nothing done yet | *Not started* | "Pending", "Inactive" |
| A source | *sales records*, *phone system*, *billing*, *messaging*, *the conversation* | Odoo, MagnusBilling, PBX, Clawith, Foundation, Meta |
| An AI colleague | *AI employee*, *your AI team*, named (Atlas, Nova, Ledger, Echo) | "Agent", "Bot", "LLM", "Assistant AI" |
| AI output | *Internal suggestion* + *Not sent to customer* | "AI response", "Generated reply" |

---

## Known copy defect carried from the prototype

One string in the loading state reads *"Loading customer record from Chatwoot and Odoo…"*.
This is the single place a system name leaked into operator-visible copy. **Implement it as
"Loading customer record from the conversation and your sales records…"** — the spec, not the
prototype, is authoritative here.
