/**
 * GET /api/admin/magnus/plans — list every Magnus rate plan (operator-only,
 * read-only). See lib/magnus-rateplan.ts for the verified-live module/field
 * discovery notes.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { listRatePlans } from '@/lib/magnus-rateplan';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  try {
    const plans = await listRatePlans(getMagnusConfig());
    return NextResponse.json({ plans });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
