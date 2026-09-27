/**
 * POST /api/isola-360/actions/schedule-followup-assigned
 *
 * The Hermes-facing door onto the `followup.scheduleAssigned` governed action
 * (lib/governed/executors/index.ts) -- NOT the panel's own create-followup
 * route, which writes through a separate, unassigned-only path
 * (lib/customer-360/odoo-projection.ts's createCustomerFollowUp). This route
 * exists specifically so an agent acting on the OWNER's behalf can schedule a
 * follow-up AND name who it is assigned to, through the full governed
 * pipeline (validate -> authorize -> execute -> readback -> audit), not a
 * shortcut around it.
 *
 * AUTH: resolveCaller's existing service-Bearer door (lib/customer-360/
 * service-auth.ts), reused exactly as-is -- no new mechanism. A new labelled
 * caller (e.g. ISOLA_360_SERVICE_TOKEN_HERMES) is deployment configuration,
 * not code; this route does not know or care which labelled token
 * authenticated it. Per dec-pilot-assistant-tool-path-mcp-facade-2026-09-27:
 * the service caller is ALWAYS 'manager', never 'owner' -- the owner is
 * named only as assigneeRef in the payload, never granted the role.
 *
 * ACTOR IDENTITY IS CONSTRUCTED, NOT ACCEPTED. A caller supplies only
 * `paperclipAgentId`; actorPrincipalId is built server-side as the fixed
 * template `hermes:epic-business-assistant:<paperclipAgentId>` so a caller
 * can never assert an arbitrary principal string into the audit trail.
 * correlationId is REQUIRED, not generated -- it is meant to be the
 * Paperclip run id (Law 10: never invent or substitute a run id).
 *
 * TENANT BOUNDARY PROVEN BEFORE PROPOSING, same as the generic
 * /api/v1/customers/:customerId/actions route this is modelled on: the
 * customer is read from THIS resolved tenant's Odoo first, so a customerId
 * belonging to another tenant is refused before the ledger or any executor
 * is touched.
 */

import { NextRequest, NextResponse } from 'next/server'

import { odooCallerFor, parseCustomerId, readCustomer } from '@/lib/context/customer-sources'
import { runCustomerAction } from '@/lib/governed/customer-actions'
import { buildExecutors } from '@/lib/governed/executors'
import { createOdooRecordSystem } from '@/lib/governed/executors/odoo-record-system'
import { prismaLedgerStore } from '@/lib/operations/ledger'
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings'
import { resolveCaller } from '@/lib/customer-360/route-context'

export const revalidate = 0

const ACTION_TYPE = 'followup.scheduleAssigned'
const NOT_FOUND = { error: 'not found, or not available to you' }

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/** hermes:epic-business-assistant:<uuid> -- a UUID-shaped agent id only. A
 *  caller cannot smuggle an arbitrary string into the constructed principal
 *  by supplying a malformed one; malformed is refused, not sanitised. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface ScheduleFollowupAssignedBody {
  customerId?: unknown
  note?: unknown
  dueDate?: unknown
  assigneeRef?: unknown
  idempotencyKey?: unknown
  correlationId?: unknown
  paperclipAgentId?: unknown
}

export async function POST(req: NextRequest) {
  const resolved = await resolveCaller(req)
  if (!resolved.ok) return resolved.response
  const caller = resolved.caller

  // Codex P1: this route is a machine door, not a general session-authenticated
  // one. resolveCaller's session-cookie fallback would let a real browser
  // session (manager OR owner) reach it too -- and this route unconditionally
  // builds actorPrincipalId as "hermes:...:<caller-supplied paperclipAgentId>",
  // so a human session would corrupt the audit trail to look like Hermes
  // acted, and could ride in as actorRole 'owner', which this route was never
  // designed to carry. Service callers only; a session caller is refused
  // outright, not silently downgraded.
  if (caller.kind !== 'service') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  let parsedBody: unknown
  try {
    parsedBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  // Codex P2: `req.json()` succeeds on literal JSON `null` (and on an array),
  // which is not an object a field can be read from -- an unchecked cast
  // would throw on the first `body.x` access and surface as an uncaught 500
  // instead of this route's own intended 400.
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  const body = parsedBody as ScheduleFollowupAssignedBody

  // Codex P2: parseCustomerId already accepts a number OR a numeric string;
  // pre-converting with str() turned a legitimate numeric customerId (as
  // Hermes would send it, matching the existing context/create-followup
  // APIs) into an empty string and produced a false 400. Parse the raw field
  // first, canonicalize to a string only afterward for the string-typed
  // fields downstream.
  const parsedCustomerId = parseCustomerId(body.customerId)
  if (parsedCustomerId === null) {
    return NextResponse.json({ error: 'customerId is required' }, { status: 400 })
  }
  const customerIdRaw = String(parsedCustomerId)

  const note = str(body.note)
  if (!note) {
    return NextResponse.json({ error: 'note is required' }, { status: 400 })
  }

  const dueDate = str(body.dueDate)
  if (!dueDate) {
    return NextResponse.json({ error: 'dueDate is required' }, { status: 400 })
  }

  const assigneeRef = str(body.assigneeRef)
  if (!assigneeRef) {
    return NextResponse.json({ error: 'assigneeRef is required' }, { status: 400 })
  }

  const idempotencyKey = str(body.idempotencyKey)
  if (!idempotencyKey) {
    return NextResponse.json({ error: 'idempotencyKey is required' }, { status: 400 })
  }

  const correlationId = str(body.correlationId)
  if (!correlationId) {
    // Deliberately required, never generated: this is meant to BE the
    // Paperclip run id, threaded through, not invented here.
    return NextResponse.json({ error: 'correlationId is required (the calling run\'s own id)' }, { status: 400 })
  }

  const paperclipAgentId = str(body.paperclipAgentId)
  if (!UUID_RE.test(paperclipAgentId)) {
    return NextResponse.json({ error: 'paperclipAgentId is required and must be a UUID' }, { status: 400 })
  }
  const actorPrincipalId = `hermes:epic-business-assistant:${paperclipAgentId}`

  let config
  try {
    config = await resolveOdooConfigForTenant(caller.tenantId)
  } catch {
    return NextResponse.json(
      {
        actionType: ACTION_TYPE,
        lifecycle: 'dependency_unavailable',
        success: false,
        detail: 'The system of record could not be reached, so nothing was sent.',
        operationId: null,
      },
      { status: 200 },
    )
  }

  let exists: boolean
  try {
    const found = await readCustomer(odooCallerFor(config), parsedCustomerId)
    exists = found.length > 0
  } catch {
    return NextResponse.json(
      {
        actionType: ACTION_TYPE,
        lifecycle: 'dependency_unavailable',
        success: false,
        detail: 'The system of record could not be reached, so nothing was sent.',
        operationId: null,
      },
      { status: 200 },
    )
  }

  if (!exists) return NextResponse.json(NOT_FOUND, { status: 404 })

  const recordSystem = createOdooRecordSystem({ resolveConfig: async () => config })

  const outcome = await runCustomerAction(
    {
      tenantId: caller.tenantId,
      companyId: caller.tenantId,
      customerId: customerIdRaw,
      actionType: ACTION_TYPE,
      payload: { note, dueDate, assigneeRef },
      actorPrincipalId,
      actorRole: caller.actorRole,
      idempotencyKey,
      correlationId,
    },
    {
      ledger: prismaLedgerStore,
      executors: buildExecutors(recordSystem),
      now: () => new Date(),
    },
  )

  return NextResponse.json(
    {
      version: outcome.version,
      actionType: outcome.actionType,
      correlationId: outcome.correlationId,
      operationId: outcome.operationId,
      auditRef: outcome.auditRef,
      lifecycle: outcome.lifecycle,
      success: outcome.presentation.success,
      label: outcome.presentation.label,
      detail: outcome.detail,
      marker: outcome.presentation.marker,
      tone: outcome.presentation.tone,
      terminal: outcome.presentation.terminal,
      retryWrite: outcome.presentation.retryWrite,
      retryReadback: outcome.presentation.retryReadback,
      escalate: outcome.presentation.escalate,
      showsPriorResult: outcome.presentation.showsPriorResult,
      readbackProven: outcome.readbackProven,
      approvalRef: outcome.approvalRef,
    },
    { status: 200 },
  )
}
