/**
 * POST /api/isola-360/lifecycle
 *
 * One Personal Line's onboarding checklist, opened on demand from its row
 * in the Services tab (owner baseline, 2026-09-20: onboarding status is
 * CONTEXT for the concierge's continuing relationship with a customer, not
 * a standalone deliverable).
 *
 * OWNERSHIP IS PROVEN THROUGH THE SNAPSHOT, SAME AS /api/isola-360/objects
 * -------------------------------------------------------------------------
 * The caller names a `did`. That is a locator, never an authorisation. This
 * route resolves the conversation, resolves THAT conversation's customer,
 * reads the customer's own snapshot, and requires the requested `did` to be
 * present in `snapshot.services` before it will ask bff-v2 for anything.
 * Without this check, an authenticated caller could probe any phone number
 * and learn whether it maps to a Personal Line account at all — the same
 * enumeration-oracle shape the objects route's own header describes.
 *
 * `resolveAndReadLifecycle` then resolves `did -> liteAccountId` and calls
 * bff-v2's service-detail itself, entirely server-to-server — liteAccountId
 * is used and discarded inside that function; it never reaches this route,
 * and this route never returns it.
 */

import { NextRequest, NextResponse } from 'next/server'

import { prisma } from '@/lib/prisma'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { readCustomer360 } from '@/lib/customer-360/odoo-projection'
import { resolveRouteContext } from '@/lib/customer-360/route-context'
import { resolveAndReadLifecycle } from '@/lib/customer-360/personal-line-services'
import type { LifecycleMilestones } from '@/lib/customer-360/contracts'

export const revalidate = 0

export type LifecycleResponse =
  | { state: 'ready'; lifecycle: LifecycleMilestones }
  | { state: 'not-found'; message: string }
  | { state: 'unavailable'; message: string }

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null

  const resolved = await resolveRouteContext(req, body)
  if (!resolved.ok) return resolved.response
  const { tenantId, hint } = resolved.ctx

  const did = typeof body?.did === 'string' ? body.did.trim() : ''
  if (!did) {
    return NextResponse.json({ error: 'did is required' }, { status: 400 })
  }

  // Same authority chain as /api/isola-360/objects: the conversation says
  // which customer, the session says which tenant.
  const conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, chatwoot_conversation_id: hint.conversationDisplayIdHint },
    select: { customer_phone: true },
  })
  if (!conversation) {
    return NextResponse.json<LifecycleResponse>({
      state: 'not-found',
      message: 'This conversation has not reached the Isola customer mirror.',
    })
  }

  let snapshot: Awaited<ReturnType<typeof readCustomer360>>
  try {
    const config = await resolveOdooConfigForTenant(tenantId)
    snapshot = await readCustomer360(config, conversation.customer_phone, {
      displayId: hint.conversationDisplayIdHint,
      currentRequest: null,
    })
  } catch {
    // Odoo failing is reported as a failure, never as an empty checklist.
    // Scoped to ONLY the Odoo read -- resolveAndReadLifecycle (a bff-v2
    // call, not Odoo) is deliberately OUTSIDE this try/catch below, so an
    // unrelated bff-v2 failure is never misreported as "Odoo is not
    // answering" (it also never throws itself; every path inside it
    // already returns a LifecycleReadResult, so this catch would never
    // legitimately fire for it anyway -- the separation is about not
    // MISLABELING a failure's source, not about needing a second catch).
    return NextResponse.json<LifecycleResponse>(
      {
        state: 'unavailable',
        message: 'Odoo is not answering, so this checklist could not be opened.',
      },
      { status: 503 },
    )
  }

  if (!snapshot) {
    return NextResponse.json<LifecycleResponse>({
      state: 'not-found',
      message: 'No Odoo customer matched this conversation.',
    })
  }

  // bff-v2 not answering must read as 'unavailable', never as 'not-found' --
  // an outage on the ownership check must not be presented as "this
  // Personal Line does not exist" (PR144 review, isola-foundation-5c +
  // Codex, 2026-09-21: this check was missing entirely; every service
  // lookup during a bff-v2 outage fell through to the ownership check
  // below, which an empty `services` array always fails, misreporting a
  // "could not check" as a "does not exist").
  if (!snapshot.servicesAvailable) {
    return NextResponse.json<LifecycleResponse>(
      {
        state: 'unavailable',
        message: 'bff-v2 did not answer for this customer’s services, so this checklist could not be opened.',
      },
      { status: 503 },
    )
  }

  // Ownership, proven against the customer's own snapshot — never trust
  // the caller's did alone. Same "not yours and does not exist collapse
  // into one wording" rule the objects route applies, so an unauthorised
  // caller cannot use this to learn which numbers are real Personal Lines.
  const owned = snapshot.services.some((s) => s.did === did)
  if (!owned) {
    return NextResponse.json<LifecycleResponse>({
      state: 'not-found',
      message: 'That Personal Line is not available on this customer.',
    })
  }

  // Deliberately OUTSIDE the Odoo try/catch above — this never throws (every
  // internal failure path already resolves to a LifecycleReadResult), and
  // keeping it out means a bff-v2 problem can never be mislabeled as Odoo
  // being unreachable.
  const result = await resolveAndReadLifecycle(did)
  return NextResponse.json<LifecycleResponse>(result)
}
