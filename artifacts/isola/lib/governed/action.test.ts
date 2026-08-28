import { describe, expect, it, vi } from 'vitest'

import {
  DependencyUnavailable,
  WriteIndeterminate,
  runGovernedAction,
  type ActionExecutor,
  type ActionPorts,
  type ActionProposal,
} from './action'

const PROPOSAL: ActionProposal = {
  actionType: 'note.create',
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
    actionType: 'note.create',
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

  it('never claims success when readback THROWS, and names the id written', async () => {
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [
          executor({
            readback: async () => {
              throw new Error('odoo read timeout')
            },
          }),
        ],
      }),
    )
    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.detail).toContain('note-9')
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

describe('governed action — a dependency being down is its own outcome', () => {
  it('DEPENDENCY_UNAVAILABLE when the system of record is unreachable', async () => {
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [
          executor({
            execute: async () => {
              throw new DependencyUnavailable('odoo', 'ECONNREFUSED')
            },
          }),
        ],
      }),
    )
    expect(r.outcome).toBe('DEPENDENCY_UNAVAILABLE')
    expect(r.detail).toContain('odoo')
  })

  it('EXECUTION_FAILED when the write was refused, NOT the same as down', async () => {
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [
          executor({
            execute: async () => {
              throw new Error('field customer_id is required')
            },
          }),
        ],
      }),
    )
    expect(r.outcome).toBe('EXECUTION_FAILED')
  })

  it('READBACK_FAILED when the write MAY have landed — not DEPENDENCY_UNAVAILABLE', async () => {
    // The third case. A timeout on a POST proves neither that the write was
    // refused nor that it never arrived. Reporting it as "not reached, nothing
    // written, trying again is reasonable" is what sent a customer the same
    // document twice. READBACK_FAILED's presentation says the true thing:
    // something was written, we cannot prove what, re-sending is unsafe.
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [
          executor({
            execute: async () => {
              throw new WriteIndeterminate('chatwoot', 'The operation was aborted due to timeout')
            },
          }),
        ],
      }),
    )
    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.outcome).not.toBe('DEPENDENCY_UNAVAILABLE')
    expect(r.detail).toContain('chatwoot')
  })

  it('CONTROL: the three failure kinds produce three DIFFERENT outcomes', async () => {
    // Without this, all three assertions above would still pass against a
    // runtime that had been broken to answer READBACK_FAILED for everything.
    const outcomeFor = async (thrown: unknown) =>
      (
        await runGovernedAction(
          PROPOSAL,
          ports({
            executors: [
              executor({
                execute: async () => {
                  throw thrown
                },
              }),
            ],
          }),
        )
      ).outcome

    const down = await outcomeFor(new DependencyUnavailable('odoo', 'ECONNREFUSED'))
    const refused = await outcomeFor(new Error('field customer_id is required'))
    const unknown = await outcomeFor(new WriteIndeterminate('chatwoot', 'aborted'))

    expect(new Set([down, refused, unknown]).size).toBe(3)
    expect(down).toBe('DEPENDENCY_UNAVAILABLE')
    expect(refused).toBe('EXECUTION_FAILED')
    expect(unknown).toBe('READBACK_FAILED')
  })

  it('neither failure returns an empty success', async () => {
    for (const thrown of [
      new DependencyUnavailable('odoo', 'down'),
      new Error('refused'),
      new WriteIndeterminate('chatwoot', 'aborted'),
    ]) {
      const r = await runGovernedAction(
        PROPOSAL,
        ports({
          executors: [
            executor({
              execute: async () => {
                throw thrown
              },
            }),
          ],
        }),
      )
      expect(r.outcome).not.toBe('EXECUTED')
      expect(r.readback).toBeNull()
    }
  })
})

describe('governed action — authorization, validation, approval', () => {
  it('refuses a role that may not propose the action', async () => {
    const r = await runGovernedAction(
      { ...PROPOSAL, actorRole: 'staff' },
      ports({ executors: [executor({ allowedRoles: ['owner'] })] }),
    )
    expect(r.outcome).toBe('PERMISSION_DENIED')
  })

  it('refuses an invalid payload before touching the executor', async () => {
    const execute = vi.fn(async () => ({ externalId: 'x' }))
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        executors: [
          executor({ validate: () => ({ ok: false, detail: 'body required' }), execute }),
        ],
      }),
    )
    expect(r.outcome).toBe('VALIDATION_FAILED')
    expect(execute).not.toHaveBeenCalled()
  })

  it('holds for approval and does NOT execute', async () => {
    const execute = vi.fn(async () => ({ externalId: 'x' }))
    const r = await runGovernedAction(
      PROPOSAL,
      ports({ approvalRequired: () => true, executors: [executor({ execute })] }),
    )
    expect(r.outcome).toBe('APPROVAL_REQUIRED')
    expect(r.approvalId).toBe('appr-1')
    expect(execute).not.toHaveBeenCalled()
  })

  it('a GRANTED approval falls through and executes', async () => {
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        approvalRequired: () => true,
        approvalVerdict: async () => ({ state: 'granted', approvalId: 'appr-7' }),
      }),
    )
    expect(r.outcome).toBe('EXECUTED')
  })

  it('a REJECTED approval is its own outcome and executes nothing', async () => {
    const execute = vi.fn(async () => ({ externalId: 'x' }))
    const r = await runGovernedAction(
      PROPOSAL,
      ports({
        approvalRequired: () => true,
        approvalVerdict: async () => ({
          state: 'rejected',
          approvalId: 'appr-9',
          reason: 'not this customer',
        }),
        executors: [executor({ execute })],
      }),
    )
    expect(r.outcome).toBe('APPROVAL_REJECTED')
    expect(r.approvalId).toBe('appr-9')
    expect(r.detail).toContain('not this customer')
    expect(execute).not.toHaveBeenCalled()
  })

  it('treats an undeclared action type as VALIDATION_FAILED, at high risk', async () => {
    const r = await runGovernedAction({ ...PROPOSAL, actionType: 'wire.transfer' }, ports())
    expect(r.outcome).toBe('VALIDATION_FAILED')
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
    expect(second.outcome).toBe('IDEMPOTENT_REPLAY')
    expect(second.readback).toEqual(first.readback)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('checks idempotency BEFORE authorization, so a retry cannot be re-judged', async () => {
    const first = await runGovernedAction(PROPOSAL, ports())
    const r = await runGovernedAction(
      { ...PROPOSAL, actorRole: 'nobody' },
      ports({ findPriorResult: async () => first }),
    )
    expect(r.outcome).toBe('IDEMPOTENT_REPLAY')
  })

  it('requires an idempotency key', async () => {
    const r = await runGovernedAction({ ...PROPOSAL, idempotencyKey: '' }, ports())
    expect(r.outcome).toBe('VALIDATION_FAILED')
  })
})
