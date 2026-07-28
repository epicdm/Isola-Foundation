import { describe, it, expect } from 'vitest'
import { decideInboundRoute, resolveStaffIdentity, type StaffBindingRow } from './inbound-routing'
import type { OpenWorkRefCandidate } from './staff-action'

const TENANT = 'tenant-epic'

function binding(over: Partial<StaffBindingRow> = {}): StaffBindingRow {
  return {
    id: 'sb-1',
    tenantId: TENANT,
    odooResUserId: 2,
    displayName: 'Eric Giraud',
    waId: '17672958382',
    role: 'owner',
    active: true,
    managerOdooResUserId: null,
    ...over,
  }
}

const TASK: OpenWorkRefCandidate = {
  odooModel: 'project.task',
  odooId: 2292,
  correlationId: 'sw-epic-task-2292-aaaa',
}

describe('resolveStaffIdentity — fail closed, and say which failure', () => {
  it('resolves a single active binding', () => {
    const r = resolveStaffIdentity([binding()], TENANT)
    expect(r.resolved).toBe(true)
    if (r.resolved) expect(r.binding.odooResUserId).toBe(2)
  })

  it('an unknown sender is unknown, not staff', () => {
    // The legacy site tested a { ok, data } envelope, which is truthy for
    // everyone, so a stranger was classified as staff and the non-staff branch
    // became unreachable for every sender. There is no envelope here.
    const r = resolveStaffIdentity([], TENANT)
    expect(r).toEqual({ resolved: false, reason: 'unknown_sender' })
  })

  it('an inactive-only match is reported as inactive, distinct from unknown', () => {
    const r = resolveStaffIdentity([binding({ active: false, displayName: '[TEST as Kim]' })], TENANT)
    expect(r.resolved).toBe(false)
    if (!r.resolved) {
      expect(r.reason).toBe('inactive_binding')
      // An operator has to be able to tell "we deactivated them" from
      // "never heard of them" — they need different remedies.
      expect(r.candidates?.[0].displayName).toBe('[TEST as Kim]')
    }
  })

  it('refuses a number bound in two tenants', () => {
    const r = resolveStaffIdentity(
      [binding({ id: 'a', tenantId: 'tenant-a' }), binding({ id: 'b', tenantId: 'tenant-b' })],
      'tenant-a',
    )
    expect(r.resolved).toBe(false)
    if (!r.resolved) expect(r.reason).toBe('cross_tenant')
  })

  it('refuses a sole match that belongs to a different tenant than the channel', () => {
    const r = resolveStaffIdentity([binding({ tenantId: 'tenant-other' })], TENANT)
    expect(r.resolved).toBe(false)
    if (!r.resolved) expect(r.reason).toBe('cross_tenant')
  })

  it('refuses two active bindings inside one tenant', () => {
    const r = resolveStaffIdentity([binding({ id: 'a' }), binding({ id: 'b', odooResUserId: 5 })], TENANT)
    expect(r.resolved).toBe(false)
    if (!r.resolved) expect(r.reason).toBe('ambiguous_binding')
  })
})

describe('decideInboundRoute — dual-role precedence', () => {
  /**
   * The operating human is BOTH the owner principal and active staff. In BFF
   * the owner branch resolved first and returned unconditionally, so his ACK
   * was answered with the business menu and no acknowledgement could ever be
   * recorded. Dual-role is the normal case here, and these tests pin it.
   */
  it('an explicit staff command from a dual-role owner routes to staff_action', () => {
    const r = decideInboundRoute({
      text: 'ACK',
      bindingCandidates: [binding({ role: 'owner' })],
      channelTenantId: TENANT,
      openWork: [TASK],
    })
    expect(r.route).toBe('staff_action')
    if (r.route !== 'staff_action') return
    expect(r.action).toBe('ack')
    expect(r.binding.role).toBe('owner')
    expect(r.target.odooId).toBe(2292)
  })

  it('a business question from the same dual-role owner does NOT become a staff action', () => {
    const r = decideInboundRoute({
      text: 'What is our outstanding A/R this week?',
      bindingCandidates: [binding({ role: 'owner' })],
      channelTenantId: TENANT,
      openWork: [TASK],
    })
    expect(r.route).toBe('staff_help')
    if (r.route === 'staff_help') expect(r.why).toBe('non_command')
  })

  it('a manager sending a staff command is handled as staff, not swallowed by a manager fallback', () => {
    const r = decideInboundRoute({
      text: 'DONE',
      bindingCandidates: [binding({ role: 'manager', odooResUserId: 5, displayName: 'Phillip Alleyne' })],
      channelTenantId: TENANT,
      openWork: [TASK],
    })
    expect(r.route).toBe('staff_action')
    if (r.route === 'staff_action') expect(r.action).toBe('done')
  })
})

describe('decideInboundRoute — exceptions are operator-visible, never silent', () => {
  it('an unknown sender produces an exception route, not a staff route', () => {
    const r = decideInboundRoute({
      text: 'ACK',
      bindingCandidates: [],
      channelTenantId: TENANT,
      openWork: [],
    })
    expect(r).toEqual({ route: 'exception', why: 'unknown_sender', candidates: undefined })
  })

  it('a cross-tenant sender is refused before any command is even parsed', () => {
    const r = decideInboundRoute({
      text: 'DONE',
      bindingCandidates: [binding({ tenantId: 'tenant-other' })],
      channelTenantId: TENANT,
      openWork: [TASK],
    })
    expect(r.route).toBe('exception')
    if (r.route === 'exception') expect(r.why).toBe('cross_tenant')
  })

  it('several open tasks yield a disambiguation route carrying the candidates', () => {
    const second: OpenWorkRefCandidate = { ...TASK, odooId: 2478, correlationId: 'sw-epic-task-2478-bbbb' }
    const r = decideInboundRoute({
      text: 'ACK',
      bindingCandidates: [binding()],
      channelTenantId: TENANT,
      openWork: [TASK, second],
    })
    expect(r.route).toBe('staff_disambiguation')
    if (r.route === 'staff_disambiguation') {
      expect(r.action).toBe('ack')
      expect(r.candidates.map((c) => c.odooId)).toEqual([2292, 2478])
    }
  })

  it('a verb with no open work routes to help and names the attempted action', () => {
    const r = decideInboundRoute({
      text: 'BLOCKED site is locked',
      bindingCandidates: [binding()],
      channelTenantId: TENANT,
      openWork: [],
    })
    expect(r.route).toBe('staff_help')
    if (r.route === 'staff_help') {
      expect(r.why).toBe('no_open_work')
      expect(r.attemptedAction).toBe('blocked')
    }
  })

  it('an explicit HELP is served even with no open work', () => {
    const r = decideInboundRoute({
      text: 'HELP',
      bindingCandidates: [binding()],
      channelTenantId: TENANT,
      openWork: [],
    })
    expect(r.route).toBe('staff_help')
    if (r.route === 'staff_help') expect(r.why).toBe('explicit_help')
  })
})
