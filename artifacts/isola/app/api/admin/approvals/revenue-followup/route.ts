/**
 * POST /api/admin/approvals/revenue-followup
 *   Body: { op: 'approve', pendingApprovalId, tenantId, leadId }
 *       | { op: 'revoke', approvedAuditId, tenantId, leadId, reason? }
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
 *
 * HARDENING (dec-pr80-odoo-scope-idempotency-and-read-contract-2026-08-06,
 * correction 6): `tenantId` and `leadId` are now REQUIRED in the body, not
 * merely implied by the row id — the caller must assert what they believe
 * they are approving/revoking, and the route (via `expectedTool`/
 * `expectedTenantId`/`expectedObjectId` on the underlying lib functions)
 * refuses if the row is a DIFFERENT tool entirely, a different tenant's
 * request, or targets a different opportunity than asserted. This is how an
 * unrelated `.pending_approval`/`.approved` AuditLog row — one of
 * `checkGate()`'s own callers', or the same tool for a different
 * tenant/opportunity — is refused rather than silently approved/revoked
 * through this route.
 *
 * Never recomputes a scope from caller-supplied fields to MINT an approval —
 * see revenue-followup-approval.ts's header for why that distinction matters.
 * The success response body is deliberately minimal (`{ok, auditId}`
 * only) — no stored meta, no credential, no other row field is ever echoed
 * back.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import {
  approveRevenueFollowup,
  revokeRevenueFollowupApproval,
} from '@/lib/governed/revenue-followup-approval';
import { REVENUE_FOLLOWUP_SET_ACTION } from '@/lib/governed/revenue-mcp-actions';

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 });
  }

  const op = str(body.op);
  const tenantId = str(body.tenantId);
  const leadId = str(body.leadId);

  if (!tenantId || !leadId) {
    return NextResponse.json({ error: 'tenantId and leadId are required' }, { status: 400 });
  }

  if (op === 'approve') {
    const pendingApprovalId = str(body.pendingApprovalId);
    if (!pendingApprovalId) {
      return NextResponse.json({ error: 'pendingApprovalId is required' }, { status: 400 });
    }
    const result = await approveRevenueFollowup({
      pendingApprovalId,
      approverActorId: ctx.user.id,
      now: new Date(),
      expectedTool: REVENUE_FOLLOWUP_SET_ACTION,
      expectedTenantId: tenantId,
      expectedObjectId: leadId,
    });
    if (!result.ok) {
      const status = result.code === 'wrong_scope' ? 403 : 404;
      return NextResponse.json({ error: result.detail, code: result.code }, { status });
    }
    return NextResponse.json({ ok: true, auditId: result.auditId });
  }

  if (op === 'revoke') {
    const approvedAuditId = str(body.approvedAuditId);
    if (!approvedAuditId) {
      return NextResponse.json({ error: 'approvedAuditId is required' }, { status: 400 });
    }
    const reason = typeof body.reason === 'string' ? body.reason : undefined;
    const result = await revokeRevenueFollowupApproval({
      approvedAuditId,
      revokedByActorId: ctx.user.id,
      reason,
      now: new Date(),
      expectedTool: REVENUE_FOLLOWUP_SET_ACTION,
      expectedTenantId: tenantId,
      expectedObjectId: leadId,
    });
    if (!result.ok) {
      const status = result.code === 'wrong_scope' ? 403 : 404;
      return NextResponse.json({ error: result.detail, code: result.code }, { status });
    }
    return NextResponse.json({ ok: true, auditId: result.auditId });
  }

  return NextResponse.json({ error: 'op must be "approve" or "revoke"' }, { status: 400 });
}
