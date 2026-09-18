/**
 * GET /api/workspace/team/[agentId]/briefing — read-only Odoo business
 * briefing for an authenticated staff session.
 *
 * Gated identically to POST .../chat (same file's sibling route): session,
 * manager-or-above workspace access, and the agent must pass
 * `resolveStaffChatEligibility` (active, INTERNAL-classified, allowlisted,
 * belongs to this tenant). This does not call Clawith, Paperclip or
 * isola-runtime — it is a plain Foundation-owned Odoo read, reusing the
 * already-governed `getBusinessBriefing` (lib/workspace/business-briefing.ts),
 * which itself reuses the tenant's own OdooBinding and never falls back to a
 * shared platform-default credential.
 *
 * Every section reports explicit unavailability rather than fabricating or
 * omitting data — see lib/workspace/business-briefing.ts's module docstring.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { resolveStaffChatEligibility } from '@/lib/workspace/staff-agent-chat';
import { getBusinessBriefing } from '@/lib/workspace/business-briefing';
import { audit } from '@/lib/audit';

export const revalidate = 0;

export async function GET(_req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { agentId } = await params;

  const eligibility = await resolveStaffChatEligibility(session.effectiveTenantId, agentId);
  if (!eligibility.eligible) {
    if (eligibility.reason === 'agent_not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({ state: 'blocked', reason: eligibility.reason, briefing: null });
  }

  const briefing = await getBusinessBriefing(session.effectiveTenantId);

  await audit({
    tenantId: session.effectiveTenantId,
    actorId: session.user.id,
    action: 'agent.business_briefing.read',
    entity: 'Agent',
    entityId: agentId,
    meta: {
      odooConnected: briefing.odooConnected,
      sections: briefing.sections.map((s) => ({ id: s.id, state: s.state })),
    },
  });

  return NextResponse.json({ state: 'ok', briefing });
}
