import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getAiTeam, getHandoffState, getWorkspaceBindingSummary } from '@/lib/workspace/tenant-workspace';

/**
 * GET /api/workspace/team
 *
 * Tenant-scoped view of the workspace's AI team plus current human-handoff
 * state. The tenant is always derived from the session — never accepted from
 * the caller.
 */
export const revalidate = 0;

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [team, handoff, bindings] = await Promise.all([
    getAiTeam(session),
    getHandoffState(session),
    getWorkspaceBindingSummary(session),
  ]);

  return NextResponse.json({
    workspace: {
      name: session.effectiveTenant.business_name,
      status: session.effectiveTenant.status,
    },
    team,
    handoff,
    connections: bindings,
  });
}
