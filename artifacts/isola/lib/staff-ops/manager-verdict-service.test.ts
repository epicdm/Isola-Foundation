/**
 * manager-verdict-service.test.ts — authorisation and Odoo-truthful verdicts.
 *
 * A manager verdict is the most dangerous tap in the system. It closes an
 * episode, it can move a task to a terminal stage, and the button that carries
 * it is frozen copy that outlives the thing it refers to. So the tests that
 * matter here are the refusals and the truthfulness, not the happy path.
 *
 * Two defects are pinned by name because both shipped in the code this file
 * replaces:
 *
 *   1. EXACT STAGE-NAME MATCHING. `moveTaskToStage` matches a name inside the
 *      task's own project. A global "approved" name does not exist on project
 *      53, so the move silently did nothing while the manager was told the work
 *      was approved — the same shape as
 *      `def-spine-start-reports-started-without-odoo-stage-move-2026-07-29`.
 *   2. RETURN NEVER MOVED. The old condition required `input.approved`, so a
 *      Return recorded feedback and left the board untouched. Nobody noticed
 *      because nothing read the result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  bindings: [] as any[],
  activity: null as any,
  task: null as any,
  taskAfter: undefined as any,
  namedMove: { ok: false, reason: 'stage "X" not found in project 53' } as any,
  conceptMove: { ok: true, detail: { stageId: 88, stageName: 'Done' } } as any,
  complete: { ok: true, detail: { actionFeedback: true } } as any,
  calls: [] as string[],
  audits: [] as any[],
}))

vi.mock('../prisma', () => ({
  prisma: {
    staffBinding: {
      findMany: async ({ where }: any) => h.bindings.filter((b) => b.wa_id === where.wa_id),
      findUnique: async () => null,
    },
    notificationOutbox: { findMany: async () => [] },
    staffWorkAction: { findMany: async () => [], findUnique: async () => null },
  },
}))

vi.mock('../audit', () => ({
  audit: async (a: any) => {
    h.calls.push('audit')
    h.audits.push(a)
  },
}))
vi.mock('../notify', () => ({ enqueueNotification: async () => ({ enqueued: true, id: 'nb-1' }) }))
vi.mock('../engine-bindings', () => ({
  resolveOdooConfigForTenant: async () => ({ url: 'https://odoo.test', db: 'test', apiKey: 'x' }),
}))

vi.mock('./odoo-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./odoo-work')>()
  return {
    ...actual,
    readVerificationActivity: async () => {
      h.calls.push('odoo.readActivity')
      return h.activity
    },
    readWorkRecord: async () => {
      h.calls.push('odoo.readWorkRecord')
      // `taskAfter === undefined` means "unchanged"; set it to model a readback
      // that disagrees with the write, or to null to model a readback failure.
      const seenReads = h.calls.filter((c) => c === 'odoo.readWorkRecord').length
      if (seenReads > 1 && h.taskAfter !== undefined) return h.taskAfter
      return h.task
    },
    moveTaskToStage: async () => {
      h.calls.push('odoo.moveNamed')
      return h.namedMove
    },
    moveTaskToConceptStage: async (_c: any, _r: any, concept: string) => {
      h.calls.push('odoo.moveConcept:' + concept)
      return h.conceptMove
    },
    completeVerificationActivity: async () => {
      h.calls.push('odoo.completeActivity')
      return h.complete
    },
  }
})

import { applyManagerVerdict, resolveInboundManagerTap } from './service'

const WA_PHILLIP = '17672351274'
const WA_HAKEEM = '17673173398'
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79'
const ACTIVITY = 71993
const TASK = 2291

function row(over: Record<string, unknown> = {}) {
  return {
    id: 'sb-phillip',
    tenant_id: TENANT,
    odoo_res_user_id: 5,
    display_name: 'Phillip Alleyne',
    wa_id: WA_PHILLIP,
    role: 'manager',
    active: true,
    manager_odoo_res_user_id: 2,
    ...over,
  }
}

function binding(over: Record<string, unknown> = {}) {
  return {
    id: 'sb-phillip',
    tenantId: TENANT,
    odooResUserId: 5,
    displayName: 'Phillip Alleyne',
    waId: WA_PHILLIP,
    role: 'manager',
    active: true,
    managerOdooResUserId: 2,
    ...over,
  } as any
}

const TASK_RECORD = {
  odooModel: 'project.task' as const,
  odooId: TASK,
  name: 'DW 2068b - Calendar',
  projectId: 53,
  projectName: 'Dragon Windows - Vendor Workboard',
  stageId: 120,
  stageName: 'In Development',
  assigneeUserIds: [8],
  dateDeadline: null,
  writeDate: null,
}

beforeEach(() => {
  h.bindings = [row()]
  h.activity = { activityId: ACTIVITY, resModel: 'project.task', resId: TASK, userId: 5, summary: 'Verify completion' }
  h.task = TASK_RECORD
  h.taskAfter = undefined
  h.namedMove = { ok: false, reason: 'stage "X" not found in project 53' }
  h.conceptMove = { ok: true, detail: { stageId: 88, stageName: 'Done' } }
  h.complete = { ok: true, detail: { actionFeedback: true } }
  h.calls = []
  h.audits = []
  vi.stubEnv('STAFF_APPROVED_STAGE_NAME', '')
  vi.stubEnv('STAFF_RETURN_STAGE_NAME', '')
})

describe('resolveInboundManagerTap — authorisation', () => {
  const base = { waId: WA_PHILLIP, verdict: 'approve' as const, activityId: ACTIVITY, channelTenantId: TENANT }

  it('authorises a real manager on their own open activity, and takes the task FROM the activity', async () => {
    const r = await resolveInboundManagerTap(base)
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable')
    expect(r.binding.odooResUserId).toBe(5)
    // The task id is never supplied by the client — it comes from Odoo.
    expect(r.taskId).toBe(TASK)
  })

  it('authorises Return by the same path', async () => {
    const r = await resolveInboundManagerTap({ ...base, verdict: 'return' })
    expect(r.ok).toBe(true)
  })

  it('refuses an unknown sender WITHOUT reading Odoo at all', async () => {
    h.bindings = []
    const r = await resolveInboundManagerTap({ ...base, waId: '10000000000' })
    expect(r).toMatchObject({ ok: false, refusal: 'identity', why: 'unknown_sender' })
    expect(h.calls).not.toContain('odoo.readActivity')
  })

  it('refuses an inactive binding as its own outcome, not as "unknown"', async () => {
    h.bindings = [row({ active: false })]
    const r = await resolveInboundManagerTap(base)
    expect(r).toMatchObject({ ok: false, refusal: 'identity', why: 'inactive_binding' })
  })

  it('refuses a tap arriving on another tenant’s channel', async () => {
    const r = await resolveInboundManagerTap({ ...base, channelTenantId: 'some-other-tenant' })
    expect(r).toMatchObject({ ok: false, refusal: 'identity', why: 'cross_tenant' })
    expect(h.calls).not.toContain('odoo.readActivity')
  })

  it('refuses a STAFF member — the WhatsApp path is not a softer door than the API', async () => {
    h.bindings = [row({ id: 'sb-hakeem', wa_id: WA_HAKEEM, odoo_res_user_id: 8, role: 'staff', display_name: 'Hakeem' })]
    const r = await resolveInboundManagerTap({ ...base, waId: WA_HAKEEM })
    expect(r).toMatchObject({ ok: false, refusal: 'not_a_manager', why: 'staff' })
    expect(h.calls).not.toContain('odoo.readActivity')
  })

  it('allows an owner to act as verifier', async () => {
    h.bindings = [row({ role: 'owner' })]
    expect((await resolveInboundManagerTap(base)).ok).toBe(true)
  })

  it('refuses a missing activity — and an ALREADY-RESOLVED one, which looks identical', async () => {
    // Odoo's action_feedback removes the mail.activity, so a second tap after a
    // verdict finds nothing. Both must refuse; neither may guess which it was.
    h.activity = null
    const r = await resolveInboundManagerTap(base)
    expect(r).toMatchObject({ ok: false, refusal: 'activity_not_open' })
  })

  it('refuses ANOTHER manager’s activity — a forwarded button is not authority', async () => {
    h.activity = { ...h.activity, userId: 2 }
    const r = await resolveInboundManagerTap(base)
    expect(r).toMatchObject({ ok: false, refusal: 'not_this_manager' })
  })

  it('refuses an activity hanging on something that is not a project task', async () => {
    h.activity = { ...h.activity, resModel: 'res.partner' }
    expect(await resolveInboundManagerTap(base)).toMatchObject({ ok: false, refusal: 'wrong_object' })
    h.activity = { activityId: ACTIVITY, resModel: 'project.task', resId: 0, userId: 5, summary: null }
    expect(await resolveInboundManagerTap(base)).toMatchObject({ ok: false, refusal: 'wrong_object' })
  })
})

describe('applyManagerVerdict — Odoo-truthful outcomes', () => {
  const input = { manager: binding(), activityId: ACTIVITY, approved: true, taskId: TASK }

  it('APPROVE resolves the board’s TERMINAL stage by concept', async () => {
    const r = await applyManagerVerdict(input)
    expect(r.ok).toBe(true)
    expect(h.calls).toContain('odoo.moveConcept:terminal')
    const stage = (r.detail as any).stage
    expect(stage).toMatchObject({ moved: true, via: 'concept', stageName: 'Done' })
  })

  it('RETURN resolves the board’s ACTIVE stage — the old code never moved on Return at all', async () => {
    h.conceptMove = { ok: true, detail: { stageId: 120, stageName: 'In Development' } }
    const r = await applyManagerVerdict({ ...input, approved: false })
    expect(h.calls).toContain('odoo.moveConcept:active')
    expect((r.detail as any).stage).toMatchObject({ moved: true, stageName: 'In Development' })
  })

  it('an explicit configured stage WINS when it exists on this board', async () => {
    h.namedMove = { ok: true, detail: { stageId: 99, stageName: 'Approved' } }
    const r = await applyManagerVerdict({ ...input, approvedStageName: 'Approved' })
    expect((r.detail as any).stage).toMatchObject({ moved: true, via: 'explicit', stageName: 'Approved' })
    expect(h.calls).not.toContain('odoo.moveConcept:terminal')
  })

  it('an explicit configured stage MISS falls back to concept and REPORTS the miss', async () => {
    // The START defect in verdict form. The miss must be visible to an operator,
    // not swallowed, or a wrong STAFF_APPROVED_STAGE_NAME stays invisible forever.
    const r = await applyManagerVerdict({ ...input, approvedStageName: 'Completed' })
    const stage = (r.detail as any).stage
    expect(stage.moved).toBe(true)
    expect(stage.via).toBe('concept')
    expect(String(stage.explicitMiss)).toMatch(/not found in project 53/)
  })

  it('an unclassifiable board reports moved:false with a reason — never a bare success', async () => {
    h.conceptMove = { ok: false, reason: 'no stage matching concept "terminal" in project 53' }
    const r = await applyManagerVerdict(input)
    const stage = (r.detail as any).stage
    expect(stage.moved).toBe(false)
    expect(String(stage.why)).toMatch(/terminal/)
  })

  it('reports the stage Odoo ACTUALLY holds after the write, not the one requested', async () => {
    // A move can report success and still not stick. The reply must be built
    // from the readback, so the readback is what the caller receives.
    h.taskAfter = { ...TASK_RECORD, stageName: 'Under Investigation' }
    const r = await applyManagerVerdict(input)
    const stage = (r.detail as any).stage
    expect(stage.stageNameAfter).toBe('Under Investigation')
    expect(stage.readbackOk).toBe(true)
  })

  it('flags a failed post-write readback instead of asserting the requested stage', async () => {
    h.taskAfter = null
    const r = await applyManagerVerdict(input)
    const stage = (r.detail as any).stage
    expect(stage.readbackOk).toBe(false)
    expect(stage.stageNameAfter).toBeNull()
  })

  it('reports task_not_found rather than claiming a move, when the task is gone', async () => {
    h.task = null
    const r = await applyManagerVerdict(input)
    expect((r.detail as any).stage).toMatchObject({ moved: false, why: 'task_not_found' })
  })

  it('with no task reference it records the verdict and says so — no stage claim', async () => {
    const r = await applyManagerVerdict({ ...input, taskId: null })
    expect((r.detail as any).stage).toMatchObject({ moved: false, why: 'no_task_reference' })
    expect(h.calls).not.toContain('odoo.moveConcept:terminal')
  })

  it('an Odoo write failure fails the whole verdict — nothing downstream reads as success', async () => {
    h.complete = { ok: false, reason: 'odoo unreachable' }
    const r = await applyManagerVerdict(input)
    expect(r.ok).toBe(false)
    expect(h.calls).not.toContain('odoo.moveConcept:terminal')
    expect(h.audits).toHaveLength(0)
  })

  it('writes exactly ONE audit record, naming the verdict', async () => {
    await applyManagerVerdict(input)
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].action).toBe('staff_verification.approved')
    expect(h.audits[0].entity).toBe('mail.activity')
    expect(h.audits[0].entityId).toBe(String(ACTIVITY))

    h.audits = []
    await applyManagerVerdict({ ...input, approved: false })
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0].action).toBe('staff_verification.returned')
  })

  it('closes the activity exactly once per verdict', async () => {
    await applyManagerVerdict(input)
    expect(h.calls.filter((c) => c === 'odoo.completeActivity')).toHaveLength(1)
  })
})
