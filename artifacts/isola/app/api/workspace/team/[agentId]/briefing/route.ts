/**
 * GET /api/workspace/team/[agentId]/briefing — read-only Odoo business
 * briefing for an authenticated staff session.
 *
 * TWO GATES, BOTH DB-BACKED, NEITHER A BARE ROLE STRING
 * -------------------------------------------------------
 * 1. `requireWorkspaceAccess(session, 'manager')` -> `resolveWorkspaceAuthz`
 *    (lib/workspace/authz.ts) resolves the caller's role by querying
 *    `Membership` for `(identityId, session.effectiveTenantId)` — it is not
 *    satisfied by any claim on the session object alone. Proven independently
 *    in authz.test.ts, e.g. "denies a user with no membership who is not the
 *    home-tenant owner" and "does not let the User.role default promote a
 *    staff member".
 * 2. `resolveStaffChatEligibility(session.effectiveTenantId, agentId)`
 *    (lib/workspace/staff-agent-chat.ts) confirms the requested agent
 *    actually BELONGS to that same tenant (`prisma.agent.findFirst({ id,
 *    tenant_id })`), is active, and is INTERNAL-classified (B1-B4 exposure
 *    policy) — an agent belonging to another tenant, or a PUBLIC/unclassified
 *    one, never resolves. Proven independently in staff-agent-chat.test.ts,
 *    e.g. "tenant scoping is still mandatory — a same-id agent on a DIFFERENT
 *    tenant never resolves" and the B3 exposure-classification proofs.
 * Both are the exact same functions the already-live POST .../chat route
 * (this file's sibling) uses — reused, not re-derived, so a review of one
 * covers the other.
 *
 * There is no tenant_id or agent scope in the request body or query string:
 * this is a GET with no body, and the only tenant ever used is
 * `session.effectiveTenantId` — never anything caller-supplied.
 *
 * This does not call Clawith, Paperclip or isola-runtime — it is a plain
 * Foundation-owned Odoo read, reusing the already-governed
 * `getBusinessBriefing` (lib/workspace/business-briefing.ts), which reuses
 * the tenant's own OdooBinding (never a shared platform-default credential),
 * applies a record-scope guard (refuses a section outright rather than
 * blending rows from more than one Odoo company_id), and builds every
 * source link from that same tenant-scoped OdooBinding.url.
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
