/**
 * POST /api/admin/approvals/revenue-followup
 *   Body: { op: 'approve', pendingApprovalId } | { op: 'revoke', approvedAuditId, reason? }
 *
 * The admin-facing surface for lib/governed/revenue-followup-approval.ts —
 * a NEW, separate mechanism from BOTH:
 *   - /api/admin/approvals (checkGate()'s generic `${action}.approved` writer)
 *   - /api/approvals/[id] (the voice-route ApprovalRequest model, which
 *     allows self-approval — a different, narrower mechanism for a
 *     different feature)
 * Neither existing route is modified or repurposed by this file.
 *
 * Admin/owner only, same convention as every other /api/admin/* route.
 * Deliberately minimal: approve/revoke by AuditLog row id, never by
 * recomputing a scope from caller-supplied fields — see
 * revenue-followup-approval.ts's header for why that distinction matters.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import {
  approveRevenueFollowup,
  revokeRevenueFollowupApproval,
} from '@/lib/governed/revenue-followup-approval';

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  }

  const op = typeof body.op === 'string' ? body.op : '';

  if (op === 'approve') {
    const pendingApprovalId = typeof body.pendingApprovalId === 'string' ? body.pendingApprovalId : '';
    if (!pendingApprovalId) {
      return NextResponse.json({ error: 'pendingApprovalId is required' }, { status: 400 });
    }
    const result = await approveRevenueFollowup({
      pendingApprovalId,
      approverActorId: ctx.user.id,
      now: new Date(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.detail, code: result.code }, { status: 404 });
    }
    return NextResponse.json({ ok: true, auditId: result.auditId });
  }

  if (op === 'revoke') {
    const approvedAuditId = typeof body.approvedAuditId === 'string' ? body.approvedAuditId : '';
    if (!approvedAuditId) {
      return NextResponse.json({ error: 'approvedAuditId is required' }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const result = await revokeRevenueFollowupApproval({
      approvedAuditId,
      revokedByActorId: ctx.user.id,
      reason,
      now: new Date(),
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.detail }, { status: 404 });
    }
    return NextResponse.json({ ok: true, auditId: result.auditId });
  }

  return NextResponse.json({ error: 'op must be "approve" or "revoke"' }, { status: 400 });
}
