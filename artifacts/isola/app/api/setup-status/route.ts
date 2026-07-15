import { NextResponse } from 'next/server';
import { getSetupChecklist } from '@/lib/engines';

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
