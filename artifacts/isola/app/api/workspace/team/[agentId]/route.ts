import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { getAgentDetail, getAgentTools } from '@/lib/workspace/tenant-workspace';

/**
 * GET /api/workspace/team/[agentId]
 *
 * Detail for one assistant owned by the session's tenant. Returns 404 — not 403
 * — for an agent belonging to another tenant, so the endpoint never confirms
 * the existence of another tenant's records.
 */
export const revalidate = 0;

export async function GET(_req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { agentId } = await params;
  const detail = await getAgentDetail(session, agentId);
  if (!detail) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({ agent: detail, tools: getAgentTools() });
}
