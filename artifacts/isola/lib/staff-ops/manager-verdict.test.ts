/**
 * manager-verdict.test.ts — the Approve / Return codec.
 *
 * The property this file exists to protect is that the two codecs cannot read
 * each other. A staff id names a work episode; a manager id names a
 * verification activity. If either decoder ever accepted the other's shape, the
 * result would be a verdict applied against a task id — a silent, plausible,
 * wrong write. Every "must be null" case below is that failure mode in
 * miniature.
 */

import { describe, it, expect } from 'vitest'
import {
  buildManagerVerdictMenu,
  decodeManagerVerdictId,
  encodeManagerVerdictId,
  encodeManagerVerdictTemplatePayload,
  managerVerdictLabel,
} from './manager-verdict'
import { WA_LIMITS, decodeMenuId, encodeMenuId } from './staff-menu'

const ACTIVITY = 71993
const CORR = 'sw-ba290d79-task-2291-1l3wmq8'

describe('manager verdict codec', () => {
  it('round-trips a valid Approve', () => {
    const id = encodeManagerVerdictId('approve', ACTIVITY)
    expect(id).toBe('mv:approve:71993')
    expect(decodeManagerVerdictId(id)).toEqual({ verdict: 'approve', activityId: ACTIVITY })
  })

  it('round-trips a valid Return', () => {
    const id = encodeManagerVerdictId('return', ACTIVITY)
    expect(id).toBe('mv:return:71993')
    expect(decodeManagerVerdictId(id)).toEqual({ verdict: 'return', activityId: ACTIVITY })
  })

  it('refuses a malformed payload', () => {
    expect(decodeManagerVerdictId('mv:approve')).toBeNull()          // too few parts
    expect(decodeManagerVerdictId('mv:approve:1:2')).toBeNull()      // too many parts
    expect(decodeManagerVerdictId('')).toBeNull()
    expect(decodeManagerVerdictId(null)).toBeNull()
    expect(decodeManagerVerdictId(undefined)).toBeNull()
  })

  it('refuses an unsupported action', () => {
    expect(decodeManagerVerdictId(`mv:reject:${ACTIVITY}`)).toBeNull()
    expect(decodeManagerVerdictId(`mv:approved:${ACTIVITY}`)).toBeNull()
    expect(decodeManagerVerdictId(`mv:APPROVE:${ACTIVITY}`)).toBeNull()  // case is not normalised
  })

  it('refuses a reference of the WRONG TYPE — a work correlation id is not an activity', () => {
    // This is the dangerous one: it is well-formed, it is a real identifier
    // used elsewhere in this system, and a lax parser would accept it.
    expect(decodeManagerVerdictId(`mv:approve:${CORR}`)).toBeNull()
    expect(decodeManagerVerdictId('mv:approve:2291a')).toBeNull()
    expect(decodeManagerVerdictId('mv:approve:-5')).toBeNull()
    expect(decodeManagerVerdictId('mv:approve:0')).toBeNull()
    expect(decodeManagerVerdictId('mv:approve:1.5')).toBeNull()
  })

  it('refuses a missing reference', () => {
    expect(decodeManagerVerdictId('mv:approve:')).toBeNull()
    expect(decodeManagerVerdictId('mv::71993')).toBeNull()
  })

  it('refuses a tampered or foreign payload', () => {
    expect(decodeManagerVerdictId('sa:approve:71993')).toBeNull()     // staff prefix
    expect(decodeManagerVerdictId('MV:approve:71993')).toBeNull()     // prefix case
    expect(decodeManagerVerdictId('flow_token:whatever')).toBeNull()
    expect(decodeManagerVerdictId('x:approve:71993')).toBeNull()
  })

  it('THE SPLIT HOLDS: neither decoder can read the other codec', () => {
    // A manager id must not decode as a staff action...
    expect(decodeMenuId(encodeManagerVerdictId('approve', ACTIVITY))).toBeNull()
    expect(decodeMenuId(encodeManagerVerdictId('return', ACTIVITY))).toBeNull()
    // ...and a staff id must not decode as a verdict.
    for (const action of ['ack', 'start', 'update', 'blocked', 'done'] as const) {
      expect(decodeManagerVerdictId(encodeMenuId(action, CORR))).toBeNull()
    }
  })

  it('refuses to mint against a reference that is not a positive integer', () => {
    expect(() => encodeManagerVerdictId('approve', 0)).toThrow(/positive integer/)
    expect(() => encodeManagerVerdictId('approve', -1)).toThrow(/positive integer/)
    expect(() => encodeManagerVerdictId('approve', 1.5)).toThrow(/positive integer/)
    expect(() => encodeManagerVerdictId('approve', NaN)).toThrow(/positive integer/)
  })

  it('a real activity id fits both the interactive and the template ceiling', () => {
    const id = encodeManagerVerdictTemplatePayload('return', ACTIVITY)
    expect(id.length).toBeLessThanOrEqual(WA_LIMITS.templateButtonPayload)
    expect(WA_LIMITS.templateButtonPayload).toBeLessThan(WA_LIMITS.buttonId)
  })
})

describe('manager verdict menu', () => {
  it('is always exactly two inline buttons, never a list', () => {
    const menu = buildManagerVerdictMenu(ACTIVITY)
    expect(menu.kind).toBe('buttons')
    if (menu.kind !== 'buttons') throw new Error('unreachable')
    expect(menu.items).toHaveLength(2)
    expect(menu.items.map((i) => i.id)).toEqual([
      encodeManagerVerdictId('approve', ACTIVITY),
      encodeManagerVerdictId('return', ACTIVITY),
    ])
    expect(menu.items.map((i) => i.action)).toEqual(['approve', 'return'])
  })

  it('every title is inside Meta’s button-title limit', () => {
    const menu = buildManagerVerdictMenu(ACTIVITY)
    if (menu.kind !== 'buttons') throw new Error('unreachable')
    for (const item of menu.items) {
      expect(item.title.length).toBeLessThanOrEqual(WA_LIMITS.buttonTitle)
      expect(item.description.length).toBeLessThanOrEqual(WA_LIMITS.rowDescription)
    }
  })

  it('Return reads as rework, not rejection', () => {
    // Deliberate copy choice: the work goes back to the person who did it.
    expect(managerVerdictLabel('return')).toBe('Return for rework')
    expect(managerVerdictLabel('approve')).toBe('Approve')
  })
})
