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
import { bearerFrom, resolveServiceCaller, serviceAuthEnvFrom } from '@/lib/customer-360/service-auth'
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

/** Same header and refusal shape as `lib/customer-360/route-context.ts`'s
 *  `refuseOnTenantMismatch` — not imported from there to avoid pulling in
 *  that module's own session-resolution path, which this route already has
 *  its own (differently-scoped, `requireWorkspaceAccess`-gated) version of.
 *  The service door's tenant is never taken from this header; it exists only
 *  to REFUSE a caller that is confused about whose data it asked for. */
const TENANT_ASSERTION_HEADER = 'x-isola-tenant-id'
function refuseOnTenantMismatch(req: Request, resolvedTenantId: string): NextResponse | null {
  const asserted = (req.headers.get(TENANT_ASSERTION_HEADER) ?? '').trim()
  if (!asserted || asserted === resolvedTenantId) return null
  return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
}

/**
 * The body shared by both doors below: everything from "the tenant and role
 * are now known" onward. Neither door may skip any of these steps, so this is
 * a function, not a copy-pasted block — the exact discipline
 * `lib/customer-360/route-context.ts` was extracted for on the sibling route.
 */
async function respondForCustomer(
  req: Request,
  customerId: string,
  tenantId: string,
  role: Role,
  canViewAudit: boolean,
) {
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
    canViewAudit,
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

export async function GET(req: Request, { params }: Params) {
  const { customerId } = await params

  // SERVICE DOOR — added so the Lumen portal (a service-token caller, never a
  // browser session) can mount this same sections-shaped context the Chatwoot
  // cockpit already reads, instead of the older, poorer `/api/isola-360/context`
  // snapshot it was proxying before. Reuses the EXACT service-auth validation
  // that door already used (`lib/customer-360/service-auth.ts`) — no new auth
  // code, per Contract 2.3 (one source, never a sync).
  //
  // Tried FIRST, and a bearer that is PRESENTED and REJECTED refuses outright
  // rather than falling through to the cookie door below — the same precedence
  // `lib/customer-360/route-context.ts`'s `resolveCaller` documents, so a stale
  // service token can never silently retry as a different principal.
  const authorization = req.headers.get('authorization')
  if (authorization) {
    const service = resolveServiceCaller(authorization, serviceAuthEnvFrom(process.env))
    if (!service.ok) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const refusal = refuseOnTenantMismatch(req, service.tenantId)
    if (refusal) return refusal
    // A machine gets the middle role, same as every other service caller on
    // this surface — owner powers belong to a person. Audit trail is likewise
    // person-only: a service proxy has no human to attribute it to.
    return respondForCustomer(req, customerId, service.tenantId, 'manager', false)
  }
  if (bearerFrom(authorization)) {
    // Unreachable given the `if (authorization)` guard above, kept for the
    // same reason the sibling route keeps it: a bearer was OFFERED and
    // REJECTED must never fall through to try another door.
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // EXISTING SESSION PATH — UNCHANGED. Every operator request that reaches
  // this route today keeps exactly the same authentication, authorization and
  // response shape it always had.
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  return respondForCustomer(req, customerId, ctx.effectiveTenantId, contextRole(guard.authz), guard.authz.canViewAudit)
}
