/**
 * Concrete Foundation executors.
 *
 * Each one writes to the SYSTEM OF RECORD through an injected port and then
 * reads the record back. Nothing here sends a message, opens a conversation, or
 * touches a provider — a test asserts that. A note is a business fact recorded
 * against a customer; telling anyone about it is Lane 2's job.
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

export function buildExecutors(rec: RecordSystem): readonly ActionExecutor[] {
  return [
    {
      actionType: 'note.create',
      riskLevel: 'low',
      allowedRoles: ['staff', 'manager', 'owner', 'service_account'],
      validate: (p) => {
        const body = str(p.body)
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
      validate: (p) => {
        const title = str(p.title)
        if (!title) return { ok: false, detail: 'title is required' }
        if (title.length > 200) return { ok: false, detail: 'title exceeds 200 characters' }
        if (p.dueDate !== undefined && p.dueDate !== null && !validDate(p.dueDate)) {
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
      validate: (p) => {
        if (!str(p.summary)) return { ok: false, detail: 'summary is required' }
        if (!validDate(p.dueDate)) {
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
  ]
}

export { DependencyUnavailable }
