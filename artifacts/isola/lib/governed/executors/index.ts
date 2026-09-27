/**
 * Concrete Foundation executors.
 *
 * Each one writes a BUSINESS FACT to the system of record through an injected
 * port and then reads that record back. Nothing in this file sends a message,
 * opens a conversation, picks a channel or touches a provider — a test asserts
 * it. A note is a fact recorded against a customer; telling anyone about it is
 * Lane 2's job. `followup.schedule` records the INTENTION to follow up; it does
 * not deliver the follow-up.
 */

import { DependencyUnavailable, type ActionExecutor, type ActionProposal } from '../action'

/** The business system of record (Odoo today). Injected so tests need no network. */
export interface RecordSystem {
  createNote(input: {
    companyId: string
    objectType: string
    objectId: string
    body: string
    authorPrincipalId: string
  }): Promise<{ externalId: string }>
  readNote(externalId: string): Promise<Record<string, unknown> | null>

  createTask(input: {
    companyId: string
    objectType: string
    objectId: string
    title: string
    assigneeRef?: string | null
    dueDate?: string | null
  }): Promise<{ externalId: string }>
  readTask(externalId: string): Promise<Record<string, unknown> | null>

  scheduleActivity(input: {
    companyId: string
    objectType: string
    objectId: string
    summary: string
    dueDate: string
    assigneeRef?: string | null
  }): Promise<{ externalId: string }>
  readActivity(externalId: string): Promise<Record<string, unknown> | null>

  createLead(input: {
    companyId: string
    name: string
    contactRef?: string | null
    source?: string | null
  }): Promise<{ externalId: string }>
  readLead(externalId: string): Promise<Record<string, unknown> | null>

  updateLead(input: {
    companyId: string
    leadId: string
    fields: Record<string, string>
  }): Promise<{ externalId: string }>

  scheduleFollowup(input: {
    companyId: string
    objectType: string
    objectId: string
    note: string
    dueDate: string
    ownerRef?: string | null
  }): Promise<{ externalId: string }>
  readFollowup(externalId: string): Promise<Record<string, unknown> | null>

  /**
   * Resolves an assignee target -- real, active, internal (never a
   * portal/customer login), AND bound to `tenantId` as staff (Codex review,
   * PR #155: an Odoo instance can be shared across tenants/companies, so
   * "active internal user in this Odoo" alone does not prove the user
   * belongs to the ACTING tenant -- a manager could otherwise assign a
   * follow-up to a different tenant's staff member who happens to be
   * visible in the same res.users table). Returns null on any failure to
   * confirm all three. Used by followup.scheduleAssigned before any write.
   */
  resolveAssignableUser(tenantId: string, assigneeRef: string): Promise<{ id: string; name: string } | null>
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

// Codex review, PR #155: runCustomerAction() (the only production caller,
// lib/governed/customer-actions.ts) hardcodes every proposal's objectType to
// the generic Foundation vocabulary word 'customer' -- never a real Odoo
// model name. activityVals()'s ir.model lookup (odoo-record-system.ts) needs
// the concrete model. This is the ONE translation this module owns; unknown
// object types pass through unchanged (never guessed) rather than silently
// mis-resolving to a model nobody asked for.
//
// NOTE, flagged separately, not fixed here: createNote/createTask/
// scheduleActivity share the identical p.objectType passthrough and would
// hit the same gap for the 'customer' case -- out of scope for this PR
// (assignment, not a sweep of every executor's object-type handling), and
// reported to Lane A as its own finding.
const OBJECT_TYPE_TO_ODOO_MODEL: Readonly<Record<string, string>> = {
  customer: 'res.partner',
}
function toOdooModel(objectType: string): string {
  return OBJECT_TYPE_TO_ODOO_MODEL[objectType] ?? objectType
}

/** ISO date, date-only or full timestamp. Rejects anything unparseable. */
function validDate(v: unknown): boolean {
  const s = str(v)
  if (!s) return false
  return !Number.isNaN(new Date(s).getTime())
}

/**
 * Readback is only proof if it MATCHES. A record that came back with different
 * content is a different failure from no record at all, and both are failures.
 */
function matches(readback: Record<string, unknown>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([k, v]) => str(readback[k]) === v)
}

/**
 * A many2one field arrives as `[id, "Name"]` or `false` -- `matches()`'s plain
 * string comparison can never match it (str() on an array is ''). This checks
 * the id component specifically, for the one field `matches()` cannot cover.
 */
function m2oIdMatches(value: unknown, expectedId: string): boolean {
  return Array.isArray(value) && typeof value[0] === 'number' && String(value[0]) === expectedId
}

/** The fields `lead.update` is permitted to change. Anything else is ignored. */
const LEAD_UPDATABLE = ['stage', 'name', 'ownerRef', 'expectedRevenue'] as const

const LEAD_STAGES = ['new', 'qualified', 'proposition', 'won', 'lost'] as const

function leadUpdateFields(payload: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of LEAD_UPDATABLE) {
    const v = str(payload[k])
    if (v) out[k] = v
  }
  return out
}

export function buildExecutors(rec: RecordSystem): readonly ActionExecutor[] {
  return [
    {
      actionType: 'note.create',
      riskLevel: 'low',
      allowedRoles: ['staff', 'manager', 'owner', 'service_account'],
      validate: (payload) => {
        const body = str(payload.body)
        if (!body) return { ok: false, detail: 'body is required' }
        if (body.length > 5000) return { ok: false, detail: 'body exceeds 5000 characters' }
        return { ok: true }
      },
      execute: async (p: ActionProposal) =>
        rec.createNote({
          companyId: p.companyId,
          objectType: p.objectType,
          objectId: p.objectId,
          body: str(p.payload.body),
          authorPrincipalId: p.actorPrincipalId,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readNote(externalId)
        if (!row) return null
        return matches(row, { body: str(p.payload.body) }) ? row : null
      },
    },

    {
      actionType: 'task.create',
      riskLevel: 'medium',
      allowedRoles: ['staff', 'manager', 'owner'],
      validate: (payload) => {
        const title = str(payload.title)
        if (!title) return { ok: false, detail: 'title is required' }
        if (title.length > 200) return { ok: false, detail: 'title exceeds 200 characters' }
        if (payload.dueDate !== undefined && payload.dueDate !== null && !validDate(payload.dueDate)) {
          return { ok: false, detail: 'dueDate is not a valid date' }
        }
        return { ok: true }
      },
      execute: async (p) =>
        rec.createTask({
          companyId: p.companyId,
          objectType: p.objectType,
          objectId: p.objectId,
          title: str(p.payload.title),
          assigneeRef: str(p.payload.assigneeRef) || null,
          dueDate: str(p.payload.dueDate) || null,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readTask(externalId)
        if (!row) return null
        return matches(row, { title: str(p.payload.title) }) ? row : null
      },
    },

    {
      actionType: 'activity.schedule',
      riskLevel: 'medium',
      allowedRoles: ['staff', 'manager', 'owner'],
      validate: (payload) => {
        if (!str(payload.summary)) return { ok: false, detail: 'summary is required' }
        if (!validDate(payload.dueDate)) {
          return { ok: false, detail: 'dueDate is required and must be a date' }
        }
        return { ok: true }
      },
      execute: async (p) =>
        rec.scheduleActivity({
          companyId: p.companyId,
          objectType: p.objectType,
          objectId: p.objectId,
          summary: str(p.payload.summary),
          dueDate: str(p.payload.dueDate),
          assigneeRef: str(p.payload.assigneeRef) || null,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readActivity(externalId)
        if (!row) return null
        return matches(row, { summary: str(p.payload.summary) }) ? row : null
      },
    },

    {
      actionType: 'lead.create',
      riskLevel: 'medium',
      allowedRoles: ['staff', 'manager', 'owner'],
      validate: (payload) => {
        const name = str(payload.name)
        if (!name) return { ok: false, detail: 'name is required' }
        if (name.length > 120) return { ok: false, detail: 'name exceeds 120 characters' }
        const stage = str(payload.stage)
        if (stage && !(LEAD_STAGES as readonly string[]).includes(stage)) {
          return { ok: false, detail: `stage must be one of ${LEAD_STAGES.join(', ')}` }
        }
        return { ok: true }
      },
      execute: async (p) =>
        rec.createLead({
          companyId: p.companyId,
          name: str(p.payload.name),
          contactRef: str(p.payload.contactRef) || null,
          source: str(p.payload.source) || null,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readLead(externalId)
        if (!row) return null
        return matches(row, { name: str(p.payload.name) }) ? row : null
      },
    },

    {
      actionType: 'lead.update',
      riskLevel: 'medium',
      allowedRoles: ['manager', 'owner'],
      validate: (payload) => {
        const fields = leadUpdateFields(payload)
        if (Object.keys(fields).length === 0) {
          return {
            ok: false,
            detail: `at least one field to update is required (${LEAD_UPDATABLE.join(', ')})`,
          }
        }
        if (fields.stage && !(LEAD_STAGES as readonly string[]).includes(fields.stage)) {
          return { ok: false, detail: `stage must be one of ${LEAD_STAGES.join(', ')}` }
        }
        return { ok: true }
      },
      execute: async (p) =>
        rec.updateLead({
          companyId: p.companyId,
          leadId: p.objectId,
          fields: leadUpdateFields(p.payload),
        }),
      readback: async (externalId, p) => {
        const row = await rec.readLead(externalId)
        if (!row) return null
        // Every field we asked to change must come back changed. A partial write
        // that reports success is the exact failure this whole module exists to
        // prevent.
        return matches(row, leadUpdateFields(p.payload)) ? row : null
      },
    },

    {
      actionType: 'followup.schedule',
      riskLevel: 'low',
      allowedRoles: ['staff', 'manager', 'owner'],
      validate: (payload) => {
        const note = str(payload.note)
        if (!note) return { ok: false, detail: 'note is required' }
        if (note.length > 2000) return { ok: false, detail: 'note exceeds 2000 characters' }
        if (!validDate(payload.dueDate)) {
          return { ok: false, detail: 'dueDate is required and must be a date' }
        }
        return { ok: true }
      },
      execute: async (p) =>
        rec.scheduleFollowup({
          companyId: p.companyId,
          objectType: toOdooModel(p.objectType),
          objectId: p.objectId,
          note: str(p.payload.note),
          dueDate: str(p.payload.dueDate),
          ownerRef: str(p.payload.ownerRef) || null,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readFollowup(externalId)
        if (!row) return null
        if (!matches(row, { note: str(p.payload.note) })) return null
        // ev-isola-360-followup-assignment-2026-09-27: readback previously
        // asserted the note only, never the assignee -- a write that reported
        // success but landed on the wrong (or no) user_id was invisible here.
        // ownerRef unset is not a claim about who it's assigned to, so no
        // check runs; ownerRef set is a claim, and it must be confirmed the
        // same way `note` already is.
        const expectedOwnerRef = str(p.payload.ownerRef)
        if (expectedOwnerRef && !m2oIdMatches(row.user_id, expectedOwnerRef)) return null
        return row
      },
    },

    /**
     * followup.scheduleAssigned — ev-isola-360-followup-assignment-2026-09-27.
     * A DELIBERATE SIBLING of followup.schedule, not a variant of it: the
     * Lumen-facing action (`foundation_actions.schedule_customer_followup`)
     * is confirmed narrow by design (note + dueDate only), and "assign to a
     * person" is a materially different, higher-trust act reviewed on its own
     * terms here, per the owner's ruling that assignment needs its own
     * tenant/role gate rather than an optional field on the existing action.
     *
     * assigneeRef is REQUIRED (an optional one would just be followup.schedule
     * again). allowedRoles is intentionally narrower than followup.schedule's
     * (manager/owner only) -- a design choice stated here, not derived from an
     * existing rule, matching the same default already applied to the
     * isola-360 panel's create-followup route for consistency between the
     * two doors into the same underlying write.
     */
    {
      actionType: 'followup.scheduleAssigned',
      riskLevel: 'low',
      allowedRoles: ['manager', 'owner'],
      validate: (payload) => {
        const note = str(payload.note)
        if (!note) return { ok: false, detail: 'note is required' }
        if (note.length > 2000) return { ok: false, detail: 'note exceeds 2000 characters' }
        if (!validDate(payload.dueDate)) {
          return { ok: false, detail: 'dueDate is required and must be a date' }
        }
        // Presence only, matching this catalogue's own convention for
        // 'reference' fields (ownerRef on lead.update/followup.schedule is
        // never format-checked here either) -- catalogue.test.ts's generic
        // payload builder fills 'reference' fields with `example ${name}`,
        // not a number. The strict positive-integer shape check, and whether
        // it resolves to a REAL, active, internal, tenant-bound user, are
        // both Odoo/Foundation lookups validate() cannot perform (it is
        // synchronous by contract) -- both run in execute(), and a
        // non-numeric or non-existent id is refused there as
        // EXECUTION_FAILED rather than VALIDATION_FAILED.
        if (!str(payload.assigneeRef)) {
          return { ok: false, detail: 'assigneeRef is required' }
        }
        return { ok: true }
      },
      execute: async (p) => {
        const assigneeRef = str(p.payload.assigneeRef)
        const resolved = await rec.resolveAssignableUser(p.companyId, assigneeRef)
        if (!resolved) {
          throw new Error(
            'assigneeRef does not match a real, active, internal user bound to this tenant; the follow-up was not created',
          )
        }
        return rec.scheduleFollowup({
          companyId: p.companyId,
          objectType: toOdooModel(p.objectType),
          objectId: p.objectId,
          note: str(p.payload.note),
          dueDate: str(p.payload.dueDate),
          ownerRef: resolved.id,
        })
      },
      readback: async (externalId, p) => {
        const row = await rec.readFollowup(externalId)
        if (!row) return null
        if (!matches(row, { note: str(p.payload.note) })) return null
        // Assignment is the entire point of this action -- unlike
        // followup.schedule, where ownerRef is optional, here a readback that
        // does not confirm the assignee is a failure, not a pass.
        const assigneeRef = str(p.payload.assigneeRef)
        if (!m2oIdMatches(row.user_id, assigneeRef)) return null
        return row
      },
    },
  ]
}

export { DependencyUnavailable }
