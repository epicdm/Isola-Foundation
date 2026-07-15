import { NextResponse } from 'next/server';

/**
 * Lightweight health check — returns 200 unconditionally.
 * Used by the production startup probe; must never redirect or require auth.
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
