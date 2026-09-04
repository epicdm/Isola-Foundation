/**
 * GET /api/v1/customers/:customerId/conversation
 *
 * Step B of the owner's 2026-09-04 build order: resolve THIS customer's
 * Chatwoot conversation by phone, for the workspace's "message the
 * customer" action.
 *
 * Same auth/tenant ordering as .../context/route.ts, plus one more: Odoo is
 * read BEFORE the Chatwoot mirror. The mirror never gets to answer "does
 * this customer exist" — only Odoo does. See
 * lib/chatwoot-conversation-by-phone.ts's header for why that ordering is
 * the actual fix for conv #42, not a style preference.
 *
 * A customer with no matching conversation is a normal, expected answer
 * (`found: false`) — never a 404. 404 here is reserved for "no such
 * customer in this tenant's Odoo", exactly as in every other route in this
 * directory.
 */

import { NextResponse } from 'next/server'

import { odooCallerFor, parseCustomerId, readCustomer } from '@/lib/context/customer-sources'
import { resolveCustomerConversation } from '@/lib/chatwoot-conversation-by-phone'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string }> }

const NOT_FOUND = { error: 'not found, or not available to you' }

export async function GET(_req: Request, { params }: Params) {
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const { customerId } = await params
  const id = parseCustomerId(customerId)
  if (id === null) return NextResponse.json(NOT_FOUND, { status: 404 })

  try {
    const config = await resolveOdooConfigForTenant(ctx.effectiveTenantId)
    const [customer] = await readCustomer(odooCallerFor(config), id)
    if (!customer) return NextResponse.json(NOT_FOUND, { status: 404 })

    const resolution = await resolveCustomerConversation(ctx.effectiveTenantId, customer.phone)
    return NextResponse.json(resolution, { status: 200 })
  } catch (err) {
    // An outage in either Odoo or the mirror — not a verdict on whether a
    // conversation exists. The composer renders this as "could not be
    // resolved right now", never as "not found".
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'could not be read' },
      { status: 502 },
    )
  }
}
