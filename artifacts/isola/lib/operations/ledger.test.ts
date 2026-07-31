import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createFakeLedgerStore } from './fake-ledger-store'
import {
  CALLER_CLASSES,
  canonicalJson,
  claimOperation,
  completeOperation,
  deriveOperationId,
  failOperation,
  hashArguments,
  type CallerClass,
  type ClaimInput,
  type OperationEnvelope,
  type OperationIdentity,
} from './ledger'

const BASE: OperationIdentity = {
  callerClass: 'foundation_staff',
  tenantId: 'tenant-1',
  companyId: 'company-epic',
  actionType: 'note.create',
  objectType: 'res.partner',
  objectId: '42',
  idempotencyKey: 'key-1',
}

const input = (
  over: Partial<OperationIdentity> = {},
  args: unknown = { body: 'hello' },
): ClaimInput => ({
  identity: { ...BASE, ...over },
  authorizedArguments: args,
  correlationId: 'corr-1',
  actorRef: 'principal-7',
})

const envelopeOf = (identity: OperationIdentity): OperationEnvelope => ({
  version: 'operations.ledger@1',
  callerClass: identity.callerClass,
  companyId: identity.companyId,
  actionType: identity.actionType,
  objectType: identity.objectType,
  objectId: identity.objectId,
  actorRef: 'principal-7',
  auditRef: null,
  readback: null,
  result: null,
})

describe('the operation id — what makes two requests the same operation', () => {
  it('is stable for the same identity', () => {
    expect(deriveOperationId(BASE)).toBe(deriveOperationId({ ...BASE }))
  })

  it.each([
    ['caller class', { callerClass: 'customer_agent' as CallerClass }],
    ['tenant', { tenantId: 'tenant-2' }],
    ['company', { companyId: 'company-other' }],
    ['action type', { actionType: 'task.create' }],
    ['object type', { objectType: 'crm.lead' }],
    ['object id', { objectId: '43' }],
    ['idempotency key', { idempotencyKey: 'key-2' }],
  ])('changes when the %s changes', (_label, over) => {
    expect(deriveOperationId({ ...BASE, ...over })).not.toBe(deriveOperationId(BASE))
  })

  it('gives every caller class its own id space', () => {
    const ids = CALLER_CLASSES.map((c) => deriveOperationId({ ...BASE, callerClass: c }))
    expect(new Set(ids).size).toBe(CALLER_CLASSES.length)
  })

  it('does not change when key ORDER changes in the arguments', () => {
    expect(hashArguments({ a: 1, b: 2 })).toBe(hashArguments({ b: 2, a: 1 }))
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}')
  })

  it('does change when the arguments themselves change', () => {
    expect(hashArguments({ body: 'a' })).not.toBe(hashArguments({ body: 'b' }))
  })
})

describe('claiming', () => {
  it('claims a fresh operation', async () => {
    const store = createFakeLedgerStore()
    const r = await claimOperation(input(), store)
    expect(r.status).toBe('claimed')
    expect(store.rows()).toHaveLength(1)
  })

  it('a Foundation retry returns the prior result and does not execute again', async () => {
    const store = createFakeLedgerStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)

    await completeOperation(
      first.recordId,
      {
        envelope: envelopeOf(BASE),
        readback: { id: 101, body: 'hello' },
        resultModel: 'mail.message',
        resultId: 101,
      },
      store,
    )

    const retry = await claimOperation(input(), store)
    expect(retry.status).toBe('already_completed')
    if (retry.status !== 'already_completed') return
    expect(retry.record.envelope?.readback).toEqual({ id: 101, body: 'hello' })
    expect(retry.record.resultId).toBe(101)
    expect(store.rows()).toHaveLength(1)
  })

  it('a customer-tool retry returns the prior result too', async () => {
    const store = createFakeLedgerStore()
    const identity = { ...BASE, callerClass: 'customer_agent' as CallerClass }
    const first = await claimOperation(
      { ...input({ callerClass: 'customer_agent' }), contextRef: 'conversation-42' },
      store,
    )
    if (first.status !== 'claimed') throw new Error(first.status)

    await completeOperation(first.recordId, { envelope: envelopeOf(identity), readback: { id: 7 } }, store)

    const retry = await claimOperation(
      { ...input({ callerClass: 'customer_agent' }), contextRef: 'conversation-42' },
      store,
    )
    expect(retry.status).toBe('already_completed')
    if (retry.status !== 'already_completed') return
    expect(retry.record.envelope?.readback).toEqual({ id: 7 })
  })

  it('two simultaneous duplicates create ONE operation — the index decides, not the read', async () => {
    const store = createFakeLedgerStore()
    // Both callers pass the read; the loser hits the unique constraint.
    store.onNextInsert(async () => {
      await claimOperation(input(), store)
    })

    const second = await claimOperation(input(), store)
    expect(second.status).toBe('in_flight')
    expect(store.rows()).toHaveLength(1)
  })

  it('reports an operation already claimed by someone else as in flight', async () => {
    const store = createFakeLedgerStore()
    await claimOperation(input(), store)
    expect((await claimOperation(input(), store)).status).toBe('in_flight')
  })
})

describe('collisions that must NOT happen', () => {
  it('a staff action and a customer-agent action with the same key are separate operations', async () => {
    const store = createFakeLedgerStore()
    const staff = await claimOperation(input({ callerClass: 'foundation_staff' }), store)
    const agent = await claimOperation(input({ callerClass: 'customer_agent' }), store)

    expect(staff.status).toBe('claimed')
    expect(agent.status).toBe('claimed')
    expect(store.rows()).toHaveLength(2)
  })

  it.each([
    ['companies', { companyId: 'company-b' }],
    ['objects', { objectId: '43' }],
    ['tenants', { tenantId: 'tenant-2' }],
    ['action types', { actionType: 'task.create' }],
  ])('two different %s with the same key are separate operations', async (_label, over) => {
    const store = createFakeLedgerStore()
    await claimOperation(input(), store)
    const other = await claimOperation(input(over), store)
    expect(other.status).toBe('claimed')
    expect(store.rows()).toHaveLength(2)
  })

  it('the SAME key with DIFFERENT arguments is refused, not replayed', async () => {
    const store = createFakeLedgerStore()
    const first = await claimOperation(input({}, { body: 'the original note' }), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    await completeOperation(first.recordId, { envelope: envelopeOf(BASE), readback: { id: 1 } }, store)

    const changed = await claimOperation(input({}, { body: 'a completely different note' }), store)
    expect(changed.status).toBe('argument_conflict')
    if (changed.status !== 'argument_conflict') return
    // Handing back the earlier result here would answer a question nobody asked.
    expect(changed.detail).toMatch(/different authorised arguments/)
  })
})

describe('failure and retry', () => {
  it('a failed operation is re-claimable by default and reports what failed before', async () => {
    const store = createFakeLedgerStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    await failOperation(
      first.recordId,
      { failureClass: 'DEPENDENCY_UNAVAILABLE', detail: 'odoo unreachable' },
      store,
    )

    const again = await claimOperation(input(), store)
    expect(again.status).toBe('retry_after_failure')
    if (again.status !== 'retry_after_failure') return
    expect(again.previousFailureClass).toBe('DEPENDENCY_UNAVAILABLE')
    expect(store.rows()).toHaveLength(1)
  })

  it('a failed operation is NOT re-claimable when the caller forbids it', async () => {
    const store = createFakeLedgerStore()
    const first = await claimOperation(input(), store)
    if (first.status !== 'claimed') throw new Error(first.status)
    await failOperation(first.recordId, { failureClass: 'EXECUTION_FAILED', detail: 'refused' }, store)

    const again = await claimOperation({ ...input(), retryFailed: false }, store)
    expect(again.status).toBe('previously_failed')
    if (again.status !== 'previously_failed') return
    expect(again.failureClass).toBe('EXECUTION_FAILED')
    expect(again.failureDetail).toBe('refused')
  })

  it('a pending operation is never executed twice while it is still pending', async () => {
    const store = createFakeLedgerStore()
    await claimOperation(input(), store)
    for (let i = 0; i < 3; i++) {
      expect((await claimOperation(input(), store)).status).toBe('in_flight')
    }
    expect(store.rows()).toHaveLength(1)
  })
})

describe('what the record keeps', () => {
  it('keeps the audit reference and the authoritative readback', async () => {
    const store = createFakeLedgerStore()
    const claimed = await claimOperation({ ...input(), auditRef: 'audit-9' }, store)
    if (claimed.status !== 'claimed') throw new Error(claimed.status)

    const done = await completeOperation(
      claimed.recordId,
      {
        envelope: { ...envelopeOf(BASE), auditRef: 'audit-9' },
        readback: { id: 101, body: 'hello' },
        resultModel: 'mail.message',
        resultId: 101,
      },
      store,
    )

    expect(done.envelope?.auditRef).toBe('audit-9')
    expect(done.envelope?.readback).toEqual({ id: 101, body: 'hello' })
    expect(done.state).toBe('completed')
    expect(done.completedAt).not.toBeNull()
  })

  it('keeps caller class, company and object on the record', async () => {
    const store = createFakeLedgerStore()
    const claimed = await claimOperation(input({ callerClass: 'customer_agent' }), store)
    if (claimed.status !== 'claimed') throw new Error(claimed.status)
    expect(store.rows()[0].envelope).toMatchObject({
      callerClass: 'customer_agent',
      companyId: 'company-epic',
      objectType: 'res.partner',
      objectId: '42',
      actorRef: 'principal-7',
    })
  })

  it('leaves an unproven readback null rather than inventing success', async () => {
    const store = createFakeLedgerStore()
    const claimed = await claimOperation(input(), store)
    if (claimed.status !== 'claimed') throw new Error(claimed.status)
    const done = await completeOperation(
      claimed.recordId,
      { envelope: envelopeOf(BASE), readback: null },
      store,
    )
    expect(done.envelope?.readback).toBeNull()
  })
})

describe('the ledger is neutral', () => {
  const src = readFileSync(join(__dirname, 'ledger.ts'), 'utf8')
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const code = noComments.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

  it('knows nothing about channels, providers or customer identity', () => {
    expect(noComments).not.toMatch(/whatsapp|telegram|twilio|graph\.facebook|agents\.epic\.dm/i)
    expect(noComments).not.toMatch(/handset|wa_id|msisdn/i)
    expect(noComments).not.toMatch(/chatwoot|clawith/i)
  })

  it('sends nothing and reaches no network', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\b(sendMessage|deliver|enqueueMessage|reply)\s*\(/)
  })

  it('is not bound to one executor family', () => {
    expect(code).not.toMatch(/note\.create|lead\.create|business-note|lead-create/)
  })
})
