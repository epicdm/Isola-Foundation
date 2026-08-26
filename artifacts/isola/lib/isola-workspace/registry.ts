/**
 * Isola Workspace — the module registry.
 *
 * This is the whole plug-in mechanism. Adding a service means calling `registerModule` with
 * a descriptor and shipping an adapter. The shell never changes.
 *
 * THE TWO-STAGE FILTER — the most important behaviour in this file
 * ---------------------------------------------------------------
 * Entitlement and permission are filtered at DIFFERENT TIMES, on purpose:
 *
 *   Stage 1 (SERVER, `selectEntitledModules`) — entitlement.
 *       A module the tenant is not entitled to is REMOVED. It never reaches the browser, so
 *       it cannot be discovered in the DOM, in a network response, or by reading the bundle.
 *       This is a confidentiality boundary, not a display preference: which products a
 *       business has not bought is that business's information.
 *
 *   Stage 2 (RENDER, `annotateAuthorization`) — permission.
 *       A module the tenant IS entitled to but this person may not use is KEPT AND LISTED,
 *       and renders `unauthorized`. The operator learns Billing exists and that it is for
 *       managers, which is what lets them escalate instead of being stuck.
 *
 * Collapsing these two into one filter breaks one of the two guarantees, whichever way it
 * is collapsed. `registry.test.ts` asserts both directions.
 *
 * CLIENT-SIDE GATING IS A COURTESY, NEVER A CONTROL. Every governed action is re-authorized
 * server-side at execution regardless of what this registry decided (see
 * `03-module-framework.md` §5). Nothing here is a security control on its own.
 */

import {
  assertValidDescriptor,
  PINNED_MODULE_IDS,
  PINNED_SLOT_COUNT,
  type Entitlement,
  type ModuleContext,
  type ModuleDescriptor,
  type Permission,
  type WorkspaceContext,
} from './contracts'

// ── Registry ────────────────────────────────────────────────────────────────

/**
 * A registry instance. Deliberately NOT a module-level singleton mutated by imports:
 * a per-request registry keeps tests isolated and keeps server rendering free of
 * cross-request state. `defaultRegistry()` builds the real one.
 */
export class ModuleRegistry {
  private readonly modules = new Map<string, ModuleDescriptor>()

  /**
   * Register a module. Throws `ModuleRegistrationError` if the descriptor breaks the
   * contract — failure lands on the author, not on an operator.
   */
  register(descriptor: ModuleDescriptor): this {
    assertValidDescriptor(descriptor)
    if (this.modules.has(descriptor.id)) {
      throw new Error(
        `Module "${descriptor.id}" is already registered. Module ids are stable and unique; ` +
          `a second registration is almost always an accidental double-import.`,
      )
    }
    this.modules.set(descriptor.id, descriptor)
    return this
  }

  get(id: string): ModuleDescriptor | undefined {
    return this.modules.get(id)
  }

  /** Every registered module, in priority order. Unfiltered — server use only. */
  all(): ModuleDescriptor[] {
    return [...this.modules.values()].sort(byPriority)
  }

  get size(): number {
    return this.modules.size
  }
}

function byPriority(a: ModuleDescriptor, b: ModuleDescriptor): number {
  return a.priority - b.priority || a.id.localeCompare(b.id)
}

// ── Stage 1: entitlement (server-side) ──────────────────────────────────────

export interface EntitlementFilterInput {
  entitlements: readonly Entitlement[]
  context: ModuleContext
  /** Feature flags that are ON. A module naming an absent flag is treated as unentitled. */
  enabledFeatureFlags?: readonly string[]
}

/**
 * Remove every module this tenant is not entitled to, and every module that cannot appear
 * in this context. MUST run on the server before the module list is serialized.
 *
 * Returns a NEW array; the registry is never mutated.
 */
export function selectEntitledModules(
  modules: readonly ModuleDescriptor[],
  input: EntitlementFilterInput,
): ModuleDescriptor[] {
  const held = new Set(input.entitlements)
  const flags = new Set(input.enabledFeatureFlags ?? [])

  return modules
    .filter((m) => m.contexts.includes(input.context))
    .filter((m) => m.entitlements.every((e) => held.has(e)))
    .filter((m) => (m.featureFlag ? flags.has(m.featureFlag) : true))
    .sort(byPriority)
}

// ── Stage 2: permission (render-time) ───────────────────────────────────────

export interface AvailableModule {
  descriptor: ModuleDescriptor
  /**
   * False => the module is listed but renders `unauthorized`. It is NOT removed: the
   * operator must be able to see that the capability exists in order to escalate.
   */
  authorized: boolean
  /** Which declared permissions the actor is missing. Drives the unauthorized copy. */
  missingPermissions: Permission[]
  /** True when this module occupies one of the four pinned tabs. */
  pinned: boolean
}

/**
 * Annotate each entitled module with whether this actor may use it.
 *
 * Note this never drops a module. Dropping on permission is the bug this function exists to
 * prevent — see the header of this file.
 */
export function annotateAuthorization(
  modules: readonly ModuleDescriptor[],
  permissions: readonly Permission[],
): AvailableModule[] {
  const held = new Set(permissions)
  return modules.map((descriptor) => {
    const missingPermissions = descriptor.permissions.filter((p) => !held.has(p))
    return {
      descriptor,
      authorized: missingPermissions.length === 0,
      missingPermissions,
      pinned: descriptor.pinned,
    }
  })
}

// ── Navigation layout ───────────────────────────────────────────────────────

export interface NavigationLayout {
  /** The four permanent tabs. Identical for every tenant and every role, by law. */
  pinned: AvailableModule[]
  /** Everything else, reachable only through `More`. Never a new top-level tab. */
  overflow: AvailableModule[]
  /** Badge on the `More` tab. Hidden when zero. */
  overflowCount: number
}

/**
 * Split available modules into the four pinned tabs and the `More` sheet.
 *
 * THE INVARIANT THIS ENCODES: the pinned set is derived from `PINNED_MODULE_IDS`, a fixed
 * list — NOT from "the first four by priority". If it were priority-derived, a new module
 * with a low priority number would silently displace a permanent tab and navigation would
 * change when a service was added. That is the exact failure this design forbids.
 *
 * A pinned module the tenant is not entitled to simply does not appear; the remaining tabs
 * do not reflow into its slot, because their identity is fixed, not positional.
 */
export function buildNavigationLayout(available: readonly AvailableModule[]): NavigationLayout {
  const pinnedIds = new Set<string>(PINNED_MODULE_IDS)

  const pinned = available
    .filter((m) => pinnedIds.has(m.descriptor.id))
    .sort((a, b) => byPriority(a.descriptor, b.descriptor))

  const overflow = available
    .filter((m) => !pinnedIds.has(m.descriptor.id))
    .sort((a, b) => byPriority(a.descriptor, b.descriptor))

  if (pinned.length > PINNED_SLOT_COUNT) {
    // Unreachable given assertValidDescriptor, but a cheap guard against a future edit to
    // PINNED_MODULE_IDS silently growing the tab bar.
    throw new Error(
      `Navigation would render ${pinned.length} pinned tabs; the design permits exactly ${PINNED_SLOT_COUNT}.`,
    )
  }

  return { pinned, overflow, overflowCount: overflow.length }
}

// ── The composed resolution ─────────────────────────────────────────────────

export interface ResolvedNavigation extends NavigationLayout {
  all: AvailableModule[]
  activeModuleId: string | null
}

/**
 * The one call a surface should make: registry + context in, renderable navigation out.
 *
 * `requestedModuleId` is a HINT from the browser (a tab click, a deep link). It is honoured
 * only if that module survived entitlement filtering — a URL naming an unentitled module
 * resolves to the first available one rather than revealing that the module exists.
 */
export function resolveNavigation(
  registry: ModuleRegistry,
  ctx: WorkspaceContext,
  requestedModuleId?: string | null,
  enabledFeatureFlags?: readonly string[],
): ResolvedNavigation {
  const entitled = selectEntitledModules(registry.all(), {
    entitlements: ctx.entitlements,
    context: ctx.context,
    enabledFeatureFlags,
  })

  const withBindings = entitled.filter((m) => bindingsSatisfied(m, ctx))
  const available = annotateAuthorization(withBindings, ctx.permissions)
  const layout = buildNavigationLayout(available)

  const requested = requestedModuleId
    ? available.find((m) => m.descriptor.id === requestedModuleId)
    : undefined

  const activeModuleId =
    requested?.descriptor.id ??
    layout.pinned[0]?.descriptor.id ??
    layout.overflow[0]?.descriptor.id ??
    null

  return { ...layout, all: available, activeModuleId }
}

/**
 * A module declaring a required `conversation` binding is hidden when no conversation is in
 * scope — but only in the panel. In the full workspace the same module is reachable without
 * one (`03-module-framework.md` §2), which is how Work appears both beside a conversation
 * and in Today without being two different modules.
 *
 * A missing `customer` binding never hides anything: it drives an `empty` state
 * (no match / multiple matches), because hiding it would leave the operator with a blank
 * panel and no explanation.
 */
function bindingsSatisfied(m: ModuleDescriptor, ctx: WorkspaceContext): boolean {
  for (const b of m.bindings) {
    if (!b.required) continue
    if (b.kind === 'conversation' && !ctx.conversation) {
      if (ctx.context === 'conversation-panel') return false
    }
  }
  return true
}
