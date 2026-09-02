import { describe, it, expect } from 'vitest'
import {
  WORK_REF_MODELS,
  formatWorkRef,
  isWorkRefModel,
  makeWorkRef,
  mintCorrelationId,
  parseWorkRef,
} from './work-ref'

describe('WorkRef — the Odoo-only work contract', () => {
  it('admits exactly the three ratified Odoo models and nothing else', () => {
    expect([...WORK_REF_MODELS]).toEqual(['project.task', 'mail.activity', 'helpdesk.ticket'])
    expect(isWorkRefModel('project.task')).toBe(true)
    expect(isWorkRefModel('mail.activity')).toBe(true)
    expect(isWorkRefModel('helpdesk.ticket')).toBe(true)
    // The whole point of the decision: nothing from the legacy authority is a model.
    expect(isWorkRefModel('epic_work_items')).toBe(false)
    expect(isWorkRefModel('EpicWorkItem')).toBe(false)
    expect(isWorkRefModel('res.partner')).toBe(false)
    expect(isWorkRefModel('')).toBe(false)
    expect(isWorkRefModel(undefined)).toBe(false)
  })

  it('round-trips the canonical string form', () => {
    const ref = { odooModel: 'project.task' as const, odooId: 2292, correlationId: 'sw-abc-task-2292-xyz' }
    const s = formatWorkRef(ref)
    expect(s).toBe('project.task#2292@sw-abc-task-2292-xyz')
    const parsed = parseWorkRef(s)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) expect(parsed.workRef).toEqual(ref)
  })

  it('fails closed on every malformed or non-Odoo reference', () => {
    // An OPS- reference is not a WorkRef and must not become one by accident.
    expect(parseWorkRef('OPS-000053')).toEqual({ ok: false, reason: 'malformed' })
    expect(parseWorkRef('epic_work_items#53@c1')).toEqual({ ok: false, reason: 'unknown_model' })
    expect(parseWorkRef('project.task#0@c1')).toEqual({ ok: false, reason: 'invalid_id' })
    expect(parseWorkRef('project.task#-4@c1')).toEqual({ ok: false, reason: 'malformed' })
    expect(parseWorkRef('project.task#12')).toEqual({ ok: false, reason: 'malformed' })
    expect(parseWorkRef('')).toEqual({ ok: false, reason: 'malformed' })
  })

  it('makeWorkRef validates model, id and correlation id', () => {
    expect(makeWorkRef('project.task', 2292, 'c1').ok).toBe(true)
    expect(makeWorkRef('epic_work_items', 53, 'c1')).toEqual({ ok: false, reason: 'unknown_model' })
    expect(makeWorkRef('project.task', 0, 'c1')).toEqual({ ok: false, reason: 'invalid_id' })
    expect(makeWorkRef('project.task', 1.5, 'c1')).toEqual({ ok: false, reason: 'invalid_id' })
    expect(makeWorkRef('project.task', 2292, '   ')).toEqual({ ok: false, reason: 'missing_correlation_id' })
  })

  it('mints a correlation id that names its tenant and record but is not a work id', () => {
    const id = mintCorrelationId('43b006e4-33e0-42a8-bec7-4422ba290d79', 'project.task', 2292, 'deadbeef')
    expect(id).toBe('sw-ba290d79-task-2292-deadbeef')
    // It is Foundation's own trail id — it carries no Odoo authority by itself.
    expect(parseWorkRef(id).ok).toBe(false)
  })

  it('a correlation id survives being embedded in and parsed back out of a WorkRef', () => {
    const correlationId = mintCorrelationId('tenant-1', 'mail.activity', 23, 'n0nce')
    const built = makeWorkRef('mail.activity', 23, correlationId)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    const reparsed = parseWorkRef(formatWorkRef(built.workRef))
    expect(reparsed.ok).toBe(true)
    if (reparsed.ok) expect(reparsed.workRef.correlationId).toBe(correlationId)
  })
})
