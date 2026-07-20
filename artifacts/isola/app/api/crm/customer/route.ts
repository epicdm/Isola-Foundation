import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { isOdooConfigured } from '@/lib/engines';
import { callEngine } from '@/lib/connector';
import { prisma } from '@/lib/prisma';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  // A tenant with its own OdooBinding is configured even when the platform
  // default (ODOO_URL/ODOO_API_KEY/ODOO_DB env) is not set.
  const hasTenantBinding = await prisma.odooBinding.findUnique({
    where: { tenant_id: ctx.effectiveTenantId },
    select: { id: true },
  });
  if (!hasTenantBinding && !isOdooConfigured()) {
    return NextResponse.json({ customer: null, odoo_configured: false });
  }

  const phone = new URL(req.url).searchParams.get('phone');
  if (!phone) return NextResponse.json({ error: 'phone query param required' }, { status: 400 });

  try {
    const customer = await callEngine('odoo', 'findCustomerByPhone', [phone], {
      tenant: { tenantId: ctx.effectiveTenantId },
      actorId: ctx.user.id,
      entity: 'crm_customer',
    });
    return NextResponse.json({ customer, odoo_configured: true });
  } catch (e: any) {
    console.error('[crm/customer]', e.message);
    return NextResponse.json({ error: e.message, customer: null }, { status: 502 });
  }
}
