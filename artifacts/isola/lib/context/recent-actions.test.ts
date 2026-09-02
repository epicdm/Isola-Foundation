import { describe, expect, it, vi } from 'vitest'

import { LEDGER_VERSION, type LedgerRecord, type OperationEnvelope } from '@/lib/operations/ledger'
import { LIFECYCLE_PRESENTATION } from '@/lib/customer-workspace/contract'

import {
  MAX_RECENT_ACTIONS,
  lifecycleOfRecord,
  recentActionsAdapter,
  toRecentAction,
  type RecentActionsStore,
} from './recent-actions'

const envelope = (over: Partial<OperationEnvelope> = {}): OperationEnvelope => ({
  version: LEDGER_VERSION,
  callerClass: 'foundation_staff',
  companyId: 'tenant-1',
  actionType: 'note.create',
  objectType: 'customer',
  objectId: '42',
  actorRef: 'principal-9',
  auditRef: 'audit-1',
  readback: null,
  result: null,
  ...over,
})

const record = (over: Partial<LedgerRecord> = {}): LedgerRecord => ({
  recordId: 'rec-1',
  tenantId: 'tenant-1',
  operationId: 'op_abc',
  state: 'completed',
  requestHash: 'hash',
  correlationId: 'corr-1',
  claimedAt: new Date('2026-08-01T10:00:00Z'),
  completedAt: new Date('2026-08-01T10:00:05Z'),
  failureClass: null,
  failureDetail: null,
  resultModel: 'mail.message',
  resultId: 7,
  envelope: envelope(),
  ...over,
})

const storeOf = (records: LedgerRecord[]): RecentActionsStore => ({
  list: vi.fn(async () => records),
})

const deps = (store: RecentActionsStore) => ({
  store,
  tenantId: 'tenant-1',
  now: () => new Date('2026-08-01T12:00:00Z'),
})

/* ── the assertion this file exists for ────────────────────────────────────*/

describe('a completed operation is not automatically a success', () => {
  it('reports readback_failed when the envelope carries no readback', () => {
    const state = lifecycleOfRecord(record({ state: 'completed', envelope: envelope() }))

    expect(state).toBe('readback_failed')
    // And the contract must refuse to dress that up as done.
    expect(LIFECYCLE_PRESENTATION[state].success).toBe(false)
    expect(LIFECYCLE_PRESENTATION[state].label).toBe('Written but not confirmed')
    expect(LIFECYCLE_PRESENTATION[state].escalate).toBe(true)
  })

  it('reports completed_verified only when a readback is actually present', () => {
    const state = lifecycleOfRecord(
      record({ state: 'completed', envelope: envelope({ readback: { body: 'hello' } }) }),
    )

    expect(state).toBe('completed_verified')
    expect(LIFECYCLE_PRESENTATION[state].success).toBe(true)
  })

  it('is the ONLY state in the whole map that reads as success', () => {
    const succeeding = Object.values(LIFECYCLE_PRESENTATION)
      .filter((p) => p.success)
      .map((p) => p.state)

    expect(succeeding).toEqual(['completed_verified'])
  })
})

/* ── failure classes keep their meaning ────────────────────────────────────*/

describe('a failed row keeps the distinction the executor drew', () => {
  it.each([
    ['DEPENDENCY_UNAVAILABLE', 'dependency_unavailable'],
    ['EXECUTION_FAILED', 'execution_failed'],
    ['EXECUTOR_UNAVAILABLE', 'executor_unavailable'],
    ['READBACK_FAILED', 'readback_failed'],
    ['VALIDATION_FAILED', 'validation_failed'],
    ['PERMISSION_DENIED', 'permission_denied'],
    ['APPROVAL_REJECTED', 'approval_rejected'],
  ])('%s becomes %s', (failureClass, expected) => {
    expect(lifecycleOfRecord(record({ state: 'failed', failureClass }))).toBe(expected)
  })

  it('does not flatten unreachable into refused', () => {
    const unreachable = lifecycleOfRecord(record({ state: 'failed', failureClass: 'DEPENDENCY_UNAVAILABLE' }))
    const refused = lifecycleOfRecord(record({ state: 'failed', failureClass: 'EXECUTION_FAILED' }))

    expect(unreachable).not.toBe(refused)
    // Different on every channel a reader could be relying on, not just the word.
    expect(LIFECYCLE_PRESENTATION[unreachable].label).not.toBe(LIFECYCLE_PRESENTATION[refused].label)
    expect(LIFECYCLE_PRESENTATION[unreachable].marker).not.toBe(LIFECYCLE_PRESENTATION[refused].marker)
    expect(LIFECYCLE_PRESENTATION[unreachable].tone).not.toBe(LIFECYCLE_PRESENTATION[refused].tone)
    expect(LIFECYCLE_PRESENTATION[unreachable].retryWrite).toBe('safe')
    expect(LIFECYCLE_PRESENTATION[refused].retryWrite).toBe('unsafe')
  })

  it('lands an unrecognised failure class on execution_failed, never on success', () => {
    const state = lifecycleOfRecord(record({ state: 'failed', failureClass: 'SOMETHING_NEW' }))
    expect(state).toBe('execution_failed')
    expect(LIFECYCLE_PRESENTATION[state].success).toBe(false)
  })

  it('reports a still-claimed row as executing rather than as finished', () => {
    expect(lifecycleOfRecord(record({ state: 'claimed', completedAt: null }))).toBe('executing')
  })
})

/* ── what leaves this module ───────────────────────────────────────────────*/

describe('what a row is allowed to put on a screen', () => {
  it('carries identity and outcome but neither the payload nor the readback', () => {
    const row = toRecentAction(
      record({ envelope: envelope({ readback: { body: 'private note text' }, result: { secret: 1 } }) }),
    )

    const serialised = JSON.stringify(row)
    expect(serialised).not.toContain('private note text')
    expect(serialised).not.toContain('secret')
    expect(row).not.toHaveProperty('readback')
    expect(row).not.toHaveProperty('result')

    // The one bit that IS needed: whether the outcome is evidence or a claim.
    expect(row.readbackProven).toBe(true)
    expect(row.actionType).toBe('note.create')
    expect(row.resultModel).toBe('mail.message')
    expect(row.resultId).toBe(7)
  })

  it('does not attribute a legacy row with no envelope to any customer', () => {
    const row = toRecentAction(record({ envelope: null }))

    expect(row.objectId).toBeNull()
    expect(row.actionType).toBeNull()
    expect(row.callerClass).toBeNull()
    expect(row.readbackProven).toBe(false)
  })
})

/* ── the adapter ───────────────────────────────────────────────────────────*/

describe('the recentActions adapter', () => {
  it('scopes the read to the session tenant and the selected object', async () => {
    const store = storeOf([record()])
    const adapter = recentActionsAdapter(deps(store))

    await adapter.load({ companyId: 'tenant-1', objectType: 'customer', objectId: '42', limit: 10 })

    expect(store.list).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      objectType: 'customer',
      objectId: '42',
      limit: 10,
    })
  })

  it('THROWS when the store fails, so the section becomes unavailable and not empty', async () => {
    const store: RecentActionsStore = {
      list: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.4:5432')
      }),
    }
    const adapter = recentActionsAdapter(deps(store))

    await expect(
      adapter.load({ companyId: 'tenant-1', objectType: 'customer', objectId: '42', limit: 10 }),
    ).rejects.toThrow('the action history could not be read')
  })

  it('does not put driver text on a screen', async () => {
    const store: RecentActionsStore = {
      list: vi.fn(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.4:5432')
      }),
    }
    const adapter = recentActionsAdapter(deps(store))

    const err = await adapter
      .load({ companyId: 'tenant-1', objectType: 'customer', objectId: '42', limit: 10 })
      .catch((e: Error) => e)

    expect((err as Error).message).not.toContain('ECONNREFUSED')
    expect((err as Error).message).not.toContain('10.0.0.4')
  })

  it('reports an empty history as an ANSWER, with provenance', async () => {
    const adapter = recentActionsAdapter(deps(storeOf([])))

    const out = await adapter.load({
      companyId: 'tenant-1',
      objectType: 'customer',
      objectId: '42',
      limit: 10,
    })

    expect(out.data).toEqual([])
    expect(out.provenance.source).toBe('ledger:CustomerToolOperation')
    expect(out.provenance.stale).toBe(false)
  })

  it('is not offered to a role without the workspace gate', () => {
    const adapter = recentActionsAdapter(deps(storeOf([])))
    expect(adapter.allowedRoles).not.toContain('staff')
    expect(adapter.allowedRoles).toContain('manager')
  })

  it('has a ceiling a caller cannot argue with', () => {
    expect(MAX_RECENT_ACTIONS).toBeLessThanOrEqual(50)
  })
})
