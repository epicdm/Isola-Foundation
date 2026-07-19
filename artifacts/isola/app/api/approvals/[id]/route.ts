/**
 * GET  /api/approvals/[id] — status for the operator (tenant-scoped). No token in the body.
 * POST /api/approvals/[id] — decide a pending ApprovalRequest. Body: { decision: 'approve' | 'deny' }
 *
 * Approver = tenant owner/admin, same `can(ctx, 'voice.route_change')` gate
 * as the routing routes themselves. Self-approve is allowed in v1 — this is
 * a deliberate confirm-and-audit step, not a two-person rule. On approve,
 * the single-use redemption token is returned to the authenticated approver
 * only — it is never selectable via GET and never logged.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { can } from '@/lib/permissions';
import { audit } from '@/lib/audit';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { id } = await params;
  const row = await prisma.approvalRequest.findUnique({
    where: { id },
    select: {
      id: true,
      tenant_id: true,
      action: true,
      target_entity: true,
      target_id: true,
      payload: true,
      status: true,
      expires_at: true,
      created_at: true,
    },
  });
  if (!row || row.tenant_id !== ctx.effectiveTenantId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { tenant_id, ...safe } = row; // never leak token (not selected) — tenant_id also dropped
  return NextResponse.json(safe);
}

export async function POST(req: NextRequest, { params }: Params) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const allowed = await can(
    { identityId: ctx.identityId, tenantId: ctx.effectiveTenantId, isAdmin: ctx.isAdmin, isOwner: ctx.isOwner },
    'voice.route_change',
  );
  if (!allowed) return NextResponse.json({ error: 'Not authorized to decide approvals' }, { status: 403 });

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const decision = body?.decision;
  if (decision !== 'approve' && decision !== 'deny') {
    return NextResponse.json({ error: 'decision must be "approve" or "deny"' }, { status: 400 });
  }

  const row = await prisma.approvalRequest.findUnique({ where: { id } });
  if (!row || row.tenant_id !== ctx.effectiveTenantId) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const now = new Date();
  if (row.status !== 'pending') return NextResponse.json({ error: `Already ${row.status}` }, { status: 409 });
  if (row.expires_at <= now) {
    await prisma.approvalRequest.updateMany({ where: { id: row.id, status: 'pending' }, data: { status: 'expired' } });
    return NextResponse.json({ error: 'Approval expired' }, { status: 410 });
  }

  const auditBase = { tenantId: row.tenant_id, actorId: ctx.user.id, entity: 'approval_request', entityId: row.id };

  if (decision === 'deny') {
    const r = await prisma.approvalRequest.updateMany({
      where: { id: row.id, status: 'pending' },
      data: { status: 'denied', decided_by: ctx.user.id, decided_at: now },
    });
    if (r.count !== 1) return NextResponse.json({ error: 'Already decided' }, { status: 409 });
    await audit({ ...auditBase, action: 'voice.route.denied', meta: { action_gated: row.action } });
    return NextResponse.json({ status: 'denied' });
  }

  // approve — atomic pending→approved (self-approve allowed in v1)
  const r = await prisma.approvalRequest.updateMany({
    where: { id: row.id, status: 'pending' },
    data: { status: 'approved', decided_by: ctx.user.id, decided_at: now },
  });
  if (r.count !== 1) return NextResponse.json({ error: 'Already decided' }, { status: 409 });
  const approved = await prisma.approvalRequest.findUnique({ where: { id: row.id }, select: { token: true } });
  await audit({ ...auditBase, action: 'voice.route.approved', meta: { action_gated: row.action, self_approved: ctx.user.id === row.requested_by } });
  return NextResponse.json({ status: 'approved', token: approved!.token });
}
