/**
 * POST /api/consumer/auth/logout — clears the consumer session cookie only.
 * Does not touch the operator `sid` cookie/session in any way.
 */

import { NextResponse } from 'next/server';
import { CONSUMER_SESSION_COOKIE } from '@/lib/consumer-session';

export async function POST() {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(CONSUMER_SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
