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
export function middleware(req: NextRequest) {
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? '';
  const hostname = host.split(':')[0].toLowerCase();

  if (hostname === 'ema.epic.dm' && req.nextUrl.pathname === '/') {
    const hasSession = req.cookies.has(CONSUMER_SESSION_COOKIE);
    if (!hasSession) {
      const url = req.nextUrl.clone();
      url.pathname = '/consumer/landing';
      return NextResponse.rewrite(url);
    }
    return NextResponse.redirect(publicUrl('/consumer', req));
  }

  return NextResponse.next();
}

export const config = {
  matcher: '/',
};
