/**
 * service.orchestration.test.ts — deterministic tests for the ORDER of
 * operations in applyStaffAction, with Prisma and Odoo replaced by fakes.
 *
 * The pure cores are already covered. What is untested until here is the thing
 * that actually bit this packet before: a handler that runs, produces output,
 * and leaves a record reading stronger than what happened. So these tests
 * assert sequencing and failure semantics, not return values alone:
 *
 *   - the idempotency key is claimed BEFORE Odoo is touched, so a concurrent
 *     retry loses the race instead of double-writing;
 *   - `applied_at` is stamped ONLY after Odoo accepted;
 *   - every failure path leaves `applied_at` NULL and records a reason;
 *   - an unauthorised actor never reaches the write at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Fakes ─────────────────────────────────────────────────────────────────

const h = vi.hoisted(() => {
  const calls: string[] = []
  const rows = new Map<string, { id: string; applied_at: Date | null }>()
  const odoo = {
    record: null as any,
    chatterOk: true,
    chatterReason: 'odoo unreachable',
    verificationOk: true,
    stageMoveResult: { ok: true as const, detail: { stageId: 42 } } as any,
  }
  return { calls, rows, odoo }
})

const { calls, rows: staffWorkActionRows, odoo: odooState } = h

vi.mock('../prisma', () => ({
  prisma: {
    staffWorkAction: {
      findUnique: async ({ where }: any) => {
        h.calls.push('sa.findUnique')
        return h.rows.get(where.tenant_id_idempotency_key.idempotency_key) ?? null
      },
      create: async ({ data }: any) => {
        h.calls.push('sa.create')
        const row = { id: `sa-${h.rows.size + 1}`, applied_at: null }
        h.rows.set(data.idempotency_key, row)
        return row
      },
      update: async ({ where, data }: any) => {
        h.calls.push(data.applied_at ? 'sa.update.applied' : 'sa.update.failure')
        for (const row of h.rows.values()) {
          if (row.id === where.id && data.applied_at) row.applied_at = data.applied_at
        }
        return { id: where.id }
      },
      count: async () => 0,
    },
    notificationOutbox: { findMany: async () => [], update: async () => ({}), count: async () => 0 },
    staffBinding: { findMany: async () => [], findUnique: async () => null },
  },
}))

vi.mock('../audit', () => ({ audit: async () => { h.calls.push('audit') } }))
vi.mock('../notify', () => ({ enqueueNotification: async () => ({ enqueued: true, id: 'nb-1' }) }))
vi.mock('../engine-bindings', () => ({
  resolveOdooConfigForTenant: async () => ({ url: 'https://odoo.test', db: 'test', apiKey: 'x' }),
}))

vi.mock('./odoo-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./odoo-work')>()
  return {
    ...actual,
    listOpenTasksForUser: async () => [],
    readWorkRecord: async () => {
      h.calls.push('odoo.read')
      return h.odoo.record
    },
    postStaffActionNote: async () => {
      h.calls.push('odoo.chatter')
      return h.odoo.chatterOk
        ? { ok: true as const, detail: { messagePost: true } }
        : { ok: false as const, reason: h.odoo.chatterReason }
    },
    requestManagerVerification: async () => {
      h.calls.push('odoo.verification')
      return h.odoo.verificationOk
        ? { ok: true as const, detail: { activityId: 99 }, activityId: 99 }
        : { ok: false as const, reason: 'activity create failed' }
    },
    moveTaskToStage: async () => {
      h.calls.push('odoo.stageMove')
      return h.odoo.stageMoveResult
    },
  }
})

import { applyStaffAction } from './service'
import type { StaffBindingRow } from './inbound-routing'

const ERIC: StaffBindingRow = {
  id: 'sb-epic-dev-2',
  tenantId: 'epic-dev-pilot',
  odooResUserId: 2,
  displayName: 'Eric Giraud',
  waId: '17672958382',
  role: 'owner',
  active: true,
  managerOdooResUserId: null,
}

const KIM: StaffBindingRow = { ...ERIC, id: 'sb-epic-dev-6', odooResUserId: 6, displayName: 'Kimberly Alleyne', waId: '17676126416', role: 'staff', managerOdooResUserId: 2 }

function taskAssignedTo(userIds: number[]) {
  return {
    odooModel: 'project.task' as const,
    odooId: 2292,
    name: 'DW 2068c - WhatsApp: confirm pricing',
    projectId: 53,
    projectName: 'Dragon Windows - Vendor Workboard',
    stageId: 120,
    stageName: 'In Development',
    assigneeUserIds: userIds,
    dateDeadline: null,
    writeDate: null,
  }
}

const baseAction = {
  action: 'ack' as const,
  workRefModel: 'project.task' as const,
  workRefId: 2292,
  correlationId: 'sw-epic-task-2292-aaaa',
}

beforeEach(() => {
  calls.length = 0
  staffWorkActionRows.clear()
  odooState.record = taskAssignedTo([2])
  odooState.chatterOk = true
  odooState.verificationOk = true
  odooState.stageMoveResult = { ok: true, detail: { stageId: 42 } }
  delete process.env.STAFF_START_STAGE_NAME
  vi.clearAllMocks()
})

describe('applyStaffAction — sequencing', () => {
  it('claims the idempotency key BEFORE touching Odoo', async () => {
    const r = await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(r.ok).toBe(true)

    // If Odoo were read or written before the claim, a concurrent retry could
    // double-write to the system of record before either run had a row.
    expect(calls.indexOf('sa.create')).toBeLessThan(calls.indexOf('odoo.read'))
    expect(calls.indexOf('sa.create')).toBeLessThan(calls.indexOf('odoo.chatter'))
  })

  it('stamps applied_at only AFTER Odoo accepted the write', async () => {
    await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(calls.indexOf('odoo.chatter')).toBeLessThan(calls.indexOf('sa.update.applied'))
  })
})

describe('applyStaffAction — idempotency', () => {
  it('a webhook retry of the same inbound is deduped and never re-writes Odoo', async () => {
    const first = await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(first.ok && first.deduped).toBe(false)

    calls.length = 0
    const second = await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.deduped).toBe(true)
    expect(calls).not.toContain('odoo.chatter')
    expect(calls).not.toContain('odoo.read')
  })

  it('two genuinely different UPDATEs on the same task both apply', async () => {
    const a = await applyStaffAction({ ...baseAction, action: 'update', note: 'on site now', binding: ERIC })
    const b = await applyStaffAction({ ...baseAction, action: 'update', note: 'parts fitted', binding: ERIC })
    expect(a.ok && !a.deduped).toBe(true)
    expect(b.ok && !b.deduped).toBe(true)
  })
})

describe('applyStaffAction — failing closed', () => {
  it('refuses an actor Odoo does not list as an assignee, before any write', async () => {
    odooState.record = taskAssignedTo([5]) // Phillip's task, Eric acting
    const r = await applyStaffAction({ ...baseAction, binding: ERIC })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('not_assigned_to_actor')
    expect(calls).not.toContain('odoo.chatter')
    expect(calls).toContain('sa.update.failure')
    expect(calls).not.toContain('sa.update.applied')
  })

  it('refuses a stale or unknown task rather than defaulting to allow', async () => {
    odooState.record = null
    const r = await applyStaffAction({ ...baseAction, binding: ERIC })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('record_not_found')
    expect(calls).not.toContain('odoo.chatter')
  })

  it('an Odoo outage on the chatter write leaves applied_at NULL', async () => {
    odooState.chatterOk = false
    const r = await applyStaffAction({ ...baseAction, binding: ERIC })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('odoo unreachable')
    // The whole point: the staff member is NOT told this landed, and the row
    // does not read as done.
    expect(calls).not.toContain('sa.update.applied')
    expect(calls).toContain('sa.update.failure')
  })

  it('a failed action can be retried and then succeed, without a duplicate row', async () => {
    odooState.chatterOk = false
    const failed = await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(failed.ok).toBe(false)

    odooState.chatterOk = true
    calls.length = 0
    const retried = await applyStaffAction({ ...baseAction, binding: ERIC, providerMessageId: 'wamid.A' })
    expect(retried.ok).toBe(true)
    if (retried.ok) expect(retried.deduped).toBe(false)
    // Reused the existing claim rather than creating a second one.
    expect(calls).not.toContain('sa.create')
    expect(calls).toContain('sa.update.applied')
  })
})

describe('applyStaffAction — DONE and manager verification', () => {
  it('requests manager verification when the staff member has a manager', async () => {
    odooState.record = taskAssignedTo([6])
    const r = await applyStaffAction({ ...baseAction, action: 'done', binding: KIM })
    expect(r.ok).toBe(true)
    if (r.ok && !r.deduped) {
      expect(r.odooResult.verification).toEqual({ requested: true, activityId: 99 })
    }
    expect(calls).toContain('odoo.verification')
  })

  it('does not invent a verifier when the staff member has no manager', async () => {
    const r = await applyStaffAction({ ...baseAction, action: 'done', binding: ERIC })
    expect(r.ok).toBe(true)
    if (r.ok && !r.deduped) {
      expect(r.odooResult.verification).toEqual({ requested: false, why: 'staff_member_has_no_manager' })
    }
    expect(calls).not.toContain('odoo.verification')
  })

  it('a failed verification request does not fail the DONE itself', async () => {
    // The completion WAS recorded in Odoo chatter. Rolling that back because a
    // follow-up activity failed would discard a true fact; the failure is
    // reported on the result instead.
    odooState.record = taskAssignedTo([6])
    odooState.verificationOk = false
    const r = await applyStaffAction({ ...baseAction, action: 'done', binding: KIM })
    expect(r.ok).toBe(true)
    if (r.ok && !r.deduped) {
      expect(r.odooResult.verification).toMatchObject({ requested: false })
    }
    expect(calls).toContain('sa.update.applied')
  })

  it('an ACK never triggers a verification request', async () => {
    odooState.record = taskAssignedTo([6])
    await applyStaffAction({ ...baseAction, action: 'ack', binding: KIM })
    expect(calls).not.toContain('odoo.verification')
  })
})

describe('applyStaffAction — START', () => {
  it('START records a chatter note and stamps applied_at', async () => {
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(r.ok).toBe(true)
    expect(calls).toContain('odoo.chatter')
    expect(calls).toContain('sa.update.applied')
  })

  it('START captures the note — different notes on the same task are distinct actions', async () => {
    const a = await applyStaffAction({ ...baseAction, action: 'start', note: 'picking up from Kim', binding: ERIC })
    const b = await applyStaffAction({ ...baseAction, action: 'start', note: 'starting fresh', binding: ERIC })
    expect(a.ok && !a.deduped).toBe(true)
    expect(b.ok && !b.deduped).toBe(true)
    expect(calls.filter((c) => c === 'odoo.chatter').length).toBe(2)
  })

  it('idempotency key is claimed before Odoo is touched', async () => {
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC, providerMessageId: 'wamid.S1' })
    expect(r.ok).toBe(true)
    expect(calls.indexOf('sa.create')).toBeLessThan(calls.indexOf('odoo.read'))
    expect(calls.indexOf('sa.create')).toBeLessThan(calls.indexOf('odoo.chatter'))
  })

  it('applied_at is stamped only after Odoo accepted the chatter write', async () => {
    await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(calls.indexOf('odoo.chatter')).toBeLessThan(calls.indexOf('sa.update.applied'))
  })

  it('an unauthorised actor is refused before any chatter write', async () => {
    odooState.record = taskAssignedTo([5]) // not Eric
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(r.ok).toBe(false)
    expect(calls).not.toContain('odoo.chatter')
    expect(calls).not.toContain('sa.update.applied')
  })

  it('an invalid START returns valid next actions derived from the Odoo record', async () => {
    odooState.record = taskAssignedTo([5]) // project.task — Eric not assigned
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(r.ok).toBe(false)
    if (r.ok) return
    // validNextActions is derived from the Odoo record — never from Foundation state
    expect(r.validNextActions).toBeDefined()
    expect(r.validNextActions).toContain('ack')
    expect(r.validNextActions).toContain('start')
  })

  it('with no STAFF_START_STAGE_NAME configured, stage is untouched and result says so', async () => {
    // STAFF_START_STAGE_NAME is deleted in beforeEach
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(r.ok).toBe(true)
    if (!r.ok || r.deduped) return
    expect(r.odooResult.stageMove).toMatchObject({ moved: false, why: 'STAFF_START_STAGE_NAME_not_configured' })
    expect(calls).not.toContain('odoo.stageMove')
  })

  it('with STAFF_START_STAGE_NAME configured, the stage move is attempted after the note', async () => {
    process.env.STAFF_START_STAGE_NAME = 'In Progress'
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    expect(r.ok).toBe(true)
    expect(calls).toContain('odoo.stageMove')
    // Stage move happens after chatter, never before
    expect(calls.indexOf('odoo.chatter')).toBeLessThan(calls.indexOf('odoo.stageMove'))
    if (!r.ok || r.deduped) return
    expect(r.odooResult.stageMove).toMatchObject({ moved: true })
  })

  it('a failed stage move leaves the action applied and reports the failure — note is not rolled back', async () => {
    process.env.STAFF_START_STAGE_NAME = 'In Progress'
    odooState.stageMoveResult = { ok: false, reason: 'stage "In Progress" not found in project 53' }
    const r = await applyStaffAction({ ...baseAction, action: 'start', binding: ERIC })
    // The chatter note IS the durable record of the action — it was written.
    // A subsequent stage-move failure must not undo a true fact.
    expect(r.ok).toBe(true)
    expect(calls).toContain('sa.update.applied')
    if (!r.ok || r.deduped) return
    expect(r.odooResult.stageMove).toMatchObject({ moved: false })
  })
})
