import { describe, it, expect } from 'vitest'
import {
  WA_LIMITS,
  buildMenu,
  decodeMenuId,
  deriveStageMenu,
  encodeMenuId,
  menuLabel,
} from './staff-menu'
import type { OdooWorkRecord } from './odoo-work'

const CORR = 'sw-ba290d79-task-2588-07k7i61'

function task(stageName: string | null): OdooWorkRecord {
  return {
    odooModel: 'project.task',
    odooId: 2588,
    name: 'SL 001 - Staff loop pilot: confirm WhatsApp task flow',
    projectId: 7,
    projectName: 'BFF — EPIC AI Platform (bff.epic.dm)',
    stageId: 87,
    stageName,
    assigneeUserIds: [8],
    dateDeadline: null,
    writeDate: null,
  }
}

describe('menu id — the tap carries the work reference, so it is never typed', () => {
  it('round-trips action and correlation id', () => {
    const id = encodeMenuId('done', CORR)
    expect(id).toBe(`sa:done:${CORR}`)
    expect(decodeMenuId(id)).toEqual({ action: 'done', correlationId: CORR })
  })

  it('stays inside Meta’s 256-char id limit for a real correlation id', () => {
    expect(encodeMenuId('blocked', CORR).length).toBeLessThanOrEqual(WA_LIMITS.buttonId)
  })

  it('fails closed on anything that is not exactly our shape', () => {
    expect(decodeMenuId(null)).toBeNull()
    expect(decodeMenuId('')).toBeNull()
    expect(decodeMenuId('ack')).toBeNull()
    expect(decodeMenuId(`xx:ack:${CORR}`)).toBeNull()
    expect(decodeMenuId('sa:explode:' + CORR)).toBeNull()
    expect(decodeMenuId('sa:ack:')).toBeNull()
    expect(decodeMenuId(`sa:ack:${CORR}:extra`)).toBeNull()
  })

  it('never decodes a free-text command as a tap', () => {
    expect(decodeMenuId('ACK SL 001')).toBeNull()
  })
})

describe('deriveStageMenu — the board decides what is offered', () => {
  it('offers acknowledge and start on unstarted work', () => {
    expect(deriveStageMenu(task('New'))).toEqual(['ack', 'start', 'blocked'])
    expect(deriveStageMenu(task('Inbox'))).toEqual(['ack', 'start', 'blocked'])
    expect(deriveStageMenu(task('To Do'))).toEqual(['ack', 'start', 'blocked'])
  })

  it('drops start once work is already in progress', () => {
    for (const s of ['In-Progress', 'In Progress', 'in progress', 'Doing']) {
      const menu = deriveStageMenu(task(s))
      expect(menu).toEqual(['update', 'done', 'blocked'])
      expect(menu).not.toContain('start')
    }
  })

  it('offers resume from a blocked stage', () => {
    expect(deriveStageMenu(task('Blocked'))).toEqual(['start', 'update', 'done'])
    expect(menuLabel('start', { resuming: true })).toBe('Resume work')
  })

  it('offers nothing on a terminal stage', () => {
    for (const s of ['Done', 'Solved', 'Closed', 'Cancelled']) {
      expect(deriveStageMenu(task(s))).toEqual([])
    }
  })

  it('offers a REDUCED, safe menu on an unrecognised stage — never the full set', () => {
    // Changed deliberately. The old fallback offered all five actions, which
    // advertised DONE and BLOCKED as if they were known-valid on a stage nobody
    // had classified — the same defect as advertising a command the system
    // cannot honour. ACK and UPDATE are the only two that are true wherever the
    // record sits; the rest assert something about state we do not know.
    expect(deriveStageMenu(task('Awaiting Parts'))).toEqual(['ack', 'update'])
    expect(deriveStageMenu(task(null))).toEqual(['ack', 'update'])
  })

  it('never offers blocked on a mail.activity, which cannot carry one', () => {
    const act = { ...task('New'), odooModel: 'mail.activity' as const }
    expect(deriveStageMenu(act)).toEqual(['ack', 'update', 'done'])
  })
})

describe('buildMenu — buttons up to three, list beyond', () => {
  it('renders three or fewer as inline buttons', () => {
    const m = buildMenu(task('New'), CORR)
    expect(m.kind).toBe('buttons')
    if (m.kind !== 'buttons') throw new Error('expected buttons')
    expect(m.items.map((i) => i.action)).toEqual(['ack', 'start', 'blocked'])
    expect(m.items[0].id).toBe(`sa:ack:${CORR}`)
  })

  it('renders more than three as a list, because a fourth button is a 400', () => {
    // No stage concept yields more than three actions any more, so the list
    // path is exercised with an explicit action set — which is how a caller
    // would request one.
    const m = buildMenu(task('New'), CORR, ['ack', 'start', 'update', 'blocked', 'done'])
    expect(m.kind).toBe('list')
    if (m.kind !== 'list') throw new Error('expected list')
    expect(m.items).toHaveLength(5)
  })

  it('emits nothing at all on a terminal stage', () => {
    expect(buildMenu(task('Done'), CORR)).toEqual({ kind: 'none' })
  })

  it('keeps every title inside the limit Meta enforces', () => {
    for (const stage of ['New', 'In-Progress', 'Blocked', 'Awaiting Parts']) {
      const m = buildMenu(task(stage), CORR)
      if (m.kind === 'none') continue
      const cap = m.kind === 'buttons' ? WA_LIMITS.buttonTitle : WA_LIMITS.rowTitle
      for (const it of m.items) {
        expect(it.title.length).toBeLessThanOrEqual(cap)
        expect(it.description.length).toBeLessThanOrEqual(WA_LIMITS.rowDescription)
      }
    }
  })

  it('every rendered item decodes back to its own action and this episode', () => {
    const m = buildMenu(task('New'), CORR)
    if (m.kind === 'none') throw new Error('expected a menu')
    for (const it of m.items) {
      expect(decodeMenuId(it.id)).toEqual({ action: it.action, correlationId: CORR })
    }
  })
})
