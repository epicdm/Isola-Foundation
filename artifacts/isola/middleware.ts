import { NextRequest, NextResponse } from 'next/server';
import { publicUrl } from '@/lib/request';

// Mirrors CONSUMER_SESSION_COOKIE in lib/consumer-session.ts. Not imported
// directly — that module pulls in node:crypto/Prisma/next/headers, none of
// which are safe to bundle into the Edge middleware runtime. Middleware only
// needs the cookie *name*, never the verification logic (see below).
const CONSUMER_SESSION_COOKIE = 'consumer_sid';

/**
 * Host-based routing split (Eric, 2026-07-13 — RATIFIED domain split):
 *   ema.epic.dm    → EMA CONSUMER app is canonical here. Root '/' must show
 *                    either the public marketing landing (logged-out) or the
 *                    consumer app home (logged-in) — never the B2B platform
 *                    landing page.
 *   isola.epic.dm  → Isola B2B platform is canonical here. Root '/' stays
 *                    the existing platform landing page — unchanged.
 *   app.isola.epic.dm / test.epic.dm / isola-foundation.replit.app remain
 *   live aliases of the SAME deployment and are intentionally NOT matched
 *   here, so this branch only fires for ema.epic.dm and nothing else
 *   changes for any other alias.
 *
 * Logged-in vs. logged-out split (2026-07-14): middleware only checks
 * whether the consumer_sid cookie is *present* — it deliberately does NOT
 * verify the HMAC/DB session here (that requires Prisma + SESSION_SECRET,
 * not available/desired in the Edge middleware runtime). A stale/expired
 * cookie still round-trips through '/consumer', whose own
 * `(app)/layout.tsx` does the real `getConsumerSession()` check and bounces
 * to /consumer/login exactly as it does today — so this is strictly
 * additive and never weakens the existing auth guard.
 *
 * The public landing is served via rewrite (not redirect) so the canonical
 * public URL stays exactly `ema.epic.dm/` for SEO/crawlability, while the
 * actual page lives at app/consumer/landing/page.tsx (still inside the EMA
 * font/theme scope from app/consumer/layout.tsx).
 */
/**
 * Workspace (B2B) session cookie, set by artifacts/api-server after Replit
 * OIDC. Only the NAME is needed here — middleware never verifies it. Presence
 * is used solely to decide whether to send someone to the login screen; the
 * real check stays in app/(owner)/layout.tsx via getSession(), so a stale or
 * forged cookie gains nothing.
 */
const WORKSPACE_SESSION_COOKIE = 'sid';

/**
 * Routes that require a workspace session. An unauthenticated visitor to one
 * of these must be sent to the real OIDC login and returned to where they
 * were going — previously they were bounced to '/', losing the destination
 * (defect-isola-signin-entrypoint-missing-2026-07-25).
 */
const PROTECTED_PREFIXES = [
  '/team',
  '/activity',
  '/inbox',
  '/dashboard',
  '/workspace',
  '/agent',
  '/voice',
  '/wallet',
  '/plan',
  '/onboard',
  '/admin',
  // Session-gated only (getSession() + resolveWorkspaceAuthz() in the page itself do the
  // real, role-based authorization) — this is an earlier bounce to login, defense in depth,
  // not a substitute for the route's own membership check.
  '/isola-workspace',
];

function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + '/'));
}

export function middleware(req: NextRequest) {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const hostname = host.split(':')[0].toLowerCase();
  const { pathname, search } = req.nextUrl;

  if (hostname === 'ema.epic.dm' && pathname === '/') {
    const hasSession = req.cookies.has(CONSUMER_SESSION_COOKIE);
    if (!hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = '/consumer/landing';
      return NextResponse.rewrite(url);
    }
    return NextResponse.redirect(publicUrl('/consumer', req));
  }

  if (isProtectedPath(pathname) && !req.cookies.has(WORKSPACE_SESSION_COOKIE)) {
    // returnTo is built from this request's own pathname, never from
    // user-supplied input, so it cannot be an external destination. The
    // api-server re-validates it anyway (getSafeReturnTo).
    const returnTo = pathname + (search || '');
    return NextResponse.redirect(publicUrl(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`, req));
  }

  // Server components cannot read the request path. Expose it so the owner
  // layout can build an accurate returnTo when it rejects a stale session.
  const headers = new Headers(req.headers);
  headers.set('x-isola-pathname', pathname + (search || ''));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: [
    '/',
    '/team/:path*',
    '/activity/:path*',
    '/inbox/:path*',
    '/dashboard/:path*',
    '/workspace/:path*',
    '/agent/:path*',
    '/voice/:path*',
    '/wallet/:path*',
    '/plan/:path*',
    '/onboard/:path*',
    '/admin/:path*',
    '/isola-workspace/:path*',
  ],
};
