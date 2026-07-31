/**
 * GET /api/v1/activity
 *
 * The AUTHORITATIVE normalized, filtered and paginated Recent Work feed. It is
 * the one endpoint that turns every activity source into a single ordered list
 * with per-source states, a cursor and honest data-state reporting.
 *
 * `/api/workspace/activity` is the tenant SUMMARY and is a DIFFERENT contract:
 * counts and overviews for the workspace landing page, not a normalized feed.
 * Neither is a fallback for the other, and neither should grow into the other.
 *
 * This file is transport only. Every decision — parsing, filtering, ordering,
 * paging, which failure is which status — lives in `lib/activity/handler.ts`
 * and is tested there without a server. Nothing below reaches a database, a
 * provider or a message transport.
 */

import { NextResponse } from 'next/server'

import { buildActivityHandler } from '@/lib/activity/handler'
import { ACTIVITY_SOURCE_NAMES, buildActivitySources } from '@/lib/activity/registry'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

export async function GET(req: Request) {
  // AUTHENTICATION FIRST, BEFORE ANY PARSING.
  // An unauthenticated caller gets the same 401 whatever they send. If a bad
  // cursor or an unknown filter could produce a 400 here, the difference
  // between 400 and 401 would tell an anonymous caller which cursors were once
  // real — an existence oracle built out of validation.
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  // From the SESSION. A `company` parameter can only narrow within the
  // permitted set; it is never read as an authorization override.
  const tenantId = ctx.effectiveTenantId

  const sources = buildActivitySources({
    tenantId,
    // Not "hide the audit rows afterwards" — the audit source does not read at
    // all for a session without audit permission, and reports `forbidden`.
    canViewAudit: guard.authz.canViewAudit,
    now: () => new Date(),
  })

  const handler = buildActivityHandler({
    sources,
    permissions: {
      // The session was already resolved and role-checked above.
      actorIsActive: async () => true,
      // Exactly one company: the tenant this session is scoped to.
      permittedCompanies: async () => [tenantId],
      // Per-customer and per-object checks arrive with the contextual
      // workbench, which is where object-level grants are defined. Until then
      // tenant scoping is the whole boundary, and saying so here is better
      // than a stub that looks like a check and is not one.
      mayViewCustomer: async () => true,
      mayViewObject: async () => true,
    },
    now: () => new Date(),
    knownSources: ACTIVITY_SOURCE_NAMES,
  })

  const result = await handler.handle(new URL(req.url).searchParams, { companyId: tenantId })
  return NextResponse.json(result.body, { status: result.status })
}
