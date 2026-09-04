/**
 * GET /api/v1/customers/:customerId/invoices/:invoiceId/lines
 *
 * The invoice detail sheet's "Lines" sub-tab. Same shape and same three
 * ordering decisions as the order-lines route beside this one — see that
 * file's header comment, not restated here.
 */

import { NextResponse } from 'next/server'

import { readInvoiceLines, parseCustomerId, odooCallerFor } from '@/lib/context/customer-sources'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string; invoiceId: string }> }

const NOT_FOUND = { error: 'not found, or not available to you' }

export async function GET(_req: Request, { params }: Params) {
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const { customerId, invoiceId } = await params
  if (parseCustomerId(customerId) === null || parseCustomerId(invoiceId) === null) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  try {
    const config = await resolveOdooConfigForTenant(ctx.effectiveTenantId)
    const lines = await readInvoiceLines(odooCallerFor(config), Number(invoiceId))
    return NextResponse.json({ lines }, { status: 200 })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'could not be read' },
      { status: 502 },
    )
  }
}
