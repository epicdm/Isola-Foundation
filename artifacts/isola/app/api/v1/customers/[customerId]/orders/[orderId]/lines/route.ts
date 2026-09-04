/**
 * GET /api/v1/customers/:customerId/orders/:orderId/lines
 *
 * The order detail sheet's "Line items" sub-tab. Deliberately narrow: the
 * order's own header fields (state, amount, dates) are already in hand from
 * the customer context's `orders` section — this route exists only for the
 * one thing that list doesn't carry, sale.order.line rows.
 *
 * Same three ordering decisions as .../context/route.ts (auth before
 * parsing, tenant from session before any Odoo read, not-found only on a
 * genuine answer) — see that file's header comment for the full reasoning,
 * not restated here.
 */

import { NextResponse } from 'next/server'

import { readOrderLines, parseCustomerId, odooCallerFor } from '@/lib/context/customer-sources'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string; orderId: string }> }

const NOT_FOUND = { error: 'not found, or not available to you' }

export async function GET(_req: Request, { params }: Params) {
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const { customerId, orderId } = await params
  if (parseCustomerId(customerId) === null || parseCustomerId(orderId) === null) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  try {
    const config = await resolveOdooConfigForTenant(ctx.effectiveTenantId)
    const lines = await readOrderLines(odooCallerFor(config), Number(orderId))
    return NextResponse.json({ lines }, { status: 200 })
  } catch (err) {
    // An outage, not a verdict on the order. The sheet's own "Line items"
    // sub-tab renders this as unavailable, never as an empty order.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'could not be read' },
      { status: 502 },
    )
  }
}
