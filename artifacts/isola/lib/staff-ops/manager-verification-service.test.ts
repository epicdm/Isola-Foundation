/**
 * manager-verification-service.test.ts — the orchestration half of
 * Foundation-native manager verification.
 *
 * `def-spine-manager-verification-activity-never-created-2026-07-29` blocked the
 * manager loop: a staff DONE recorded chatter and nothing else, because the
 * `mail.activity` create was refused every single time. Commit 4 behaved
 * correctly and sent no manager notice for a verification that did not exist —
 * which is exactly why the gap surfaced as honest silence rather than Phillip
 * being told about something imaginary.
 *
 * So these tests are about the ORDER and the REFUSALS, not the happy path:
 *
 *   - the operation is claimed in Foundation BEFORE Odoo is touched, and the
 *     claim survives Odoo later unlinking the completed activity;
 *   - every id is resolved from Odoo, and any resolution failure refuses
 *     without creating anything;
 *   - `requested: true` is returned only after the created record has been read
 *     back and matched against what was asked for;
 *   - a refusal never becomes a manager notice.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.STAFF_MANAGER_VERIFICATION_TEMPLATE_APPROVED = 'true'

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79'
const TASK = 2588
const MODEL_ID = 727
const TODO_TYPE = 4
const ACTIVITY = 71993
const CORR = 'sw-ba290d79-task-2588-07k7i61'

const h = vi.hoisted(() => ({
  calls: [] as string[],
  rows: [] as Record<string, unknown>[],
  seq: 0,
  audits: [] as Record<string, unknown>[],
  createInputs: [] as Record<string, unknown>[],
  bindingRows: [] as Record<string, unknown>[],
  managerBindingRow: null as Record<string, unknown> | null,
  claimCollision: null as Record<string, unknown> | null,
  odoo: {
    record: null as Record<string, unknown> | null,
    modelId: 727 as number | null,
    task: null as Record<string, unknown> | null,
    managerUser: { userId: 5, name: 'Phillip Alleyne', login: 'phillip@epic.dm' } as Record<string, unknown> | null,
    activityType: { activityTypeId: 4, name: 'To-Do', via: 'xml_id' } as Record<string, unknown> | null,
    createResult: null as ((i: Record<string, unknown>) => unknown) | null,
    readActivity: null as Record<string, unknown> | null,
  },
}))

vi.mock('../prisma', () => ({
  prisma: {
    consent: { findUnique: async () => ({ status: 'opted_in' }) },
    staffWorkAction: {
      findUnique: async ({ where }: any) => {
        const k = where.tenant_id_idempotency_key
        return (
          h.rows.find((r) => r.tenant_id === k.tenant_id && r.idempotency_key === k.idempotency_key) ?? null
        )
      },
      create: async ({ data }: any) => {
        h.calls.push(`sa.create:${data.action}`)
        if (data.action === 'verify_request' && h.claimCollision) {
          // Model the racer that reached the unique index first. The row it
          // wrote is already there when we come back to look.
          h.rows.push({ id: 'sa-winner', applied_at: null, failure_reason: null, ...data, ...h.claimCollision })
          const e: any = new Error('Unique constraint failed on the fields: (`tenant_id`,`idempotency_key`)')
          e.code = 'P2002'
          throw e
        }
        if (h.rows.some((r) => r.tenant_id === data.tenant_id && r.idempotency_key === data.idempotency_key)) {
          const e: any = new Error('Unique constraint failed')
          e.code = 'P2002'
          throw e
        }
        const row = { id: `sa-${++h.seq}`, applied_at: null, failure_reason: null, ...data }
        h.rows.push(row)
        return row
      },
      update: async ({ where, data }: any) => {
        const row = h.rows.find((r) => r.id === where.id)
        if (row) Object.assign(row, data)
        h.calls.push(data.applied_at ? 'sa.update.applied' : 'sa.update.failure')
        return row ?? { id: where.id }
      },
      findMany: async () => [],
      count: async () => 0,
    },
    staffBinding: {
      findMany: async ({ where }: any) => h.bindingRows.filter((b) => b.wa_id === where.wa_id),
      findUnique: async () => h.managerBindingRow,
    },
    notificationOutbox: { findUnique: async () => null, create: async () => ({ id: 'ob-test' }), findMany: async () => [], update: async () => ({}), count: async () => 0 },
  },
}))

vi.mock('../audit', () => ({
  audit: async (a: any) => {
    h.calls.push(`audit:${a.action}`)
    h.audits.push(a)
  },
}))
vi.mock('../notify', () => ({ enqueueNotification: async () => ({ enqueued: true, id: 'nb-1' }) }))
vi.mock('../engine-bindings', () => ({
  resolveOdooConfigForTenant: async () => ({ url: 'https://epic.odoo.test', db: 'epic', apiKey: 'redacted' }),
}))

vi.mock('./odoo-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./odoo-work')>()
  return {
    ...actual,
    listOpenTasksForUser: async () => [],
    readWorkRecord: async () => {
      h.calls.push('odoo.readWorkRecord')
      return h.odoo.record
    },
    postStaffActionNote: async () => {
      h.calls.push('odoo.chatter')
      return { ok: true as const, detail: { messagePost: [72531] } }
    },
    resolveVerificationModelId: async () => {
      h.calls.push('odoo.resolveModelId')
      return h.odoo.modelId
    },
    findTaskForVerification: async () => {
      h.calls.push('odoo.findTask')
      return h.odoo.task
    },
    findActiveOdooUser: async () => {
      h.calls.push('odoo.findUser')
      return h.odoo.managerUser
    },
    resolveVerificationActivityType: async () => {
      h.calls.push('odoo.activityType')
      return h.odoo.activityType
    },
    createManagerVerificationActivity: async (_c: any, input: any) => {
      h.calls.push('odoo.createActivity')
      h.createInputs.push(input)
      return h.odoo.createResult
        ? h.odoo.createResult(input)
        : {
            ok: true as const,
            activity: {
              activityId: ACTIVITY,
              resModel: 'project.task',
              resModelId: input.resModelId,
              resId: input.resId,
              userId: input.managerOdooResUserId,
              summary: input.summary,
              activityTypeId: input.activityTypeId,
            },
          }
    },
    readVerificationActivity: async () => {
      h.calls.push('odoo.readActivity')
      return h.odoo.readActivity
    },
    moveTaskToStage: async () => ({ ok: true as const, detail: {} }),
    moveTaskToConceptStage: async () => ({ ok: true as const, detail: {} }),
    completeVerificationActivity: async () => ({ ok: true as const, detail: {} }),
  }
})

import { applyStaffAction, resolveInboundManagerTap } from './service'
import type { StaffBindingRow } from './inbound-routing'



const HAKEEM: StaffBindingRow = {
  id: 'sb-hakeem',
  tenantId: TENANT,
  odooResUserId: 8,
  displayName: 'Hakeem Dalrymple',
  waId: '17673173398',
  role: 'staff',
  active: true,
  managerOdooResUserId: 5,
}

const ERIC: StaffBindingRow = { ...HAKEEM, id: 'sb-eric', odooResUserId: 2, displayName: 'Eric Giraud', waId: '17672958382', role: 'owner', managerOdooResUserId: null }

const RECORD = {
  odooModel: 'project.task' as const,
  odooId: TASK,
  name: 'SL 001 - Staff loop pilot',
  projectId: 46,
  projectName: 'BFF - EPIC AI Platform',
  stageId: 88,
  stageName: 'In-Progress',
  assigneeUserIds: [8],
  dateDeadline: null,
  writeDate: null,
}

const TASK_CONTEXT = {
  taskId: TASK,
  name: 'SL 001 - Staff loop pilot',
  projectId: 46,
  projectName: 'BFF - EPIC AI Platform',
  stageName: 'In-Progress',
  assigneeUserIds: [8],
}

const MANAGER_ROW = {
  id: 'sb-phillip',
  tenant_id: TENANT,
  odoo_res_user_id: 5,
  display_name: 'Phillip Alleyne',
  wa_id: '17672351274',
  role: 'manager',
  active: true,
  manager_odoo_res_user_id: 2,
}

const doneAction = {
  action: 'done' as const,
  workRefModel: 'project.task' as const,
  workRefId: TASK,
  correlationId: CORR,
}

function verifyRows() {
  return h.rows.filter((r) => r.action === 'verify_request')
}

async function done(providerMessageId: string, binding: StaffBindingRow = HAKEEM) {
  const r = await applyStaffAction({ ...doneAction, binding, providerMessageId })
  return r as { ok: true; deduped: false; odooResult: Record<string, any> }
}

beforeEach(() => {
  h.calls = []
  h.rows = []
  h.seq = 0
  h.audits = []
  h.createInputs = []
  h.claimCollision = null
  h.managerBindingRow = MANAGER_ROW
  h.bindingRows = [MANAGER_ROW]
  h.odoo.record = RECORD
  h.odoo.modelId = MODEL_ID
  h.odoo.task = TASK_CONTEXT
  h.odoo.managerUser = { userId: 5, name: 'Phillip Alleyne', login: 'phillip@epic.dm' }
  h.odoo.activityType = { activityTypeId: TODO_TYPE, name: 'To-Do', via: 'xml_id' }
  h.odoo.createResult = null
  h.odoo.readActivity = null
  vi.clearAllMocks()
})

describe('a staff DONE creates exactly one proven manager-verification activity', () => {
  it('reports requested:true with the created activity id', async () => {
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({
      requested: true,
      activityId: ACTIVITY,
      resModelId: MODEL_ID,
      resId: TASK,
      managerOdooResUserId: 5,
      activityTypeId: TODO_TYPE,
    })
  })

  it('creates the activity against the resolved model id, the right task, manager and type', async () => {
    await done('wamid.d1')
    expect(h.createInputs).toHaveLength(1)
    expect(h.createInputs[0]).toMatchObject({
      resModel: 'project.task',
      resModelId: MODEL_ID,
      resId: TASK,
      managerOdooResUserId: 5,
      activityTypeId: TODO_TYPE,
    })
    expect(h.createInputs[0].dateDeadline).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('claims the operation in Foundation BEFORE anything is created in Odoo', async () => {
    await done('wamid.d1')
    expect(h.calls.indexOf('sa.create:verify_request')).toBeGreaterThan(-1)
    expect(h.calls.indexOf('sa.create:verify_request')).toBeLessThan(h.calls.indexOf('odoo.createActivity'))
  })

  it('stores the activity id against the verification episode, and survives Odoo unlinking it', async () => {
    const r = await done('wamid.d1')
    const rows = verifyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].applied_at).toBeInstanceOf(Date)
    expect((rows[0].odoo_result as any).activity.activityId).toBe(ACTIVITY)
    // The episode id is the DONE action row — the claim is not derived from the
    // Odoo activity, which `action_feedback` deletes when the manager answers.
    expect((rows[0].odoo_result as any).request.episodeId).toBe(r.odooResult.verification.episodeId)
    expect(String(rows[0].idempotency_key)).toContain('manager_verification_request')
  })

  it('audits the request against the Odoo activity', async () => {
    await done('wamid.d1')
    const a = h.audits.find((x) => x.action === 'staff_verification.requested')
    expect(a).toMatchObject({ tenantId: TENANT, entity: 'mail.activity', entityId: String(ACTIVITY) })
  })

  it('a fresh verification episode gets a NEW operation id and may create again', async () => {
    await done('wamid.d1')
    await done('wamid.d2')
    const rows = verifyRows()
    expect(rows).toHaveLength(2)
    expect(rows[0].idempotency_key).not.toBe(rows[1].idempotency_key)
    expect(h.createInputs).toHaveLength(2)
  })
})

describe('deduplication is durable and lives in Foundation', () => {
  it('a retry of the SAME operation returns the existing activity and creates nothing', async () => {
    h.claimCollision = {
      applied_at: new Date('2026-07-29T15:27:00Z'),
      failure_reason: null,
      odoo_result: { activity: { activityId: ACTIVITY } },
    }
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: true, deduped: true, activityId: ACTIVITY })
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('a concurrent racer that has not finished yet creates NO second activity', async () => {
    h.claimCollision = { applied_at: null, failure_reason: null }
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: false, why: 'verification_in_flight' })
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('a claim that failed BEFORE creation is safely retried on the same row', async () => {
    h.claimCollision = { applied_at: null, failure_reason: 'activity_type_not_resolvable' }
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: true, activityId: ACTIVITY })
    expect(h.calls).toContain('odoo.createActivity')
  })

  it('the same operation id carrying CONFLICTING data is refused, never overwritten', async () => {
    h.claimCollision = { applied_at: null, failure_reason: null, work_ref_id: 9999 }
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: false, why: 'operation_id_conflict' })
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('a completed claim with no activity id is a conflict, not a silent success', async () => {
    h.claimCollision = { applied_at: new Date(), failure_reason: null, odoo_result: {} }
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: false, why: 'operation_id_conflict' })
  })

  it('a duplicate DONE is stopped upstream by the action idempotency key', async () => {
    await done('wamid.d1')
    const second = await applyStaffAction({ ...doneAction, binding: HAKEEM, providerMessageId: 'wamid.d1' })
    expect(second.ok && second.deduped).toBe(true)
    expect(verifyRows()).toHaveLength(1)
    expect(h.createInputs).toHaveLength(1)
  })
})

describe('every resolution failure refuses without creating anything', () => {
  const expectRefusal = async (why: string) => {
    const r = await done('wamid.d1')
    expect(r.odooResult.verification).toMatchObject({ requested: false, why })
    // A refusal must never be readable as a verification, so the notice path
    // (which requires requested && activityId) can never fire on it.
    expect(r.odooResult.verification.activityId).toBeUndefined()
    return r
  }

  it('no manager on the binding: refuses before any claim or Odoo call', async () => {
    // ERIC is the assignee here on purpose. The refusal under test is the
    // missing manager, and an assignment check upstream of it would mask that.
    h.odoo.record = { ...RECORD, assigneeUserIds: [2] }
    h.odoo.task = { ...TASK_CONTEXT, assigneeUserIds: [2] }
    const r = await applyStaffAction({ ...doneAction, binding: ERIC, providerMessageId: 'wamid.d1' })
    expect((r as any).odooResult.verification).toEqual({ requested: false, why: 'staff_member_has_no_manager' })
    expect(verifyRows()).toHaveLength(0)
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('res_model_id unresolvable', async () => {
    h.odoo.modelId = null
    await expectRefusal('model_not_resolvable_in_odoo')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('the target task does not exist', async () => {
    h.odoo.task = null
    await expectRefusal('task_not_found')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('the task found is not the WorkRef this DONE is about', async () => {
    h.odoo.task = { ...TASK_CONTEXT, projectId: 53 }
    await expectRefusal('task_is_not_the_current_work_ref')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('the task is not assigned to the staff member reporting it done', async () => {
    h.odoo.task = { ...TASK_CONTEXT, assigneeUserIds: [10] }
    await expectRefusal('task_not_assigned_to_staff_member')
  })

  it('the manager has no active binding in THIS tenant — a cross-tenant user id cannot be assigned', async () => {
    h.managerBindingRow = null
    await expectRefusal('manager_not_bound_in_this_tenant')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('the manager binding exists but is deactivated', async () => {
    h.managerBindingRow = { ...MANAGER_ROW, active: false }
    await expectRefusal('manager_not_bound_in_this_tenant')
  })

  it('the manager is archived in Odoo', async () => {
    h.odoo.managerUser = null
    await expectRefusal('manager_not_active_in_odoo')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('no activity type resolves — never create with a guessed type', async () => {
    h.odoo.activityType = null
    await expectRefusal('activity_type_not_resolvable')
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('the Odoo create fails — the live error is carried through verbatim', async () => {
    h.odoo.createResult = () => ({
      ok: false,
      reason: 'Activities have to be linked to records with a not null res_id.',
    })
    const r = await expectRefusal('activity_create_failed')
    expect(JSON.stringify(r.odooResult.verification.detail)).toContain('not null res_id')
  })

  it('the readback fails — no notice, and the orphan id is recorded', async () => {
    h.odoo.createResult = () => ({ ok: false, reason: 'activity_readback_failed', activityId: ACTIVITY })
    const r = await expectRefusal('activity_readback_failed')
    expect(r.odooResult.verification.detail).toMatchObject({ orphanActivityId: ACTIVITY })
  })

  it('the readback DISAGREES with what was asked for', async () => {
    h.odoo.createResult = (i: any) => ({
      ok: true,
      activity: {
        activityId: ACTIVITY,
        resModel: 'project.task',
        resModelId: i.resModelId,
        resId: 9999,
        userId: i.managerOdooResUserId,
        summary: i.summary,
        activityTypeId: i.activityTypeId,
      },
    })
    const r = await expectRefusal('activity_readback_mismatch')
    expect(JSON.stringify(r.odooResult.verification.detail)).toContain('res_id')
  })

  it('records the refusal on the claim row and in the audit trail', async () => {
    h.odoo.activityType = null
    await done('wamid.d1')
    const rows = verifyRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].applied_at).toBeNull()
    expect(rows[0].failure_reason).toBe('activity_type_not_resolvable')
    expect(h.audits.some((a) => a.action === 'staff_verification.refused')).toBe(true)
  })

  it('a failed verification never fails the DONE itself — the chatter note is a true fact', async () => {
    h.odoo.activityType = null
    const r = await done('wamid.d1')
    expect(r.ok).toBe(true)
    expect(r.odooResult.chatter).toBeDefined()
  })
})

describe('the created activity is exactly what the existing verdict path requires', () => {
  it('resolveInboundManagerTap accepts it and derives the task from the activity', async () => {
    await done('wamid.d1')
    const created = (verifyRows()[0].odoo_result as any).activity
    h.odoo.readActivity = {
      activityId: created.activityId,
      resModel: created.resModel,
      resModelId: created.resModelId,
      resId: created.resId,
      userId: created.userId,
      summary: 'Verify completion: SL 001 - Staff loop pilot',
      activityTypeId: created.activityTypeId,
    }

    const r = await resolveInboundManagerTap({
      waId: '17672351274',
      verdict: 'approve',
      activityId: created.activityId,
      channelTenantId: TENANT,
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.taskId).toBe(TASK)
      expect(r.binding.odooResUserId).toBe(5)
    }
  })
})

describe('existing behaviour is unchanged', () => {
  it('an ACK never raises a verification', async () => {
    const r = await applyStaffAction({
      ...doneAction,
      action: 'ack',
      binding: HAKEEM,
      providerMessageId: 'wamid.a1',
    })
    expect((r as any).odooResult.verification).toBeUndefined()
    expect(verifyRows()).toHaveLength(0)
    expect(h.calls).not.toContain('odoo.createActivity')
  })

  it('a START never raises a verification', async () => {
    const r = await applyStaffAction({
      ...doneAction,
      action: 'start',
      binding: HAKEEM,
      providerMessageId: 'wamid.s1',
    })
    expect((r as any).odooResult.verification).toBeUndefined()
    expect(h.calls).not.toContain('odoo.createActivity')
  })
})

describe('the capability is Foundation-native', () => {
  it('no BFF-v2 activity route is referenced anywhere in the verification path', () => {
    // `dec-foundation-native-manager-verification-activity-2026-07-29` forbids a
    // new dependency on the transitional BFF-v2 `create_activity` route. BFF-v2
    // is retirement-bound; moving Spine authority back into it is the one
    // architectural mistake this slice must not make.
    const here = dirname(fileURLToPath(import.meta.url))
    for (const f of ['manager-verification.ts', 'odoo-work.ts', 'service.ts']) {
      const src = readFileSync(join(here, f), 'utf8')
      expect(src).not.toMatch(/create_activity/)
      expect(src).not.toMatch(/bff\.epic\.dm/)
      expect(src).not.toMatch(/BFF_V2|bffV2Fetch/)
    }
  })
})
