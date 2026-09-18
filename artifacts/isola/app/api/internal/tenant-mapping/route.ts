/**
 * GET /api/internal/tenant-mapping — the ONE place another service may ask
 * "what is this tenant's authoritative Paperclip company id?"
 *
 * Built for isola-portal's apps.isola_provisioning.foundation_client, which
 * exists specifically because isola-portal's own CreateAgentView used to
 * substitute a single shared PAPERCLIP_DEFAULT_COMPANY_ID for every tenant —
 * the exact "shared default standing in for a missing per-tenant mapping"
 * defect this route closes at the source.
 *
 * Token-gated exactly like /api/agent-tools/invoke and /api/internal/staff:
 *   Authorization: Bearer <ISOLA_AGENT_TOOLS_TOKEN>
 * NOT a session cookie. `tenant_id` is FOUNDATION's own Tenant.id — the
 * caller (isola-portal) is responsible for holding the correct
 * operator-confirmed join key; this route does no cross-service matching of
 * its own (there is no shared identifier to match on — see
 * CompanyProfile.foundation_tenant_id's docstring in isola-portal).
 *
 * Read-only. Reports `paperclip_company_id: ""` (never null, never a
 * default) when the tenant exists but Foundation has not yet recorded a
 * mapping for it — that is a genuine, honest "not mapped" answer, distinct
 * from "tenant not found" (404) and from "bad auth" (401). A caller must
 * never conflate any of these three.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAgentToolsToken } from '@/lib/engines';
import { prisma } from '@/lib/prisma';

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authenticate(req: NextRequest): boolean {
  const expected = getAgentToolsToken();
  if (!expected) return false; // not configured — never authenticate against an empty token
  const header = req.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  return constantTimeEquals(match[1], expected);
}

export async function GET(req: NextRequest) {
  if (!authenticate(req)) return NextResponse.json({ ok: false, error: 'bad_auth' }, { status: 401 });

  const tenantId = req.nextUrl.searchParams.get('tenant_id');
  if (!tenantId || !tenantId.trim()) {
    return NextResponse.json({ ok: false, error: 'tenant_id required' }, { status: 400 });
  }

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId.trim() },
    select: { paperclip_company_id: true },
  });
  if (!tenant) {
    return NextResponse.json({ ok: false, error: 'tenant_not_found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, paperclip_company_id: tenant.paperclip_company_id ?? '' });
}
