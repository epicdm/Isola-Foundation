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
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    sha: process.env.DEPLOY_SHA ?? null,
  });
}
