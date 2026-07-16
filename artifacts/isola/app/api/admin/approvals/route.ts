/**
 * GET  /api/admin/approvals — list pending human-approval gates (see
 *      lib/approval-gate.ts). Optional ?tenant_id= filter.
 * POST /api/admin/approvals — approve a pending gate.
 *      Body: { tenant_id, action, request_id }
 *
 * Admin/owner only, same as every other /api/admin/* route. This does not
 * change behavior for any existing route — checkGate() is opt-in per call
 * site and the gate itself no-ops unless PERMISSION_GATES_ENABLED=true.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const tenantId = req.nextUrl.searchParams.get('tenant_id') ?? undefined;

  const pendingRows = await prisma.auditLog.findMany({
    where: {
      action: { endsWith: '.pending_approval' },
      ...(tenantId ? { tenant_id: tenantId } : {}),
    },
    orderBy: { created_at: 'desc' },
    take: 100,
  });

  // A pending row is resolved once a matching `.approved` row with the same
  // (tenant_id, base action, request_id) exists — filter those out here
  // rather than trusting callers to have polled checkGate() again.
  const open = [];
  for (const row of pendingRows) {
    if (!row.request_id) continue;
    const baseAction = row.action.replace(/\.pending_approval$/, '');
    const resolved = await prisma.auditLog.findFirst({
      where: {
        tenant_id: row.tenant_id ?? undefined,
        action: `${baseAction}.approved`,
        request_id: row.request_id,
      },
    });
    if (!resolved) open.push({ ...row, base_action: baseAction });
  }

  return NextResponse.json({ pending: open });
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx?.isAdmin) return NextResponse.json({ error: 'Forbidden' }, { status: 403 });

  const { tenant_id, action, request_id } = (await req.json()) as {
    tenant_id?: string;
    action?: string;
    request_id?: string;
  };
  if (!tenant_id || !action || !request_id) {
    return NextResponse.json({ error: 'tenant_id, action, and request_id are required' }, { status: 400 });
  }

  const pending = await prisma.auditLog.findFirst({
    where: { tenant_id, action: `${action}.pending_approval`, request_id },
    orderBy: { created_at: 'desc' },
  });
  if (!pending) {
    return NextResponse.json({ error: 'No matching pending approval found' }, { status: 404 });
  }

  const alreadyApproved = await prisma.auditLog.findFirst({
    where: { tenant_id, action: `${action}.approved`, request_id },
  });
  if (alreadyApproved) {
    return NextResponse.json({ ok: true, already_approved: true, audit_id: alreadyApproved.id });
  }

  await audit({
    tenantId: tenant_id,
    actorId: ctx.user.id,
    action: `${action}.approved`,
    entity: pending.entity ?? undefined,
    entityId: pending.entity_id ?? undefined,
    requestId: request_id,
    meta: { approved_pending_audit_id: pending.id },
  });

  return NextResponse.json({ ok: true });
}
