/**
 * POST /api/isola-360/objects
 *
 * One object, opened INSIDE the customer workspace — an invoice or an order,
 * with its lines, its payments and its stage rail.
 *
 * WHY OWNERSHIP IS PROVEN THROUGH THE SNAPSHOT AND NOT BY ID
 * ---------------------------------------------------------
 * The caller names a record id. That id is a locator, never an authorisation.
 * This route resolves the conversation, resolves THAT conversation's customer,
 * reads the customer's own snapshot, and requires the requested object to be
 * present in it. A record belonging to another customer is therefore
 * unaddressable even if its id is guessed — and production Odoo holds 2,661
 * partners, so guessing is cheap.
 *
 * `readCustomer360Object` then pins `partner_id` in its own domain as well. Two
 * independent checks on the same property: without the snapshot check this route
 * is an enumeration oracle, and without the partner pin the detail read would be.
 *
 * "NOT YOURS" AND "DOES NOT EXIST" COLLAPSE INTO ONE WORDING
 * ----------------------------------------------------------
 * Same rule the send route applies. Distinguishing them tells an unauthorised
 * caller which ids are real, which is the whole of the information they wanted.
 */

import { NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/prisma'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { readCustomer360, readCustomer360Object } from '@/lib/customer-360/odoo-projection'
import { positiveInt, resolveRouteContext } from '@/lib/customer-360/route-context'
import type { Customer360ObjectResponse } from '@/lib/customer-360/contracts'

export const revalidate = 0

const OBJECT_KINDS = ['quotation', 'order', 'invoice', 'ticket'] as const
type ObjectKind = (typeof OBJECT_KINDS)[number]

function isObjectKind(value: unknown): value is ObjectKind {
  return typeof value === 'string' && (OBJECT_KINDS as readonly string[]).includes(value)
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null

  const resolved = await resolveRouteContext(req, body)
  if (!resolved.ok) return resolved.response
  const { tenantId, hint } = resolved.ctx

  const objectId = positiveInt(body?.objectId)
  if (!objectId) {
    return NextResponse.json({ error: 'objectId is required' }, { status: 400 })
  }
  if (!isObjectKind(body?.objectKind)) {
    return NextResponse.json(
      { error: `objectKind must be one of ${OBJECT_KINDS.join(', ')}` },
      { status: 400 },
    )
  }
  const objectKind = body.objectKind as ObjectKind

  // The conversation is the authority on whose data this panel may show. The
  // hint says which conversation; the session says which tenant.
  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, chatwoot_conversation_id: hint.conversationDisplayIdHint },
    select: { customer_phone: true },
  })
  if (!conversation) {
    return NextResponse.json<Customer360ObjectResponse>({
      state: 'not-found',
      message: 'This conversation has not reached the Isola customer mirror.',
    })
  }

  try {
    const config = await resolveOdooConfigForTenant(tenantId)
    const snapshot = await readCustomer360(config, conversation.customer_phone, {
      displayId: hint.conversationDisplayIdHint,
      currentRequest: null,
    })
    if (!snapshot) {
      return NextResponse.json<Customer360ObjectResponse>({
        state: 'not-found',
        message: 'No Odoo customer matched this conversation.',
      })
    }

    // Ownership, proven against the customer's own snapshot. One wording for
    // "not yours" and "does not exist" — see the header. Tickets live in
    // `openLoops`, not `documents` — a different array, same proof.
    const owned = objectKind === 'ticket'
      ? snapshot.openLoops.some((l) => l.id === objectId && l.kind === 'ticket')
      : snapshot.documents.some((d) => d.id === objectId && d.kind === objectKind)
    if (!owned) {
      return NextResponse.json<Customer360ObjectResponse>({
        state: 'not-found',
        message: 'That record is not available on this customer.',
      })
    }

    const detail = await readCustomer360Object(config, snapshot.customer.id, objectKind, objectId)
    if (!detail) {
      return NextResponse.json<Customer360ObjectResponse>({
        state: 'not-found',
        message: 'That record is not available on this customer.',
      })
    }

    return NextResponse.json<Customer360ObjectResponse>({ state: 'ready', detail })
  } catch {
    // Odoo failing is reported as a failure, never as an empty object. The
    // panel must be able to tell "could not read" from "nothing there".
    return NextResponse.json<Customer360ObjectResponse>(
      {
        state: 'unavailable',
        message: 'Odoo is not answering, so this record could not be opened.',
      },
      { status: 503 },
    )
  }
}
