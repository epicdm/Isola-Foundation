/**
 * GET|POST /api/internal/staff — read a tenant's staff roster (hr.employee)
 * from its OWN Odoo via the governed OdooBinding (S2). Read-only.
 *
 * Server-to-server seam for the internal/operator onboarding flow (Hermes /
 * isola-ops), so it is token-gated exactly like /api/agent-tools/invoke:
 *   Authorization: Bearer <ISOLA_AGENT_TOOLS_TOKEN>
 * NOT a session cookie and NOT an Odoo key. `tenant_id` must be supplied and
 * scopes the OdooBinding lookup — the roster comes only from that tenant's
 * own governed connector, never a shared credential. If the tenant has no
 * binding, resolveOdooConfigForTenant falls back to the platform-default env
 * (still governed by this route's bearer token).
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAgentToolsToken } from '@/lib/engines'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { listStaff } from '@/engines/odoo-staff'

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authenticate(req: NextRequest): boolean {
  const expected = getAgentToolsToken()
  if (!expected) return false // not configured — never authenticate against an empty token
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  return constantTimeEquals(match[1], expected)
}

async function handle(tenantId: string | null) {
  if (!tenantId || !tenantId.trim()) {
    return NextResponse.json({ ok: false, error: 'tenant_id required' }, { status: 400 })
  }
  const config = await resolveOdooConfigForTenant(tenantId)
  const staff = await listStaff(config)
  return NextResponse.json({ ok: true, tenant_id: tenantId, count: staff.length, staff })
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 })
  return handle(req.nextUrl.searchParams.get('tenant_id'))
}

export async function POST(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 })
  let body: any = {}
  try { body = await req.json() } catch { /* empty body → fall through to query param */ }
  return handle(body?.tenant_id ?? req.nextUrl.searchParams.get('tenant_id'))
}
