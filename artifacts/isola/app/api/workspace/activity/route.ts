import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getActivitySummary, getConversationOverview, getHandoffState } from '@/lib/workspace/tenant-workspace';

/**
 * GET /api/workspace/activity
 *
 * Real activity and reporting for the session's tenant: conversation volumes,
 * metered usage, recent audited actions and current handoff state. Every panel
 * carries its own provenance so the UI can state where each number came from.
 */
export const revalidate = 0;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [activity, conversations, handoff] = await Promise.all([
    getActivitySummary(session),
    getConversationOverview(session, 10),
    getHandoffState(session),
  ]);

  return NextResponse.json({ activity, conversations, handoff });
}
