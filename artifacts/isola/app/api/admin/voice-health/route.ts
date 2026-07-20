import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-guard';
import { isMagnusConfigured } from '@/lib/engines';
import { getVoiceHealthReport } from '@/lib/voice-health-report';

/**
 * GET /api/admin/voice-health
 * Admin-only, live-computed per-VoiceLine health + summary. Read-only —
 * reuses lib/voice-health.ts, which itself reuses the existing
 * degraded-routing classifier (lib/voice-routing.ts). Never writes to Neon
 * or Magnus. Backs the "Re-check" button on app/admin/voice-health/page.tsx.
 *
 * Uses the same requireAdmin() guard as the page's server component so the
 * two call sites can never disagree on isAdmin.
 */
export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

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
