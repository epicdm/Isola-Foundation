/**
 * Isola Workspace — permission resolution.
 *
 * THE AUTHORITY CHAIN, AND WHY IT IS SHAPED THIS WAY
 * -------------------------------------------------
 * Foundation is the ONLY authority for permission. Specifically:
 *
 *   `Membership.role` (owner | admin | staff)  ->  resolveWorkspaceAuthz  ->  owner | manager | denied
 *
 * Chatwoot's own `User.role` is NEVER an authorization input. Neither is anything in the
 * Dashboard App `postMessage` payload — including `currentAgent`, which is browser-supplied
 * and unsigned. (CHATWOOT-R1-EXECUTION-PLAN §6.3; CHATWOOT-OPERATING-WORKSPACE-DESIGN §6.1.)
 *
 * WHY NOT `lib/permissions.ts`'s `can()`
 * --------------------------------------
 * That helper short-circuits `if (ctx.isAdmin || ctx.isOwner) return true`, and `User.role`
 * defaults to `'owner'` for every normal user — so `can()` would authorize essentially
 * everyone. `lib/workspace/authz.ts` was written specifically to close that hole
 * (defect-isola-workspace-tenant-role-authorization-missing-2026-07-25, now Verified), and
 * this file builds on THAT, not on `can()`. Using `can()` here would silently reintroduce a
 * closed P1.
 *
 * This module is PURE so it is testable under vitest's `node` environment.
 * `resolveWorkspacePermissions` in `permissions.server.ts` is the only I/O-touching entry.
 */

import type { Permission, WorkspaceRole } from './contracts'

// ── The permission vocabulary ───────────────────────────────────────────────

/**
 * Every permission Isola Workspace knows about. Read permissions gate module visibility;
 * approve permissions gate governed actions.
 */
export const KNOWN_PERMISSIONS = [
  'customer.read',
  'work.read',
  'work.approve',
  'ai.consult',
  'today.read',
  /** Team-level view: workload, service problems, other people's work. */
  'today.read.team',
  'phone.read',
  'phone.update-routing',
  'billing.read',
  'billing.approve-credit',
  /** Setup, verification and go-live. */
  'onboarding.manage',
] as const

export type KnownPermission = (typeof KNOWN_PERMISSIONS)[number]

export function assertKnownPermissions(permissions: readonly Permission[]): void {
  for (const p of permissions) {
    if (!(KNOWN_PERMISSIONS as readonly string[]).includes(p)) {
      throw new Error(
        `Unknown permission "${p}". Add it to KNOWN_PERMISSIONS and to PERMISSIONS_BY_ROLE, ` +
          `or a module declaring it will render unauthorized for every actor forever.`,
      )
    }
  }
}

// ── Role mapping ────────────────────────────────────────────────────────────

/**
 * The repository's access level, as produced by `resolveWorkspaceAuthz`.
 * Re-declared structurally rather than imported so this module stays free of server imports
 * and remains testable in the `node` environment.
 */
export type WorkspaceAccessLevel = 'owner' | 'manager' | 'denied'

/**
 * Map Foundation's access level onto the operator-facing role vocabulary the design uses.
 *
 * `denied` has NO workspace role. It is not "operator with fewer permissions" — it is a
 * person with no business in this tenant's workspace at all, and the shell renders a
 * shell-level `unauthorized` rather than an empty module list.
 */
export function toWorkspaceRole(level: WorkspaceAccessLevel): WorkspaceRole | null {
  switch (level) {
    case 'owner':
      return 'admin'
    case 'manager':
      return 'manager'
    case 'denied':
      return null
  }
}

/**
 * The grant table. DENY BY DEFAULT — a role holds exactly what is listed and nothing more.
 *
 * `operator` is the narrowest tier: their own work, the customer in front of them, and the
 * AI team. Explicitly NOT: team workload (`today.read.team`), money (`billing.*`), routing
 * changes (`phone.update-routing`), or setup (`onboarding.manage`).
 *
 * Note `operator` is not currently produced by `resolveWorkspaceAuthz`, which only emits
 * owner|manager|denied. It is defined here because the design requires the tier and because
 * a staff-level mapping is the next thing to land; until `Membership.role === 'staff'` is
 * plumbed through to an `operator` level, no live actor receives this set. Recorded as an
 * open question rather than silently granting staff a manager's view.
 */
export const PERMISSIONS_BY_ROLE: Record<WorkspaceRole, readonly KnownPermission[]> = {
  operator: ['customer.read', 'work.read', 'ai.consult', 'today.read', 'phone.read'],
  manager: [
    'customer.read',
    'work.read',
    'work.approve',
    'ai.consult',
    'today.read',
    'today.read.team',
    'phone.read',
    'phone.update-routing',
    'billing.read',
    'billing.approve-credit',
  ],
  admin: [
    'customer.read',
    'work.read',
    'work.approve',
    'ai.consult',
    'today.read',
    'today.read.team',
    'phone.read',
    'phone.update-routing',
    'billing.read',
    'billing.approve-credit',
    'onboarding.manage',
  ],
}

/** Permissions for a role. An unknown or absent role yields an empty set, never a default. */
export function permissionsForRole(role: WorkspaceRole | null): KnownPermission[] {
  if (!role) return []
  return [...(PERMISSIONS_BY_ROLE[role] ?? [])]
}

/**
 * Whether an actor holds every permission required.
 *
 * A courtesy check for rendering only. Every governed action is re-authorized server-side at
 * execution; nothing in this file is a security control on its own.
 */
export function holdsAll(
  held: readonly Permission[],
  required: readonly Permission[],
): boolean {
  const set = new Set(held)
  return required.every((r) => set.has(r))
}
