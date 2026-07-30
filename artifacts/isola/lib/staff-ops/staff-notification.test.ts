import { describe, it, expect } from 'vitest'
import {
  INTERNAL_TASK_TEMPLATE,
  SERVICE_WINDOW_MS,
  buildStaffNotification,
  buildStaffTaskTemplateParams,
  INTERNAL_TASK_TEMPLATE_PARAM_COUNT,
  decideDispatchMode,
  hasOpenServiceWindow,
  staffContactE164,
  staffNotificationDedupeKey,
} from './staff-notification'

const NOW = new Date('2026-07-28T12:00:00.000Z')

describe('hasOpenServiceWindow — the predicate whose false positive is a 131047', () => {
  it('is closed when there has never been an inbound', () => {
    expect(hasOpenServiceWindow({ lastInboundAt: null, now: NOW })).toBe(false)
  })

  it('is open just inside 24 hours and closed exactly at the boundary', () => {
    const justInside = new Date(NOW.getTime() - (SERVICE_WINDOW_MS - 1))
    const exactly = new Date(NOW.getTime() - SERVICE_WINDOW_MS)
    expect(hasOpenServiceWindow({ lastInboundAt: justInside, now: NOW })).toBe(true)
    expect(hasOpenServiceWindow({ lastInboundAt: exactly, now: NOW })).toBe(false)
  })

  it('treats a future inbound timestamp as closed rather than open', () => {
    // Clock skew must fail safe: an impossible window is not an open one.
    const future = new Date(NOW.getTime() + 60_000)
    expect(hasOpenServiceWindow({ lastInboundAt: future, now: NOW })).toBe(false)
  })
})

describe('decideDispatchMode — template-first, always, for anything proactive', () => {
  it('uses the approved template for proactive sends even when a window is open', () => {
    const d = decideDispatchMode({
      proactive: true,
      window: { lastInboundAt: new Date(NOW.getTime() - 60_000), now: NOW },
    })
    expect(d.mode).toBe('template')
    if (d.mode === 'template') {
      expect(d.template).toBe(INTERNAL_TASK_TEMPLATE)
      expect(d.why).toBe('proactive_always_template')
    }
  })

  it('allows free-form only as continuation inside an open window', () => {
    const d = decideDispatchMode({
      proactive: false,
      window: { lastInboundAt: new Date(NOW.getTime() - 60_000), now: NOW },
    })
    expect(d.mode).toBe('freeform')
  })

  it('falls back to the template when the window is closed', () => {
    const d = decideDispatchMode({ proactive: false, window: { lastInboundAt: null, now: NOW } })
    expect(d.mode).toBe('template')
    if (d.mode === 'template') expect(d.why).toBe('window_closed')
  })
})

describe('buildStaffTaskTemplateParams — Meta rejects empty parameters', () => {
  it('fills every slot with a readable placeholder rather than a blank', () => {
    const params = buildStaffTaskTemplateParams({
      workRefId: 2589,
      staffName: '',
      workTitle: '   ',
      projectName: null,
      dueDate: null,
    })
    expect(params).toEqual(['#2589', 'NORMAL', 'Assigned work', 'ASAP', 'No due date'])
    for (const p of params) expect(p.trim().length).toBeGreaterThan(0)
  })

  it('builds exactly the five slots the approved template declares', () => {
    const params = buildStaffTaskTemplateParams({
      workRefId: 2590,
      staffName: 'Hakeem Dalrymple',
      workTitle: 'Controlled internal test',
      projectName: 'BFF',
      dueDate: null,
    })
    expect(params).toHaveLength(INTERNAL_TASK_TEMPLATE_PARAM_COUNT)
    expect(INTERNAL_TASK_TEMPLATE_PARAM_COUNT).toBe(5)
  })

  it('puts the record reference in slot 1 so the reply commands resolve', () => {
    expect(
      buildStaffTaskTemplateParams({
        workRefId: 2589,
        staffName: 'Hakeem Dalrymple',
        workTitle: 'anything',
        projectName: null,
        dueDate: null,
      })[0],
    ).toBe('#2589')
  })

  it('flattens newlines, tabs and space runs Meta would reject', () => {
    const params = buildStaffTaskTemplateParams({
      workRefId: 7,
      staffName: 'Someone',
      workTitle: 'Line one\nline two\tafter tab     five spaces',
      projectName: null,
      dueDate: null,
    })
    expect(params[2]).toBe('Line one line two after tab five spaces')
    for (const p of params) {
      expect(p).not.toMatch(/[\r\n\t]/)
      expect(p).not.toMatch(/ {4,}/)
    }
  })

  it('preserves real values in template order', () => {
    expect(
      buildStaffTaskTemplateParams({
        workRefId: 2068,
        staffName: 'Phillip Alleyne',
        workTitle: 'INC/26-27/2068c - WhatsApp integration',
        projectName: 'Dragon Windows - Customer Status Portal',
        dueDate: '2026-08-01',
        priority: 'HIGH',
        acknowledgeBy: '10:45',
      }),
    ).toEqual([
      '#2068',
      'HIGH',
      'INC/26-27/2068c - WhatsApp integration',
      '10:45',
      '2026-08-01',
    ])
  })
})

describe('staffNotificationDedupeKey', () => {
  it('collapses repeat producer runs for one episode', () => {
    const a = staffNotificationDedupeKey({ correlationId: 'c1', purpose: 'task_dispatch' })
    const b = staffNotificationDedupeKey({ correlationId: 'c1', purpose: 'task_dispatch' })
    expect(a).toBe(b)
  })

  it('keeps different purposes on the same episode distinct', () => {
    const dispatch = staffNotificationDedupeKey({ correlationId: 'c1', purpose: 'task_dispatch' })
    const verify = staffNotificationDedupeKey({ correlationId: 'c1', purpose: 'manager_verification' })
    expect(dispatch).not.toBe(verify)
  })
})

describe('buildStaffNotification — the enqueue envelope', () => {
  const envelope = buildStaffNotification({
    tenantId: 'tenant-epic',
    toWaId: '17672958382',
    correlationId: 'sw-epic-task-2292-aaaa',
    workRefModel: 'project.task',
    workRefId: 2292,
    template: INTERNAL_TASK_TEMPLATE,
    templateInput: {
      staffName: 'Eric Giraud',
      workTitle: 'DW 2068c - WhatsApp: confirm pricing',
      projectName: 'Dragon Windows - Vendor Workboard',
      dueDate: null,
    },
    purpose: 'task_dispatch',
  })

  it('carries the Odoo WorkRef and no legacy work identifier', () => {
    expect(envelope.payload.workRefModel).toBe('project.task')
    expect(envelope.payload.workRefId).toBe(2292)
    const serialised = JSON.stringify(envelope)
    expect(serialised).not.toMatch(/OPS-\d/)
    expect(serialised.toLowerCase()).not.toContain('epicworkitem')
    expect(serialised).not.toContain('epic_work_items')
  })

  it('uses the internal staff consent basis, not an owner or customer basis', () => {
    expect(envelope.consentBasis).toBe('internal_staff_directive')
    expect(envelope.consentBasis).not.toBe('owner_self_notification')
  })

  it('produces a summary line the outbox adapter can send', () => {
    expect(envelope.payload.summaryLine).toBe(
      'DW 2068c - WhatsApp: confirm pricing — Dragon Windows - Vendor Workboard (due No due date)',
    )
  })

  it('keys dedupe on the correlation id so one episode dispatches once', () => {
    expect(envelope.dedupeKey).toBe('staff:task_dispatch:sw-epic-task-2292-aaaa')
  })
})

describe('staffContactE164 — the write key and the read key are one key', () => {
  it('prefixes a bare wa_id so it matches the Consent.phone format', () => {
    expect(staffContactE164('17673173398')).toBe('+17673173398')
  })

  it('is idempotent — an already-normalised value survives unchanged', () => {
    expect(staffContactE164('+17673173398')).toBe('+17673173398')
  })

  it('strips separators a human or an import might have left in', () => {
    expect(staffContactE164('+1 (767) 317-3398')).toBe('+17673173398')
  })
})

describe('the enqueued contact matches the Consent key format', () => {
  const fromBareWaId = buildStaffNotification({
    tenantId: 'tenant-epic',
    toWaId: '17673173398',
    correlationId: 'sw-epic-task-2588-bbbb',
    workRefModel: 'project.task',
    workRefId: 2588,
    template: INTERNAL_TASK_TEMPLATE,
    templateInput: {
      staffName: 'Hakeem Dalrymple',
      workTitle: 'Wave 1 pilot task',
      projectName: 'EPIC Internal',
      dueDate: null,
    },
    purpose: 'task_dispatch',
  })

  it('enqueues E.164 with a leading +, not the bare wa_id', () => {
    expect(fromBareWaId.contact).toBe('+17673173398')
    expect(fromBareWaId.contact).not.toBe('17673173398')
  })

  it('produces a contact that satisfies the Consent.phone shape', () => {
    // prisma/schema.prisma: Consent.phone is "E.164 with leading +", and
    // lib/notify.ts keys tenant_id_phone on exactly this value. A contact that
    // fails this regex can never match a Consent row, so enqueueNotification
    // returns consent_denied for every staff dispatch — the Wave 1 defect.
    expect(fromBareWaId.contact).toMatch(/^\+[1-9]\d{7,14}$/)
  })

  it('routes through the same helper the outbox readers use', () => {
    expect(fromBareWaId.contact).toBe(staffContactE164('17673173398'))
  })
})
