/**
 * GET /api/provision
 * Auto-provisions a user on first login via Replit Auth.
 * Creates Tenant + User + Subscription + Wallet + Agent, then redirects.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthUser } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { publicUrl } from '@/lib/request';

export async function GET(req: NextRequest) {
  const cookieHeader = req.headers.get('cookie') ?? '';
  const authUser = await getAuthUser({ Cookie: cookieHeader });
  if (!authUser?.id) {
    return NextResponse.redirect(publicUrl('/auth/login?returnTo=/', req));
  }

  // Already provisioned?
  const existing = await prisma.user.findUnique({ where: { replit_id: authUser.id } });
  if (existing) {
    const dest = existing.role === 'admin' ? '/admin' : '/dashboard';
    return NextResponse.redirect(publicUrl(dest, req));
  }

  // Admin pre-created this user by email — link the real Replit ID now
  if (authUser.email) {
    const preCreated = await prisma.user.findFirst({
      where: {
        email: authUser.email,
        replit_id: { startsWith: 'pending:' },
      },
    });
    if (preCreated) {
      await prisma.user.update({
        where: { id: preCreated.id },
        data: {
          replit_id: authUser.id,
          name: [authUser.firstName, authUser.lastName].filter(Boolean).join(' ') || preCreated.name,
          profile_image_url: authUser.profileImageUrl ?? preCreated.profile_image_url,
        },
      });
      const dest = preCreated.role === 'admin' ? '/admin' : '/dashboard';
      return NextResponse.redirect(publicUrl(dest, req));
    }
  }

  // Determine role — ADMIN_REPLIT_IDS is a comma-separated list of Replit user IDs
  const adminIds = (process.env.ADMIN_REPLIT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const isAdmin = adminIds.includes(authUser.id);

  const displayName =
    [authUser.firstName, authUser.lastName].filter(Boolean).join(' ') ||
    authUser.email?.split('@')[0] ||
    'Owner';

  // Create Tenant
  const tenant = await prisma.tenant.create({
    data: {
      business_name: isAdmin ? 'EPIC Operators' : `${displayName}'s Business`,
      status: 'active',
      plan: isAdmin ? 'pro' : 'starter',
    },
  });

  // Create User
  const user = await prisma.user.create({
    data: {
      tenant_id: tenant.id,
      replit_id: authUser.id,
      role: isAdmin ? 'admin' : 'owner',
      email: authUser.email,
      name: displayName,
      profile_image_url: authUser.profileImageUrl,
      intelligence_tier: 'standard',
    },
  });

  // Subscription
  await prisma.subscription.create({
    data: { tenant_id: tenant.id, plan: isAdmin ? 'pro' : 'starter', status: 'active' },
  });

  // Wallet
  await prisma.wallet.create({
    data: { tenant_id: tenant.id, balance_cache: 0 },
  });

  // Default agent — every tenant gets one, including admin tenants.
  // Idempotent: upsert so re-running provision (edge case) never duplicates.
  await prisma.agent.upsert({
    where: { tenant_id: tenant.id },
    create: {
      tenant_id: tenant.id,
      name: 'Isola Assistant',
      greeting: 'Hello! How can I help you today?',
      intelligence_tier: 'standard',
      is_active: true,
    },
    update: {}, // no-op if one already exists
  });

  // Audit
  await prisma.auditLog.create({
    data: {
      tenant_id: tenant.id,
      actor_id: user.id,
      action: 'user.provision',
      entity: 'user',
      entity_id: user.id,
      meta: { role: user.role, email: user.email },
    },
  });

  const dest = isAdmin ? '/admin' : '/onboard';
  return NextResponse.redirect(publicUrl(dest, req));
}
