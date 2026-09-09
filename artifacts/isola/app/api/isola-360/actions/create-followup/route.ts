/**
 * POST /api/isola-360/actions/create-followup
 *
 * "Create follow-up task" landing a REAL `mail.activity` row on the
 * customer's res.partner record — not a toast. Reuses the already-built,
 * already-tested governed executor (lib/governed/executors/odoo-record-
 * system.ts's scheduleFollowup) via createCustomerFollowUp, rather than a
 * second write path.
 *
 * SIMPLER DOOR THAN send-document, DELIBERATELY. A follow-up note is not
 * customer-facing — it never reaches Chatwoot, never composes a message a
 * customer will read — so it does not need the conversation-binding chain
 * that document sends require (resolveConversationDoor, idempotency,
 * ledger, audit). It needs the SAME tenant/caller resolution every read in
 * this lineage already uses (resolveCaller), and a customerId locator,
 * exactly like the customerId door on /api/isola-360/context.
 *
 * THE DESTINATION IS NAMED, NEVER INHERITED
 * -----------------------------------------
 * Every READ in this lineage resolves Odoo through
 * resolveOdooConfigForTenant, which falls back to the deployment's own
 * ODOO_URL/ODOO_DB when a tenant has no OdooBinding row. This route is not a
 * read. Measured 2026-09-09 on isola-360-uat: OdooBinding held zero rows
 * while that deployment's env named EPIC's PRODUCTION Odoo — so this button,
 * on STAGING, would have written a real mail.activity onto a live business's
 * contact record, with no error anywhere to show for it.
 *
 * A write inherits nothing. The tenant whose system of record is about to
 * change must be named by a binding row, so this route resolves through
 * resolveOdooConfigForTenantWrite and refuses when it cannot.
 */

import { NextRequest, NextResponse } from 'next/server'

import {
  TENANT_NOT_BOUND,
  isOdooBindingRequiredError,
  resolveOdooConfigForTenantWrite,
} from '@/lib/engine-bindings'
import { createCustomerFollowUp } from '@/lib/customer-360/odoo-projection'
import { resolveCaller } from '@/lib/customer-360/route-context'

export const revalidate = 0

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Date-only, YYYY-MM-DD. Anything else is refused rather than passed to
 *  Odoo and hoped to parse. */
function validDateOnly(v: unknown): string | null {
  const s = str(v)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return Number.isNaN(new Date(s).getTime()) ? null : s
}

export async function POST(req: NextRequest) {
  const resolved = await resolveCaller(req)
  if (!resolved.ok) return resolved.response
  const caller = resolved.caller

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })

  const customerId = positiveInt(body.customerId)
  if (customerId === null) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }

  const note = str(body.note)
  if (!note) {
    return NextResponse.json({ error: 'note is required' }, { status: 400 })
  }

  const dueDate = validDateOnly(body.dueDate)
  if (!dueDate) {
    return NextResponse.json({ error: 'dueDate must be a real date, YYYY-MM-DD' }, { status: 400 })
  }

  try {
    const config = await resolveOdooConfigForTenantWrite(caller.tenantId)
    const followUp = await createCustomerFollowUp(config, customerId, note, dueDate)
    return NextResponse.json({ ok: true, followUp }, { status: 200 })
  } catch (err) {
    // The unbound tenant is answered FIRST and by name. It is not an outage:
    // Odoo was never contacted and retrying will be refused identically until
    // somebody binds this workspace. Reported as {ok:false} at 200 — the shape
    // the panel and the portal already consume — plus a `reason` a caller can
    // branch on, rather than a status code they would render as "the network
    // failed".
    if (isOdooBindingRequiredError(err)) {
      return NextResponse.json(
        {
          ok: false,
          reason: TENANT_NOT_BOUND,
          error:
            'This workspace is not connected to its own Odoo, so there is nowhere this follow-up could be written. Nothing was created.',
        },
        { status: 200 },
      )
    }
    // Created-but-unreadable and never-created both surface as the same
    // honest refusal — the panel must not claim a follow-up exists when it
    // cannot prove one does.
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : 'The follow-up could not be created.',
      },
      { status: 200 },
    )
  }
}
