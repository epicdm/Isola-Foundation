import { describe, expect, it, vi } from 'vitest'

import {
  runGovernedAction,
  type ActionExecutor,
  type ActionPorts,
  type ActionProposal,
} from './action'

const PROPOSAL: ActionProposal = {
  actionType: 'note.add',
  actorPrincipalId: 'p-1',
  actorRole: 'staff',
  companyId: 'co-1',
  objectType: 'customer',
  objectId: 'cust-1',
  payload: { body: 'called the customer' },
  idempotencyKey: 'idem-1',
  correlationId: 'c-1',
}

function executor(over: Partial<ActionExecutor> = {}): ActionExecutor {
  return {
    actionType: 'note.add',
    riskLevel: 'low',
    allowedRoles: ['staff', 'manager', 'owner'],
    validate: () => ({ ok: true }),
    execute: async () => ({ externalId: 'note-9' }),
    readback: async (id) => ({ id, body: 'called the customer' }),
    ...over,
  }
}

function ports(over: Partial<ActionPorts> = {}): ActionPorts {
  return {
    executors: [executor()],
    approvalRequired: () => false,
    findPriorResult: async () => null,
    recordApprovalRequest: async () => 'appr-1',
    writeAudit: async () => 'audit-1',
    ...over,
  }
}

describe('governed action — the happy path proves itself by readback', () => {
  it('EXECUTED carries the record read back from the system of record', async () => {
    const r = await runGovernedAction(PROPOSAL, ports())
    expect(r.outcome).toBe('EXECUTED')
    expect(r.readback).toEqual({ id: 'note-9', body: 'called the customer' })
    expect(r.auditId).toBe('audit-1')
  })

  it('never claims success when readback comes back empty', async () => {
    const r = await runGovernedAction(
      PROPOSAL,
      ports({ executors: [executor({ readback: async () => null })] }),
    )
    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.readback).toBeNull()
  })
})

describe('governed action — an unimplemented executor says so', () => {
  it('returns EXECUTOR_UNAVAILABLE rather than false success', async () => {
    const declared = executor({ execute: undefined, readback: undefined })
    const r = await runGovernedAction(PROPOSAL, ports({ executors: [declared] }))
    expect(r.outcome).toBe('EXECUTOR_UNAVAILABLE')
    expect(r.readback).toBeNull()
    expect(r.detail).toMatch(/nothing was performed/)
  })

  it('still writes an audit entry when nothing was performed', async () => {
    // Captured rather than spied: the point of the assertion is WHAT was audited,
    // and a plain closure types the entry without fighting the mock generics.
    const audited: string[] = []
    await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [executor({ execute: undefined, readback: undefined })],
        writeAudit: async (entry) => {
          audited.push(entry.outcome)
          return 'audit-x'
        },
      }),
    )
    expect(audited).toEqual(['EXECUTOR_UNAVAILABLE'])
  })
})

describe('governed action — authorization, validation, approval', () => {
  it('refuses a role that may not propose the action', async () => {
    const r = await runGovernedAction(
      { ...PROPOSAL, actorRole: 'staff' },
      ports({ executors: [executor({ allowedRoles: ['owner'] })] }),
    )
    expect(r.outcome).toBe('UNAUTHORIZED')
  })

  it('refuses an invalid payload before touching the executor', async () => {
    const execute = vi.fn(async () => ({ externalId: 'x' }))
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [executor({ validate: () => ({ ok: false, detail: 'body required' }), execute })],
      }),
    )
    expect(r.outcome).toBe('INVALID')
    expect(execute).not.toHaveBeenCalled()
  })

  it('holds for approval and does NOT execute', async () => {
    const execute = vi.fn(async () => ({ externalId: 'x' }))
    const r = await runGovernedAction(
      PROPOSAL,
      ports({ approvalRequired: () => true, executors: [executor({ execute })] }),
    )
    expect(r.outcome).toBe('AWAITING_APPROVAL')
    expect(r.approvalId).toBe('appr-1')
    expect(execute).not.toHaveBeenCalled()
  })

  it('treats an undeclared action type as INVALID, at high risk', async () => {
    const r = await runGovernedAction({ ...PROPOSAL, actionType: 'wire.transfer' }, ports())
    expect(r.outcome).toBe('INVALID')
    expect(r.riskLevel).toBe('high')
  })
})

describe('governed action — idempotency', () => {
  it('replays a prior result instead of executing twice', async () => {
    const execute = vi.fn(async () => ({ externalId: 'note-9' }))
    const first = await runGovernedAction(PROPOSAL, ports({ executors: [executor({ execute })] }))
    const second = await runGovernedAction(
      PROPOSAL,
      ports({ executors: [executor({ execute })], findPriorResult: async () => first }),
    )
    expect(second.outcome).toBe('DUPLICATE_IGNORED')
    expect(second.readback).toEqual(first.readback)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('checks idempotency BEFORE authorization, so a retry cannot be re-judged', async () => {
    const first = await runGovernedAction(PROPOSAL, ports())
    const r = await runGovernedAction(
      { ...PROPOSAL, actorRole: 'nobody' },
      ports({ findPriorResult: async () => first }),
    )
    expect(r.outcome).toBe('DUPLICATE_IGNORED')
  })

  it('requires an idempotency key', async () => {
    const r = await runGovernedAction({ ...PROPOSAL, idempotencyKey: '' }, ports())
    expect(r.outcome).toBe('INVALID')
  })
})
