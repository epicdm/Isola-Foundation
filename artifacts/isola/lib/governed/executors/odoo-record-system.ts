/**
 * The Odoo-backed RecordSystem for Foundation's governed executors.
 *
 * WHY THIS FILE EXISTS AND WHAT IT IS NOT
 * ---------------------------------------
 * `lib/customer-tools/*` already writes notes, activities and leads to Odoo. It
 * is NOT duplicated here and it is NOT wrapped here, because its inputs are
 * conversation-bound by design — `chatwootConversationId` and `clawithSessionId`
 * are required fields, and `partnerId` must have been resolved from a
 * transport-verified identity. Those are facts a CUSTOMER conversation has and
 * an OWNER sitting in the Foundation workbench does not.
 *
 * What IS shared is the layer underneath both: `engines/odoo`. There is one way
 * this product talks to Odoo, and this file uses it.
 *
 * THE ONE JOB
 * -----------
 * Two failures look identical from the outside and must not be reported the
 * same way:
 *   - Odoo is DOWN (5xx, timeout, DNS failure, plan has no /json/2 route)
 *     → DependencyUnavailable → the action reports DEPENDENCY_UNAVAILABLE and a
 *       retry is sensible.
 *   - Odoo REFUSED the write (4xx: validation, access rule, missing field)
 *     → an ordinary Error → the action reports EXECUTION_FAILED and retrying
 *       the same payload will fail again.
 *
 * THE OTHER JOB
 * -------------
 * Readback is only proof if it matches what was asked for. Odoo does not hand
 * back what you gave it: a note comes back as HTML, a stage comes back as an
 * [id, name] pair, a number comes back as a float. Every read here is translated
 * into the caller's own vocabulary so the comparison in `executors/index.ts` is
 * comparing like with like.
 */

import {
  json2Call,
  OdooApiError,
  OdooNoApiError,
  type OdooConfig,
} from '@/engines/odoo'

import { DependencyUnavailable } from '../action'

import type { RecordSystem } from './index'

/** The transport, injected so tests never open a socket. */
export type OdooCall = (
  config: OdooConfig,
  model: string,
  method: string,
  params?: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>

/**
 * Foundation's canonical lead stages mapped to the names Odoo shows a human.
 * Overridable per tenant — an Odoo pipeline that has been renamed is normal, and
 * silently failing to find "Qualified" would be reported as a readback failure
 * with no clue why.
 */
export const DEFAULT_STAGE_NAMES: Readonly<Record<string, string>> = {
  new: 'New',
  qualified: 'Qualified',
  proposition: 'Proposition',
  won: 'Won',
  lost: 'Lost',
}

export interface OdooRecordSystemDeps {
  /** Resolves the Odoo binding for the acting tenant. May itself fail. */
  resolveConfig: () => Promise<OdooConfig>
  call?: OdooCall
  /** Wall-clock guard per call. A hung Odoo must not hang a staff member. */
  timeoutMs?: number
  stageNames?: Readonly<Record<string, string>>
  /**
   * Which `mail.activity.type` to use. Resolved at runtime, never hardcoded —
   * activity type ids differ per database.
   */
  resolveActivityTypeId?: (config: OdooConfig, call: OdooCall) => Promise<number | null>
  /**
   * Confirms an Odoo res.users id is bound to `tenantId` as staff (Codex
   * review, PR #155: an Odoo instance can be shared across tenants/companies,
   * so "active internal user" alone never proves tenant membership).
   * Injectable so odoo-record-system.ts itself stays Prisma-free and every
   * existing test needs no real database -- defaults to the real Foundation
   * binding table via lib/staff-ops/service.ts's findBindingByOdooUser, the
   * SAME check the staff-ops flow already uses for this exact question.
   */
  verifyStaffBinding?: (tenantId: string, odooUserId: number) => Promise<boolean>
}

async function defaultVerifyStaffBinding(tenantId: string, odooUserId: number): Promise<boolean> {
  const { findBindingByOdooUser } = await import('@/lib/staff-ops/service')
  const binding = await findBindingByOdooUser(tenantId, odooUserId)
  // Codex review, PR #155: existence alone is not enough -- a deactivated
  // staff member's binding row still exists. lib/staff-ops/service.ts's own
  // manager-tap path requires `.active` explicitly (service.ts:882-885);
  // this is the same requirement, for the same reason.
  return binding !== null && binding.active
}

const DEFAULT_TIMEOUT_MS = 15_000

// ── shape helpers ──────────────────────────────────────────────────────

/** Odoo returns a new id as a bare number, a one-element list, or `{ id }`. */
function asId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (Array.isArray(v) && typeof v[0] === 'number') return v[0]
  if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'number') {
    return (v as { id: number }).id
  }
  return null
}

/** search_read comes back as a bare array, or wrapped in `{ records }`. */
function rowsOf(v: unknown): Record<string, unknown>[] {
  const arr = Array.isArray(v)
    ? v
    : v && typeof v === 'object' && Array.isArray((v as { records?: unknown }).records)
      ? ((v as { records: unknown[] }).records as unknown[])
      : []
  return arr.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
}

function firstRow(v: unknown): Record<string, unknown> | null {
  return rowsOf(v)[0] ?? null
}

/** A many2one arrives as [id, display_name]. */
function m2oName(v: unknown): string {
  return Array.isArray(v) && v.length > 1 ? String(v[1]) : ''
}

function m2oId(v: unknown): string {
  return Array.isArray(v) && typeof v[0] === 'number' ? String(v[0]) : ''
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')

/** Undo Odoo's HTML so a stored note can be compared to the text we sent. */
export function plainText(html: unknown): string {
  const s = typeof html === 'string' ? html : ''
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim()
}

// ── failure classification ── the entire point of the adapter ────────────────

const NETWORK_SHAPED =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|network|dns/i

function rethrowClassified(err: unknown): never {
  // Already classified upstream — do not re-wrap and lose the dependency name.
  if (err instanceof DependencyUnavailable) throw err

  if (err instanceof OdooNoApiError) {
    // Permanently unavailable rather than transient, but it IS the dependency
    // that is missing, and naming it tells the operator exactly what to fix.
    throw new DependencyUnavailable('odoo-external-api', err.message)
  }

  if (err instanceof OdooApiError) {
    if (err.httpStatus >= 500) {
      throw new DependencyUnavailable('odoo', `HTTP ${err.httpStatus}: ${err.message}`)
    }
    // 4xx — Odoo understood us and said no. Retrying will say no again.
    throw err
  }

  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new DependencyUnavailable('odoo', `request timed out: ${err.message}`)
    }
    if (NETWORK_SHAPED.test(err.message)) {
      throw new DependencyUnavailable('odoo', err.message)
    }
  }

  throw err
}

// ── the adapter ───────────────────────────────────────────────────

async function defaultResolveActivityTypeId(
  config: OdooConfig,
  call: OdooCall,
): Promise<number | null> {
  const res = await call(config, 'mail.activity.type', 'search_read', {
    domain: [['res_model', '=', false]],
    fields: ['id', 'name'],
    order: 'sequence asc, id asc',
    limit: 1,
  })
  const row = firstRow(res)
  return row ? asId(row.id) : null
}

export function createOdooRecordSystem(deps: OdooRecordSystemDeps): RecordSystem {
  const call = deps.call ?? json2Call
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stageNames = deps.stageNames ?? DEFAULT_STAGE_NAMES
  const resolveActivityTypeId = deps.resolveActivityTypeId ?? defaultResolveActivityTypeId
  const verifyStaffBinding = deps.verifyStaffBinding ?? defaultVerifyStaffBinding

  async function config(): Promise<OdooConfig> {
    try {
      return await deps.resolveConfig()
    } catch (err) {
      // No binding means we cannot even ask the question. That is the dependency
      // being unavailable, not the write being refused.
      throw new DependencyUnavailable(
        'odoo-binding',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  async function rpc(model: string, method: string, params: Record<string, unknown>) {
    const cfg = await config()
    try {
      return await call(cfg, model, method, params, timeout)
    } catch (err) {
      rethrowClassified(err)
    }
  }

  /** Every create funnels through here so "Odoo returned no id" is one message. */
  async function createOne(
    model: string,
    vals: Record<string, unknown>,
  ): Promise<{ externalId: string }> {
    const res = await rpc(model, 'create', { vals_list: [vals] })
    const id = asId(res)
    if (id === null) {
      throw new Error(`${model} create returned no id; nothing can be read back`)
    }
    return { externalId: String(id) }
  }

  async function readOne(
    model: string,
    externalId: string,
    fields: string[],
  ): Promise<Record<string, unknown> | null> {
    const id = Number(externalId)
    if (!Number.isFinite(id)) return null
    const res = await rpc(model, 'search_read', {
      domain: [['id', '=', id]],
      fields,
      limit: 1,
    })
    return firstRow(res)
  }

  async function resolveStageId(name: string): Promise<number | null> {
    const res = await rpc('crm.stage', 'search_read', {
      domain: [['name', '=', name]],
      fields: ['id'],
      limit: 1,
    })
    const row = firstRow(res)
    return row ? asId(row.id) : null
  }

  /** Odoo stage name -> Foundation's canonical stage word. */
  function canonicalStage(odooName: string): string {
    const hit = Object.entries(stageNames).find(
      ([, v]) => v.toLowerCase() === odooName.toLowerCase(),
    )
    return hit ? hit[0] : odooName
  }

  async function activityVals(input: {
    objectType: string
    objectId: string
    summary: string
    dueDate: string
    assigneeRef?: string | null
  }) {
    const res = await rpc('ir.model', 'search_read', {
      domain: [['model', '=', input.objectType]],
      fields: ['id'],
      limit: 1,
    })
    const modelRow = firstRow(res)
    const resModelId = modelRow ? asId(modelRow.id) : null
    if (resModelId === null) {
      throw new Error(`ir.model has no entry for ${input.objectType}; the activity was not created`)
    }

    const cfg = await config()
    const activityTypeId = await resolveActivityTypeId(cfg, call).catch(rethrowClassified)
    if (activityTypeId === null) {
      throw new Error(
        'no mail.activity.type could be resolved for this database; the activity was not created',
      )
    }

    const assignee = Number(input.assigneeRef)
    return {
      res_model_id: resModelId,
      res_id: Number(input.objectId),
      summary: input.summary,
      date_deadline: input.dueDate.slice(0, 10),
      activity_type_id: activityTypeId,
      ...(Number.isFinite(assignee) && assignee > 0 ? { user_id: assignee } : {}),
    }
  }

  return {
    // ── notes — posted to the record's chatter as mail.message ──────────────
    async createNote(input) {
      const res = await rpc(input.objectType, 'message_post', {
        ids: [Number(input.objectId)],
        body: `<p>${escapeHtml(input.body)}</p>`,
        message_type: 'comment',
      })
      const id = asId(res)
      if (id === null) {
        throw new Error('message_post returned no message id; the note cannot be proven')
      }
      return { externalId: String(id) }
    },
    async readNote(externalId) {
      const row = await readOne('mail.message', externalId, ['id', 'body'])
      if (!row) return null
      // Hand back the note as TEXT. The caller compares against the text it sent.
      return { ...row, body: plainText(row.body) }
    },

    // ── tasks ───────────────────────────────────────────────────
    async createTask(input) {
      const assignee = Number(input.assigneeRef)
      return createOne('project.task', {
        name: input.title,
        ...(input.dueDate ? { date_deadline: input.dueDate.slice(0, 10) } : {}),
        ...(Number.isFinite(assignee) && assignee > 0 ? { user_ids: [[6, 0, [assignee]]] } : {}),
        ...(input.objectType === 'res.partner'
          ? { partner_id: Number(input.objectId) }
          : {}),
      })
    },
    async readTask(externalId) {
      const row = await readOne('project.task', externalId, ['id', 'name', 'date_deadline'])
      if (!row) return null
      return { ...row, title: String(row.name ?? '') }
    },

    // ── activities ──────────────────────────────────────────────
    async scheduleActivity(input) {
      return createOne('mail.activity', await activityVals(input))
    },
    async readActivity(externalId) {
      const row = await readOne('mail.activity', externalId, [
        'id',
        'summary',
        'date_deadline',
        'user_id',
      ])
      if (!row) return null
      return { ...row, summary: String(row.summary ?? '') }
    },

    // ── leads ──────────────────────────────────────────────────
    async createLead(input) {
      const contact = Number(input.contactRef)
      return createOne('crm.lead', {
        name: input.name,
        type: 'lead',
        ...(Number.isFinite(contact) && contact > 0 ? { partner_id: contact } : {}),
        ...(input.source ? { description: `Source: ${input.source}` } : {}),
      })
    },
    async readLead(externalId) {
      const row = await readOne('crm.lead', externalId, [
        'id',
        'name',
        'stage_id',
        'user_id',
        'expected_revenue',
      ])
      if (!row) return null
      // Translate back into the caller's vocabulary, or the comparison in
      // executors/index.ts is comparing a word to an [id, name] pair.
      return {
        ...row,
        name: String(row.name ?? ''),
        stage: canonicalStage(m2oName(row.stage_id)),
        ownerRef: m2oId(row.user_id),
        expectedRevenue:
          row.expected_revenue === null || row.expected_revenue === undefined
            ? ''
            : String(row.expected_revenue),
      }
    },
    async updateLead(input) {
      const vals: Record<string, unknown> = {}

      if (input.fields.name) vals.name = input.fields.name

      if (input.fields.stage) {
        const odooName = stageNames[input.fields.stage] ?? input.fields.stage
        const stageId = await resolveStageId(odooName)
        if (stageId === null) {
          throw new Error(
            `crm.stage "${odooName}" does not exist in this pipeline; the lead was not changed`,
          )
        }
        vals.stage_id = stageId
      }

      if (input.fields.ownerRef) {
        const owner = Number(input.fields.ownerRef)
        if (!Number.isFinite(owner) || owner <= 0) {
          throw new Error('ownerRef must be an Odoo res.users id; the lead was not changed')
        }
        vals.user_id = owner
      }

      if (input.fields.expectedRevenue) {
        const revenue = Number(input.fields.expectedRevenue)
        if (!Number.isFinite(revenue)) {
          throw new Error('expectedRevenue must be a number; the lead was not changed')
        }
        vals.expected_revenue = revenue
      }

      await rpc('crm.lead', 'write', { ids: [Number(input.leadId)], vals })
      return { externalId: String(input.leadId) }
    },

    // ── follow-ups — a mail.activity, recorded. NOT delivered. ──────────────
    async scheduleFollowup(input) {
      return createOne(
        'mail.activity',
        await activityVals({
          objectType: input.objectType,
          objectId: input.objectId,
          summary: input.note,
          dueDate: input.dueDate,
          assigneeRef: input.ownerRef,
        }),
      )
    },
    async readFollowup(externalId) {
      const row = await readOne('mail.activity', externalId, ['id', 'summary', 'date_deadline', 'user_id'])
      if (!row) return null
      return { ...row, note: String(row.summary ?? '') }
    },

    // ── assignable-user resolution — ev-isola-360-followup-assignment- ──────
    // 2026-09-27, followup.scheduleAssigned's target check. `share = false`
    // excludes portal/customer logins on Odoo's shared multi-tenant instance
    // -- "any active user" would let a follow-up be assigned to a customer's
    // own portal account. Odoo identity alone is NOT tenant proof (Codex
    // review, PR #155): an id real and active in THIS Odoo can still belong
    // to a DIFFERENT tenant sharing the same database/company, so
    // verifyStaffBinding (Foundation's own tenant<->Odoo-user binding table,
    // the same one lib/staff-ops/service.ts already uses for this question)
    // must also confirm it before this returns non-null.
    async resolveAssignableUser(tenantId, assigneeRef) {
      const id = Number(assigneeRef)
      if (!Number.isFinite(id) || id <= 0) return null
      const res = await rpc('res.users', 'search_read', {
        domain: [['id', '=', id], ['active', '=', true], ['share', '=', false]],
        fields: ['id', 'name'],
        limit: 1,
      })
      const row = firstRow(res)
      const resolvedId = row ? asId(row.id) : null
      if (resolvedId === null) return null
      let bound: boolean
      try {
        bound = await verifyStaffBinding(tenantId, resolvedId)
      } catch (err) {
        // Codex review, PR #155: this runs BEFORE any Odoo write. A Prisma/
        // Foundation-database outage here is the dependency being
        // unreachable, not the write being refused -- a plain throw would
        // surface as EXECUTION_FAILED ("Odoo rejected it, do not retry"),
        // which is the wrong advice for a check that never touched Odoo and
        // where retrying is genuinely safe.
        throw new DependencyUnavailable(
          'staff-binding',
          err instanceof Error ? err.message : String(err),
        )
      }
      if (!bound) return null
      return { id: String(resolvedId), name: String(row?.name ?? '') }
    },
  }
}
