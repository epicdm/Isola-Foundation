import { NextResponse } from 'next/server';
import { getSetupChecklist } from '@/lib/engines';

// This endpoint reports live runtime configuration. Without these exports the
// App Router prerenders it at build time and every `configured` boolean is
// frozen at the build's env, which made the setup banner report stale truth.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** GET /api/setup-status — public endpoint (no auth) used by the setup banner. */
export async function GET() {
  const checklist = getSetupChecklist();
  const allRequired = checklist.filter((s) => s.required);
  const missing = allRequired.filter((s) => !s.configured);
  return NextResponse.json({
    ready: missing.length === 0,
    checklist,
    missing_required: missing.map((s) => s.key),
  });
}
