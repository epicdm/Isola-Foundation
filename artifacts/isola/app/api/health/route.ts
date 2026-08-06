import { NextResponse } from 'next/server';

import { BUILD_INFO } from '@/lib/build-info/generated';
import { buildHealthResponse } from '@/lib/build-info/contract';

/**
 * GET /api/health
 *
 * Health status plus the build identity of the artifact serving this request.
 *
 * Note: the shared Express API server owns /auth/* via the reverse proxy. This
 * route is the Next.js server's own health surface. The Autoscale STARTUP probe
 * is /api/healthz (see .replit-artifact/artifact.toml) and is deliberately a
 * different, unconditional route — a build-identity failure must be visible here
 * without preventing the container from booting and being diagnosed.
 *
 * The build block exists because a Replit publish on 2026-08-06 minted a genuine
 * new build from a source snapshot that preceded the accepted CB-0 source, and
 * nothing observable from outside could tell. Changed HTML and chunk hashes prove
 * only that a build ran. `dec-cb0-build-identity-six-hostname-corrected-release-2026-08-06`.
 *
 * Public deployment provenance only. BUILD_INFO is a compile-time constant
 * produced by scripts/generate-build-info.mjs before `next build`; this handler
 * reads no request, no header, no cookie, no session and no environment value
 * other than NODE_ENV, so there is nothing a caller can supply that changes the
 * answer and no path by which tenant, identity or credential data can enter it.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  const { status, body } = buildHealthResponse(BUILD_INFO, {
    isProduction: process.env.NODE_ENV === 'production',
  });
  return NextResponse.json(body, { status });
}
