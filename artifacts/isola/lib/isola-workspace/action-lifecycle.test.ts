import { describe, expect, it } from 'vitest'

import {
  ACTION_STATE_FAMILY,
  ACTION_STATE_LABEL,
  ActionLifecycleError,
  assertActionInvariants,
  canTransition,
  offersRetry,
  transition,
  type GovernedActionInstance,
  type Readback,
} from './action-lifecycle'

const readback: Readback = {
  system: 'salesRecords',
  statement:
    "Reminder 'Follow up on package pricing' now exists on the Joss Boutique record, assigned to Eric Giraud, due 7 Aug 2026.",
  readAt: '2026-08-06T09:31:00-04:00',
}

function action(over: Partial<GovernedActionInstance> = {}): GovernedActionInstance {
  return {
    id: 'wk-1',
    title: 'Add a follow-up reminder on the sales record',
    state: 'awaitingApproval',
    requestedBy: { name: 'Atlas', kind: 'ai' },
    consequence: 'A reminder is added to the sales record. Nothing is sent to the customer.',
    ...over,
  }
}

describe('the completed-requires-readback rule', () => {
  it('REFUSES to construct a completed action without a readback', () => {
    // This is the guarantee that makes "Done and confirmed" trustworthy in the UI: a
    // completed state without proof cannot be constructed, so a badge rendering it cannot
    // be lying.
    expect(() =>
      assertActionInvariants(action({ state: 'completed', readback: null })),
    ).toThrow(/without an authoritative readback/)
  })

  it('refuses a readback with no timestamp — a readback without a time is not evidence', () => {
    expect(() =>
      assertActionInvariants(
        action({ state: 'completed', readback: { ...readback, readAt: '' } }),
      ),
    ).toThrow(/without an authoritative readback/)
  })

  it('refuses a readback with an empty statement', () => {
    expect(() =>
      assertActionInvariants(
        action({ state: 'completed', readback: { ...readback, statement: '   ' } }),
      ),
    ).toThrow()
  })

  it('accepts a completed action carrying a full readback', () => {
    expect(() =>
      assertActionInvariants(action({ state: 'completed', readback })),
    ).not.toThrow()
  })

  it('refuses a readback attached to a state that is not completed', () => {
    // Otherwise a UI could render success while the action is still in flight.
    expect(() => assertActionInvariants(action({ state: 'executing', readback }))).toThrow(
      /may only accompany "completed"/,
    )
  })
})

describe('executing is not success', () => {
  it('uses the info family, never ok', () => {
    expect(ACTION_STATE_FAMILY.executing).toBe('info')
    expect(ACTION_STATE_FAMILY.executing).not.toBe('ok')
  })

  it('is the only state that reaches completed, and only with a readback', () => {
    expect(canTransition('executing', 'completed')).toBe(true)
    expect(() => transition(action({ state: 'executing' }), 'completed')).toThrow(
      ActionLifecycleError,
    )
    expect(() =>
      transition(action({ state: 'executing' }), 'completed', { readback }),
    ).not.toThrow()
  })

  it('cannot go back to awaiting approval — re-approving in-flight work duplicates effects', () => {
    expect(canTransition('executing', 'awaitingApproval')).toBe(false)
  })
})

describe('an AI may prepare an action but never approve one', () => {
  it('allows an AI as the requester', () => {
    expect(() =>
      assertActionInvariants(action({ requestedBy: { name: 'Atlas', kind: 'ai' } })),
    ).not.toThrow()
  })

  it('REFUSES an AI as the approver', () => {
    expect(() =>
      assertActionInvariants(action({ approvedBy: { name: 'Atlas', kind: 'ai' } })),
    ).toThrow(/approved by an AI employee/)
  })

  it('allows a named human as the approver', () => {
    expect(() =>
      assertActionInvariants(action({ approvedBy: { name: 'Eric Giraud', kind: 'human' } })),
    ).not.toThrow()
  })
})

describe('blocked, failed and unconfirmed must explain themselves', () => {
  it('blocked requires an explanation', () => {
    expect(() => assertActionInvariants(action({ state: 'blocked' }))).toThrow(/explanation/)
  })

  it('failed requires BOTH what did not change and what the customer still believes', () => {
    expect(() =>
      assertActionInvariants(action({ state: 'failed', explanation: 'The change was rejected.' })),
    ).toThrow(/what the customer still believes/)

    expect(() =>
      assertActionInvariants(
        action({
          state: 'failed',
          explanation: 'The phone system did not accept the change, so nothing was changed.',
          customerImpact: 'The café is still on the daytime menu.',
        }),
      ),
    ).not.toThrow()
  })

  it('unconfirmed requires an explanation', () => {
    expect(() => assertActionInvariants(action({ state: 'unconfirmed' }))).toThrow(/explanation/)
  })
})

describe('retry honesty', () => {
  it('offers retry only for a failed action', () => {
    expect(offersRetry('failed')).toBe(true)
    // We do not know whether the effect landed; retrying risks doing it twice.
    expect(offersRetry('unconfirmed')).toBe(false)
    expect(offersRetry('completed')).toBe(false)
    expect(offersRetry('blocked')).toBe(false)
  })

  it('makes unconfirmed terminal with no onward transition', () => {
    for (const to of ['completed', 'failed', 'executing', 'blocked'] as const) {
      expect(canTransition('unconfirmed', to)).toBe(false)
    }
  })
})

describe('every governed action states its consequence', () => {
  it('refuses an action with no consequence', () => {
    expect(() => assertActionInvariants(action({ consequence: '' }))).toThrow(/consequence/)
  })
})

describe('the operator-facing vocabulary is exact', () => {
  it('uses the reviewed plain-language labels, not product language', () => {
    expect(ACTION_STATE_LABEL.completed).toBe('Done and confirmed')
    expect(ACTION_STATE_LABEL.failed).toBe('Did not work')
    expect(ACTION_STATE_LABEL.awaitingApproval).toBe('Awaiting your approval')
    expect(ACTION_STATE_LABEL.executing).toBe('Running now')
    expect(ACTION_STATE_LABEL.unconfirmed).toBe('Not confirmed')
    expect(ACTION_STATE_LABEL.proposed).toBe('To do')
  })

  it('never uses the forbidden alternatives', () => {
    const forbidden = ['Completed', 'Success', 'Error', 'Pending', 'Processing', 'Sent', 'Delivered']
    for (const label of Object.values(ACTION_STATE_LABEL)) {
      expect(forbidden).not.toContain(label)
    }
  })
})

describe('transition returns a new instance', () => {
  it('never mutates the input', () => {
    const original = action({ state: 'awaitingApproval' })
    const next = transition(original, 'executing')
    expect(original.state).toBe('awaitingApproval')
    expect(next.state).toBe('executing')
  })

  it('rejects an illegal transition', () => {
    expect(() => transition(action({ state: 'blocked' }), 'completed')).toThrow(
      ActionLifecycleError,
    )
  })
})
