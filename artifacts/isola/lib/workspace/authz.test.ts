import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getMembershipRoleMock } = vi.hoisted(() => ({ getMembershipRoleMock: vi.fn() }));

vi.mock('@/lib/permissions', () => ({
  getMembershipRole: getMembershipRoleMock,
  // re-exported types only; the guard deliberately does NOT use can()
}));

import { resolveWorkspaceAuthz, requireWorkspaceAccess, levelSatisfies, workspaceRoleLabel } from './authz';
import type { SessionCtx } from '@/lib/session';

const TENANT = 'tenant-epic';
const OTHER = 'tenant-other';

function ctx(overrides: Record<string, unknown> = {}): SessionCtx {
  return {
    replitId: 'r1',
    user: { id: 'u1', tenant_id: TENANT, role: 'owner', agent_took_over: false, tenant: {} },
    effectiveTenantId: TENANT,
    effectiveTenant: { id: TENANT, business_name: 'EPIC', status: 'active' },
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
    ...overrides,
  } as unknown as SessionCtx;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMembershipRoleMock.mockResolvedValue(null);
});

describe('workspace authorization', () => {
  it('grants owner access to a Membership owner', async () => {
    getMembershipRoleMock.mockResolvedValue('owner');
    const a = await resolveWorkspaceAuthz(ctx());
    expect(a.level).toBe('owner');
    expect(a.basis).toBe('membership');
    expect(a.canViewAudit).toBe(true);
    expect(a.canViewConfiguration).toBe(true);
  });

  it('grants a Membership admin manager access WITHOUT audit or configuration', async () => {
    getMembershipRoleMock.mockResolvedValue('admin');
    const a = await resolveWorkspaceAuthz(ctx());
    expect(a.level).toBe('manager');
    expect(a.canViewAudit).toBe(false);
    expect(a.canViewConfiguration).toBe(false);
  });

  it('denies an ordinary tenant user (staff)', async () => {
    getMembershipRoleMock.mockResolvedValue('staff');
    const a = await resolveWorkspaceAuthz(ctx());
    expect(a.level).toBe('denied');
    expect(a.basis).toBe('insufficient-role');
  });

  it('denies a user with no membership who is not the home-tenant owner', async () => {
    getMembershipRoleMock.mockResolvedValue(null);
    const a = await resolveWorkspaceAuthz(ctx({ isOwner: false }));
    expect(a.level).toBe('denied');
    expect(a.basis).toBe('no-membership');
  });

  it('preserves the pre-Membership single-owner tenant (home tenant only)', async () => {
    getMembershipRoleMock.mockResolvedValue(null);
    const a = await resolveWorkspaceAuthz(ctx());
    expect(a.level).toBe('owner');
    expect(a.basis).toBe('home-tenant-owner');
  });

  it('does NOT extend the home-tenant fallback to another tenant', async () => {
    // A non-admin whose effective tenant somehow differs from their home tenant
    // must never inherit owner access from User.role.
    getMembershipRoleMock.mockResolvedValue(null);
    const a = await resolveWorkspaceAuthz(ctx({ effectiveTenantId: OTHER }));
    expect(a.level).toBe('denied');
  });

  it('grants the platform administrator owner access while acting as a tenant', async () => {
    const a = await resolveWorkspaceAuthz(ctx({ isAdmin: true, isOwner: false, effectiveTenantId: OTHER }));
    expect(a.level).toBe('owner');
    expect(a.basis).toBe('platform-admin');
    // No membership lookup is needed for a platform admin.
    expect(getMembershipRoleMock).not.toHaveBeenCalled();
  });

  it('fails closed when there is no tenant scope', async () => {
    const a = await resolveWorkspaceAuthz(ctx({ effectiveTenantId: undefined }));
    expect(a.level).toBe('denied');
  });

  // The trap this module exists to avoid: User.role defaults to 'owner', so
  // SessionCtx.isOwner is true for essentially every provisioned user. A guard
  // built on can() would authorize a staff member. This asserts we do not.
  it('does not let the User.role default promote a staff member', async () => {
    getMembershipRoleMock.mockResolvedValue('staff');
    const a = await resolveWorkspaceAuthz(ctx({ isOwner: true }));
    expect(a.level).toBe('denied');
  });
});

describe('requireWorkspaceAccess', () => {
  it('allows a manager at manager level', async () => {
    getMembershipRoleMock.mockResolvedValue('admin');
    const g = await requireWorkspaceAccess(ctx(), 'manager');
    expect(g.ok).toBe(true);
  });

  it('refuses a manager at owner level with 403', async () => {
    getMembershipRoleMock.mockResolvedValue('admin');
    const g = await requireWorkspaceAccess(ctx(), 'owner');
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.status).toBe(403);
      expect(g.error).toMatch(/owner/i);
    }
  });

  it('refuses an ordinary user with 403 and no data hint', async () => {
    getMembershipRoleMock.mockResolvedValue('staff');
    const g = await requireWorkspaceAccess(ctx(), 'manager');
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.status).toBe(403);
      // The message must not describe what the view contains.
      expect(g.error).not.toMatch(/audit|conversation|customer|phone/i);
    }
  });
});

/**
 * defect-isola-owner-login-lands-saas-operator-2026-07-25.
 * One human may legitimately hold BOTH platform authority and a tenant
 * Membership. Platform status must never silently pick the realm, and the
 * displayed role must come from the same authority that grants access.
 */
describe('dual-role identity (platform admin + tenant owner)', () => {
  it('still resolves workspace access for a platform admin on a tenant route', async () => {
    const a = await resolveWorkspaceAuthz(ctx({ isAdmin: true }));
    expect(a.level).toBe('owner');
    expect(a.basis).toBe('platform-admin');
  });

  it('labels a platform administrator as such, never as tenant owner', async () => {
    const a = await resolveWorkspaceAuthz(ctx({ isAdmin: true }));
    expect(workspaceRoleLabel(a)).toBe('Platform administrator');
  });

  it('keeps the tenant realm resolvable so the homepage does not divert to the console', async () => {
    // The root page sends the user to the operator console ONLY when workspace
    // access is denied. A dual-role identity must therefore resolve non-denied.
    getMembershipRoleMock.mockResolvedValue('owner');
    const a = await resolveWorkspaceAuthz(ctx({ isAdmin: false }));
    expect(a.level).not.toBe('denied');
    expect(workspaceRoleLabel(a)).toBe('Tenant owner');
  });

  it('a tenant member who is NOT a platform admin is never labelled an administrator', async () => {
    getMembershipRoleMock.mockResolvedValue('admin');
    const a = await resolveWorkspaceAuthz(ctx({ isAdmin: false }));
    expect(workspaceRoleLabel(a)).toBe('Tenant manager');
    expect(a.canViewAudit).toBe(false);
  });

  it('act-as does not blend realms: scope follows the acted-as tenant', async () => {
    const a = await resolveWorkspaceAuthz(
      ctx({ isAdmin: true, effectiveTenantId: OTHER, user: { id: 'admin', tenant_id: TENANT, role: 'admin' } })
    );
    expect(a.level).toBe('owner');
    expect(a.basis).toBe('platform-admin');
  });
});

describe('workspaceRoleLabel', () => {
  it('never reports a role for someone with no access', async () => {
    getMembershipRoleMock.mockResolvedValue('staff');
    const a = await resolveWorkspaceAuthz(ctx({ isOwner: true }));
    expect(a.level).toBe('denied');
    expect(workspaceRoleLabel(a)).toBe('Tenant staff');
  });

  it('does not fall back to User.role when there is no membership and no admin', async () => {
    getMembershipRoleMock.mockResolvedValue(null);
    const a = await resolveWorkspaceAuthz(ctx({ isOwner: false }));
    expect(workspaceRoleLabel(a)).toBe('No workspace access');
  });
});

describe('levelSatisfies', () => {
  it.each([
    ['owner', 'manager', true],
    ['owner', 'owner', true],
    ['manager', 'manager', true],
    ['manager', 'owner', false],
    ['denied', 'manager', false],
    ['denied', 'owner', false],
  ] as const)('%s satisfies %s = %s', (level, min, expected) => {
    expect(levelSatisfies(level, min)).toBe(expected);
  });
});
