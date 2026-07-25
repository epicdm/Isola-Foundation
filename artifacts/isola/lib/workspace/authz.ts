/**
 * Fail-closed tenant-role authorization for the owner workspace.
 *
 * Closes `defect-isola-workspace-tenant-role-authorization-missing-2026-07-25`.
 *
 * WHY THIS DOES NOT USE `can()` FROM lib/permissions.ts
 * ----------------------------------------------------
 * `can()` short-circuits with `if (ctx.isAdmin || ctx.isOwner) return true`, and
 * `SessionCtx.isOwner` is `user.role === 'owner'` where `User.role` carries
 * `@default("owner")`. Every normally-provisioned tenant user is therefore
 * `isOwner: true`, so routing workspace access through `can()` would authorize
 * everyone and leave the defect open while appearing to fix it.
 *
 * `Membership.role` is the authority here. It is the per-tenant role added by
 * Unify Identity Phase A and is the only value that actually distinguishes an
 * owner from a manager from an ordinary user.
 *
 * LEVELS
 *   owner    Membership.role 'owner'  — everything, including the audit trail
 *                                       and assistant configuration detail.
 *   manager  Membership.role 'admin'  — operational view: team, agent identity,
 *                                       channels, conversations, activity
 *                                       volumes. No audit trail, no
 *                                       configuration/knowledge detail.
 *   denied   Membership.role 'staff', or no membership — ordinary tenant users
 *                                       are denied until an approved permission
 *                                       grants them a role.
 *
 * PLATFORM ADMIN: `ctx.isAdmin` is `user.role === 'admin'` — the EPIC platform
 * administrator, whose act-as capability is already gated behind an admin-only
 * route. They receive owner-level access to the tenant they are acting as.
 *
 * HOME-TENANT FALLBACK: when a user has no Membership row at all AND is viewing
 * their own home tenant AND their `User.role` is 'owner', they are treated as
 * owner. This preserves single-owner tenants such as EPIC Tenant Zero, which
 * predate Membership rows. It cannot widen access under act-as, because act-as
 * requires `isAdmin`, which is handled above. It never applies to another
 * tenant's workspace.
 */

import type { SessionCtx } from '@/lib/session';
import { getMembershipRole, type Role } from '@/lib/permissions';

export type WorkspaceAccessLevel = 'owner' | 'manager' | 'denied';

export interface WorkspaceAuthz {
  level: WorkspaceAccessLevel;
  /** Where the decision came from, for audit and for honest UI copy. */
  basis: 'platform-admin' | 'membership' | 'home-tenant-owner' | 'no-membership' | 'insufficient-role';
  membershipRole: Role | null;
  /** Audit trail and audited action history. */
  canViewAudit: boolean;
  /** Assistant configuration: business context, knowledge, away/after-hours copy. */
  canViewConfiguration: boolean;
}

const DENIED: Omit<WorkspaceAuthz, 'basis' | 'membershipRole'> = {
  level: 'denied',
  canViewAudit: false,
  canViewConfiguration: false,
};

/**
 * Resolve what the session may see in the workspace it is currently scoped to
 * (`ctx.effectiveTenantId`). Always fail closed: any unexpected state denies.
 */
export async function resolveWorkspaceAuthz(ctx: SessionCtx): Promise<WorkspaceAuthz> {
  const tenantId = ctx.effectiveTenantId;
  if (!tenantId) {
    return { ...DENIED, basis: 'no-membership', membershipRole: null };
  }

  // Platform administrator — including while acting as this tenant.
  if (ctx.isAdmin) {
    return {
      level: 'owner',
      basis: 'platform-admin',
      membershipRole: null,
      canViewAudit: true,
      canViewConfiguration: true,
    };
  }

  const membershipRole = await getMembershipRole(ctx.identityId, tenantId);

  if (membershipRole === 'owner') {
    return {
      level: 'owner',
      basis: 'membership',
      membershipRole,
      canViewAudit: true,
      canViewConfiguration: true,
    };
  }

  if (membershipRole === 'admin') {
    return {
      level: 'manager',
      basis: 'membership',
      membershipRole,
      canViewAudit: false,
      canViewConfiguration: false,
    };
  }

  if (membershipRole === 'staff') {
    // Ordinary tenant user. Denied until an approved permission grants a role.
    return { ...DENIED, basis: 'insufficient-role', membershipRole };
  }

  // No Membership row. Only the tenant's own owner-role user, viewing their own
  // home tenant, is trusted — this is the pre-Membership single-owner case.
  const viewingOwnHomeTenant = ctx.user?.tenant_id === tenantId;
  if (viewingOwnHomeTenant && ctx.isOwner) {
    return {
      level: 'owner',
      basis: 'home-tenant-owner',
      membershipRole: null,
      canViewAudit: true,
      canViewConfiguration: true,
    };
  }

  return { ...DENIED, basis: 'no-membership', membershipRole: null };
}

/** True when `level` satisfies `minimum`. */
export function levelSatisfies(level: WorkspaceAccessLevel, minimum: 'manager' | 'owner'): boolean {
  if (level === 'denied') return false;
  if (minimum === 'manager') return level === 'manager' || level === 'owner';
  return level === 'owner';
}

export type WorkspaceGuardResult =
  | { ok: true; authz: WorkspaceAuthz }
  | { ok: false; status: 403; error: string; authz: WorkspaceAuthz };

/**
 * Route guard. Returns 403 for an authenticated user of this tenant who lacks
 * the role. Cross-tenant access is NOT handled here — it stays a 404 from the
 * data layer, so another tenant's records remain indistinguishable from absent.
 */
export async function requireWorkspaceAccess(
  ctx: SessionCtx,
  minimum: 'manager' | 'owner' = 'manager'
): Promise<WorkspaceGuardResult> {
  const authz = await resolveWorkspaceAuthz(ctx);
  if (!levelSatisfies(authz.level, minimum)) {
    return {
      ok: false,
      status: 403,
      error:
        minimum === 'owner'
          ? 'This view is available to workspace owners.'
          : 'You do not have access to this workspace.',
      authz,
    };
  }
  return { ok: true, authz };
}
