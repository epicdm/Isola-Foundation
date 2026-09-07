import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Simple health check for the Next.js server.
 * Note: the shared Express API server owns /api/* via the reverse proxy.
 * This route is available for internal Next.js health checks only.
 *
 * DEPLOYMENT IDENTITY (added for host03 staging, 2026-08-26)
 * ---------------------------------------------------------
 * `sha` reports the commit this image was built from, so a health check
 * answers "which code is serving" and not merely "something is serving".
 * A rollback that silently went to the wrong image, or a build that quietly
 * reused a stale layer, is otherwise invisible from outside the container --
 * the estate has already been bitten by a deploy poller that read a phase and
 * not a commit, and reported success for a rolled-back build.
 *
 * The value is injected at image build time and is never derived from the
 * running branch, because a branch name is a claim and a commit is a fact.
 * It is null when unset rather than a guessed or empty string, so an
 * unstamped image is visibly unstamped instead of pretending to be stamped.
 */
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    sha: process.env.DEPLOY_SHA ?? null,
  });
}
