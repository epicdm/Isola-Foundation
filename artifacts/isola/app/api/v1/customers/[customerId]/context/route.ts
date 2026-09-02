/**
 * GET /api/v1/customers/:customerId/context
 *
 * The Customer 360 context bundle: every expected section, every section
 * carrying its own state, nothing invented.
 *
 * TRANSPORT ONLY. The decisions live where they can be tested without a server:
 *   which sources exist and what they read → lib/context/customer-sources.ts
 *   the action history                     → lib/context/recent-actions.ts
 *   the activity slice                     → lib/context/customer-activity.ts
 *   how a section becomes a state          → lib/customer-workspace/contract.ts
 *   how the response is shaped             → lib/context/customer-context.ts
 *
 * THREE ORDERING DECISIONS, EACH OF WHICH IS A BOUNDARY
 * ----------------------------------------------------
 * 1. AUTHENTICATION BEFORE PARSING. An unauthenticated caller gets the same 401
 *    whatever they send. If a malformed customer id could produce a 400 here,
 *    the difference between 400 and 401 would tell an anonymous caller
 *    something about the shape of our ids.
 *
 * 2. THE TENANT IS RESOLVED BEFORE ANY SOURCE IS TOUCHED, and it comes from the
 *    SESSION. It selects which Odoo instance is read. That is the whole
 *    cross-tenant boundary: a customer id belonging to another tenant is not
 *    "hidden" from this reader, it is genuinely absent from the instance this
 *    session can reach.
 *
 * 3. NOT-FOUND IS ONLY CLAIMED WHEN THE SOURCE ACTUALLY ANSWERED. If Odoo could
 *    not be reached, the customer section is `unavailable` and the response is
 *    200 with a degraded body — never 404. "We could not ask" and "there is no
 *    such customer" are the same confusion this whole mutation exists to stop,
 *    and a 404 is the loudest possible way of making it.
 */

import { NextResponse } from 'next/server'

import { buildContextBundle } from '@/lib/context/context-bundle'
import { assembleCustomerContext } from '@/lib/context/customer-context'
import { loadCustomerActivity } from '@/lib/context/customer-activity'
import { buildCustomerAdapters, odooCallerFor, parseCustomerId } from '@/lib/context/customer-sources'
import { recentActionsAdapter, prismaRecentActionsStore } from '@/lib/context/recent-actions'
import { ACTIONS_BY_ROLE, type Role } from '@/lib/context/resolve-context'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess, type WorkspaceAuthz } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string }> }

/** The workspace's access level, in the vocabulary the context layer speaks. */
function contextRole(authz: WorkspaceAuthz): Role {
  return authz.level === 'owner' ? 'owner' : 'manager'
}

/**
 * Identical wording for "no such customer" and "not in your tenant". Telling
 * them apart is an enumeration oracle over another tenant's customer ids.
 */
const NOT_FOUND = { error: 'not found, or not available to you' }

export async function GET(req: Request, { params }: Params) {
  // 1 ── AUTHENTICATION, before anything is parsed.
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  // 2 ── THE TENANT, from the session. It decides which Odoo is read.
  const tenantId = ctx.effectiveTenantId
  const role = contextRole(guard.authz)

  const { customerId } = await params
  // Refused before it can reach a domain. An id is not trusted input just
  // because it arrived in a path segment rather than in a query string.
  if (parseCustomerId(customerId) === null) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  const correlationId = req.headers.get('x-correlation-id') || `ctx-${customerId}-${Date.now()}`
  const now = () => new Date()

  // 3 ── The tenant's Odoo binding. Failing to resolve it is an OUTAGE, not a
  // verdict about the customer: the adapters below then fail individually and
  // each section reports `unavailable` with its own reason.
  let odooBaseUrl: string | null = null
  let adapters
  try {
    const config = await resolveOdooConfigForTenant(tenantId)
    odooBaseUrl = config.url || null
    adapters = buildCustomerAdapters({ call: odooCallerFor(config), odooBaseUrl, now })
  } catch {
    // No binding: every Odoo-backed section refuses, in the same shape it would
    // if the instance were down. Nothing is fabricated and nothing 404s.
    adapters = buildCustomerAdapters({
      call: async () => {
        throw new Error('no Odoo binding is configured for this workspace')
      },
      odooBaseUrl: null,
      now,
    })
  }

  const bundle = await buildContextBundle(
    {
      correlationId,
      companyId: tenantId,
      role,
      objectType: 'customer',
      objectId: customerId,
      limit: 25,
    },
    {
      adapters: [
        ...adapters,
        recentActionsAdapter({ store: prismaRecentActionsStore, tenantId, now }),
      ],
      workspaceUrlFor: () => '',
      now,
    },
  )

  // 4 ── NOT FOUND is claimed ONLY on an answer. `ok` with no rows means Odoo
  // was asked and said there is no such partner in this tenant's instance.
  const customer = bundle.sections.customer
  if (customer?.status === 'ok' && Array.isArray(customer.data) && customer.data.length === 0) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  // 5 ── The activity slice, through the existing feed.
  const activity = await loadCustomerActivity(customerId, {
    tenantId,
    canViewAudit: guard.authz.canViewAudit,
    now,
  })

  const body = assembleCustomerContext({
    correlationId,
    customerId,
    role,
    bundle,
    activity: activity.result,
    activityMissing: activity.missing,
    odooBaseUrl,
    permittedActions: ACTIONS_BY_ROLE[role] ?? [],
    now: now(),
  })

  return NextResponse.json(body, { status: 200 })
}
