import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Unit tests for the strict, 8-dimension-bound approval primitive backing
 * `revenue.followup.set`. Backed by an in-memory fake of the AuditLog table
 * (real create/findFirst/findUnique semantics, not a bare stub) so
 * expiry/revocation/strict-match are proven against something that actually
 * behaves like the persistence layer, not against mocked return values.
 */

interface FakeRow {
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
  const rows: FakeRow[] = []
  let seq = 0

  function matches(row: FakeRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k as keyof FakeRow] === v)
  }

  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1
      const row: FakeRow = {
        id: `al-${seq}`,
        tenant_id: (data.tenant_id as string) ?? null,
        actor_id: data.actor_id as string,
        action: data.action as string,
        entity: data.entity as string | undefined,
        entity_id: data.entity_id as string | undefined,
        request_id: (data.request_id as string) ?? null,
        meta: data.meta,
        created_at: new Date(Date.now() + seq), // strictly increasing
      }
      rows.push(row)
      return row
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.filter((r) => matches(r, where))
      found.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      return found[0] ?? null
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
      return rows.find((r) => r.id === where.id) ?? null
    }),
  }

  return { rows, prismaMock: { auditLog } }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import {
  approveRevenueFollowup,
  computeApprovalScope,
  mintPendingApproval,
  revokeRevenueFollowupApproval,
  verdictForRevenueFollowup,
  type RevenueApprovalScope,
} from './revenue-followup-approval'

const NOW = new Date('2026-08-06T12:00:00.000Z')

function baseScope(overrides: Partial<Parameters<typeof computeApprovalScope>[0]> = {}): RevenueApprovalScope {
  return computeApprovalScope({
    tenantId: 'tenant-epic',
    clawithAgentId: 'agent-atlas',
    tool: 'revenue.followup.set',
    objectId: '1642',
    fields: { ownerRef: '7', nextAction: 'Call back re: internet', dueDate: '2026-08-07' },
    correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
    idempotencyKey: 'idem-1',
    ...overrides,
  })
}

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
})

describe('mintPendingApproval', () => {
  it('creates a fresh pending row when none exists', async () => {
    const scope = baseScope()
    const minted = await mintPendingApproval(scope, NOW)
    expect(minted.auditId).toBeTruthy()
    expect(rows).toHaveLength(1)
    expect(rows[0].action).toBe('revenue.followup.set.pending_approval')
    expect(rows[0].request_id).toBe('idem-1')
  })

  it('reuses the same pending row on an identical, still-live repeat call', async () => {
    const scope = baseScope()
    const first = await mintPendingApproval(scope, NOW)
    const second = await mintPendingApproval(scope, new Date(NOW.getTime() + 1000))
    expect(second.auditId).toBe(first.auditId)
    expect(rows).toHaveLength(1)
  })

  it('mints a NEW row when the scope (delta) changed, even with the same idempotencyKey', async () => {
    const scope1 = baseScope()
    const first = await mintPendingApproval(scope1, NOW)
    const scope2 = baseScope({ fields: { ownerRef: '7', nextAction: 'Call back', dueDate: '2026-08-09' } })
    const second = await mintPendingApproval(scope2, NOW)
    expect(second.auditId).not.toBe(first.auditId)
    expect(rows).toHaveLength(2)
  })

  it('mints a NEW row when the previous pending row has expired', async () => {
    const scope = baseScope()
    const first = await mintPendingApproval(scope, NOW, 1000) // 1s TTL
    const second = await mintPendingApproval(scope, new Date(NOW.getTime() + 5000))
    expect(second.auditId).not.toBe(first.auditId)
    expect(rows).toHaveLength(2)
  })
})

describe('verdictForRevenueFollowup — no approval yet', () => {
  it('returns pending and mints a pending row', async () => {
    const scope = baseScope()
    const verdict = await verdictForRevenueFollowup(scope, NOW)
    expect(verdict.state).toBe('pending')
    expect(verdict.approvalId).toBeTruthy()
    expect(rows.some((r) => r.action === 'revenue.followup.set.pending_approval')).toBe(true)
  })
})

describe('verdictForRevenueFollowup — approved and strictly matching', () => {
  async function approveScope(scope: RevenueApprovalScope) {
    const pending = await mintPendingApproval(scope, NOW)
    const approved = await approveRevenueFollowup({
      pendingApprovalId: pending.auditId,
      approverActorId: 'user-eric',
      now: NOW,
    })
    if (!approved.ok) throw new Error('setup failed: ' + JSON.stringify(approved))
    return approved.auditId
  }

  it('grants when every dimension matches and it has not expired', async () => {
    const scope = baseScope()
    const approvedId = await approveScope(scope)
    const verdict = await verdictForRevenueFollowup(scope, new Date(NOW.getTime() + 1000))
    expect(verdict).toEqual({ state: 'granted', approvalId: approvedId })
  })

  it('CHANGED DELTA: denies when the proposal values differ from what was approved', async () => {
    const approvedScope = baseScope({ fields: { ownerRef: '7', nextAction: 'Call back', dueDate: '2026-08-07' } })
    await approveScope(approvedScope)

    const changedScope = baseScope({ fields: { ownerRef: '7', nextAction: 'Call back', dueDate: '2026-08-09' } })
    const verdict = await verdictForRevenueFollowup(changedScope, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('WRONG TENANT: an approval minted under tenant A does not satisfy tenant B, same idempotencyKey', async () => {
    const scopeA = baseScope({ tenantId: 'tenant-a', idempotencyKey: 'idem-shared' })
    await approveScope(scopeA)

    const scopeB = baseScope({ tenantId: 'tenant-b', idempotencyKey: 'idem-shared' })
    const verdict = await verdictForRevenueFollowup(scopeB, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('REUSE FOR A DIFFERENT OPPORTUNITY: approval for lead 1642 does not satisfy lead 9999, same idempotencyKey', async () => {
    const scope1642 = baseScope({ objectId: '1642', idempotencyKey: 'idem-shared-2' })
    await approveScope(scope1642)

    const scope9999 = baseScope({ objectId: '9999', idempotencyKey: 'idem-shared-2' })
    const verdict = await verdictForRevenueFollowup(scope9999, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('REUSE FOR A DIFFERENT CORRELATION: mismatched correlationId denies even with the same idempotencyKey', async () => {
    const scopeC1 = baseScope({ correlationId: 'corr-1', idempotencyKey: 'idem-shared-3' })
    await approveScope(scopeC1)

    const scopeC2 = baseScope({ correlationId: 'corr-2', idempotencyKey: 'idem-shared-3' })
    const verdict = await verdictForRevenueFollowup(scopeC2, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('REUSE BY A DIFFERENT AGENT: mismatched clawithAgentId denies', async () => {
    const scopeAgentA = baseScope({ clawithAgentId: 'agent-atlas', idempotencyKey: 'idem-shared-4' })
    await approveScope(scopeAgentA)

    const scopeAgentB = baseScope({ clawithAgentId: 'agent-scout', idempotencyKey: 'idem-shared-4' })
    const verdict = await verdictForRevenueFollowup(scopeAgentB, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('SUPERSET OF FIELDS: an approval scoped to ownerRef only does not satisfy a proposal that also sets nextAction/dueDate', async () => {
    const ownerOnly = baseScope({
      fields: { ownerRef: '7', nextAction: '', dueDate: '' },
      idempotencyKey: 'idem-shared-5',
    })
    await approveScope(ownerOnly)

    const widened = baseScope({
      fields: { ownerRef: '7', nextAction: 'Call back', dueDate: '2026-08-07' },
      idempotencyKey: 'idem-shared-5',
    })
    const verdict = await verdictForRevenueFollowup(widened, new Date(NOW.getTime() + 1000))
    expect(verdict.state).not.toBe('granted')
  })

  it('EXPIRED APPROVAL: denies once the approved grant has passed its expiry', async () => {
    const scope = baseScope({ idempotencyKey: 'idem-expiring' })
    const pending = await mintPendingApproval(scope, NOW)
    const approved = await approveRevenueFollowup({
      pendingApprovalId: pending.auditId,
      approverActorId: 'user-eric',
      now: NOW,
      ttlMs: 1000, // 1 second grant
    })
    expect(approved.ok).toBe(true)

    const verdict = await verdictForRevenueFollowup(scope, new Date(NOW.getTime() + 5000))
    expect(verdict.state).not.toBe('granted')
  })

  it('REVOKED APPROVAL: denies once revoked, even though it strictly matches and has not expired', async () => {
    const scope = baseScope({ idempotencyKey: 'idem-revoked' })
    const approvedId = await approveScope(scope)

    const revoked = await revokeRevenueFollowupApproval({
      approvedAuditId: approvedId,
      revokedByActorId: 'user-eric',
      reason: 'owner changed their mind',
      now: new Date(NOW.getTime() + 500),
    })
    expect(revoked.ok).toBe(true)

    const verdict = await verdictForRevenueFollowup(scope, new Date(NOW.getTime() + 1000))
    expect(verdict.state).toBe('rejected')
    if (verdict.state === 'rejected') {
      expect(verdict.reason).toContain('owner changed their mind')
    }
  })

  it('a revocation of a DIFFERENT approved row does not affect this one', async () => {
    const scopeOld = baseScope({ idempotencyKey: 'idem-old' })
    const oldApprovedId = await approveScope(scopeOld)
    await revokeRevenueFollowupApproval({
      approvedAuditId: oldApprovedId,
      revokedByActorId: 'user-eric',
      now: new Date(NOW.getTime() + 200),
    })

    const scopeNew = baseScope({ idempotencyKey: 'idem-new' })
    const newApprovedId = await approveScope(scopeNew)
    const verdict = await verdictForRevenueFollowup(scopeNew, new Date(NOW.getTime() + 1000))
    expect(verdict).toEqual({ state: 'granted', approvalId: newApprovedId })
  })
})

describe('approveRevenueFollowup', () => {
  it('fails with not_found for an unknown pending id', async () => {
    const result = await approveRevenueFollowup({
      pendingApprovalId: 'al-does-not-exist',
      approverActorId: 'user-eric',
      now: NOW,
    })
    expect(result).toEqual({ ok: false, code: 'not_found', detail: expect.any(String) })
  })

  it('fails with expired for a pending row past its own TTL', async () => {
    const scope = baseScope({ idempotencyKey: 'idem-pending-expired' })
    const pending = await mintPendingApproval(scope, NOW, 1000)
    const result = await approveRevenueFollowup({
      pendingApprovalId: pending.auditId,
      approverActorId: 'user-eric',
      now: new Date(NOW.getTime() + 5000),
    })
    expect(result).toEqual({ ok: false, code: 'expired', detail: expect.any(String) })
  })
})

describe('revokeRevenueFollowupApproval', () => {
  it('fails for an unknown approved-audit id', async () => {
    const result = await revokeRevenueFollowupApproval({
      approvedAuditId: 'al-does-not-exist',
      revokedByActorId: 'user-eric',
      now: NOW,
    })
    expect(result.ok).toBe(false)
  })
})

describe('FORGED APPROVAL', () => {
  it('a scope that was never actually approved never grants, no matter how it is constructed', async () => {
    // Nothing was ever minted or approved for this exact idempotencyKey — the
    // "forgery" here is simply that no real .approved row exists to match
    // against. The verdict function reads NOTHING from a caller-supplied
    // token; it only ever compares against real rows it looked up itself.
    const scope = baseScope({ idempotencyKey: 'idem-never-approved-' + Math.random() })
    const verdict = await verdictForRevenueFollowup(scope, NOW)
    expect(verdict.state).not.toBe('granted')
  })
})
