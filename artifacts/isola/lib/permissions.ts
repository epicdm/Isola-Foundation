/**
 * Per-action permission model — extends the tenant-global `User.role`
 * (owner|admin, checked via SessionCtx.isOwner/isAdmin in lib/session.ts)
 * with the per-tenant `Membership.role` (owner|admin|staff) added by the
 * Unify Identity Phase A schema.
 *
 * This is additive: nothing here changes what an existing `ctx.isAdmin` /
 * `ctx.isOwner` check allows. `can()` treats a global admin/owner as always
 * authorized (today's behavior everywhere, since no call site used this
 * module before), then falls through to the finer Membership-role check
 * for everyone else — the piece that lets a `staff` Membership do a subset
 * of actions without being promoted to the tenant's single admin/owner User.
 */

import { prisma } from './prisma';

export type Role = 'owner' | 'admin' | 'staff';

const ROLE_RANK: Record<Role, number> = { staff: 0, admin: 1, owner: 2 };

export function isRole(value: unknown): value is Role {
  return value === 'owner' || value === 'admin' || value === 'staff';
}

export function roleAtLeast(role: Role, min: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Actions checkable via `can()`. Keep in sync with call sites that adopt
 * the Membership-role model — an action not listed here falls back to the
 * 'admin' minimum in `minRoleForAction()`, so adding a new action always
 * defaults to the stricter existing behavior until explicitly loosened.
 */
export type Action =
  | 'wallet.credit_adjust'
  | 'tenant.act_as'
  | 'tenant.provision_voice'
  | 'agent.update'
  | 'agent.takeover_toggle'
  | 'voice.route_change';

const ACTION_MIN_ROLE: Partial<Record<Action, Role>> = {
  'agent.update': 'staff',
  'agent.takeover_toggle': 'staff',
};

export function minRoleForAction(action: Action): Role {
  return ACTION_MIN_ROLE[action] ?? 'admin';
}

/** Looks up the caller's Membership.role for a tenant. Null if no row exists. */
export async function getMembershipRole(
  identityId: string | null | undefined,
  tenantId: string,
): Promise<Role | null> {
  if (!identityId) return null;
  const membership = await prisma.membership.findUnique({
    where: { identity_id_tenant_id: { identity_id: identityId, tenant_id: tenantId } },
  });
  if (!membership || !isRole(membership.role)) return null;
  return membership.role;
}

export interface PermissionCtx {
  identityId?: string | null;
  tenantId: string;
  isAdmin: boolean;
  isOwner: boolean;
}

/**
 * Authorize `action` for `ctx`. Existing global admin/owner sessions always
 * pass — this preserves current behavior for every route that has not
 * (yet) adopted per-action Membership checks. Everyone else is authorized
 * against their Membership.role for `ctx.tenantId` at the action's minimum
 * required role.
 */
export async function can(ctx: PermissionCtx, action: Action): Promise<boolean> {
  if (ctx.isAdmin || ctx.isOwner) return true;
  const role = await getMembershipRole(ctx.identityId, ctx.tenantId);
  if (!role) return false;
  return roleAtLeast(role, minRoleForAction(action));
}
