/**
 * An in-memory LedgerStore for tests.
 *
 * It enforces the SAME unique constraint the database does, on
 * (tenant_id, operation_id), and throws a Prisma-shaped P2002 when it is
 * violated. Without that, a test would prove the read-then-write check works and
 * say nothing at all about the constraint that actually prevents double
 * execution under a race.
 */

import type { LedgerInsert, LedgerRecord, LedgerStore, OperationEnvelope } from './ledger'

export class FakeUniqueViolation extends Error {
  readonly code = 'P2002'
  constructor() {
    super('Unique constraint failed on the fields: (tenant_id, operation_id)')
    this.name = 'FakeUniqueViolation'
  }
}

export interface FakeLedgerStore extends LedgerStore {
  rows(): LedgerRecord[]
  /** Runs once before the next insert — used to simulate a concurrent winner. */
  onNextInsert(fn: () => void | Promise<void>): void
}

export function createFakeLedgerStore(
  now: () => Date = () => new Date('2026-07-31T12:00:00Z'),
): FakeLedgerStore {
  const byKey = new Map<string, LedgerRecord>()
  const byId = new Map<string, LedgerRecord>()
  let seq = 0
  let hook: (() => void | Promise<void>) | null = null

  const key = (tenantId: string, operationId: string) => `${tenantId}::${operationId}`

  const put = (r: LedgerRecord) => {
    byKey.set(key(r.tenantId, r.operationId), r)
    byId.set(r.recordId, r)
    return r
  }

  const mustGet = (recordId: string): LedgerRecord => {
    const r = byId.get(recordId)
    if (!r) throw new Error(`no ledger record ${recordId}`)
    return r
  }

  return {
    async find(tenantId, operationId) {
      return byKey.get(key(tenantId, operationId)) ?? null
    },

    async insert(row: LedgerInsert) {
      if (hook) {
        const fn = hook
        hook = null
        await fn()
      }
      if (byKey.has(key(row.tenantId, row.operationId))) throw new FakeUniqueViolation()
      return put({
        recordId: `rec-${++seq}`,
        tenantId: row.tenantId,
        operationId: row.operationId,
        state: 'claimed',
        requestHash: row.requestHash,
        correlationId: row.correlationId,
        claimedAt: now(),
        completedAt: null,
        failureClass: null,
        failureDetail: null,
        resultModel: null,
        resultId: null,
        envelope: row.envelope,
      })
    },

    async reclaim(recordId) {
      const r = mustGet(recordId)
      return put({
        ...r,
        state: 'claimed',
        failureClass: null,
        failureDetail: null,
        claimedAt: now(),
      })
    },

    async markCompleted(
      recordId,
      data: { resultModel: string | null; resultId: number | null; envelope: OperationEnvelope },
    ) {
      const r = mustGet(recordId)
      return put({
        ...r,
        state: 'completed',
        completedAt: now(),
        resultModel: data.resultModel,
        resultId: data.resultId,
        envelope: data.envelope,
      })
    },

    async markFailed(recordId, data) {
      const r = mustGet(recordId)
      return put({
        ...r,
        state: 'failed',
        completedAt: now(),
        failureClass: data.failureClass,
        failureDetail: data.failureDetail,
      })
    },

    isUniqueViolation(err) {
      return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
    },

    rows() {
      return [...byId.values()]
    },

    onNextInsert(fn) {
      hook = fn
    },
  }
}
