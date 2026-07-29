/**
 * manager-verification-odoo.test.ts — the Odoo half of Foundation-native
 * manager verification, with the transport replaced by a fake.
 *
 * WHAT THESE TESTS EXIST TO PREVENT, by name:
 *
 *   1. `def-spine-manager-verification-activity-never-created-2026-07-29`.
 *      The create wrote the STRING `res_model`, which is `readonly` and merely
 *      `related` to `res_model_id` on this Odoo. Nothing was ever created. The
 *      create-shape tests below assert `res_model` is absent from the payload
 *      and `res_model_id` is present, so the old shape cannot come back.
 *
 *   2. THE BY-ID EXISTENCE TRAP. Proven live against this Odoo on 2026-07-29:
 *      `project.task.read` for id 99999999 returns `[{"id": 99999999}]`. A
 *      by-id read selecting only `id` therefore reports that every record
 *      exists. `search_read` with an `id =` domain returns `[]`. Both halves
 *      are pinned here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

interface Call {
  model: string
  method: string
  kwargs: Record<string, unknown>
}

const h = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (() => []) as (c: Call) => unknown,
}))

vi.mock('@/engines/odoo', () => ({
  json2Call: async (_config: unknown, model: string, method: string, kwargs: Record<string, unknown>) => {
    const call = { model, method, kwargs }
    h.calls.push(call)
    const out = h.respond(call)
    if (out instanceof Error) throw out
    return out
  },
}))

import {
  __resetOdooResolutionCaches,
  createManagerVerificationActivity,
  findActiveOdooUser,
  findTaskForVerification,
  readVerificationActivity,
  resolveVerificationActivityType,
  resolveVerificationModelId,
} from './odoo-work'

const CONFIG = { url: 'https://epic.odoo.test', apiKey: 'redacted', db: 'epic' }
const MODEL_ID = 727
const TASK = 2588
const TODO_TYPE = 4

/** The real shapes this Odoo returns, transcribed from the 2026-07-29 probe. */
const REAL = {
  irModel: [{ id: MODEL_ID, model: 'project.task', name: 'Task' }],
  task: [
    {
      id: TASK,
      name: 'SL 001 - Staff loop pilot: confirm WhatsApp task flow',
      project_id: [46, 'BFF - EPIC AI Platform'],
      stage_id: [88, 'In-Progress'],
      user_ids: [8],
    },
  ],
  irModelData: [{ id: 18830, res_id: TODO_TYPE }],
  activityType: [{ id: TODO_TYPE, name: 'To-Do', res_model: false }],
  user: [{ id: 5, name: 'Phillip Alleyne', login: 'phillip@epic.dm' }],
}

function router(overrides: Partial<Record<string, unknown>> = {}) {
  return (c: Call): unknown => {
    const key = `${c.model}.${c.method}`
    if (key in overrides) {
      const v = overrides[key]
      return typeof v === 'function' ? (v as (c: Call) => unknown)(c) : v
    }
    if (key === 'ir.model.search_read') return REAL.irModel
    if (key === 'project.task.search_read') return REAL.task
    if (key === 'ir.model.data.search_read') return REAL.irModelData
    if (key === 'mail.activity.type.search_read') return REAL.activityType
    if (key === 'res.users.search_read') return REAL.user
    if (key === 'mail.activity.create') return [71993]
    if (key === 'mail.activity.search_read') {
      return [
        {
          id: 71993,
          summary: 'Verify completion: SL 001',
          user_id: [5, 'Phillip Alleyne'],
          res_model: 'project.task',
          res_model_id: [MODEL_ID, 'Task'],
          res_id: TASK,
          activity_type_id: [TODO_TYPE, 'To-Do'],
        },
      ]
    }
    return []
  }
}

beforeEach(() => {
  h.calls = []
  h.respond = router()
  __resetOdooResolutionCaches()
})

const only = (model: string, method?: string) =>
  h.calls.filter((c) => c.model === model && (method ? c.method === method : true))

describe('resolveVerificationModelId', () => {
  it('resolves project.task to its ir.model id', async () => {
    await expect(resolveVerificationModelId(CONFIG, 'project.task')).resolves.toBe(MODEL_ID)
    expect(only('ir.model', 'search_read')[0].kwargs.domain).toEqual([['model', '=', 'project.task']])
  })

  it('refuses a model outside the allowlist WITHOUT touching Odoo', async () => {
    await expect(resolveVerificationModelId(CONFIG, 'res.partner')).resolves.toBeNull()
    await expect(resolveVerificationModelId(CONFIG, 'mail.activity')).resolves.toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  it('refuses when ir.model returns nothing rather than inventing an id', async () => {
    h.respond = router({ 'ir.model.search_read': [] })
    await expect(resolveVerificationModelId(CONFIG, 'project.task')).resolves.toBeNull()
  })

  it('refuses a row whose model does not match what was asked for', async () => {
    h.respond = router({ 'ir.model.search_read': [{ id: 42, model: 'res.partner' }] })
    await expect(resolveVerificationModelId(CONFIG, 'project.task')).resolves.toBeNull()
  })

  it('caches per database, so one resolution serves later creates', async () => {
    await resolveVerificationModelId(CONFIG, 'project.task')
    await resolveVerificationModelId(CONFIG, 'project.task')
    expect(only('ir.model')).toHaveLength(1)

    await resolveVerificationModelId({ ...CONFIG, db: 'other' }, 'project.task')
    expect(only('ir.model')).toHaveLength(2)
  })
})

describe('findTaskForVerification — the by-id echo trap', () => {
  it('uses a FILTERING search_read, never a by-id read', async () => {
    await findTaskForVerification(CONFIG, TASK)
    const calls = only('project.task')
    expect(calls).toHaveLength(1)
    expect(calls[0].method).toBe('search_read')
    expect(calls[0].kwargs.domain).toEqual([['id', '=', TASK]])
    expect(h.calls.some((c) => c.method === 'read')).toBe(false)
  })

  it('REGRESSION: a nonexistent id is refused even though a by-id read would echo it back', async () => {
    // This is the exact live behaviour: `read` hands back `[{id: 99999999}]`.
    // If the existence check ever regresses to that call, this test fails.
    h.respond = router({
      'project.task.search_read': [],
      'project.task.read': [{ id: 99999999 }],
    })
    await expect(findTaskForVerification(CONFIG, 99999999)).resolves.toBeNull()
    expect(h.calls.some((c) => c.method === 'read')).toBe(false)
  })

  it('refuses a row whose id is not the id requested', async () => {
    h.respond = router({ 'project.task.search_read': [{ id: 9, name: 'other' }] })
    await expect(findTaskForVerification(CONFIG, TASK)).resolves.toBeNull()
  })

  it('refuses a nonsense id without a round trip', async () => {
    await expect(findTaskForVerification(CONFIG, 0)).resolves.toBeNull()
    await expect(findTaskForVerification(CONFIG, -1)).resolves.toBeNull()
    expect(h.calls).toHaveLength(0)
  })

  it('returns the project and assignees a caller needs to validate the target', async () => {
    await expect(findTaskForVerification(CONFIG, TASK)).resolves.toMatchObject({
      taskId: TASK,
      projectId: 46,
      stageName: 'In-Progress',
      assigneeUserIds: [8],
    })
  })

  it('returns null when Odoo is unreachable rather than throwing into the DONE path', async () => {
    h.respond = router({ 'project.task.search_read': new Error('odoo down') })
    await expect(findTaskForVerification(CONFIG, TASK)).resolves.toBeNull()
  })
})

describe('findActiveOdooUser', () => {
  it('puts active = true in the DOMAIN, so an archived manager cannot be resolved', async () => {
    await expect(findActiveOdooUser(CONFIG, 5)).resolves.toMatchObject({ userId: 5, login: 'phillip@epic.dm' })
    expect(only('res.users')[0].kwargs.domain).toEqual([
      ['id', '=', 5],
      ['active', '=', true],
    ])
  })

  it('returns null for a missing or archived user', async () => {
    h.respond = router({ 'res.users.search_read': [] })
    await expect(findActiveOdooUser(CONFIG, 5)).resolves.toBeNull()
  })
})

describe('resolveVerificationActivityType', () => {
  it('prefers the XML id, which is stable across databases', async () => {
    const r = await resolveVerificationActivityType(CONFIG, {
      xmlId: 'mail.mail_activity_data_todo',
      configuredId: 999,
      names: ['To-Do'],
    })
    expect(r).toMatchObject({ activityTypeId: TODO_TYPE, name: 'To-Do', via: 'xml_id' })
    expect(only('ir.model.data')[0].kwargs.domain).toEqual([
      ['module', '=', 'mail'],
      ['name', '=', 'mail_activity_data_todo'],
      ['model', '=', 'mail.activity.type'],
    ])
  })

  it('falls back to a configured id — but VERIFIES it exists first', async () => {
    h.respond = router({
      'ir.model.data.search_read': [],
      'mail.activity.type.search_read': [{ id: 4, name: 'To-Do', res_model: false }],
    })
    const r = await resolveVerificationActivityType(CONFIG, { xmlId: 'mail.missing', configuredId: 4 })
    expect(r).toMatchObject({ activityTypeId: 4, via: 'configured_id' })
  })

  it('refuses a configured id that does not exist rather than creating with it', async () => {
    h.respond = router({ 'ir.model.data.search_read': [], 'mail.activity.type.search_read': [] })
    await expect(
      resolveVerificationActivityType(CONFIG, { xmlId: 'mail.missing', configuredId: 999, names: ['To-Do'] }),
    ).resolves.toBeNull()
  })

  it('falls back to an allowlisted name last', async () => {
    h.respond = router({
      'ir.model.data.search_read': [],
      'mail.activity.type.search_read': [{ id: 4, name: 'To-Do', res_model: false }],
    })
    const r = await resolveVerificationActivityType(CONFIG, { names: ['To-Do', 'To Do'] })
    expect(r).toMatchObject({ activityTypeId: 4, via: 'name' })
  })

  it('refuses a type scoped to another model — Time Off Approval is not a task verification', async () => {
    h.respond = router({
      'ir.model.data.search_read': [{ id: 1, res_id: 11 }],
      'mail.activity.type.search_read': [{ id: 11, name: 'Time Off Approval', res_model: 'hr.leave' }],
    })
    await expect(resolveVerificationActivityType(CONFIG, { xmlId: 'mail.x', names: ['To-Do'] })).resolves.toBeNull()
  })

  it('returns null when nothing resolves — the caller must refuse, not guess', async () => {
    h.respond = router({ 'ir.model.data.search_read': [], 'mail.activity.type.search_read': [] })
    await expect(resolveVerificationActivityType(CONFIG, {})).resolves.toBeNull()
  })
})

describe('createManagerVerificationActivity — the create shape IS the defect', () => {
  const input = {
    resModel: 'project.task' as const,
    resModelId: MODEL_ID,
    resId: TASK,
    activityTypeId: TODO_TYPE,
    managerOdooResUserId: 5,
    summary: 'Verify completion: SL 001',
    note: 'Hakeem reported this DONE.',
    dateDeadline: '2026-07-31',
  }

  it('writes res_model_id and NEVER the readonly text res_model', async () => {
    const r = await createManagerVerificationActivity(CONFIG, input)
    expect(r.ok).toBe(true)

    const create = only('mail.activity', 'create')[0]
    const vals = (create.kwargs.vals_list as Record<string, unknown>[])[0]
    expect(vals).not.toHaveProperty('res_model')
    expect(vals.res_model_id).toBe(MODEL_ID)
    expect(vals.res_id).toBe(TASK)
    expect(vals.user_id).toBe(5)
    expect(vals.activity_type_id).toBe(TODO_TYPE)
    // date_deadline is REQUIRED on mail.activity; never left to a server default.
    expect(vals.date_deadline).toBe('2026-07-31')
  })

  it('reads the record back and returns what Odoo actually holds', async () => {
    const r = await createManagerVerificationActivity(CONFIG, input)
    expect(r.ok && r.activity).toMatchObject({
      activityId: 71993,
      resModel: 'project.task',
      resModelId: MODEL_ID,
      resId: TASK,
      userId: 5,
      activityTypeId: TODO_TYPE,
    })
  })

  it('refuses unresolved ids before any Odoo call', async () => {
    await expect(createManagerVerificationActivity(CONFIG, { ...input, resModelId: 0 })).resolves.toMatchObject({
      ok: false,
      reason: 'res_model_id_unresolved',
    })
    await expect(
      createManagerVerificationActivity(CONFIG, { ...input, activityTypeId: 0 }),
    ).resolves.toMatchObject({ ok: false, reason: 'activity_type_unresolved' })
    await expect(
      createManagerVerificationActivity(CONFIG, { ...input, managerOdooResUserId: 0 }),
    ).resolves.toMatchObject({ ok: false, reason: 'user_id_invalid' })
    expect(h.calls).toHaveLength(0)
  })

  it('refuses a model outside the allowlist', async () => {
    await expect(
      createManagerVerificationActivity(CONFIG, { ...input, resModel: 'mail.activity' as never }),
    ).resolves.toMatchObject({ ok: false, reason: 'model_not_allowlisted' })
    expect(h.calls).toHaveLength(0)
  })

  it('surfaces the Odoo error verbatim — this is how the live defect was found', async () => {
    h.respond = router({
      'mail.activity.create': new Error('Activities have to be linked to records with a not null res_id.'),
    })
    await expect(createManagerVerificationActivity(CONFIG, input)).resolves.toMatchObject({
      ok: false,
      reason: 'Activities have to be linked to records with a not null res_id.',
    })
  })

  it('refuses a create that returns no usable id', async () => {
    h.respond = router({ 'mail.activity.create': [] })
    const r = await createManagerVerificationActivity(CONFIG, input)
    expect(r.ok).toBe(false)
  })

  it('reports a readback failure AND the orphan id, so an unproven record is traceable', async () => {
    h.respond = router({ 'mail.activity.search_read': [] })
    await expect(createManagerVerificationActivity(CONFIG, input)).resolves.toMatchObject({
      ok: false,
      reason: 'activity_readback_failed',
      activityId: 71993,
    })
  })
})

describe('readVerificationActivity carries the link columns the verdict path checks', () => {
  it('selects res_model_id and activity_type_id, not just the mirror field', async () => {
    const a = await readVerificationActivity(CONFIG, 71993)
    expect(a).toMatchObject({ resModel: 'project.task', resModelId: MODEL_ID, resId: TASK, userId: 5 })
    const fields = only('mail.activity', 'search_read')[0].kwargs.fields as string[]
    expect(fields).toContain('res_model_id')
    expect(fields).toContain('activity_type_id')
  })

  it('refuses a nonsense id without a round trip', async () => {
    await expect(readVerificationActivity(CONFIG, 0)).resolves.toBeNull()
    expect(h.calls).toHaveLength(0)
  })
})
