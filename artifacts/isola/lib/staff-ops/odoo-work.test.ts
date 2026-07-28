import { describe, it, expect } from 'vitest'
import { checkActorMayAct, renderChatterNote, type OdooWorkRecord } from './odoo-work'

function record(over: Partial<OdooWorkRecord> = {}): OdooWorkRecord {
  return {
    odooModel: 'project.task',
    odooId: 2292,
    name: 'DW 2068c - WhatsApp: confirm pricing',
    projectId: 53,
    projectName: 'Dragon Windows - Vendor Workboard',
    stageId: 120,
    stageName: 'In Development',
    assigneeUserIds: [2],
    dateDeadline: null,
    writeDate: '2026-07-11 00:07:33',
    ...over,
  }
}

describe('checkActorMayAct — Odoo decides who owns the work', () => {
  it('allows the assigned user', () => {
    expect(checkActorMayAct(record(), 2)).toEqual({ allowed: true })
  })

  it('allows any of several assignees on a shared task', () => {
    expect(checkActorMayAct(record({ assigneeUserIds: [2, 5] }), 5)).toEqual({ allowed: true })
  })

  it('refuses a user Odoo does not list as an assignee', () => {
    expect(checkActorMayAct(record(), 5)).toEqual({ allowed: false, reason: 'not_assigned_to_actor' })
  })

  it('refuses when the record does not exist rather than defaulting to allow', () => {
    expect(checkActorMayAct(null, 2)).toEqual({ allowed: false, reason: 'record_not_found' })
  })

  it('refuses an unassigned record', () => {
    expect(checkActorMayAct(record({ assigneeUserIds: [] }), 2)).toEqual({
      allowed: false,
      reason: 'not_assigned_to_actor',
    })
  })
})

describe('renderChatterNote — the durable human-readable trail in the system of record', () => {
  it('names the action, the actor, the channel and the correlation', () => {
    const html = renderChatterNote({
      action: 'ack',
      actorName: 'Eric Giraud',
      note: null,
      correlationId: 'sw-epic-task-2292-aaaa',
      channel: 'whatsapp',
    })
    expect(html).toContain('<b>ACK</b>')
    expect(html).toContain('Eric Giraud')
    expect(html).toContain('via whatsapp')
    expect(html).toContain('sw-epic-task-2292-aaaa')
  })

  it('includes the note when there is one', () => {
    const html = renderChatterNote({
      action: 'blocked',
      actorName: 'Desmond Trotter',
      note: 'no access to the site until Monday',
      correlationId: 'c1',
      channel: 'whatsapp',
    })
    expect(html).toContain('<b>BLOCKED</b>')
    expect(html).toContain('no access to the site until Monday')
  })

  it('escapes staff-supplied text so a note cannot inject markup into Odoo chatter', () => {
    const html = renderChatterNote({
      action: 'update',
      actorName: 'Kim <admin>',
      note: '<script>alert(1)</script> & "quoted"',
      correlationId: 'c1',
      channel: 'whatsapp',
    })
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('Kim &lt;admin&gt;')
    expect(html).toContain('&amp;')
    expect(html).toContain('&quot;quoted&quot;')
  })
})
