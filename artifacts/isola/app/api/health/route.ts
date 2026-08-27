import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Simple health check for the Next.js server.
 * Note: the shared Express API server owns /api/* via the reverse proxy.
 * This route is available for internal Next.js health checks only.
 *
 * DEPLOY_SHA is set by the deploy pipeline to the exact commit the running
 * image was built from, so a curl against a live environment can prove
 * which commit is actually served without trusting the image tag or a
 * stack label (both have been observed stale/absent on this service).
 *
 * force-dynamic: a GET with no arguments and no dynamic-API call would
 * otherwise be statically rendered, freezing this process.env read at
 * build time forever (the exact shape of the 2026-07-27 /api/setup-status
 * defect this repo's own contract test guards against) — DEPLOY_SHA is
 * unset during the image build and only exported at deploy time, so a
 * frozen render would report null forever regardless of what is deployed.
 */
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    sha: process.env.DEPLOY_SHA ?? null,
  });
}
