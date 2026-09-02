import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { getActivitySummary, getConversationOverview, getHandoffState } from '@/lib/workspace/tenant-workspace';

/**
 * GET /api/workspace/activity
 *
 * Real activity and reporting for the session's tenant. Requires manager-level
 * access; the audit trail within it is owner-only and is not queried at all for
 * a manager.
 *
 * This is the workspace/tenant SUMMARY only. The authoritative normalized,
 * filtered and paginated activity feed is `/api/v1/activity` — a different
 * contract, and the one to build against for a Recent Work surface.
 */
export const revalidate = 0;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const [activity, conversations, handoff] = await Promise.all([
    getActivitySummary(session, { includeAudit: guard.authz.canViewAudit }),
    getConversationOverview(session, 10),
    getHandoffState(session),
  ]);

  return NextResponse.json({
    access: { level: guard.authz.level, canViewAudit: guard.authz.canViewAudit },
    activity,
    conversations,
    handoff,
  });
}
