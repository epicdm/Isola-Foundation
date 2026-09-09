/**
 * POST /api/v1/customers/:customerId/actions
 *
 * Runs one governed action against one customer, through the shared ledger and
 * the governed runtime. Transport only — the lifecycle lives in
 * `lib/governed/customer-actions.ts` and is tested without a server.
 *
 * WHY A FAILED ACTION STILL ANSWERS 200
 * ------------------------------------
 * The status line describes the REQUEST. The body describes the ACTION. They
 * are different facts and this route refuses to conflate them:
 *
 *   200 + completed_verified      written, and read back to prove it
 *   200 + readback_failed         something was written and we cannot prove what
 *   200 + execution_failed        the system of record refused it
 *   200 + dependency_unavailable  the system of record was never reached
 *   200 + executor_unavailable    nothing here can perform this yet
 *
 * A client that mapped `res.ok` to "it worked" would report all five as success.
 * So `success` is emitted as an explicit field, taken from the presentation
 * contract, where exactly one state carries it. There is no path by which this
 * route emits `success: true` for anything but a verified readback.
 *
 * 4xx is reserved for the request being wrong: unauthenticated, not permitted,
 * an unusable customer reference, or a body that is not JSON.
 *
 * THE TENANT BOUNDARY IS PROVEN BEFORE ANYTHING IS PROPOSED
 * --------------------------------------------------------
 * The customer is read from THIS session's Odoo instance first. A customer id
 * belonging to another tenant is not present there, so the action is refused
 * before the ledger is touched and before any executor exists. That read is
 * also why `objectCompanyId` is left unwired in the governed ports — the check
 * has already happened here, against the real system of record, rather than
 * against a value the caller supplied.
 *
 * AND THAT SYSTEM OF RECORD IS NAMED, NOT INHERITED
 * -------------------------------------------------
 * The config resolved below is handed to createOdooRecordSystem, so it is the
 * connection every executor behind this route WRITES through. Until 2026-09-09
 * it came from resolveOdooConfigForTenant, which falls back to the
 * deployment's own ODOO_URL/ODOO_DB for a tenant with no OdooBinding row — and
 * on the UAT deployment, measured that day, there were zero binding rows and
 * that env named EPIC's PRODUCTION Odoo. A write inherits nothing: the tenant
 * whose records are about to change must be named by a binding row, so this
 * resolves through resolveOdooConfigForTenantWrite and refuses when it cannot.
 */

import { NextResponse } from 'next/server'

import { odooCallerFor, parseCustomerId, readCustomer } from '@/lib/context/customer-sources'
import { type Role } from '@/lib/context/resolve-context'
import { runCustomerAction } from '@/lib/governed/customer-actions'
import { buildExecutors } from '@/lib/governed/executors'
import { createOdooRecordSystem } from '@/lib/governed/executors/odoo-record-system'
import { prismaLedgerStore } from '@/lib/operations/ledger'
import {
  TENANT_NOT_BOUND,
  isOdooBindingRequiredError,
  resolveOdooConfigForTenantWrite,
} from '@/lib/engine-bindings'
import { getSession } from '@/lib/session'
import { requireWorkspaceAccess, type WorkspaceAuthz } from '@/lib/workspace/authz'

export const revalidate = 0

type Params = { params: Promise<{ customerId: string }> }

function contextRole(authz: WorkspaceAuthz): Role {
  return authz.level === 'owner' ? 'owner' : 'manager'
}

const NOT_FOUND = { error: 'not found, or not available to you' }

interface ActionBody {
  actionType?: unknown
  payload?: unknown
  idempotencyKey?: unknown
  correlationId?: unknown
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

export async function POST(req: Request, { params }: Params) {
  // AUTHENTICATION FIRST, before the body is even read.
  const ctx = await getSession()
  if (!ctx || !ctx.effectiveTenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const guard = await requireWorkspaceAccess(ctx, 'manager')
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status })

  const tenantId = ctx.effectiveTenantId
  const role = contextRole(guard.authz)

  const { customerId } = await params
  if (parseCustomerId(customerId) === null) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  let body: ActionBody
  try {
    body = (await req.json()) as ActionBody
  } catch {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })
  }

  const actionType = str(body.actionType)
  if (!actionType) {
    return NextResponse.json({ error: 'actionType is required' }, { status: 400 })
  }

  const idempotencyKey = str(body.idempotencyKey)
  if (!idempotencyKey) {
    // Required rather than generated. A key minted here would be new on every
    // retry, which is the opposite of what a key is for.
    return NextResponse.json({ error: 'idempotencyKey is required' }, { status: 400 })
  }

  const payload =
    body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
      ? (body.payload as Record<string, unknown>)
      : {}

  const correlationId = str(body.correlationId) || `act-${customerId}-${Date.now()}`

  // ── The tenant's system of record. Resolving it is the first thing that can
  // legitimately fail as an OUTAGE rather than as a refusal.
  let config
  try {
    config = await resolveOdooConfigForTenantWrite(tenantId)
  } catch (err) {
    // An unbound tenant is NOT an outage, and must not be reported as one.
    // `dependency_unavailable` tells the reader the system of record was not
    // reached and that trying again is reasonable — here nothing was reached
    // because there is nothing to reach, and retrying will be refused
    // identically until a person binds this workspace.
    //
    // `executor_unavailable` is the existing state for "this is listed but
    // there is nothing behind it to perform it — a gap in the system, not a
    // refusal by the system of record", which is exactly the case, and it
    // already escalates. A NEW lifecycle state was deliberately not invented:
    // ACTION_LIFECYCLE_STATES is a closed vocabulary the portal and the
    // workspace component both render from, and widening it to say one more
    // thing is a bigger change than this one is allowed to be. The `reason`
    // field carries the specific fact for anything that wants to branch on it.
    if (isOdooBindingRequiredError(err)) {
      return NextResponse.json(
        {
          actionType,
          lifecycle: 'executor_unavailable',
          reason: TENANT_NOT_BOUND,
          success: false,
          detail:
            'This workspace is not connected to its own system of record, so there is nowhere this action could be written. Nothing was sent.',
          operationId: null,
        },
        { status: 200 },
      )
    }
    return NextResponse.json(
      {
        actionType,
        lifecycle: 'dependency_unavailable',
        success: false,
        detail: 'The system of record could not be reached, so nothing was sent.',
        operationId: null,
      },
      { status: 200 },
    )
  }

  // ── Prove the customer belongs to THIS tenant's instance before proposing.
  let exists: boolean
  try {
    const found = await readCustomer(odooCallerFor(config), parseCustomerId(customerId)!)
    exists = found.length > 0
  } catch {
    // Could not ask. NOT "no such customer" — nothing has been written and a
    // retry is reasonable.
    return NextResponse.json(
      {
        actionType,
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
      tenantId,
      companyId: tenantId,
      customerId,
      actionType,
      payload,
      actorPrincipalId: ctx.user.id,
      actorRole: role,
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
      // Straight from the contract. Exactly one lifecycle state carries it.
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
