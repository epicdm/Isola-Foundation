/**
 * GET /api/admin/magnus/prefixes?prefix=44 — exact dial-prefix lookup in the
 * Magnus destination catalog, used by "add a new rate" to resolve a prefix
 * the operator types (e.g. "44" for UK, "1767225" for Dominica Cellular) to
 * its Magnus `id_prefix`. Magnus only supports exact-match filtering here —
 * there is no substring search over the ~95k-row prefix catalog.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { findPrefixByExact } from '@/lib/magnus-rateplan';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  const prefix = req.nextUrl.searchParams.get('prefix')?.trim();
  if (!prefix) return NextResponse.json({ error: 'prefix query param required' }, { status: 400 });

  try {
    const entry = await findPrefixByExact(getMagnusConfig(), prefix);
    if (!entry) return NextResponse.json({ error: `No exact match for prefix "${prefix}"` }, { status: 404 });
    return NextResponse.json({ prefix: entry });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
