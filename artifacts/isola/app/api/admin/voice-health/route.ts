import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceHealthReport } from '@/lib/voice-health-report';

/**
 * GET /api/admin/voice-health
 * Admin-only, live-computed per-VoiceLine health + summary. Read-only —
 * reuses lib/voice-health.ts, which itself reuses the existing
 * degraded-routing classifier (lib/voice-routing.ts). Never writes to Neon
 * or Magnus. Backs the "Re-check" button on app/admin/voice-health/page.tsx.
 */
export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  if (!isMagnusConfigured()) {
    return NextResponse.json({ error: 'Magnus is not configured' }, { status: 502 });
  }

  try {
    const report = await getVoiceHealthReport();
    return NextResponse.json(report);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? 'Voice health check failed' }, { status: 500 });
  }
}
