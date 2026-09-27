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
 * AUTH -- a DEDICATED, write-scoped credential, deliberately NOT
 * resolveCaller/resolveServiceCaller (Codex round 4, P1). Two things were
 * wrong with the earlier version: (a) resolveCaller's session-cookie
 * fallback let a real browser session reach a machine-only door, and (b)
 * even restricted to `caller.kind === 'service'`, resolveServiceCaller pools
 * every labelled ISOLA_360_SERVICE_TOKEN* into ONE set with no per-label
 * authority (service-auth.ts's own docs: "the label carries no authority") --
 * so any existing READ-scoped caller (the Customer 360 portal, staging)
 * could pass this gate too and silently get upgraded to manager-level
 * follow-up assignment. validateHermesFollowupToken below is a completely
 * separate credential, checked against its own dedicated env var, that no
 * existing read caller holds and that grants nothing beyond this one route.
 *
 * ACTOR IDENTITY IS CONSTRUCTED, NOT ACCEPTED. A caller supplies only
 * `paperclipAgentId`; actorPrincipalId is built server-side as the fixed
 * template `hermes:epic-business-assistant:<paperclipAgentId>` so a caller
 * can never assert an arbitrary principal string into the audit trail.
 * correlationId is REQUIRED, not generated -- it is meant to be the
 * Paperclip run id (Law 10: never invent or substitute a run id).
 *
 * TENANT + COMPANY BOUNDARY PROVEN BEFORE PROPOSING (Codex round 4, P1).
 * Existence-by-id was not enough: `lib/workspace/business-briefing.ts`
 * documents that an OdooBinding names a DATABASE, not a company, and a
 * database can hold more than one res.company. This route now resolves the
 * credential's OWN authorized company the same way business-briefing.ts
 * does (resolveAuthorizedCompany, reading Odoo's res.users/context_get for
 * the bearer's real identity -- never a Foundation-stored value) and
 * verifies the target customer's own company_id equals it before proposing,
 * reusing that module's already-Codex-hardened logic rather than a second,
 * weaker copy.
 *
 * LEDGER COLLISION NAMESPACE (Codex round 4, P2, disclosed mitigation, not
 * a full fix). runCustomerAction's exactly-once claim key is
 * (tenantId, companyId, actionType, objectType, objectId, idempotencyKey) --
 * it does NOT include actorPrincipalId, so a Hermes request and a real
 * staff request that happen to share all five other fields would collide,
 * and the loser would silently receive the winner's PRIOR result instead of
 * executing. The structurally correct fix is a distinct CallerClass for
 * Hermes through lib/operations/ledger.ts -- but CallerClass is a closed,
 * tested, cross-module enum (lib/operations/caller-class.ts) that several
 * OTHER files also depend on, and widening it is a bigger, separately-
 * authorized change than this route (Law 22: the authorization on this
 * route is for schedule-followup-assigned, not for widening the ledger's
 * caller-class scheme). The chosen mitigation here is narrower and fully
 * self-contained: Hermes's idempotencyKey is namespaced (`hermes:<key>`)
 * before it ever reaches the ledger, so it cannot collide with a
 * staff-supplied key from the generic actions route, which never produces
 * that prefix. Disclosed explicitly rather than silently patched, so the
 * wider CallerClass question can be raised and authorized on its own.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createHash, timingSafeEqual } from 'node:crypto'

import { prisma } from '@/lib/prisma'
import { decryptSecret } from '@/lib/tenant-secrets'
import { getOdooConfig } from '@/lib/engines'
import { checkOdooPolicy } from '@/lib/agent-tools'
import { resolveAuthorizedCompany, companyIdOf } from '@/lib/workspace/business-briefing'
import { odooCallerFor, parseCustomerId, readCustomer } from '@/lib/context/customer-sources'
import { runCustomerAction } from '@/lib/governed/customer-actions'
import { buildExecutors } from '@/lib/governed/executors'
import { createOdooRecordSystem } from '@/lib/governed/executors/odoo-record-system'
import { prismaLedgerStore } from '@/lib/operations/ledger'

export const revalidate = 0

const ACTION_TYPE = 'followup.scheduleAssigned'
const NOT_FOUND = { error: 'not found, or not available to you' }
const DEPENDENCY_UNAVAILABLE = {
  actionType: ACTION_TYPE,
  lifecycle: 'dependency_unavailable',
  success: false,
  detail: 'The system of record could not be reached, so nothing was sent.',
  operationId: null,
} as const

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

/**
 * A dedicated, timing-safe Bearer check against ISOLA_360_HERMES_FOLLOWUP_TOKEN
 * -- a credential ONLY this route accepts. Never folded into resolveCaller's
 * shared service-token pool (see the file header). An unconfigured token
 * never authenticates.
 */
function validateHermesFollowupToken(req: NextRequest): boolean {
  const header = req.headers.get('authorization') || ''
  const match = /^Bearer\s+(.+)$/i.exec(header.trim())
  const presented = match ? match[1].trim() : ''
  const expected = (process.env.ISOLA_360_HERMES_FOLLOWUP_TOKEN ?? '').trim()
  if (!presented || !expected) return false
  const a = createHash('sha256').update(presented, 'utf8').digest()
  const b = createHash('sha256').update(expected, 'utf8').digest()
  return timingSafeEqual(a, b)
}

export async function POST(req: NextRequest) {
  if (!validateHermesFollowupToken(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The tenant this credential may act on is deployment configuration, the
  // same construction-not-parameter shape resolveServiceCaller already uses
  // for ISOLA_360_SERVICE_TENANT_ID -- a caller cannot assert a tenant
  // because there is nowhere in this request to put one.
  const tenantId = (process.env.ISOLA_360_SERVICE_TENANT_ID ?? '').trim()
  if (!tenantId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  // A service caller is always 'manager', never 'owner' -- the owner is
  // named only as assigneeRef in the payload, never granted the role.
  const actorRole = 'manager' as const

  let parsedBody: unknown
  try {
    parsedBody = await req.json()
  } catch {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
    return NextResponse.json({ error: 'a JSON body is required' }, { status: 400 })
  }
  const body = parsedBody as ScheduleFollowupAssignedBody

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

  const idempotencyKeyRaw = str(body.idempotencyKey)
  if (!idempotencyKeyRaw) {
    return NextResponse.json({ error: 'idempotencyKey is required' }, { status: 400 })
  }
  // See the file header's LEDGER COLLISION NAMESPACE note.
  const idempotencyKey = `hermes:${idempotencyKeyRaw}`

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

  const binding = await prisma.odooBinding.findUnique({ where: { tenant_id: tenantId } })
  if (!binding) {
    return NextResponse.json(DEPENDENCY_UNAVAILABLE, { status: 200 })
  }

  let config
  try {
    config = getOdooConfig({ url: binding.url, db: binding.db, apiKey: decryptSecret(binding.api_key_enc) })
  } catch {
    return NextResponse.json(DEPENDENCY_UNAVAILABLE, { status: 200 })
  }

  // Codex round 4 P1: resolve the credential's OWN authorized company --
  // never a Foundation-stored field -- before trusting anything read
  // through it. Refuses (not guesses) when the credential is scoped to
  // zero or more than one company.
  const scope = await resolveAuthorizedCompany(config, binding.login)
  if (!scope.ok) {
    return NextResponse.json(DEPENDENCY_UNAVAILABLE, { status: 200 })
  }

  let exists: boolean
  let customerCompanyId: number | null = null
  try {
    const found = await readCustomer(odooCallerFor(config), parsedCustomerId)
    exists = found.length > 0
    if (exists) {
      // readCustomer's own CustomerRecord shape doesn't carry company_id
      // (it's shared by routes that don't need it) -- a small, dedicated
      // read here, same house pattern as business-briefing.ts's own
      // withAuthorizedCompanyGuard.
      checkOdooPolicy('res.partner', 'search_read')
      const call = odooCallerFor(config)
      const result = await call('res.partner', 'search_read', {
        domain: [['id', '=', parsedCustomerId]],
        fields: ['company_id'],
        limit: 1,
      })
      // json2Call's search_read result is a plain array -- same normalisation
      // customer-sources.ts's own `rows()` helper does, kept local here since
      // that helper isn't exported.
      const rowList = Array.isArray(result) ? (result as { company_id?: unknown }[]) : []
      customerCompanyId = rowList.length > 0 ? companyIdOf(rowList[0].company_id) : null
    }
  } catch {
    return NextResponse.json(DEPENDENCY_UNAVAILABLE, { status: 200 })
  }

  if (!exists) return NextResponse.json(NOT_FOUND, { status: 404 })
  // A partner with no resolvable company_id, or one that disagrees with the
  // credential's authorized company, can never be proven to belong to this
  // tenant's own scope -- refused, not silently included.
  if (customerCompanyId === null || customerCompanyId !== scope.companyId) {
    return NextResponse.json(NOT_FOUND, { status: 404 })
  }

  const recordSystem = createOdooRecordSystem({ resolveConfig: async () => config })

  const outcome = await runCustomerAction(
    {
      tenantId,
      companyId: tenantId,
      customerId: customerIdRaw,
      actionType: ACTION_TYPE,
      payload: { note, dueDate, assigneeRef },
      actorPrincipalId,
      actorRole,
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
