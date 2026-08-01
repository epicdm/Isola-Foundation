/**
 * Server-side session helper for Next.js Route Handlers and Server Components.
 *
 * Auth is handled by the shared Express API server (Replit OIDC).
 * We forward the cookie to /auth/user to get the Replit identity,
 * then look up the corresponding Prisma business_user record.
 */

import { cookies } from 'next/headers';
import { probeAuth } from './auth';
import type { AuthProbe, AuthUnavailableReason } from './auth-probe';
import { prisma } from './prisma';
import { getOrCreateIdentityForUser } from './identity';
import type { User, Tenant } from '@prisma/client';

export type DbUser = User;
export type DbTenant = Tenant;

export interface SessionCtx {
  replitId: string;
  user: DbUser & { tenant: DbTenant };
  /** For admin act-as: the tenant they are currently acting as. Otherwise = user.tenant_id. */
  effectiveTenantId: string;
  /** The Tenant record for effectiveTenantId (may differ from user.tenant when admin act-as). */
  effectiveTenant: DbTenant;
  isAdmin: boolean;
  isOwner: boolean;
  /** Identity.id resolved via getOrCreateIdentityForUser(). Null only for the
   *  NEEDS_PHONE_OR_LOGIN edge case (no replit_id and no tenant owner_phone). */
  identityId: string | null;
}

/**
 * Use in Server Components AND Route Handlers alike.
 *
 * next/headers' `cookies()` is fully supported inside Route Handlers in the
 * App Router — it reads from the same request-scoped cookie jar as Server
 * Components. We rely on it exclusively for both call sites so tenant
 * resolution (in particular the admin `act_as_tenant_id` override) can never
 * diverge between the two.
 */
export async function getSession(): Promise<SessionCtx | null> {
  const result = await getSessionResult();
  return result.status === 'authenticated' ? result.session : null;
}

/**
 * The same resolution, without throwing away WHY there is no session.
 *
 * `anonymous` is a verdict about the reader. `unavailable` is a fact about us --
 * the service that knows who they are could not be reached, so nothing has been
 * established and nothing about their session should be discarded. A guard that
 * cannot tell these apart redirects the second case to sign-in, and because
 * /auth/login sets prompt: 'login consent', that redirect costs the reader an
 * OAuth consent screen for an outage that was over in seconds.
 */
export type SessionResult =
  | { status: 'authenticated'; session: SessionCtx }
  | { status: 'anonymous' }
  | { status: 'unavailable'; reason: AuthUnavailableReason; detail: string };

export async function getSessionResult(): Promise<SessionResult> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const probe: AuthProbe = await probeAuth({ Cookie: cookieHeader });
  if (probe.status === 'unavailable') {
    return { status: 'unavailable', reason: probe.reason, detail: probe.detail };
  }
  if (probe.status === 'anonymous') return { status: 'anonymous' };

  const session = await resolveSession(probe.user);
  // Authenticated upstream but no business_user row is a real verdict about
  // this reader, not an outage: they have signed in and have no place here.
  return session ? { status: 'authenticated', session } : { status: 'anonymous' };
}

/**
 * Route Handlers previously reconstructed the cookie header manually from
 * `req.headers.get('cookie')`. That produced a *different* (and sometimes
 * stale) view of the request than next/headers' `cookies()` jar, which is
 * why admin "act as tenant" was honored on Server Component pages (e.g. the
 * dashboard) but ignored by API routes like GET /api/voice/line and
 * GET /api/wallet/balance — they'd silently fall back to the admin's own
 * tenant instead of the tenant being acted as.
 *
 * `cookies()` from next/headers works identically inside Route Handlers, so
 * this now delegates to getSession() and ignores the passed-in header. The
 * parameter is kept (optional) so existing call sites
 * (`getSessionFromCookie(req.headers.get('cookie') ?? '')`) keep compiling
 * without a mechanical edit across every route file.
 */
export async function getSessionFromCookie(
  _cookieHeader?: string,
): Promise<SessionCtx | null> {
  return getSession();
}

async function resolveSession(
  authUser: { id: string },
): Promise<SessionCtx | null> {
  const user = await prisma.user.findUnique({
    where: { replit_id: authUser.id },
    include: { tenant: true },
  });
  if (!user) return null;

  const isAdmin = user.role === 'admin';
  const effectiveTenantId =
    isAdmin && user.act_as_tenant_id ? user.act_as_tenant_id : user.tenant_id;

  let effectiveTenant: DbTenant = user.tenant;
  if (effectiveTenantId !== user.tenant_id) {
    const t = await prisma.tenant.findUnique({ where: { id: effectiveTenantId } });
    if (t) effectiveTenant = t;
  }

  // Identity resolution always anchors on the user's OWN home tenant
  // (user.tenant), never the admin act-as effectiveTenant — act-as is a
  // view override, not a change of who the admin actually is.
  const identity = await getOrCreateIdentityForUser(
    {
      id: user.id,
      replit_id: user.replit_id,
      name: user.name,
      role: user.role,
      tenant_id: user.tenant_id,
      identity_id: user.identity_id,
    },
    user.tenant.owner_phone,
  );

  return {
    replitId: authUser.id,
    user,
    effectiveTenantId,
    effectiveTenant,
    isAdmin,
    isOwner: user.role === 'owner',
    identityId: identity?.id ?? null,
  };
}

/** Returns 401-shaped JSON response when not authenticated. */
export class AuthError extends Error {
  constructor(public status = 401, message = 'Unauthorized') {
    super(message);
  }
}
