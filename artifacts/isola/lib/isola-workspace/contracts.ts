/**
 * Isola Workspace — the module contract.
 *
 * THE RULE THIS FILE EXISTS TO PROTECT
 * ------------------------------------
 * There is ONE Isola Workspace application inside Chatwoot. Every current and future
 * service — phone, billing, payments, field visits, insurance, anything — is a MODULE
 * inside that shell. A new service never adds top-level navigation, never mounts a second
 * embedded app, and never requires a change to the shell.
 *
 * Adding a service should mean: one adapter, one registry entry, permission + entitlement
 * declarations, tests. Nothing else.
 *
 * Source: design_handoff_isola_workspace v2.0.0, `03-module-framework.md`.
 * Field names are adapted to this repository's conventions; the contract is the behaviour.
 *
 * WHY THIS IS PLAIN DATA, NOT CLASSES
 * -----------------------------------
 * A descriptor must be filterable on the SERVER before it reaches the browser (see
 * `registry.ts` — entitlement filtering happens server-side, by law). Component references
 * are therefore kept in a separate client-side lookup keyed by module id, so the descriptor
 * itself stays serializable across the server/client boundary.
 */

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * Where a module may appear.
 *
 * `conversation-panel` is the embedded Chatwoot Dashboard App (384px column).
 * `workspace` is the Foundation-hosted full-width view (Today).
 * `onboarding` is the Foundation-hosted setup wizard.
 *
 * Verified against the live substrate 2026-08-06: a Chatwoot Dashboard App renders as a
 * TAB INSIDE ConversationBox and only when a conversation is open. There is no global
 * full-page Chatwoot surface in 4.16.1 CE, which is why `workspace` and `onboarding` are
 * Foundation-hosted and reached by deep link rather than by a second embedded app.
 */
export type ModuleContext = 'conversation-panel' | 'workspace' | 'onboarding'

/**
 * An entitlement is a PLAN/PRODUCT fact about the tenant: "this business bought telephony".
 * A permission is a ROLE fact about the person: "this operator may see money".
 *
 * The distinction is load-bearing and must never be collapsed:
 *   - entitlement ABSENT  => the module does not exist for this tenant. Not listed, not in
 *                            the DOM. The operator never learns it could exist.
 *   - permission ABSENT   => the module IS listed and renders `unauthorized`. The operator
 *                            learns the capability exists and who to ask.
 *
 * Collapsing them produces either a padlocked upsell (wrong: we do not advertise into an
 * operator's workspace) or an invisible capability the operator cannot ask for (wrong: they
 * cannot escalate what they cannot see).
 */
export type Entitlement = string
export type Permission = string

/** A piece of context a module needs in scope before it can render. */
export type BindingKind = 'conversation' | 'customer' | 'tenant' | 'actor'

export interface BindingRequirement {
  kind: BindingKind
  /** A required binding that is missing hides the module (conversation) or drives a state. */
  required: boolean
}

/**
 * Plain-English source labels. An operator must never learn a system name, so this union is
 * the ONLY vocabulary a module may attribute a fact to.
 *
 * Adding a new integration means adding a plain-English label here — never a vendor name.
 * `06-inventories.md` status vocabulary: "sales records", "phone system", "billing",
 * "messaging", "the conversation" — never Odoo, MagnusBilling, PBX, Clawith, Foundation, Meta.
 */
export type SourceRef =
  | 'conversation'
  | 'salesRecords'
  | 'phoneSystem'
  | 'billing'
  | 'messaging'

/** The seven action states. See `action-lifecycle.ts` for the transition rules. */
export type ActionState =
  | 'proposed'
  | 'awaitingApproval'
  | 'executing'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'unconfirmed'

// ── Governed actions ────────────────────────────────────────────────────────

/**
 * Anything a module can change in an authoritative system.
 *
 * `consequence` and `readback` are REQUIRED and are not decoration. A governed action
 * without a stated consequence cannot be approved by an informed human, and one without a
 * readback definition can never legitimately reach `completed` — see `action-lifecycle.ts`.
 */
export interface GovernedActionDescriptor {
  /** Stable id, e.g. `phone.update-routing`. */
  id: string
  /** Operator-facing: "Change call routing to the evening menu". */
  label: string
  /**
   * REQUIRED. What will change if approved, and explicitly whether anything reaches the
   * customer. In the reference design: "Nothing is sent to the customer."
   */
  consequence: string
  /** Whether a human must authorise before execution. */
  requiresApproval: boolean
  /** e.g. `manager` for credits over a threshold. */
  approverRole?: WorkspaceRole
  /** Plain English: "the phone system". NEVER a vendor name. */
  owningSystem: SourceRef
  /**
   * REQUIRED. How the platform confirms the change exists, and what it will quote back.
   * This is a description of the verification, not the verification itself.
   */
  readback: string
  /** Drives whether a decline/undo is offered. */
  reversible: boolean
}

// ── Roles ───────────────────────────────────────────────────────────────────

/**
 * The operator-facing role vocabulary for this workspace.
 *
 * Mapped from — never equal to — the repository's real authority. `Membership.role`
 * (owner|admin|staff) and `resolveWorkspaceAuthz` are the authority; see `permissions.ts`
 * for the single mapping site. Chatwoot's own `User.role` is NEVER an authorization input
 * (CHATWOOT-R1-EXECUTION-PLAN §6.3).
 */
export type WorkspaceRole = 'operator' | 'manager' | 'admin'

// ── The descriptor ──────────────────────────────────────────────────────────

export interface ModuleDescriptor {
  /** Stable, kebab-case, never renamed once shipped. */
  id: string
  /** Semver. The shell may refuse a module whose major version it does not support. */
  version: string
  /** Short operator-facing noun, <= 10 chars for a pinned tab. NEVER a system name. */
  label: string
  /** One sentence, written for an operator. Shown in the module sheet. */
  purpose: string
  /** Key into the icon sprite. 16px stroke glyph, currentColor. */
  icon: string
  /** Where this module may appear. */
  contexts: readonly ModuleContext[]
  /** Plan/product requirements. Absent => module does not exist for the tenant. */
  entitlements: readonly Entitlement[]
  /** Role requirements. Present entitlement + missing permission => renders `unauthorized`. */
  permissions: readonly Permission[]
  /** What must be in scope for this module to render. */
  bindings: readonly BindingRequirement[]
  /** Sort order in the sheet, and order of consideration for the four pinned slots. */
  priority: number
  /**
   * Only the four reference modules may be pinned. Enforced at registration by
   * `assertValidDescriptor` — a new service cannot pin itself into the tab bar, which is
   * the mechanism that stops navigation growing.
   */
  pinned: boolean
  /** Everything this module can ask the platform to change. May be empty for read-only. */
  governedActions: readonly GovernedActionDescriptor[]
  /** Plain-English sources this module attributes facts to. */
  sources?: readonly SourceRef[]
  /** Optional feature flag; when set, the flag must be on for the module to be available. */
  featureFlag?: string
}

/** The four ids permitted to occupy a pinned tab. Enforced, not advisory. */
export const PINNED_MODULE_IDS = ['customer', 'work', 'ai-team', 'today'] as const
export type PinnedModuleId = (typeof PINNED_MODULE_IDS)[number]

/** The shell renders exactly this many pinned tabs; everything else lives behind `More`. */
export const PINNED_SLOT_COUNT = PINNED_MODULE_IDS.length

// ── Shell + module state ────────────────────────────────────────────────────

/**
 * The states every module must be able to render, plus the two the shell owns and every
 * module inherits (`stale`, `offline`).
 *
 * THE FOUR QUESTIONS. Every state — module or shell — must answer:
 *   1. What happened?
 *   2. Might what I am seeing be out of date?
 *   3. What can I do next?
 *   4. Is customer-facing work affected?
 * A state that cannot answer all four is not finished. `states.test.ts` asserts this over
 * the rendered copy rather than trusting the claim.
 */
export type ModuleState =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'unavailable'
  | 'unauthorized'
  | 'stale'
  | 'offline'

export type ShellState = ModuleState

// ── Resolved context handed to a module ─────────────────────────────────────

export interface TenantIdentity {
  id: string
  name: string
  /** Tenant-brandable accent. Status colours are never brandable. */
  accent?: string
  logoUrl?: string
}

export interface ActorIdentity {
  /** Foundation user id. Never a Chatwoot id. */
  id: string
  name: string
  role: WorkspaceRole
}

/**
 * The conversation a module is scoped to.
 *
 * IMPORTANT: these are SERVER-VERIFIED identifiers, not the browser's claim. The values
 * that arrive from Chatwoot's `postMessage` are untrusted hints and must pass through
 * `chatwoot-context.ts` and a server-side re-read before they can become a
 * `ResolvedConversationRef`. The type is deliberately distinct from `ChatwootContextHint`
 * so the two can never be confused at a call site.
 */
export interface ResolvedConversationRef {
  accountId: number
  inboxId: number
  /**
   * Chatwoot's `display_id`, which is what its UI and its own API path use — NOT the
   * database primary key. Verified against the served bundle 2026-08-06: the Dashboard App
   * payload's `conversation.id` is `display_id` (`json.id conversation.display_id`).
   */
  conversationDisplayId: number
}

export interface PrimaryAction {
  label: string
  /** Short reassurance under the button, e.g. "Due tomorrow · nothing sent yet." */
  note?: string
  disabled?: boolean
  /** Identifies what invoking this does; the shell does not execute anything itself. */
  intent: string
}

/** Everything the shell resolves and hands down. A module reads nothing outside this. */
export interface WorkspaceContext {
  tenant: TenantIdentity
  actor: ActorIdentity
  context: ModuleContext
  conversation: ResolvedConversationRef | null
  /** Zero, one or many. Many is a first-class state, not an error. */
  customerMatches: number
  entitlements: readonly Entitlement[]
  permissions: readonly Permission[]
}

// ── Registration validation ─────────────────────────────────────────────────

export class ModuleRegistrationError extends Error {
  constructor(
    public readonly moduleId: string,
    message: string,
  ) {
    super(`Module "${moduleId}" cannot be registered: ${message}`)
    this.name = 'ModuleRegistrationError'
  }
}

/**
 * The registration checklist from `03-module-framework.md` §6, enforced in code.
 *
 * A module that fails any of these is REJECTED AT REGISTRATION rather than rendering
 * something broken later. This is the whole value of having a contract: the failure is at
 * the point of authorship, not in front of an operator.
 */
export function assertValidDescriptor(d: ModuleDescriptor): void {
  const fail = (m: string) => {
    throw new ModuleRegistrationError(d.id || '(missing id)', m)
  }

  if (!d.id || !/^[a-z][a-z0-9-]*$/.test(d.id)) {
    fail('id must be non-empty kebab-case')
  }
  if (!/^\d+\.\d+\.\d+$/.test(d.version)) fail('version must be semver')
  if (!d.label) fail('label is required')
  if (d.label.length > 10) {
    fail(`label "${d.label}" exceeds 10 characters and will not fit a pinned tab`)
  }
  if (!d.purpose) fail('purpose is required and is shown to operators in the module sheet')
  if (!d.icon) fail('icon is required')
  if (!d.contexts.length) fail('at least one context must be declared')
  if (!d.bindings.length) fail('bindings must be declared explicitly, even if only tenant')
  if (!Number.isInteger(d.priority)) fail('priority must be an integer')

  // Only the four reference modules may be pinned. This is the mechanism that stops
  // navigation growing when a service is added — a new module physically cannot pin itself.
  if (d.pinned && !(PINNED_MODULE_IDS as readonly string[]).includes(d.id)) {
    fail(
      `only ${PINNED_MODULE_IDS.join(', ')} may be pinned. A new service is reached through More, never a new top-level tab.`,
    )
  }

  // A pinned module must actually be usable in the panel, or a tab leads nowhere.
  if (d.pinned && !d.contexts.includes('conversation-panel')) {
    fail('a pinned module must declare the conversation-panel context')
  }

  // Entitlement/permission must be declared, even if empty, so the author has made a
  // deliberate decision rather than inheriting a default.
  if (!Array.isArray(d.entitlements)) fail('entitlements must be declared (may be empty)')
  if (!Array.isArray(d.permissions)) fail('permissions must be declared (may be empty)')

  for (const a of d.governedActions) {
    if (!a.id) fail('every governed action needs an id')
    if (!a.consequence) {
      fail(
        `governed action "${a.id}" has no consequence. A human cannot informedly approve an action whose effect is unstated.`,
      )
    }
    if (!a.readback) {
      fail(
        `governed action "${a.id}" has no readback. Without one it can never legitimately reach "Done and confirmed".`,
      )
    }
  }
}
