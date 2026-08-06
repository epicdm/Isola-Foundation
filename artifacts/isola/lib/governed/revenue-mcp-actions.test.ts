import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests for `revenue.followup.set` through the full governed
 * lifecycle: propose -> validate -> company-scope -> approve -> execute ->
 * readback -> audit. Backed by:
 *   - a fake RecordSystem with call counters (never a network call), and
 *   - an in-memory fake of the AuditLog table (shared by BOTH this file's
 *     own idempotency lookup AND lib/governed/revenue-followup-approval.ts's
 *     strict approval store — both import '@/lib/prisma', mocked once here).
 *
 * Covers the original 12-point test matrix (write-tool-relevant items) AND
 * the Port decision `dec-pr41-delivery-and-revenue-mcp-write-approval-2026-08-06`
 * additions: changed-delta-after-approval denial and forged-approval denial.
 * Wrong-tenant-approval and expiry/revocation are proven at the unit level in
 * revenue-followup-approval.test.ts and are not re-derived here.
 */

interface FakeAuditRow {
  id: string
  tenant_id: string | null
  actor_id: string
  action: string
  entity: string | null | undefined
  entity_id: string | null | undefined
  request_id: string | null
  meta: unknown
  created_at: Date
}

const { rows, prismaMock } = vi.hoisted(() => {
  const rows: FakeAuditRow[] = []
  let seq = 0

  function matches(row: FakeAuditRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k as keyof FakeAuditRow] === v)
  }

  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1
      const row: FakeAuditRow = {
        id: `al-${seq}`,
        tenant_id: (data.tenant_id as string) ?? null,
        actor_id: data.actor_id as string,
        action: data.action as string,
        entity: data.entity as string | undefined,
        entity_id: data.entity_id as string | undefined,
        request_id: (data.request_id as string) ?? null,
        meta: data.meta,
        created_at: new Date(Date.now() + seq),
      }
      rows.push(row)
      return row
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.filter((r) => matches(r, where))
      found.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      return found[0] ?? null
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
  }

  const agent = {
    findUnique: vi.fn(async () => null),
  }

  return { rows, prismaMock: { auditLog, agent } }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import { approveRevenueFollowup } from './revenue-followup-approval'
import { runRevenueFollowupSet, type RevenueMcpPorts } from './revenue-mcp-actions'
import type { RecordSystem } from './executors'

const TENANT = 'tenant-epic'
const AGENT_REF = 'agent-atlas'
const LEAD_ID = '1642'

function fakeRecordSystem(knownLeadIds: string[] = [LEAD_ID]) {
  const known = new Set(knownLeadIds)
  const leads = new Map<string, Record<string, unknown>>()
  leads.set(LEAD_ID, { id: 1642, name: 'EPIC Communications Inc', stage: 'qualified', ownerRef: '' })
  const activities = new Map<string, Record<string, unknown>>()
  let activitySeq = 0
  const calls = { updateLead: 0, scheduleFollowup: 0, readLead: 0, readFollowup: 0 }

  const notUsed = async () => {
    throw new Error('not used by revenue.followup.set')
  }

  const rec: RecordSystem = {
    createNote: notUsed,
    readNote: async () => null,
    createTask: notUsed,
    readTask: async () => null,
    scheduleActivity: notUsed,
    readActivity: async () => null,
    createLead: notUsed,
    readLead: async (externalId) => {
      calls.readLead += 1
      if (!known.has(externalId)) return null
      return leads.get(externalId) ?? null
    },
    updateLead: async (input) => {
      calls.updateLead += 1
      const row = leads.get(input.leadId) ?? { id: Number(input.leadId) }
      leads.set(input.leadId, { ...row, ...input.fields })
      return { externalId: input.leadId }
    },
    scheduleFollowup: async (input) => {
      calls.scheduleFollowup += 1
      activitySeq += 1
      const id = `activity-${activitySeq}`
      activities.set(id, { id, note: input.note, date_deadline: input.dueDate })
      return { externalId: id }
    },
    readFollowup: async (externalId) => {
      calls.readFollowup += 1
      return activities.get(externalId) ?? null
    },
  }

  return { rec, calls, leads, activities }
}

function ports(rec: RecordSystem, resolveTenantForAgent: (ref: string) => Promise<string | null>, now: Date): RevenueMcpPorts {
  return { rec, resolveTenantForAgent, now: () => now }
}

const resolveKnownAgent = async (ref: string) => (ref === AGENT_REF ? TENANT : null)

const NOW = new Date('2026-08-06T12:00:00.000Z')

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
})

// ── unauthenticated ──────────────────────────────────────────────────────────

describe('unauthenticated caller', () => {
  it('denies when no agentRef is supplied', async () => {
    const { rec, calls } = fakeRecordSystem()
    const result = await runRevenueFollowupSet(
      {
        caller: { agentRef: '' },
        leadId: LEAD_ID,
        payload: { ownerRef: '7' },
        idempotencyKey: 'idem-unauth-1',
        correlationId: 'corr-1',
      },
      ports(rec, resolveKnownAgent, NOW),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
    expect(calls.updateLead).toBe(0)
  })

  it('denies when the agentRef does not resolve to an active tenant', async () => {
    const { rec, calls } = fakeRecordSystem()
    const result = await runRevenueFollowupSet(
      {
        caller: { agentRef: 'agent-unknown' },
        leadId: LEAD_ID,
        payload: { ownerRef: '7' },
        idempotencyKey: 'idem-unauth-2',
        correlationId: 'corr-1',
      },
      ports(rec, resolveKnownAgent, NOW),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
    expect(calls.updateLead).toBe(0)
  })
})

// ── wrong tenant ─────────────────────────────────────────────────────────────

describe('wrong tenant', () => {
  it('denies when the lead is not visible in the resolved tenant Odoo binding', async () => {
    const { rec, calls } = fakeRecordSystem([]) // no lead known — simulates "not in this tenant's Odoo"
    const result = await runRevenueFollowupSet(
      {
        caller: { agentRef: AGENT_REF },
        leadId: LEAD_ID,
        payload: { ownerRef: '7' },
        idempotencyKey: 'idem-wrong-tenant',
        correlationId: 'corr-1',
      },
      ports(rec, resolveKnownAgent, NOW),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.outcome).toBe('PERMISSION_DENIED')
    }
    expect(calls.updateLead).toBe(0)
    expect(calls.scheduleFollowup).toBe(0)
  })
})

// ── approval lifecycle ───────────────────────────────────────────────────────

async function approveCurrentPending(tenantId: string, idempotencyKey: string, approverActorId = 'user-eric') {
  const pending = rows
    .filter((r) => r.tenant_id === tenantId && r.action === 'revenue.followup.set.pending_approval' && r.request_id === idempotencyKey)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0]
  if (!pending) throw new Error('setup: no pending approval row found to approve')
  const approved = await approveRevenueFollowup({ pendingApprovalId: pending.id, approverActorId, now: NOW })
  if (!approved.ok) throw new Error('setup: approve failed: ' + JSON.stringify(approved))
  return approved.auditId
}

describe('unapproved write', () => {
  it('performs zero Odoo mutations and reports APPROVAL_REQUIRED', async () => {
    const { rec, calls } = fakeRecordSystem()
    const result = await runRevenueFollowupSet(
      {
        caller: { agentRef: AGENT_REF },
        leadId: LEAD_ID,
        payload: { ownerRef: '7', nextAction: 'Call back re: internet/calling/support recommendation', dueDate: '2026-08-07' },
        idempotencyKey: 'idem-unapproved',
        correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
      },
      ports(rec, resolveKnownAgent, NOW),
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.outcome).toBe('APPROVAL_REQUIRED')
      expect(result.result.approvalId).toBeTruthy()
    }
    expect(calls.updateLead).toBe(0)
    expect(calls.scheduleFollowup).toBe(0)
  })

  it('FORGED APPROVAL: extra caller-supplied fields (e.g. a fake approvalId) never grant execution', async () => {
    const { rec, calls } = fakeRecordSystem()
    const result = await runRevenueFollowupSet(
      {
        caller: { agentRef: AGENT_REF },
        leadId: LEAD_ID,
        // @ts-expect-error — deliberately smuggling in fields the payload type does not declare
        payload: { ownerRef: '7', approvalId: 'al-999-does-not-exist', approved: true },
        idempotencyKey: 'idem-forged',
        correlationId: 'corr-forged',
      },
      ports(rec, resolveKnownAgent, NOW),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('APPROVAL_REQUIRED')
    expect(calls.updateLead).toBe(0)
  })
})

describe('approved write', () => {
  const request = {
    caller: { agentRef: AGENT_REF },
    leadId: LEAD_ID,
    payload: { ownerRef: '7', nextAction: 'Call back re: internet/calling/support recommendation', dueDate: '2026-08-07' },
    idempotencyKey: 'idem-approved-1',
    correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
  }

  it('executes exactly once, with a readback that matches what Odoo actually stored', async () => {
    const { rec, calls, leads, activities } = fakeRecordSystem()

    // First pass: mints the pending approval.
    const first = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, NOW))
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error('unreachable')
    expect(first.result.outcome).toBe('APPROVAL_REQUIRED')

    // Human approves it.
    const approvedId = await approveCurrentPending(TENANT, request.idempotencyKey)

    // Second pass: same idempotencyKey, same values -> now executes.
    const second = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 1000)))
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')

    expect(second.result.outcome).toBe('EXECUTED')
    // action.ts's terminal EXECUTED result does not itself carry approvalId
    // (only APPROVAL_REQUIRED/APPROVAL_REJECTED do) — the approval reference
    // that actually authorized this write is preserved in the audit row's
    // own meta instead. See the assertion on `executedRow` below.
    expect(calls.updateLead).toBe(1)
    expect(calls.scheduleFollowup).toBe(1)

    // ODOO_WRITE_COUNT — real fake-store assertions, not trust in the result envelope.
    expect(leads.get(LEAD_ID)?.ownerRef).toBe('7')
    expect(activities.size).toBe(1)

    // Readback matches Odoo — not just an echo of the input.
    expect(second.result.readback).toBeTruthy()
    expect(second.result.readback).toMatchObject({
      leadId: LEAD_ID,
      ownerRef: '7',
      followup: { note: 'Call back re: internet/calling/support recommendation' },
    })

    // Audit reference exists and is non-empty.
    expect(second.result.auditId).toBeTruthy()
    const executedRow = rows.find((r) => r.action === 'revenue.followup.set' && (r.meta as { outcome?: string })?.outcome === 'EXECUTED')
    expect(executedRow).toBeTruthy()
    expect((executedRow?.meta as { approvalId?: string })?.approvalId).toBe(approvedId)
  })

  it('REPLAY: a second call with the same idempotencyKey after execution performs zero additional writes', async () => {
    const { rec, calls } = fakeRecordSystem()
    await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, NOW))
    await approveCurrentPending(TENANT, request.idempotencyKey)
    const executed = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 1000)))
    if (!executed.ok || executed.result.outcome !== 'EXECUTED') throw new Error('setup: did not execute')

    const callsAfterExecution = { ...calls }

    const replay = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 2000)))
    expect(replay.ok).toBe(true)
    if (!replay.ok) throw new Error('unreachable')
    expect(replay.result.outcome).toBe('IDEMPOTENT_REPLAY')
    expect(calls.updateLead).toBe(callsAfterExecution.updateLead)
    expect(calls.scheduleFollowup).toBe(callsAfterExecution.scheduleFollowup)
  })

  it('CHANGED DELTA: values changed after approval are denied, with zero additional writes', async () => {
    const { rec, calls } = fakeRecordSystem()
    const approvedRequest = { ...request, idempotencyKey: 'idem-changed-delta' }
    await runRevenueFollowupSet(approvedRequest, ports(rec, resolveKnownAgent, NOW))
    await approveCurrentPending(TENANT, approvedRequest.idempotencyKey)

    const callsAfterApproval = { ...calls }
    expect(callsAfterApproval.updateLead).toBe(0) // approval alone writes nothing

    const changedRequest = {
      ...approvedRequest,
      payload: { ...approvedRequest.payload, dueDate: '2026-08-09' }, // differs from what was approved
    }
    const result = await runRevenueFollowupSet(changedRequest, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 1000)))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.result.outcome).not.toBe('EXECUTED')
    expect(calls.updateLead).toBe(0)
    expect(calls.scheduleFollowup).toBe(0)
  })
})

// ── secret scan ──────────────────────────────────────────────────────────────

describe('secret scan', () => {
  const SECRET_SHAPED = /(api[_-]?key|access[_-]?token|client[_-]?secret|hmac|webhook[_-]?verify|authorization\s*:\s*bearer)/i

  it('neither the result envelope nor the audit meta ever contains a secret-shaped string', async () => {
    const { rec } = fakeRecordSystem()
    const request = {
      caller: { agentRef: AGENT_REF },
      leadId: LEAD_ID,
      payload: { ownerRef: '7', nextAction: 'Call back re: internet/calling/support recommendation', dueDate: '2026-08-07' },
      idempotencyKey: 'idem-secret-scan',
      correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
    }
    const first = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, NOW))
    await approveCurrentPending(TENANT, request.idempotencyKey)
    const second = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 1000)))

    const serializedResults = JSON.stringify([first, second])
    expect(SECRET_SHAPED.test(serializedResults)).toBe(false)

    const serializedAuditMeta = JSON.stringify(rows.map((r) => r.meta))
    expect(SECRET_SHAPED.test(serializedAuditMeta)).toBe(false)
  })
})

// ── write-surface discipline ─────────────────────────────────────────────────

describe('write-surface discipline', () => {
  it('unknown payload keys are never used to widen the write', async () => {
    const { rec, calls, leads } = fakeRecordSystem()
    const request = {
      caller: { agentRef: AGENT_REF },
      leadId: LEAD_ID,
      payload: { ownerRef: '7', stage: 'won', expectedRevenue: '999999' } as Record<string, string>,
      idempotencyKey: 'idem-widen-attempt',
      correlationId: 'corr-widen',
    }
    await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, NOW))
    await approveCurrentPending(TENANT, request.idempotencyKey)
    const result = await runRevenueFollowupSet(request, ports(rec, resolveKnownAgent, new Date(NOW.getTime() + 1000)))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('EXECUTED')
    expect(calls.updateLead).toBe(1)
    // Only ownerRef was ever picked — stage/expectedRevenue must not have landed.
    expect(leads.get(LEAD_ID)?.stage).toBe('qualified') // unchanged from fixture default
  })
})
