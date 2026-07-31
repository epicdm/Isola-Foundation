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
}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

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
          objectType: p.objectType,
          objectId: p.objectId,
          note: str(p.payload.note),
          dueDate: str(p.payload.dueDate),
          ownerRef: str(p.payload.ownerRef) || null,
        }),
      readback: async (externalId, p) => {
        const row = await rec.readFollowup(externalId)
        if (!row) return null
        return matches(row, { note: str(p.payload.note) }) ? row : null
      },
    },
  ]
}

export { DependencyUnavailable }
