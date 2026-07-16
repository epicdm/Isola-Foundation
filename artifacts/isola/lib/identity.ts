/**
 * lib/identity.ts — Phase C: the ONE resolution path for Identity lookups.
 * EMA/consumer realm anchors by phone; Isola/B2B (Replit Auth) realm anchors
 * by replit_id. getOrCreateIdentityForUser() mirrors the exact resolution
 * order proven in scripts/backfill-identity-phase-b.ts's
 * resolveUserIdentity(), refactored into a reusable path so live session
 * resolution — not just the one-time backfill — creates/links Identity +
 * Membership rows the same way for any User the backfill didn't already
 * cover (e.g. a signup after Phase B ran).
 */
import type { Identity } from '@prisma/client';
import { prisma } from './prisma';

export async function getIdentityByPhone(phone: string): Promise<Identity | null> {
  return prisma.identity.findUnique({ where: { phone } });
}

export async function getIdentityByReplitId(replitId: string): Promise<Identity | null> {
  return prisma.identity.findUnique({ where: { replit_id: replitId } });
}

/**
 * EMA/consumer realm anchor: find-or-create by phone. Never fabricates — the
 * phone is always known here (it's the OTP-verified login key itself).
 */
export async function getOrCreateIdentityByPhone(
  phone: string,
  displayName?: string | null,
): Promise<Identity> {
  const existing = await getIdentityByPhone(phone);
  if (!existing) {
    return prisma.identity.create({ data: { phone, display_name: displayName ?? null } });
  }
  if (displayName && existing.display_name !== displayName) {
    return prisma.identity.update({ where: { id: existing.id }, data: { display_name: displayName } });
  }
  return existing;
}

/**
 * Isola/B2B realm anchor, used by lib/session.ts on every session resolve.
 * Order: existing User.identity_id link, else replit_id, else the user's
 * home tenant's owner_phone, else create phone-anchored, else create
 * replit_id-only-anchored. Returns null (never fabricates) only when the
 * user has neither a replit_id nor a tenant owner_phone to anchor on — the
 * same NEEDS_PHONE_OR_LOGIN edge case the Phase B backfill records.
 * Self-healing: backfills User.identity_id and upserts the Membership row
 * whenever they're missing, so this converges any pre-Phase-B row on first
 * live resolve without needing a second backfill pass.
 */
export async function getOrCreateIdentityForUser(
  user: {
    id: string;
    replit_id: string | null;
    name: string | null;
    role: string;
    tenant_id: string;
    identity_id: string | null;
  },
  tenantOwnerPhone: string | null,
): Promise<Identity | null> {
  let identity: Identity | null = user.identity_id
    ? await prisma.identity.findUnique({ where: { id: user.identity_id } })
    : null;

  if (!identity && user.replit_id) {
    identity = await getIdentityByReplitId(user.replit_id);
  }

  if (!identity && tenantOwnerPhone) {
    identity = await getIdentityByPhone(tenantOwnerPhone);
    if (identity && user.replit_id && !identity.replit_id) {
      identity = await prisma.identity.update({
        where: { id: identity.id },
        data: { replit_id: user.replit_id },
      });
    }
    if (!identity) {
      identity = await prisma.identity.create({
        data: { phone: tenantOwnerPhone, replit_id: user.replit_id, display_name: user.name },
      });
    }
  }

  if (!identity && user.replit_id) {
    identity = await prisma.identity.create({
      data: { phone: null, replit_id: user.replit_id, display_name: user.name },
    });
  }

  if (!identity) return null; // NEEDS_PHONE_OR_LOGIN — never fabricate

  if (user.identity_id !== identity.id) {
    await prisma.user.update({ where: { id: user.id }, data: { identity_id: identity.id } });
  }

  await prisma.membership.upsert({
    where: { identity_id_tenant_id: { identity_id: identity.id, tenant_id: user.tenant_id } },
    create: { identity_id: identity.id, tenant_id: user.tenant_id, role: user.role },
    update: {},
  });

  return identity;
}
