import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { getAgentDetail, getAgentTools, getAgentRuntimePanel } from '@/lib/workspace/tenant-workspace';

/**
 * GET /api/workspace/team/[agentId]
 *
 * Detail for one assistant owned by the session's tenant.
 *
 * Ordering matters: the role guard runs BEFORE the tenant-scoped lookup, so an
 * unauthorized caller gets 403 without any query being issued. A caller who IS
 * authorized but names another tenant's agent gets 404 — never 403 — so another
 * tenant's records stay indistinguishable from absent.
 */
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { agentId } = await params;
  const [detail, runtime] = await Promise.all([
    getAgentDetail(session, agentId, { includeConfiguration: guard.authz.canViewConfiguration }),
    getAgentRuntimePanel(session, agentId),
  ]);
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    access: { level: guard.authz.level, canViewConfiguration: guard.authz.canViewConfiguration },
    agent: detail,
    runtime,
    tools: getAgentTools(),
  });
}
