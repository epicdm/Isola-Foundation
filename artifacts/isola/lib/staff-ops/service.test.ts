import { describe, it, expect } from 'vitest'
import { stableCorrelationNonce } from './service'

describe('stableCorrelationNonce — why the correlation id must not drift', () => {
  /**
   * openWork is recomputed on every inbound message. If the correlation id
   * changed between two computations, the idempotency key for a staff action
   * would change with it, and a Meta webhook retry of the SAME inbound would
   * apply the action twice. Stability here is what makes dedupe work.
   */
  it('is stable for the same (staff, model, record)', () => {
    const a = stableCorrelationNonce('sb-epic-dev-2', 'project.task', 2292)
    const b = stableCorrelationNonce('sb-epic-dev-2', 'project.task', 2292)
    expect(a).toBe(b)
  })

  it('differs per staff member, per model and per record', () => {
    const base = stableCorrelationNonce('sb-epic-dev-2', 'project.task', 2292)
    expect(stableCorrelationNonce('sb-epic-dev-5', 'project.task', 2292)).not.toBe(base)
    expect(stableCorrelationNonce('sb-epic-dev-2', 'mail.activity', 2292)).not.toBe(base)
    expect(stableCorrelationNonce('sb-epic-dev-2', 'project.task', 2478)).not.toBe(base)
  })

  it('is short, lowercase-alphanumeric and safe inside a correlation id', () => {
    for (const id of ['sb-1', 'sb-epic-dev-10', 'x']) {
      const n = stableCorrelationNonce(id, 'project.task', 1)
      expect(n).toMatch(/^[a-z0-9]{7}$/)
    }
  })

  it('does not collide across a realistic cohort and task set', () => {
    const seen = new Set<string>()
    for (const staff of ['sb-epic-dev-2', 'sb-epic-dev-5', 'sb-epic-dev-6', 'sb-epic-dev-9', 'sb-epic-dev-10']) {
      for (let task = 2200; task < 2600; task++) {
        seen.add(stableCorrelationNonce(staff, 'project.task', task))
      }
    }
    expect(seen.size).toBe(5 * 400)
  })
})
