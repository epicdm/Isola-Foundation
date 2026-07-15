/** GET /api/admin/magnus/trunks — trunk-group picker source for "add a new rate". */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getMagnusConfig, isMagnusConfigured } from '@/lib/engines';
import { listTrunks } from '@/lib/magnus-rateplan';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 503 });
  }

  try {
    const trunks = await listTrunks(getMagnusConfig());
    return NextResponse.json({ trunks });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 502 });
  }
}
