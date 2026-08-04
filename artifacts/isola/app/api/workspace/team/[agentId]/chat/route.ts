/**
 * POST /api/workspace/team/[agentId]/chat — S1 staff-to-agent chat.
 *
 * One synchronous, LIVE_ASSISTED, zero-tool turn between a manager-or-above
 * workspace user and an approved INTERNAL agent. Ordering mirrors
 * GET /api/workspace/team/[agentId]: the role guard runs before any
 * tenant-scoped lookup (403 costs no query), and an agent that does not
 * belong to this tenant is 404, never 403, so it stays indistinguishable
 * from absent. Eligibility failures for an agent that DOES belong to this
 * tenant (inactive, wrong provider, no ClawithBinding, not allowlisted) are
 * not errors — they are the truthful `blocked` state, returned 200.
 *
 * Nothing here calls Chatwoot, Odoo, PBX or Meta, and no customer message is
 * ever sent — `performStaffChatTurn` always requests `allowed_tools: []`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { requireWorkspaceAccess } from '@/lib/workspace/authz';
import { resolveStaffChatEligibility, performStaffChatTurn } from '@/lib/workspace/staff-agent-chat';
import { audit } from '@/lib/audit';

export const revalidate = 0;

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const guard = await requireWorkspaceAccess(session, 'manager');
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { agentId } = await params;

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

  const eligibility = await resolveStaffChatEligibility(session.effectiveTenantId, agentId);
  if (!eligibility.eligible) {
    // Cross-tenant / nonexistent stays 404 — never reveals whether an agent
    // exists on another tenant.
    if (eligibility.reason === 'agent_not_found') {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    return NextResponse.json({
      state: 'blocked',
      text: null,
      correlationId: null,
      mode: 'LIVE_ASSISTED',
      allowedTools: [],
      reason: eligibility.reason,
    });
  }

  const trimmedThreadId = threadId.trim();
  const trimmedTurnId = turnId.trim();

  const { result } = await performStaffChatTurn({
    session,
    agent: eligibility.agent,
    message: message.trim(),
    threadId: trimmedThreadId,
    turnId: trimmedTurnId,
  });

  // One submit, one upstream call (inside performStaffChatTurn), one audit —
  // written for every reachable outcome, success or safe failure alike, so
  // the correlation id is provable end to end even on a degraded turn.
  await audit({
    tenantId: session.effectiveTenantId,
    actorId: session.user.id,
    action: 'agent.staff_chat.turn',
    entity: 'Agent',
    entityId: agentId,
    requestId: result.correlationId,
    meta: {
      state: result.state,
      failureKind: result.failureKind,
      attempts: result.attempts,
      threadId: trimmedThreadId,
      turnId: trimmedTurnId,
    },
  });

  return NextResponse.json({
    state: result.state,
    text: result.text,
    correlationId: result.correlationId,
    mode: 'LIVE_ASSISTED',
    allowedTools: [],
  });
}
