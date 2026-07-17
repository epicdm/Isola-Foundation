/**
 * GET|POST /api/customer/account — CONTAINED per-user customer read for the
 * PUBLIC agent. Returns ONLY the ONE partner matched by `phone` (their own
 * orders / invoices / balance). Admin Odoo creds are used SERVER-SIDE only;
 * the public agent holds NO Odoo credential — only the scoped
 * ISOLA_CUSTOMER_TOOLS_TOKEN, which is DELIBERATELY DIFFERENT from
 * ISOLA_AGENT_TOOLS_TOKEN so a compromised public agent cannot call the
 * internal endpoints (/api/internal/*). Never returns other partners,
 * hr.employee, or internal accounting.
 *
 * NOTE: `phone` MUST be the verified inbound WhatsApp sender (channel-supplied).
 * Personal data should additionally be gated by a one-time OTP pairing at the
 * agent layer (next brick). This endpoint hard-scopes to the matched partner
 * regardless, so its blast radius is one known number's own account.
 */
import { NextRequest, NextResponse } from 'next/server'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getCustomerAccountByPhone } from '@/engines/odoo-customer'

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let d = 0
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return d === 0
}
function authed(req: NextRequest): boolean {
  const exp = process.env.ISOLA_CUSTOMER_TOOLS_TOKEN || ''
  if (!exp) return false // fail closed when unset
  const h = req.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? ctEq(m[1], exp) : false
}

async function handle(tenantId: string | null, phone: string | null) {
  if (!tenantId || !tenantId.trim()) return NextResponse.json({ ok: false, error: 'tenant_id required' }, { status: 400 })
  if (!phone || !phone.trim()) return NextResponse.json({ ok: false, error: 'phone required' }, { status: 400 })
  const config = await resolveOdooConfigForTenant(tenantId)
  const acct = await getCustomerAccountByPhone(config, phone)
  return NextResponse.json({ ok: true, tenant_id: tenantId, ...acct })
}

export async function GET(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 })
  return handle(req.nextUrl.searchParams.get('tenant_id'), req.nextUrl.searchParams.get('phone'))
}
export async function POST(req: NextRequest) {
  if (!authed(req)) return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 })
  let b: any = {}
  try { b = await req.json() } catch { /* empty body → query params */ }
  return handle(b?.tenant_id ?? req.nextUrl.searchParams.get('tenant_id'), b?.phone ?? req.nextUrl.searchParams.get('phone'))
}
