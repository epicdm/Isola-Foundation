import { describe, expect, it } from 'vitest'

import type { SectionResult } from '@/lib/context/context-bundle'
import type { ActionOutcome } from '@/lib/governed/action'
import type { WorkOutcome } from '@/lib/activity/sources/staff-work-action'

import {
  ACTION_LIFECYCLE_STATES,
  FORM_ONLY_STATES,
  LIFECYCLE_PRESENTATION,
  fromActionOutcome,
  fromApprovalVerdict,
  fromClaimStatus,
  fromWorkOutcome,
  isProvenSuccess,
  mayHaveWritten,
  presentLifecycle,
  sectionHasContent,
  sectionIsUnknown,
  viewSection,
  type ActionLifecycleState,
  type ClaimStatus,
} from './contract'

const FETCHED = new Date('2026-08-01T12:00:00Z')

function ok(
  data: readonly unknown[],
  stale = false,
  source = 'odoo',
): SectionResult<readonly unknown[]> {
  return { status: 'ok', data, provenance: { source, fetchedAt: FETCHED, stale } }
}

describe('section states — “nothing here” and “we could not find out” must not look alike', () => {
  it('an unrequested section is loading, not empty', () => {
    expect(viewSection(undefined).state).toBe('loading')
  })

  it('a source that answered with nothing is empty', () => {
    const view = viewSection(ok([]))
    expect(view.state).toBe('empty')
    expect(view.count).toBe(0)
    expect(view.provenance).toEqual({ source: 'odoo', fetchedAt: FETCHED.toISOString(), stale: false })
  })

  it('a source that could not answer is unavailable, and never empty', () => {
    const view = viewSection({
      status: 'unavailable',
      reason: 'the source did not answer in time',
      source: 'invoices',
    })
    expect(view.state).toBe('unavailable')
    expect(view.state).not.toBe('empty')
    expect(view.reason).toBe('the source did not answer in time')
  })

  it('empty and unavailable are distinguishable by state alone', () => {
    expect(viewSection(ok([])).state).not.toBe(
      viewSection({ status: 'unavailable', reason: 'down', source: 's' }).state,
    )
  })

  it('a forbidden section discloses no count, no reason and no provenance', () => {
    // A reason, a count or a timestamp would each confirm that the record
    // exists to a reader who is not allowed to know that.
    const view = viewSection({ status: 'forbidden' })
    expect(view.state).toBe('forbidden')
    expect(view.count).toBe(0)
    expect(view.reason).toBeNull()
    expect(view.provenance).toBeNull()
    expect(view.missing).toEqual([])
  })

  it('records make a section available and carry their provenance', () => {
    const view = viewSection(ok([{ id: 1 }, { id: 2 }]))
    expect(view.state).toBe('available')
    expect(view.count).toBe(2)
    expect(sectionHasContent(view)).toBe(true)
  })

  it('a stored copy is stale, and keeps what it has', () => {
    const view = viewSection(ok([{ id: 1 }], true))
    expect(view.state).toBe('stale')
    expect(view.count).toBe(1)
    expect(view.provenance?.stale).toBe(true)
  })

  it('a partial section keeps its records and names what it lost', () => {
    const view = viewSection(ok([{ id: 1 }]), { missing: ['pbx'] })
    expect(view.state).toBe('partial')
    expect(view.count).toBe(1)
    expect(view.missing).toEqual(['pbx'])
    expect(view.reason).toContain('one part')
  })

  it('partial outranks stale — losing a part is the more important fact', () => {
    expect(viewSection(ok([{ id: 1 }], true), { missing: ['pbx'] }).state).toBe('partial')
  })

  it('a retry in flight sits on top of the answer already on screen', () => {
    const view = viewSection(ok([{ id: 1 }]), { retrying: true })
    expect(view.state).toBe('retrying')
    expect(view.count).toBe(1)
  })

  it('an answer this view cannot read is an error, not an empty section', () => {
    const view = viewSection({
      status: 'ok',
      data: { not: 'an array' } as unknown as readonly unknown[],
      provenance: { source: 'odoo', fetchedAt: FETCHED, stale: false },
    })
    expect(view.state).toBe('error')
    expect(view.state).not.toBe('empty')
  })

  it('only unavailable, error and partial mean “we do not know”', () => {
    const unknown = (r: Parameters<typeof viewSection>[0], o?: Parameters<typeof viewSection>[1]) =>
      sectionIsUnknown(viewSection(r, o))

    expect(unknown({ status: 'unavailable', reason: 'x', source: 's' })).toBe(true)
    expect(unknown(ok([{ id: 1 }]), { missing: ['pbx'] })).toBe(true)
    expect(unknown(ok([]))).toBe(false)
    expect(unknown(ok([{ id: 1 }]))).toBe(false)
    expect(unknown({ status: 'forbidden' })).toBe(false)
  })
})

describe('action lifecycle — the two rules the order calls absolute', () => {
  it('every declared state has a presentation, keyed by itself', () => {
    for (const state of ACTION_LIFECYCLE_STATES) {
      expect(presentLifecycle(state).state).toBe(state)
    }
    expect(Object.keys(LIFECYCLE_PRESENTATION).sort()).toEqual([...ACTION_LIFECYCLE_STATES].sort())
  })

  it('exactly one state is a success, and it is completed_verified', () => {
    const successes = ACTION_LIFECYCLE_STATES.filter((s) => LIFECYCLE_PRESENTATION[s].success)
    expect(successes).toEqual(['completed_verified'])
  })

  it('readback_failed is never a success and says “Written but not confirmed”', () => {
    const p = presentLifecycle('readback_failed')
    expect(p.success).toBe(false)
    expect(isProvenSuccess('readback_failed')).toBe(false)
    expect(p.label).toBe('Written but not confirmed')
    expect(p.sentence).toContain('could not read it back')
    expect(p.sentence).toContain('Do not treat this as done')
    // Re-sending may write a second time; asking again for the result may not.
    expect(p.retryWrite).toBe('unsafe')
    expect(p.retryReadback).toBe('safe')
    expect(p.escalate).toBe(true)
    expect(p.marker).not.toBe(presentLifecycle('completed_verified').marker)
  })

  it('readback_failed is the only state that may have written something', () => {
    const maybe = ACTION_LIFECYCLE_STATES.filter(mayHaveWritten)
    expect(maybe).toEqual(['readback_failed'])
  })

  it('“could not reach it” and “it refused” differ in every channel, not just colour', () => {
    const unreachable = presentLifecycle('dependency_unavailable')
    const refused = presentLifecycle('execution_failed')

    expect(unreachable.label).not.toBe(refused.label)
    expect(unreachable.sentence).not.toBe(refused.sentence)
    expect(unreachable.marker).not.toBe(refused.marker)
    expect(unreachable.tone).not.toBe(refused.tone)

    // The one bit an operator actually needs.
    expect(unreachable.retryWrite).toBe('safe')
    expect(refused.retryWrite).toBe('unsafe')

    expect(unreachable.sentence).toContain('did not refuse')
    expect(refused.sentence).toContain('rejected')
  })

  it('neither is flattened into the other', () => {
    expect(fromActionOutcome('DEPENDENCY_UNAVAILABLE')).not.toBe(
      fromActionOutcome('EXECUTION_FAILED'),
    )
  })

  it('a replay is not reported as a success of this attempt', () => {
    const p = presentLifecycle('idempotent_replay')
    expect(p.success).toBe(false)
    expect(p.showsPriorResult).toBe(true)
  })

  it('every state carries a distinct label and a non-empty marker', () => {
    const labels = ACTION_LIFECYCLE_STATES.map((s) => LIFECYCLE_PRESENTATION[s].label)
    expect(new Set(labels).size).toBe(labels.length)

    for (const state of ACTION_LIFECYCLE_STATES) {
      const p = LIFECYCLE_PRESENTATION[state]
      expect(p.label.length).toBeGreaterThan(0)
      expect(p.sentence.length).toBeGreaterThan(0)
      expect(p.marker.length).toBeGreaterThan(0)
    }
  })

  it('no state names a colour — meaning must survive monochrome', () => {
    for (const state of ACTION_LIFECYCLE_STATES) {
      const p = LIFECYCLE_PRESENTATION[state]
      expect(`${p.label} ${p.sentence}`).not.toMatch(/\b(green|red|amber|orange|yellow)\b/i)
    }
  })

  it('states sharing a tone are still told apart by their words', () => {
    const byTone = new Map<string, string[]>()
    for (const state of ACTION_LIFECYCLE_STATES) {
      const p = LIFECYCLE_PRESENTATION[state]
      byTone.set(p.tone, [...(byTone.get(p.tone) ?? []), p.label])
    }
    for (const labels of byTone.values()) {
      expect(new Set(labels).size).toBe(labels.length)
    }
  })
})

describe('mappings are total over the real source contracts', () => {
  const ACTION_OUTCOMES: readonly ActionOutcome[] = [
    'EXECUTED',
    'VALIDATION_FAILED',
    'PERMISSION_DENIED',
    'APPROVAL_REQUIRED',
    'APPROVAL_REJECTED',
    'EXECUTOR_UNAVAILABLE',
    'EXECUTION_FAILED',
    'READBACK_FAILED',
    'IDEMPOTENT_REPLAY',
    'DEPENDENCY_UNAVAILABLE',
  ]

  const CLAIM_STATUSES: readonly ClaimStatus[] = [
    'claimed',
    'already_completed',
    'in_flight',
    'argument_conflict',
    'previously_failed',
    'retry_after_failure',
  ]

  const WORK_OUTCOMES: readonly WorkOutcome[] = [
    'completed_verified',
    'readback_failed',
    'dependency_unavailable',
    'execution_failed',
    'in_progress',
  ]

  it('every ActionOutcome lands on a declared state', () => {
    for (const outcome of ACTION_OUTCOMES) {
      expect(ACTION_LIFECYCLE_STATES).toContain(fromActionOutcome(outcome))
    }
    expect(fromActionOutcome('EXECUTED')).toBe('completed_verified')
    expect(fromActionOutcome('READBACK_FAILED')).toBe('readback_failed')
    // Present in the contract, absent from the order's thirteen. Mapped, not dropped.
    expect(fromActionOutcome('EXECUTOR_UNAVAILABLE')).toBe('executor_unavailable')
  })

  it('every ClaimOutcome status lands on a declared state', () => {
    for (const status of CLAIM_STATUSES) {
      expect(ACTION_LIFECYCLE_STATES).toContain(fromClaimStatus(status))
    }
    // argument_conflict exists only here, not in ActionOutcome.
    expect(fromClaimStatus('argument_conflict')).toBe('argument_conflict')
    expect(fromClaimStatus('already_completed')).toBe('idempotent_replay')
    expect(fromClaimStatus('in_flight')).toBe('executing')
  })

  it('every WorkOutcome lands on a declared state', () => {
    for (const outcome of WORK_OUTCOMES) {
      expect(ACTION_LIFECYCLE_STATES).toContain(fromWorkOutcome(outcome))
    }
    expect(fromWorkOutcome('readback_failed')).toBe('readback_failed')
    expect(fromWorkOutcome('in_progress')).toBe('executing')
  })

  it('an approval that nobody has answered differs from one nobody has been asked', () => {
    expect(fromApprovalVerdict('none')).toBe('approval_required')
    expect(fromApprovalVerdict('pending')).toBe('approval_pending')
    expect(fromApprovalVerdict('rejected')).toBe('approval_rejected')
    expect(fromApprovalVerdict('granted')).toBe('executing')
  })

  it('no source can produce a form-only state', () => {
    const produced: ActionLifecycleState[] = [
      ...ACTION_OUTCOMES.map(fromActionOutcome),
      ...CLAIM_STATUSES.map(fromClaimStatus),
      ...WORK_OUTCOMES.map(fromWorkOutcome),
    ]
    for (const formOnly of FORM_ONLY_STATES) {
      expect(produced).not.toContain(formOnly)
    }
    expect(FORM_ONLY_STATES).toEqual(['draft'])
  })
})
