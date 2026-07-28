import { describe, it, expect } from 'vitest'
import {
  parseStaffCommand,
  staffActionIdempotencyKey,
  type OpenWorkRefCandidate,
} from './staff-action'

const TASK_A: OpenWorkRefCandidate = {
  odooModel: 'project.task',
  odooId: 2292,
  correlationId: 'sw-t1-task-2292-aaaa',
  label: 'DW 2068c — WhatsApp: confirm pricing',
}
const TASK_B: OpenWorkRefCandidate = {
  odooModel: 'project.task',
  odooId: 2478,
  correlationId: 'sw-t1-task-2478-bbbb',
  label: 'INC/26-27/2068c — WhatsApp integration',
}

describe('parseStaffCommand — the shapes a human actually sends', () => {
  it('accepts a BARE ACK against a sole open task', () => {
    // This is the exact message that returned UNKNOWN in the legacy parser and
    // is what every acceptance run sends. If this ever regresses, the loop is
    // broken again regardless of what else passes.
    const r = parseStaffCommand({ text: 'ACK', openWork: [TASK_A] })
    expect(r.matched).toBe(true)
    if (!r.matched) return
    expect(r.action).toBe('ack')
    expect(r.target.odooId).toBe(2292)
    expect(r.grammar).toBe('bare')
    expect(r.resolution).toBe('sole_open_work')
  })

  it('accepts bare verbs in any case and with trailing punctuation', () => {
    for (const text of ['ack', 'Ack', 'ACK.', 'ack!', ' acknowledge ']) {
      const r = parseStaffCommand({ text, openWork: [TASK_A] })
      expect(r.matched, `expected "${text}" to match`).toBe(true)
      if (r.matched) expect(r.action).toBe('ack')
    }
  })

  it('accepts an explicit record reference in three spellings', () => {
    for (const text of ['ACK #2478', 'ACK 2478', 'ACK project.task#2478']) {
      const r = parseStaffCommand({ text, openWork: [TASK_A, TASK_B] })
      expect(r.matched, `expected "${text}" to match`).toBe(true)
      if (!r.matched) continue
      expect(r.target.odooId).toBe(2478)
      expect(r.resolution).toBe('explicit_ref')
      expect(r.grammar).toBe('strict')
    }
  })

  it('carries a note for note-bearing verbs and drops it for ACK', () => {
    const blocked = parseStaffCommand({ text: 'BLOCKED no access to the site', openWork: [TASK_A] })
    expect(blocked.matched).toBe(true)
    if (blocked.matched) {
      expect(blocked.action).toBe('blocked')
      expect(blocked.note).toBe('no access to the site')
    }

    const ack = parseStaffCommand({ text: 'ACK will start this afternoon', openWork: [TASK_A] })
    expect(ack.matched).toBe(true)
    if (ack.matched) {
      expect(ack.action).toBe('ack')
      // ACK's meaning never depends on the remainder.
      expect(ack.note).toBeNull()
    }
  })

  it('keeps the note on DONE without letting it change the action', () => {
    const r = parseStaffCommand({ text: 'DONE replaced the printer head', openWork: [TASK_A] })
    expect(r.matched).toBe(true)
    if (!r.matched) return
    expect(r.action).toBe('done')
    expect(r.note).toBe('replaced the printer head')
  })
})

describe('parseStaffCommand — the near-miss it must keep refusing', () => {
  /**
   * The recorded near-miss: a fuzzy matcher that fires on any message
   * CONTAINING a synonym turns ordinary prose — including the owner asking a
   * business question — into a staff action. The acceptance criterion "a reply
   * arrived" would flip to PASS while nothing was acknowledged.
   */
  it('does not treat a sentence containing a verb as a command', () => {
    const prose = [
      'I think we are done with the Dragon Windows migration, what next?',
      "I can't get hold of the client, should Kim call them?",
      'Update me on the collections numbers please',
      'Has anyone acknowledged the outage yet',
      'help the team understand the new pricing',
    ]
    for (const text of prose) {
      const r = parseStaffCommand({ text, openWork: [TASK_A] })
      if (r.matched) {
        // Only a leading verb may match. "Update me on..." legitimately leads
        // with UPDATE; assert it is at least not silently retargeting.
        expect(text.toLowerCase().startsWith(r.action)).toBe(true)
      } else {
        expect(r.reason).toBe('not_a_command')
      }
    }
  })

  it('a mid-sentence "done" never produces a DONE action', () => {
    const r = parseStaffCommand({
      text: 'I think we are done with the Dragon Windows migration, what next?',
      openWork: [TASK_A],
    })
    expect(r.matched).toBe(false)
    if (!r.matched) expect(r.reason).toBe('not_a_command')
  })
})

describe('parseStaffCommand — failing closed instead of guessing', () => {
  it('refuses to guess when several tasks are open', () => {
    const r = parseStaffCommand({ text: 'ACK', openWork: [TASK_A, TASK_B] })
    expect(r.matched).toBe(false)
    if (r.matched) return
    expect(r.reason).toBe('needs_disambiguation')
    expect(r.action).toBe('ack')
    expect(r.candidates).toHaveLength(2)
  })

  it('does NOT retarget an unheld explicit reference at the sender\'s only task', () => {
    // The dangerous "helpful" behaviour: sender types a task number they do not
    // hold, and the system applies it to whatever they do hold.
    const r = parseStaffCommand({ text: 'DONE #9999', openWork: [TASK_A] })
    expect(r.matched).toBe(false)
    if (!r.matched) expect(r.reason).toBe('unknown_reference')
  })

  it('reports no_open_work rather than matching into the void', () => {
    const r = parseStaffCommand({ text: 'ACK', openWork: [] })
    expect(r.matched).toBe(false)
    if (!r.matched) {
      expect(r.reason).toBe('no_open_work')
      expect(r.action).toBe('ack')
    }
  })

  it('ignores a model-qualified reference for a model the sender does not hold', () => {
    const r = parseStaffCommand({ text: 'ACK mail.activity#2292', openWork: [TASK_A] })
    expect(r.matched).toBe(false)
    if (!r.matched) expect(r.reason).toBe('unknown_reference')
  })

  it('treats an unparseable model as not-a-reference rather than a wildcard', () => {
    const r = parseStaffCommand({ text: 'ACK epic_work_items#53', openWork: [TASK_A] })
    // Not a valid model -> not a reference -> falls through to sole-open-work.
    // It must NOT resolve to some EpicWorkItem, because none exist here at all.
    expect(r.matched).toBe(true)
    if (r.matched) expect(r.target.odooId).toBe(2292)
  })
})

describe('staffActionIdempotencyKey', () => {
  it('collapses a webhook retry of the same inbound to one action', () => {
    const a = staffActionIdempotencyKey({
      tenantId: 't1',
      correlationId: 'c1',
      action: 'ack',
      providerMessageId: 'wamid.ABC',
    })
    const b = staffActionIdempotencyKey({
      tenantId: 't1',
      correlationId: 'c1',
      action: 'ack',
      providerMessageId: 'wamid.ABC',
      note: 'different note, same inbound',
    })
    expect(a).toBe(b)
  })

  it('keeps two genuinely different UPDATEs on the same task distinct', () => {
    const a = staffActionIdempotencyKey({
      tenantId: 't1',
      correlationId: 'c1',
      action: 'update',
      note: 'on site now',
    })
    const b = staffActionIdempotencyKey({
      tenantId: 't1',
      correlationId: 'c1',
      action: 'update',
      note: 'parts fitted',
    })
    expect(a).not.toBe(b)
  })

  it('does not collide across tenants or correlations', () => {
    const base = { action: 'ack' as const, providerMessageId: 'wamid.ABC' }
    const k1 = staffActionIdempotencyKey({ ...base, tenantId: 't1', correlationId: 'c1' })
    const k2 = staffActionIdempotencyKey({ ...base, tenantId: 't2', correlationId: 'c1' })
    const k3 = staffActionIdempotencyKey({ ...base, tenantId: 't1', correlationId: 'c2' })
    expect(new Set([k1, k2, k3]).size).toBe(3)
  })
})
