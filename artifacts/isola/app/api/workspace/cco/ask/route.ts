/**
 * POST /api/workspace/cco/ask — the automated owner-to-CCO briefing path.
 *
 * owner request -> authorization -> scoped Odoo briefing -> correct CCO
 * invocation -> sourced answer, in one governed call.
 *
 * WHY 'owner', NOT 'manager' (see business-briefing GET route's own note)
 * ---------------------------------------------------------------------------
 * `askCco` derives the requester's business-data scope from the session's
 * own `effectiveTenantId` — company filtering, established in
 * business-briefing.ts. That says WHICH company's records may ever be
 * returned; it says nothing about WHICH HUMAN at this tenant may trigger
 * the action. This route requires genuine tenant-owner authority
 * (`requireWorkspaceAccess(session, 'owner')`), the same tightened bar the
 * sibling GET .../briefing route now uses — the shared OdooBinding
 * integration credential's broad access must not become every manager's
 * access.
 *
 * THIS DOES NOT DUPLICATE THE STAFF-CHAT ROUTE
 * -----------------------------------------------
 * `POST /api/workspace/team/[agentId]/chat` is for CLAWITH-bound agents
 * (`agent.brain_provider === 'clawith'`) — an architecturally different
 * backend from the CCO, which is a Paperclip-hired agent whose brain is
 * services/isola-runtime. There is no Foundation `Agent` row for the CCO
 * hire at all (verified: the Paperclip-hire flow lives entirely in
 * isola-portal's `IsolaAgentProvision`), so this route takes no `agentId`
 * path parameter — it is scoped by the session's tenant alone, and
 * `askCco`/`resolveCcoAgentBinding` resolve which specific hired agent that
 * tenant's CCO actually is.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { askCco } from '@/lib/workspace/cco-invoke';
import { audit } from '@/lib/audit';

export const revalidate = 0;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const guard = await requireWorkspaceAccess(session, 'owner');
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { message, threadId, turnId } = (body ?? {}) as {
    message?: unknown;
    threadId?: unknown;
    turnId?: unknown;
  };
  if (typeof message !== 'string' || message.trim() === '') {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }
  if (typeof threadId !== 'string' || threadId.trim() === '') {
    return NextResponse.json({ error: 'threadId is required' }, { status: 400 });
  }
  if (typeof turnId !== 'string' || turnId.trim() === '') {
    return NextResponse.json({ error: 'turnId is required' }, { status: 400 });
  }

  const result = await askCco({
    // The SESSION tenant, never anything the caller could supply — same
    // discipline as the sibling GET .../briefing route.
    tenantId: session.effectiveTenantId,
    message: message.trim(),
    threadId: threadId.trim(),
    turnId: turnId.trim(),
  });

  await audit({
    tenantId: session.effectiveTenantId,
    actorId: session.user.id,
    action: 'agent.cco_briefing.ask',
    entity: 'CcoBriefing',
    entityId: threadId.trim(),
    requestId: result.correlationId ?? undefined,
    meta: {
      state: result.state,
      reason: result.reason,
      odooConnected: result.briefing?.odooConnected ?? null,
      turnId: turnId.trim(),
    },
  });

  return NextResponse.json({
    state: result.state,
    text: result.text,
    sources: result.sources,
    correlationId: result.correlationId,
  });
}
