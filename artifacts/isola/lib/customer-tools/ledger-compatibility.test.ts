import { describe, expect, it } from 'vitest'

import {
  LEGACY_ID_PREFIX,
  NEUTRAL_ID_PREFIX,
  claimOperation as neutralClaim,
  completeOperation as neutralComplete,
  deriveOperationId as neutralDeriveId,
  isOperationEnvelope,
  unwrapResult,
} from '@/lib/operations/ledger'

import {
  claimOperation,
  completeOperation,
  deriveOperationId,
  failOperation,
  ledgerStoreFrom,
  type ClaimOperationInput,
  type OperationRecord,
  type OperationStore,
} from './operation'

/**
 * The evidence that moving customer tools onto the neutral ledger changed the
 * STORAGE and nothing else. The riskiest thing a convergence like this can do is
 * quietly re-key existing work, so most of what is asserted here is that ids,
 * results and pending state came through untouched.
 */

interface Row extends OperationRecord {
  conversation_id: string
  correlation_id: string
  agent_session_id: string | null
  failure_detail: string | null
  completed_at: Date | null
}

class UniqueViolation extends Error {
  readonly code = 'P2002'
}

function fakeStore(seed: Partial<Row>[] = []) {
  const rows: Row[] = []
  let seq = 0
  let hook: (() => void | Promise<void>) | null = null

  const make = (over: Partial<Row>): Row => ({
    id: `rec-${++seq}`,
    tenant_id: 'tenant-1',
    operation_id: 'op-seed',
    tool_name: 'customer.business_note',
    request_hash: 'hash',
    state: 'claimed',
    result_model: null,
    result_id: null,
    result: null,
    failure_code: null,
    claimed_at: new Date('2026-07-31T12:00:00Z'),
    conversation_id: 'conv-1',
    correlation_id: 'corr-1',
    agent_session_id: null,
    failure_detail: null,
    completed_at: null,
    ...over,
  })

  for (const s of seed) rows.push(make(s))

  const byId = (id: string) => {
    const r = rows.find((x) => x.id === id)
    if (!r) throw new Error(`no row ${id}`)
    return r
  }

  const store: OperationStore = {
    async findByOperationId(tenantId, operationId) {
      return rows.find((r) => r.tenant_id === tenantId && r.operation_id === operationId) ?? null
    },
    async insert(row) {
      if (hook) {
        const fn = hook
        hook = null
        await fn()
      }
      if (rows.some((r) => r.tenant_id === row.tenant_id && r.operation_id === row.operation_id)) {
        throw new UniqueViolation()
      }
      const created = make(row as Partial<Row>)
      rows.push(created)
      return created
    },
    async reclaim(id) {
      const r = byId(id)
      Object.assign(r, { state: 'claimed', failure_code: null, failure_detail: null })
      return r
    },
    async markSucceeded(id, data) {
      const r = byId(id)
      Object.assign(r, {
        state: 'succeeded',
        result_model: data.result_model,
        result_id: data.result_id,
        result: data.result,
        completed_at: new Date(),
      })
      return r
    },
    async markFailed(id, data) {
      const r = byId(id)
      Object.assign(r, {
        state: 'failed',
        failure_code: data.failure_code,
        failure_detail: data.failure_detail,
      })
      return r
    },
  }

  return { store, rows, onNextInsert: (fn: () => void | Promise<void>) => (hook = fn) }
}

const input = (over: Partial<ClaimOperationInput> = {}): ClaimOperationInput => ({
  tenantId: 'tenant-1',
  toolName: 'customer.business_note',
  conversationId: 'conv-1',
  correlationId: 'corr-1',
  agentSessionId: 'session-9',
  hint: 'hint-1',
  authorisedArguments: { body: 'the note' },
  ...over,
})

// ── the thing that must not change ──────────────────────────────────────

describe('historical operation ids', () => {
  it('still derives the pre-existing shape', () => {
    const id = deriveOperationId({
      tenantId: 'tenant-1',
      toolName: 'customer.business_note',
      conversationId: 'conv-1',
      hint: 'hint-1',
      requestHash: 'abc',
    })
    expect(id.startsWith(LEGACY_ID_PREFIX)).toBe(true)
    expect(id).toHaveLength(LEGACY_ID_PREFIX.length + 32)
  })

  it('cannot collide with a neutral id, by shape', () => {
    const legacy = deriveOperationId({
      tenantId: 'tenant-1',
      toolName: 'customer.business_note',
      conversationId: 'conv-1',
      hint: 'hint-1',
      requestHash: 'abc',
    })
    const neutral = neutralDeriveId({
      callerClass: 'foundation_staff',
      tenantId: 'tenant-1',
      companyId: 'tenant-1',
      actionType: 'customer.business_note',
      objectType: 'customer_tool',
      objectId: 'conv-1',
      idempotencyKey: 'hint-1',
    })
    // Different separator AND different length. Not "unlikely" — impossible.
    expect(legacy.startsWith(LEGACY_ID_PREFIX)).toBe(true)
    expect(neutral.startsWith(NEUTRAL_ID_PREFIX)).toBe(true)
    expect(legacy.length).not.toBe(neutral.length)
    expect(legacy).not.toBe(neutral)
  })

  it('finds a row written before the migration and replays it', async () => {
    const hash = deriveOperationId // referenced to keep the intent obvious
    void hash
    const { store } = fakeStore()
    // Claim, complete, then "restart" by claiming the identical request again.
    const first = await claimOperation(input(), store)
    expect(first.status).toBe('claimed')
    if (first.status !== 'claimed') return
    await completeOperation(
      first.recordId,
      { resultModel: 'mail.message', resultId: 77, result: { messageId: 77 } },
      store,
    )

    const replay = await claimOperation(input(), store)
    expect(replay.status).toBe('already_succeeded')
    if (replay.status !== 'already_succeeded') return
    expect(replay.operationId).toBe(first.operationId)
    expect(replay.resultId).toBe(77)
    expect(replay.result).toEqual({ messageId: 77 })
  })

  it('reads a legacy row whose result was stored WITHOUT an envelope', async () => {
    const seeded = fakeStore()
    const requestHash = (await import('./operation')).hashArguments({ body: 'the note' })
    const operationId = deriveOperationId({
      tenantId: 'tenant-1',
      toolName: 'customer.business_note',
      conversationId: 'conv-1',
      hint: 'hint-1',
      requestHash,
    })
    seeded.rows.push({
      id: 'legacy-1',
      tenant_id: 'tenant-1',
      operation_id: operationId,
      tool_name: 'customer.business_note',
      request_hash: requestHash,
      state: 'succeeded',
      result_model: 'mail.message',
      result_id: 5,
      result: { messageId: 5, body: 'the note' },
      failure_code: null,
      claimed_at: new Date('2026-07-01T00:00:00Z'),
      conversation_id: 'conv-1',
      correlation_id: 'corr-0',
      agent_session_id: null,
      failure_detail: null,
      completed_at: new Date('2026-07-01T00:00:01Z'),
    })

    const r = await claimOperation(input(), seeded.store)
    expect(r.status).toBe('already_succeeded')
    if (r.status !== 'already_succeeded') return
    // Verbatim. No unwrapping applied to something that was never wrapped.
    expect(r.result).toEqual({ messageId: 5, body: 'the note' })
    expect(seeded.rows).toHaveLength(1)
  })
})

describe('the lifecycle is unchanged', () => {
  it('claims once and reports in flight thereafter', async () => {
    const { store, rows } = fakeStore()
    expect((await claimOperation(input(), store)).status).toBe('claimed')
    expect((await claimOperation(input(), store)).status).toBe('in_flight')
    expect(rows).toHaveLength(1)
  })

  it('concurrent duplicate customer requests create ONE operation', async () => {
    const f = fakeStore()
    f.onNextInsert(async () => {
      await claimOperation(input(), f.store)
    })
    const second = await claimOperation(input(), f.store)
    expect(second.status).toBe('in_flight')
    expect(f.rows).toHaveLength(1)
  })

  it('refuses the same id with different authorised arguments', async () => {
    const { store, rows } = fakeStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    // Same id material, tampered stored hash: the row no longer matches.
    rows[0].request_hash = 'something-else'
    const r = await claimOperation(input(), store)
    expect(r.status).toBe('conflict')
    if (r.status !== 'conflict') return
    expect(r.detail).toBe('operation id reused with different authorised arguments')
  })

  it('refuses the same id recorded against a different tool', async () => {
    const { store, rows } = fakeStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    rows[0].tool_name = 'customer.lead_update'
    const r = await claimOperation(input(), store)
    expect(r.status).toBe('conflict')
    if (r.status !== 'conflict') return
    expect(r.detail).toBe('operation id reused for a different tool')
  })

  it('re-claims after a failure and reports what failed before', async () => {
    const { store } = fakeStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    await failOperation(first.recordId, { code: 'odoo_unavailable', detail: 'timeout' }, store)

    const again = await claimOperation(input(), store)
    expect(again.status).toBe('retry_after_failure')
    if (again.status !== 'retry_after_failure') return
    expect(again.previousFailureCode).toBe('odoo_unavailable')
  })

  it('a pending operation stays pending', async () => {
    const { store, rows } = fakeStore()
    await claimOperation(input(), store)
    for (let i = 0; i < 3; i++) {
      expect((await claimOperation(input(), store)).status).toBe('in_flight')
    }
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe('claimed')
  })
})

describe('separation the shared table must preserve', () => {
  it('two tenants with the same hint are separate operations', async () => {
    const { store, rows } = fakeStore()
    await claimOperation(input({ tenantId: 'tenant-1' }), store)
    await claimOperation(input({ tenantId: 'tenant-2' }), store)
    expect(rows).toHaveLength(2)
  })

  it('two conversations with the same hint are separate operations', async () => {
    const { store, rows } = fakeStore()
    await claimOperation(input({ conversationId: 'conv-1' }), store)
    await claimOperation(input({ conversationId: 'conv-2' }), store)
    expect(rows).toHaveLength(2)
  })

  it('a staff operation and a customer operation never share a row', async () => {
    const f = fakeStore()
    const ledgerStore = ledgerStoreFrom(f.store)

    await claimOperation(input(), f.store)
    const staff = await neutralClaim(
      {
        identity: {
          callerClass: 'foundation_staff',
          tenantId: 'tenant-1',
          companyId: 'tenant-1',
          actionType: 'customer.business_note',
          objectType: 'customer_tool',
          objectId: 'conv-1',
          idempotencyKey: 'hint-1',
        },
        authorizedArguments: { body: 'the note' },
        correlationId: 'corr-1',
        actorRef: 'principal-7',
      },
      ledgerStore,
    )

    expect(staff.status).toBe('claimed')
    expect(f.rows).toHaveLength(2)
    expect(f.rows[0].operation_id).not.toBe(f.rows[1].operation_id)
  })

  it('concurrent duplicate STAFF requests create one operation', async () => {
    const f = fakeStore()
    const ledgerStore = ledgerStoreFrom(f.store)
    const claim = () =>
      neutralClaim(
        {
          identity: {
            callerClass: 'foundation_staff',
            tenantId: 'tenant-1',
            companyId: 'company-epic',
            actionType: 'note.create',
            objectType: 'res.partner',
            objectId: '42',
            idempotencyKey: 'k1',
          },
          authorizedArguments: { body: 'x' },
          correlationId: 'corr-1',
          actorRef: 'principal-7',
        },
        ledgerStore,
      )

    f.onNextInsert(async () => {
      await claim()
    })
    expect((await claim()).status).toBe('in_flight')
    expect(f.rows).toHaveLength(1)
  })
})

describe('what an auditor can still see', () => {
  it('a staff operation records caller class, company and object as readable JSON', async () => {
    const f = fakeStore()
    const ledgerStore = ledgerStoreFrom(f.store)
    const claimed = await neutralClaim(
      {
        identity: {
          callerClass: 'foundation_staff',
          tenantId: 'tenant-1',
          companyId: 'company-epic',
          actionType: 'note.create',
          objectType: 'res.partner',
          objectId: '42',
          idempotencyKey: 'k1',
        },
        authorizedArguments: { body: 'x' },
        correlationId: 'corr-1',
        actorRef: 'principal-7',
        auditRef: 'audit-9',
      },
      ledgerStore,
    )
    if (claimed.status !== 'claimed') throw new Error(claimed.status)

    await neutralComplete(
      claimed.recordId,
      {
        envelope: {
          version: 'operations.ledger@1',
          callerClass: 'foundation_staff',
          companyId: 'company-epic',
          actionType: 'note.create',
          objectType: 'res.partner',
          objectId: '42',
          actorRef: 'principal-7',
          auditRef: 'audit-9',
          readback: null,
          result: null,
        },
        readback: { id: 101, body: 'x' },
        resultModel: 'mail.message',
        resultId: 101,
      },
      ledgerStore,
    )

    const stored = f.rows[0].result
    expect(isOperationEnvelope(stored)).toBe(true)
    expect(stored).toMatchObject({
      callerClass: 'foundation_staff',
      companyId: 'company-epic',
      actionType: 'note.create',
      objectType: 'res.partner',
      objectId: '42',
      actorRef: 'principal-7',
      auditRef: 'audit-9',
      readback: { id: 101, body: 'x' },
    })
    // Inspectable, not a one-way hash.
    expect(unwrapResult(stored)).toBeNull()
  })
})
