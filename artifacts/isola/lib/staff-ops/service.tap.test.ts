/**
 * service.tap.test.ts — Stage B: a menu tap is an AUTHORITY-CHECKED route, not
 * a trusted instruction.
 *
 * The tap id travels out to a handset and comes back. It is an identifier, not
 * a secret, and nothing about the transport proves the person still holds the
 * work it names. So the interesting tests here are not the happy path — they
 * are the refusals:
 *
 *   - a tap naming an episode the sender does not currently hold is refused,
 *     and refused with their REAL open work attached, not acted on;
 *   - an unknown or deactivated sender never causes an Odoo read at all;
 *   - a tap arriving on the wrong tenant's channel is refused as cross-tenant.
 *
 * And one property that is easy to get wrong and expensive to get wrong:
 * `buildStaffReplyMenu` must reflect the record's stage AT READ TIME. It is
 * called after the write precisely so that a START returns In-Progress's menu.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  bindings: [] as any[],
  tasks: [] as any[],
  outbox: [] as any[],
  record: null as any,
  odooThrows: false,
  calls: [] as string[],
}))

vi.mock('../prisma', () => ({
  prisma: {
    staffBinding: {
      findMany: async ({ where }: any) => h.bindings.filter((b) => b.wa_id === where.wa_id),
      findUnique: async () => null,
    },
    notificationOutbox: { findMany: async () => h.outbox },
    staffWorkAction: { findMany: async () => [], findUnique: async () => null },
  },
}))

vi.mock('../audit', () => ({ audit: async () => {} }))
vi.mock('../notify', () => ({ enqueueNotification: async () => ({ enqueued: true, id: 'nb-1' }) }))
vi.mock('../engine-bindings', () => ({
  resolveOdooConfigForTenant: async () => ({ url: 'https://odoo.test', db: 'test', apiKey: 'x' }),
}))

vi.mock('./odoo-work', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./odoo-work')>()
  return {
    ...actual,
    listOpenTasksForUser: async () => {
      h.calls.push('odoo.listOpenTasks')
      return h.tasks
    },
    readWorkRecord: async () => {
      h.calls.push('odoo.readWorkRecord')
      if (h.odooThrows) throw new Error('odoo unreachable')
      return h.record
    },
  }
})

import { resolveInboundStaffTap, buildStaffReplyMenu } from './service'
import { buildMenu, decodeMenuId, encodeMenuId } from './staff-menu'

const WA_ERIC = '17672958382'
const TENANT = 'epic-dev-pilot'
const CORR = 'corr-2292'

const ERIC_ROW = {
  id: 'sb-epic-dev-2',
  tenant_id: TENANT,
  odoo_res_user_id: 2,
  display_name: 'Eric Giraud',
  wa_id: WA_ERIC,
  role: 'owner',
  active: true,
  manager_odoo_res_user_id: null,
}

function task(overrides: Record<string, unknown> = {}) {
  return {
    odooModel: 'project.task' as const,
    odooId: 2292,
    name: 'DW 2068c - confirm pricing',
    projectId: 53,
    projectName: 'Dragon Windows - Vendor Workboard',
    stageId: 120,
    stageName: 'New',
    assigneeUserIds: [2],
    dateDeadline: null,
    writeDate: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.bindings = [ERIC_ROW]
  h.tasks = [task()]
  h.outbox = [{ work_ref_id: 2292, correlation_id: CORR }]
  h.record = task()
  h.odooThrows = false
  h.calls = []
})

describe('resolveInboundStaffTap — a tap is checked, not trusted', () => {
  it('resolves to the exact episode the id names, with no grammar involved', async () => {
    const res = await resolveInboundStaffTap({
      waId: WA_ERIC,
      action: 'start',
      correlationId: CORR,
      channelTenantId: TENANT,
    })

    expect(res.route.route).toBe('staff_action')
    if (res.route.route !== 'staff_action') throw new Error('unreachable')
    expect(res.route.action).toBe('start')
    expect(res.route.target.odooId).toBe(2292)
    expect(res.route.target.correlationId).toBe(CORR)
    expect(res.route.resolution).toBe('explicit_ref')
    // `tap` is what tells an operator, from the audit trail alone, that this
    // reference was never typed and therefore never mistyped.
    expect(res.route.grammar).toBe('tap')
    // A tap carries no free text, so it can never smuggle a note.
    expect(res.route.note).toBeNull()
  })

  it('refuses a tap naming work the sender does not hold — and returns their real open work', async () => {
    const res = await resolveInboundStaffTap({
      waId: WA_ERIC,
      action: 'done',
      correlationId: 'corr-someone-elses-task',
      channelTenantId: TENANT,
    })

    expect(res.route.route).toBe('staff_help')
    if (res.route.route !== 'staff_help') throw new Error('unreachable')
    expect(res.route.why).toBe('unknown_reference')
    expect(res.route.attemptedAction).toBe('done')
    // The refusal is useful, not bare: it carries what they CAN act on.
    expect(res.openWork).toHaveLength(1)
    expect(res.openWork[0].correlationId).toBe(CORR)
  })

  it('an unknown sender is refused before Odoo is touched at all', async () => {
    h.bindings = []
    const res = await resolveInboundStaffTap({
      waId: '15550009999',
      action: 'ack',
      correlationId: CORR,
      channelTenantId: TENANT,
    })

    expect(res.route.route).toBe('exception')
    if (res.route.route !== 'exception') throw new Error('unreachable')
    expect(res.route.why).toBe('unknown_sender')
    expect(res.openWork).toEqual([])
    // Identity fails closed BEFORE any read. A stranger's tap must not be able
    // to make Foundation enumerate anyone's tasks.
    expect(h.calls).not.toContain('odoo.listOpenTasks')
  })

  it('a deactivated binding is refused as its own outcome, not folded into "unknown"', async () => {
    h.bindings = [{ ...ERIC_ROW, active: false }]
    const res = await resolveInboundStaffTap({
      waId: WA_ERIC,
      action: 'start',
      correlationId: CORR,
      channelTenantId: TENANT,
    })

    expect(res.route.route).toBe('exception')
    if (res.route.route !== 'exception') throw new Error('unreachable')
    expect(res.route.why).toBe('inactive_binding')
    expect(h.calls).not.toContain('odoo.listOpenTasks')
  })

  it('a tap arriving on another tenant’s channel is refused as cross-tenant', async () => {
    const res = await resolveInboundStaffTap({
      waId: WA_ERIC,
      action: 'start',
      correlationId: CORR,
      channelTenantId: 'some-other-tenant',
    })

    expect(res.route.route).toBe('exception')
    if (res.route.route !== 'exception') throw new Error('unreachable')
    expect(res.route.why).toBe('cross_tenant')
  })

  it('accepts an id produced by the real menu builder — encode/decode/resolve close the loop', async () => {
    const menu = buildMenu(task({ stageName: 'New' }), CORR)
    expect(menu.kind).toBe('buttons')
    if (menu.kind !== 'buttons') throw new Error('unreachable')

    const startItem = menu.items.find((i) => i.action === 'start')
    expect(startItem).toBeDefined()

    const decoded = decodeMenuId(startItem!.id)
    expect(decoded).toEqual({ action: 'start', correlationId: CORR })

    const res = await resolveInboundStaffTap({
      waId: WA_ERIC,
      action: decoded!.action,
      correlationId: decoded!.correlationId,
      channelTenantId: TENANT,
    })
    expect(res.route.route).toBe('staff_action')
    if (res.route.route !== 'staff_action') throw new Error('unreachable')
    expect(res.route.target.odooId).toBe(2292)
  })
})

describe('buildStaffReplyMenu — the menu follows the record, at read time', () => {
  const target = { odooModel: 'project.task' as const, odooId: 2292, correlationId: CORR }

  it('a New record offers ack / start / blocked', async () => {
    h.record = task({ stageName: 'New' })
    const menu = await buildStaffReplyMenu({
      binding: {
        id: ERIC_ROW.id,
        tenantId: TENANT,
        odooResUserId: 2,
        displayName: 'Eric Giraud',
        waId: WA_ERIC,
        role: 'owner',
        active: true,
        managerOdooResUserId: null,
      },
      target,
    })

    expect(menu.kind).toBe('buttons')
    if (menu.kind !== 'buttons') throw new Error('unreachable')
    expect(menu.items.map((i) => i.action)).toEqual(['ack', 'start', 'blocked'])
    expect(
      menu.items.every(
        (i) =>
          // `MenuItem.action` widened to `StaffMenuAction | ManagerVerdict` when
          // the manager-verification menu landed. This narrows EXPLICITLY rather
          // than casting: a staff menu must never carry a manager verdict, so if
          // one ever leaks in, this assertion fails instead of silently encoding
          // a verdict as though it were a staff action.
          i.action !== 'approve' &&
          i.action !== 'return' &&
          i.id === encodeMenuId(i.action, CORR),
      ),
    ).toBe(true)
  })

  it('AFTER a start moved the stage, the SAME call returns In-Progress’s menu', async () => {
    // This is the whole reason the menu is built after the write rather than
    // before it. Building from the pre-write record would hand the person a
    // "Start work" button for work they just started.
    const binding = {
      id: ERIC_ROW.id,
      tenantId: TENANT,
      odooResUserId: 2,
      displayName: 'Eric Giraud',
      waId: WA_ERIC,
      role: 'owner',
      active: true,
      managerOdooResUserId: null,
    }

    h.record = task({ stageName: 'New' })
    const before = await buildStaffReplyMenu({ binding, target })
    expect(before.kind === 'buttons' && before.items.map((i) => i.action)).toEqual([
      'ack',
      'start',
      'blocked',
    ])

    h.record = task({ stageName: 'In Progress' })
    const after = await buildStaffReplyMenu({ binding, target })
    expect(after.kind === 'buttons' && after.items.map((i) => i.action)).toEqual([
      'update',
      'done',
      'blocked',
    ])
    // No "start" survives into the post-start menu.
    expect(after.kind === 'buttons' && after.items.some((i) => i.action === 'start')).toBe(false)
  })

  it('a terminal stage offers nothing — the episode is over for the staff member', async () => {
    h.record = task({ stageName: 'Done' })
    const menu = await buildStaffReplyMenu({
      binding: {
        id: ERIC_ROW.id,
        tenantId: TENANT,
        odooResUserId: 2,
        displayName: 'Eric',
        waId: WA_ERIC,
        role: 'owner',
        active: true,
        managerOdooResUserId: null,
      },
      target,
    })
    expect(menu).toEqual({ kind: 'none' })
  })

  it('an unreadable record degrades to no menu rather than failing the reply', async () => {
    h.record = null
    const binding = {
      id: ERIC_ROW.id,
      tenantId: TENANT,
      odooResUserId: 2,
      displayName: 'Eric',
      waId: WA_ERIC,
      role: 'owner',
      active: true,
      managerOdooResUserId: null,
    }
    expect(await buildStaffReplyMenu({ binding, target })).toEqual({ kind: 'none' })

    // Same for a hard transport failure: the confirmation is the part that
    // carries the fact, and a menu problem must never cost the person that.
    h.odooThrows = true
    expect(await buildStaffReplyMenu({ binding, target })).toEqual({ kind: 'none' })
  })
})
