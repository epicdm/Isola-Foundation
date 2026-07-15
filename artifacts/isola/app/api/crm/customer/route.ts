import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getOdooConfig, isOdooConfigured } from '@/lib/engines';
import { findCustomerByPhone } from '@/engines/odoo';

export async function GET(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  if (!isOdooConfigured()) {
    return NextResponse.json({ customer: null, odoo_configured: false });
  }

  const phone = new URL(req.url).searchParams.get('phone');
  if (!phone) return NextResponse.json({ error: 'phone query param required' }, { status: 400 });

  try {
    const customer = await findCustomerByPhone(getOdooConfig(), phone);
    return NextResponse.json({ customer, odoo_configured: true });
  } catch (e: any) {
    console.error('[crm/customer]', e.message);
    return NextResponse.json({ error: e.message, customer: null }, { status: 502 });
  }
}
