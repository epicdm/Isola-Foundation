/**
 * POST /api/onboard/whatsapp
 * Connect a WhatsApp number to the tenant.
 * Body: { phone_number_id, waba_id, phone_number, access_token, display_name?, coex_mode? }
 *
 * Called after Meta Embedded Signup completes (or manual admin entry).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { phone_number_id, waba_id, phone_number, access_token, display_name, coex_mode = true } =
    await req.json();

  if (!phone_number_id || !waba_id || !phone_number || !access_token) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  // Check uniqueness of phone_number_id (cannot be owned by two tenants)
  const existing = await prisma.whatsAppNumber.findUnique({ where: { phone_number_id } });
  if (existing && existing.tenant_id !== ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'This phone number is already registered to another tenant' }, { status: 409 });
  }

  const waNumber = await prisma.whatsAppNumber.upsert({
    where: { phone_number_id },
    create: {
      tenant_id: ctx.effectiveTenantId,
      phone_number_id,
      waba_id,
      phone_number,
      access_token,
      display_name: display_name ?? null,
      coex_mode: !!coex_mode,
    },
    update: {
      waba_id,
      phone_number,
      access_token,
      display_name: display_name ?? null,
      coex_mode: !!coex_mode,
    },
  });

  await audit({
    tenantId: ctx.effectiveTenantId,
    actorId: ctx.user.id,
    action: 'whatsapp.connect',
    entity: 'whatsapp_number',
    entityId: waNumber.id,
    meta: { phone_number, coex_mode },
  });

  return NextResponse.json({ ok: true, whatsapp_number: waNumber });
}

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const numbers = await prisma.whatsAppNumber.findMany({
    where: { tenant_id: ctx.effectiveTenantId },
    orderBy: { created_at: 'desc' },
  });
  return NextResponse.json({ numbers });
}
