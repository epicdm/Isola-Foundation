/**
 * task-list.test.ts — MY TASKS, the one action the approved template advertises
 * that Foundation did not implement.
 *
 * `epic_internal_task_v1` (Meta id 958699833859654, APPROVED) tells every staff
 * member they can reply `MY TASKS`. Until now the parser returned
 * `not_a_command` for that exact phrase, so the template was advertising
 * something the system could not honour — the defect class this packet exists
 * to stop. These tests pin the fix at the two levels that matter: the phrase
 * parses, and it can never turn into an action on a record.
 */

import { describe, it, expect } from 'vitest'
import { parseStaffCommand } from './staff-action'
import { decideInboundRoute, type StaffBindingRow } from './inbound-routing'

const ERIC: StaffBindingRow = {
  id: 'sb-epic-2',
  tenantId: '43b006e4-33e0-42a8-bec7-4422ba290d79',
  odooResUserId: 2,
  displayName: 'Eric Giraud',
  waId: '17672958382',
  role: 'owner',
  active: true,
  managerOdooResUserId: null,
}

const WORK = [
  { odooModel: 'project.task' as const, odooId: 2292, correlationId: 'c-2292', label: 'DW 2068c' },
  { odooModel: 'project.task' as const, odooId: 2478, correlationId: 'c-2478', label: 'INC 2068c' },
]

function route(text: string, openWork = WORK) {
  return decideInboundRoute({
    text,
    bindingCandidates: [ERIC],
    channelTenantId: ERIC.tenantId,
    openWork,
  })
}

describe('MY TASKS — the phrase the template actually advertises', () => {
  it('parses the exact template wording as a listing request', () => {
    const r = parseStaffCommand({ text: 'MY TASKS', openWork: WORK })
    expect(r.matched).toBe(false)
    if (r.matched) throw new Error('unreachable')
    expect(r.reason).toBe('list_request')
    expect(r.action).toBe('tasks')
  })

  it.each([
    'my tasks',
    'My Tasks',
    'MY TASKS.',
    'my task',
    'TASKS',
    'tasks',
    'mytasks',
  ])('accepts the variant %s', (text) => {
    const r = parseStaffCommand({ text, openWork: WORK })
    expect(r.matched).toBe(false)
    if (r.matched) throw new Error('unreachable')
    expect(r.reason).toBe('list_request')
    expect(r.action).toBe('tasks')
  })

  it('routes a known staff member to the task list, writing nothing', () => {
    const r = route('MY TASKS')
    expect(r.route).toBe('staff_help')
    if (r.route !== 'staff_help') throw new Error('unreachable')
    expect(r.why).toBe('task_list')
    expect(r.attemptedAction).toBe('tasks')
    expect(r.binding.odooResUserId).toBe(2)
  })

  it('NEVER becomes an action, even when the sender holds exactly one task', () => {
    // This is the trap. HELP auto-targets a sole open work item; a listing
    // request must not, or "show me my work" would silently act on it.
    const sole = [WORK[0]]
    const r = route('MY TASKS', sole)
    expect(r.route).toBe('staff_help')
    if (r.route !== 'staff_help') throw new Error('unreachable')
    expect(r.why).toBe('task_list')
  })

  it('lists rather than errors when the sender holds nothing', () => {
    const r = route('MY TASKS', [])
    expect(r.route).toBe('staff_help')
    if (r.route !== 'staff_help') throw new Error('unreachable')
    expect(r.why).toBe('task_list')
  })

  it('ignores anything typed after the phrase — it can never carry a note', () => {
    const r = parseStaffCommand({ text: 'MY TASKS please show me everything', openWork: WORK })
    expect(r.matched).toBe(false)
    if (r.matched) throw new Error('unreachable')
    expect(r.reason).toBe('list_request')
  })

  it('identity still resolves first — a stranger asking is an exception, not a list', () => {
    const r = decideInboundRoute({
      text: 'MY TASKS',
      bindingCandidates: [],
      channelTenantId: ERIC.tenantId,
      openWork: WORK,
    })
    expect(r.route).toBe('exception')
    if (r.route !== 'exception') throw new Error('unreachable')
    expect(r.why).toBe('unknown_sender')
  })

  it('does not swallow MY as a verb on its own', () => {
    const r = parseStaffCommand({ text: 'MY', openWork: WORK })
    expect(r.matched).toBe(false)
    if (r.matched) throw new Error('unreachable')
    expect(r.reason).toBe('not_a_command')
  })

  it('leaves the existing verbs untouched', () => {
    const ack = parseStaffCommand({ text: 'ACK 2292', openWork: WORK })
    expect(ack.matched).toBe(true)
    if (!ack.matched) throw new Error('unreachable')
    expect(ack.action).toBe('ack')
    expect(ack.target.odooId).toBe(2292)
  })
})
