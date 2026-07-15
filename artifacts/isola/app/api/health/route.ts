import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Simple health check for the Next.js server.
 * Note: the shared Express API server owns /api/* via the reverse proxy.
 * This route is available for internal Next.js health checks only.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
