/**
 * POST /api/internal/staff-ops — the Hermes-facing surface for Wave 1.
 *
 * One server-to-server seam that Hermes (and any other internal operator tool)
 * calls to read a staff member's authoritative Odoo work, resolve an inbound
 * message, apply a staff action, record a manager verdict, dispatch work, or
 * pull the owner brief. Hermes is CONFIGURED to use this; Hermes core is not
 * modified.
 *
 * AUTH: `Authorization: Bearer <ISOLA_AGENT_TOOLS_TOKEN>` with a constant-time
 * compare, exactly like /api/internal/staff and /api/agent-tools/invoke. Not a
 * session cookie, and never an Odoo key.
 *
 * TENANT SCOPING: every action requires `tenant_id` except `inbound`, which
 * resolves the tenant from the sender's binding and refuses a cross-tenant
 * match. There is no "all tenants" mode.
 *
 * FLAG GATE: STAFF_OPS_API_ENABLED must be exactly "true". Default OFF — adding
 * this route does not turn it on anywhere.
 *
 * WHAT THIS ROUTE DOES NOT DO: it never sends a WhatsApp message directly.
 * `dispatch` enqueues to the existing durable outbox and the drain owns
 * sending, so retries, dedupe and audit are inherited rather than reimplemented.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAgentToolsToken } from '@/lib/engines'
import {
  applyManagerVerdict,
  applyStaffAction,
  buildOwnerBrief,
  dispatchWorkToStaff,
  findBindingByOdooUser,
  listOpenWorkForStaff,
  resolveInboundStaffMessage,
} from '@/lib/staff-ops/service'
import { isWorkRefModel } from '@/lib/staff-ops/work-ref'
import { STAFF_ACTIONS, type StaffActionKind } from '@/lib/staff-ops/staff-action'

function isEnabled(): boolean {
  return process.env.STAFF_OPS_API_ENABLED === 'true'
}

function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function authenticate(req: NextRequest): boolean {
  const expected = getAgentToolsToken()
  if (!expected) return false // not configured — never authenticate against an empty token
  const header = req.headers.get('authorization') ?? ''
  const match = /^Bearer\s+(.+)$/i.exec(header)
  if (!match) return false
  return constantTimeEquals(match[1], expected)
}

function bad(error: string, status = 400) {
  return NextResponse.json({ ok: false, error }, { status })
}

export async function POST(req: NextRequest) {
  if (!isEnabled()) return bad('service_disabled', 403)
  if (!authenticate(req)) return bad('bad_auth', 401)

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return bad('invalid_json')
  }

  const action = typeof body.action === 'string' ? body.action : ''
  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id.trim() : ''

  try {
    switch (action) {
      // ── Read a staff member's authoritative open work ────────────────────
      case 'open_work': {
        if (!tenantId) return bad('tenant_id required')
        const odooResUserId = Number(body.odoo_res_user_id)
        if (!Number.isInteger(odooResUserId)) return bad('odoo_res_user_id required')
        const binding = await findBindingByOdooUser(tenantId, odooResUserId)
        if (!binding) return bad('no_staff_binding', 404)
        const work = await listOpenWorkForStaff(binding)
        return NextResponse.json({ ok: true, tenant_id: tenantId, staff: binding.displayName, count: work.length, work })
      }

      // ── Resolve an inbound message. READ-ONLY: decides, does not apply. ──
      case 'inbound': {
        const waId = typeof body.wa_id === 'string' ? body.wa_id.replace(/^\+/, '') : ''
        const text = typeof body.text === 'string' ? body.text : ''
        if (!waId) return bad('wa_id required')
        const resolved = await resolveInboundStaffMessage({
          waId,
          text,
          channelTenantId: tenantId || null,
        })
        // An exception is a 200 with ok:false — it is a legitimate, expected
        // outcome that the caller must surface to an operator, not a transport
        // error to be retried.
        if (resolved.route.route === 'exception') {
          return NextResponse.json({ ok: false, error: 'identity_exception', why: resolved.route.why })
        }
        return NextResponse.json({ ok: true, ...resolved })
      }

      // ── Apply a staff action to the authoritative Odoo record ────────────
      case 'apply_action': {
        if (!tenantId) return bad('tenant_id required')
        const odooResUserId = Number(body.odoo_res_user_id)
        const workRefModel = typeof body.work_ref_model === 'string' ? body.work_ref_model : ''
        const workRefId = Number(body.work_ref_id)
        const correlationId = typeof body.correlation_id === 'string' ? body.correlation_id : ''
        const staffAction = typeof body.staff_action === 'string' ? body.staff_action.toLowerCase() : ''

        if (!Number.isInteger(odooResUserId)) return bad('odoo_res_user_id required')
        if (!isWorkRefModel(workRefModel)) return bad('work_ref_model must be project.task | mail.activity | helpdesk.ticket')
        if (!Number.isInteger(workRefId) || workRefId <= 0) return bad('work_ref_id required')
        if (!correlationId) return bad('correlation_id required')
        if (!(STAFF_ACTIONS as readonly string[]).includes(staffAction)) return bad('unknown staff_action')

        const binding = await findBindingByOdooUser(tenantId, odooResUserId)
        if (!binding) return bad('no_staff_binding', 404)

        const result = await applyStaffAction({
          binding,
          action: staffAction as StaffActionKind,
          workRefModel,
          workRefId,
          correlationId,
          note: typeof body.note === 'string' ? body.note : null,
          providerMessageId: typeof body.provider_message_id === 'string' ? body.provider_message_id : null,
          source: typeof body.source === 'string' ? body.source : 'hermes',
        })
        return NextResponse.json(result, { status: result.ok ? 200 : 409 })
      }

      // ── Manager verifies or returns a completion ───────────────────────
      case 'manager_verdict': {
        if (!tenantId) return bad('tenant_id required')
        const managerOdooUserId = Number(body.manager_odoo_res_user_id)
        const activityId = Number(body.activity_id)
        if (!Number.isInteger(managerOdooUserId)) return bad('manager_odoo_res_user_id required')
        if (!Number.isInteger(activityId) || activityId <= 0) return bad('activity_id required')

        const manager = await findBindingByOdooUser(tenantId, managerOdooUserId)
        if (!manager) return bad('no_staff_binding', 404)
        if (manager.role !== 'manager' && manager.role !== 'owner') return bad('not_a_manager', 403)

        const result = await applyManagerVerdict({
          manager,
          activityId,
          approved: body.approved === true,
          feedback: typeof body.feedback === 'string' ? body.feedback : null,
          taskId: Number.isInteger(Number(body.task_id)) ? Number(body.task_id) : null,
          approvedStageName: typeof body.approved_stage === 'string' ? body.approved_stage : undefined,
        })
        return NextResponse.json(result, { status: result.ok ? 200 : 409 })
      }

      // ── Enqueue a proactive task dispatch ────────────────────────────
      case 'dispatch': {
        if (!tenantId) return bad('tenant_id required')
        const odooResUserId = Number(body.odoo_res_user_id)
        const workRefId = Number(body.work_ref_id)
        if (!Number.isInteger(odooResUserId)) return bad('odoo_res_user_id required')
        if (!Number.isInteger(workRefId) || workRefId <= 0) return bad('work_ref_id required')

        const binding = await findBindingByOdooUser(tenantId, odooResUserId)
        if (!binding) return bad('no_staff_binding', 404)

        // Dispatch only work Odoo currently says is theirs — the same
        // authority check the write path uses, applied before we message anyone.
        const work = (await listOpenWorkForStaff(binding)).find((w) => w.odooId === workRefId)
        if (!work) return bad('work_not_open_for_this_staff_member', 409)

        const result = await dispatchWorkToStaff({ binding, work, proactive: true })
        return NextResponse.json({ ok: true, work, result })
      }

      // ── Owner / manager brief ─────────────────────────────────────
      case 'brief': {
        if (!tenantId) return bad('tenant_id required')
        const rows = await buildOwnerBrief(tenantId)
        return NextResponse.json({
          ok: true,
          tenant_id: tenantId,
          staff: rows,
          note: 'awaitingDelivery counts accepted and sent — neither means the staff member has the message.',
        })
      }

      default:
        return bad('unknown action; expected open_work | inbound | apply_action | manager_verdict | dispatch | brief')
    }
  } catch (e: unknown) {
    const detail = e instanceof Error ? e.message : 'unknown error'
    console.error(`[staff-ops][api] action=${action} failed: ${detail}`)
    return NextResponse.json({ ok: false, error: 'internal_error', detail }, { status: 500 })
  }
}
