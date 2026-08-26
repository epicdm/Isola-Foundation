/**
 * Isola Workspace — the registered modules.
 *
 * THIS FILE IS THE PROOF OF THE ARCHITECTURE. Six modules are declared here and the shell
 * knows about none of them individually. `phone` and `billing` are the deliberate proof
 * case: they are ORDINARY registry entries with no special handling anywhere, and switching
 * between a tenant that holds their entitlements and one that does not changes only what
 * the module sheet lists and what each body renders. The four pinned tabs, the shell, the
 * footer and every layout are identical.
 *
 * Adding the seventh service means adding one entry below plus one adapter. If a future
 * change requires editing the shell to add a service, the contract has been broken.
 */

import type { ModuleDescriptor } from './contracts'
import { ModuleRegistry } from './registry'

// ── Customer ────────────────────────────────────────────────────────────────

const customer: ModuleDescriptor = {
  id: 'customer',
  version: '2.0.0',
  label: 'Customer',
  purpose: 'Who this is, what they need, and the one thing to do next.',
  icon: 'user',
  contexts: ['conversation-panel'],
  entitlements: ['core'],
  permissions: ['customer.read'],
  bindings: [
    { kind: 'conversation', required: true },
    // Not required: a missing customer drives an explained empty state (no match /
    // multiple matches), never a hidden module and never a blank panel.
    { kind: 'customer', required: false },
  ],
  priority: 10,
  pinned: true,
  governedActions: [],
  sources: ['conversation', 'salesRecords'],
}

// ── Work and approvals ──────────────────────────────────────────────────────

const work: ModuleDescriptor = {
  id: 'work',
  version: '2.0.0',
  label: 'Work',
  purpose: 'What is owed, what is late, and what needs your approval.',
  icon: 'check-square',
  // Appears both beside a conversation and in the full workspace, from ONE definition.
  contexts: ['conversation-panel', 'workspace'],
  entitlements: ['core'],
  permissions: ['work.read'],
  bindings: [{ kind: 'actor', required: true }],
  priority: 20,
  pinned: true,
  governedActions: [
    {
      id: 'work.approve',
      label: 'Approve the prepared action',
      consequence:
        'The prepared change is sent to the system that owns it. Nothing is sent to the customer.',
      requiresApproval: true,
      owningSystem: 'salesRecords',
      readback:
        'We read the record back and quote what it now holds, with the time we read it.',
      reversible: false,
    },
    {
      id: 'work.decline',
      label: 'Decline the prepared action',
      consequence: 'The prepared change is discarded. Nothing reaches any system or customer.',
      requiresApproval: false,
      owningSystem: 'salesRecords',
      readback: 'The decision is recorded against your name and the item disappears.',
      reversible: true,
    },
    {
      id: 'work.retry',
      label: 'Try the failed change again',
      consequence:
        'We attempt the same change once more. This creates a new attempt and the earlier ' +
        'failure is kept on the record. Nothing is sent to the customer.',
      requiresApproval: true,
      owningSystem: 'salesRecords',
      readback: 'We read the record back and quote what it now holds.',
      reversible: false,
    },
  ],
  sources: ['salesRecords', 'phoneSystem'],
}

// ── AI team ─────────────────────────────────────────────────────────────────

const aiTeam: ModuleDescriptor = {
  id: 'ai-team',
  version: '2.0.0',
  // 10-character ceiling for a pinned tab; shortens to "AI" in narrow layouts.
  label: 'AI Team',
  purpose: 'Your AI colleagues, what they may do alone, and what they have prepared.',
  icon: 'sparkles',
  contexts: ['conversation-panel'],
  entitlements: ['ai-team'],
  permissions: ['ai.consult'],
  bindings: [
    { kind: 'actor', required: true },
    { kind: 'conversation', required: true },
  ],
  priority: 30,
  pinned: true,
  governedActions: [
    {
      id: 'ai.prepare-action',
      label: 'Ask an AI colleague to prepare this for approval',
      // The whole point of this action's copy: preparing is not doing.
      consequence:
        'A suggested change is written down for a person to approve. Nothing is sent to the ' +
        'customer and nothing is changed in any system until someone approves it.',
      requiresApproval: false,
      owningSystem: 'salesRecords',
      readback: 'The prepared item appears under Work, marked as awaiting your approval.',
      reversible: true,
    },
  ],
  sources: ['conversation', 'salesRecords'],
}

// ── Today ───────────────────────────────────────────────────────────────────

const today: ModuleDescriptor = {
  id: 'today',
  version: '2.0.0',
  label: 'Today',
  purpose: 'What needs attention now, and what is at risk of being missed.',
  icon: 'sun',
  contexts: ['conversation-panel', 'workspace'],
  entitlements: ['core'],
  // Note only `today.read`. The team-level view is gated by `today.read.team` INSIDE the
  // module, because an operator must still reach Today for their own work. Declaring the
  // team permission here would render the whole tab unauthorized for operators, which is
  // wrong: they have their own work to see.
  permissions: ['today.read'],
  bindings: [{ kind: 'actor', required: true }],
  priority: 40,
  pinned: true,
  governedActions: [],
  sources: ['salesRecords', 'phoneSystem', 'conversation'],
}

// ── Phone — PROOF CASE, ordinary entry ──────────────────────────────────────

const phone: ModuleDescriptor = {
  id: 'phone',
  version: '2.0.0',
  label: 'Phone',
  purpose: 'Lines, call menus and recent calls for this customer.',
  icon: 'phone',
  contexts: ['conversation-panel'],
  entitlements: ['telephony'],
  permissions: ['phone.read'],
  bindings: [
    { kind: 'conversation', required: true },
    { kind: 'customer', required: false },
  ],
  priority: 50,
  // Not pinned. A new service is reached through More — never a new top-level tab.
  pinned: false,
  governedActions: [
    {
      id: 'phone.update-routing',
      label: 'Change where incoming calls go',
      consequence:
        'Incoming calls start going to the menu you choose. Callers hear the change ' +
        'immediately. No message is sent to the customer.',
      requiresApproval: true,
      approverRole: 'manager',
      owningSystem: 'phoneSystem',
      readback:
        'We read the routing back from the phone system and quote which menu it now points to.',
      reversible: true,
    },
  ],
  sources: ['phoneSystem'],
}

// ── Billing — PROOF CASE, ordinary entry ────────────────────────────────────

const billing: ModuleDescriptor = {
  id: 'billing',
  version: '2.0.0',
  label: 'Billing',
  purpose: 'Balance, plan and payment history for this customer.',
  icon: 'receipt',
  contexts: ['conversation-panel'],
  entitlements: ['billing'],
  // An entitled tenant whose OPERATOR lacks this permission sees Billing LISTED, rendering
  // unauthorized with "Billing is for managers". That is the entitlement/permission
  // distinction in action, and it is what lets the operator escalate rather than be stuck.
  permissions: ['billing.read'],
  bindings: [
    { kind: 'conversation', required: true },
    { kind: 'customer', required: false },
  ],
  priority: 60,
  pinned: false,
  governedActions: [
    {
      id: 'billing.prepare-credit',
      label: 'Prepare a goodwill credit for approval',
      consequence:
        'A credit is written down for a manager to approve. Nothing is applied to the ' +
        "customer's account and no message is sent until it is approved.",
      requiresApproval: true,
      approverRole: 'manager',
      owningSystem: 'billing',
      readback:
        'Once approved we read the account back and quote the balance it now holds.',
      reversible: false,
    },
  ],
  sources: ['billing'],
}

// ── Registration ────────────────────────────────────────────────────────────

export const ALL_MODULE_DESCRIPTORS: readonly ModuleDescriptor[] = [
  customer,
  work,
  aiTeam,
  today,
  phone,
  billing,
]

/**
 * Build a registry containing every shipped module.
 *
 * A FUNCTION, not a module-level constant, so each request and each test gets its own
 * instance. A shared mutable singleton would leak module state between tenants during
 * server rendering, which is the kind of bug that only shows up under concurrency.
 */
export function defaultRegistry(): ModuleRegistry {
  const registry = new ModuleRegistry()
  for (const descriptor of ALL_MODULE_DESCRIPTORS) {
    registry.register(descriptor)
  }
  return registry
}
