import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { OdooApiError, OdooNoApiError, type OdooConfig } from '@/engines/odoo'

import { DependencyUnavailable, runGovernedAction, type ActionPorts } from '../action'
import { buildExecutors } from './index'
import {
  createOdooRecordSystem,
  plainText,
  type OdooCall,
} from './odoo-record-system'

// For defaultVerifyStaffBinding's own tests only -- every other test in this
// file injects an explicit verifyStaffBinding override and never reaches
// this dynamic import at all.
const findBindingByOdooUserMock = vi.fn()
vi.mock('@/lib/staff-ops/service', () => ({
  findBindingByOdooUser: findBindingByOdooUserMock,
}))

/**
 * No network. The transport is injected in every test and a test at the bottom
 * asserts the real one is never reached.
 */

const CONFIG: OdooConfig = { url: 'https://example.invalid', apiKey: 'unused-in-tests', db: 'testdb' }

interface Call {
  model: string
  method: string
  params: Record<string, unknown>
}

/** Scripted transport: a map of "model.method" to the value Odoo would return. */
function scripted(script: Record<string, unknown | (() => unknown)>) {
  const calls: Call[] = []
  const call: OdooCall = async (_cfg, model, method, params = {}) => {
    calls.push({ model, method, params })
    const key = `${model}.${method}`
    if (!(key in script)) throw new Error(`test script has no entry for ${key}`)
    const v = script[key]
    return typeof v === 'function' ? (v as () => unknown)() : v
  }
  return { call, calls }
}

const sys = (script: Record<string, unknown | (() => unknown)>, over = {}) => {
  const { call, calls } = scripted(script)
  return {
    calls,
    rec: createOdooRecordSystem({ resolveConfig: async () => CONFIG, call, ...over }),
  }
}

describe('plainText — a note must come back as the text we sent', () => {
  it.each([
    ['<p>Customer called about a dropped line</p>', 'Customer called about a dropped line'],
    ['<p>line one<br/>line two</p>', 'line one\nline two'],
    ['<p>first</p><p>second</p>', 'first\nsecond'],
    ['<p>Ben &amp; Jerry&#39;s</p>', "Ben & Jerry's"],
    ['<p>5 &lt; 6 &gt; 4</p>', '5 < 6 > 4'],
    ['<p>spaced&nbsp;out</p>', 'spaced out'],
  ])('%s -> %s', (html, expected) => {
    expect(plainText(html)).toBe(expected)
  })

  it('survives a round trip through the escaper', async () => {
    const body = 'Quote: "he said 5 < 6 & left"'
    const { rec, calls } = sys({
      'res.partner.message_post': 77,
      'mail.message.search_read': () => [{ id: 77, body: calls[0].params.body }],
    })
    await rec.createNote({
      companyId: 'c1',
      objectType: 'res.partner',
      objectId: '5',
      body,
      authorPrincipalId: 'p1',
    })
    const row = await rec.readNote('77')
    expect(row?.body).toBe(body)
  })
})

describe('writes land on the right Odoo model with the right arguments', () => {
  it('posts a note to the target record chatter', async () => {
    const { rec, calls } = sys({ 'res.partner.message_post': 101 })
    const r = await rec.createNote({
      companyId: 'c1',
      objectType: 'res.partner',
      objectId: '42',
      body: 'noted',
      authorPrincipalId: 'p1',
    })
    expect(r.externalId).toBe('101')
    expect(calls[0].model).toBe('res.partner')
    expect(calls[0].method).toBe('message_post')
    expect(calls[0].params.ids).toEqual([42])
    expect(calls[0].params.message_type).toBe('comment')
  })

  it('creates a project.task and links the partner', async () => {
    const { rec, calls } = sys({ 'project.task.create': 9 })
    const r = await rec.createTask({
      companyId: 'c1',
      objectType: 'res.partner',
      objectId: '42',
      title: 'Call back',
      dueDate: '2026-08-04T10:00:00Z',
    })
    expect(r.externalId).toBe('9')
    const vals = (calls[0].params.vals_list as Record<string, unknown>[])[0]
    expect(vals.name).toBe('Call back')
    expect(vals.date_deadline).toBe('2026-08-04')
    expect(vals.partner_id).toBe(42)
  })

  it('resolves ir.model and the activity type before creating an activity', async () => {
    const { rec, calls } = sys({
      'ir.model.search_read': [{ id: 3 }],
      'mail.activity.type.search_read': [{ id: 4, name: 'To Do' }],
      'mail.activity.create': 55,
    })
    const r = await rec.scheduleActivity({
      companyId: 'c1',
      objectType: 'res.partner',
      objectId: '42',
      summary: 'Site visit',
      dueDate: '2026-08-05T09:00:00Z',
      assigneeRef: '7',
    })
    expect(r.externalId).toBe('55')
    const vals = (calls.at(-1)!.params.vals_list as Record<string, unknown>[])[0]
    expect(vals).toMatchObject({
      res_model_id: 3,
      res_id: 42,
      summary: 'Site visit',
      date_deadline: '2026-08-05',
      activity_type_id: 4,
      user_id: 7,
    })
  })

  it('records a follow-up as an activity and reads it back as a note', async () => {
    const { rec } = sys({
      'ir.model.search_read': [{ id: 3 }],
      'mail.activity.type.search_read': [{ id: 4 }],
      'mail.activity.create': 56,
      'mail.activity.search_read': [{ id: 56, summary: 'Check the quote landed' }],
    })
    const r = await rec.scheduleFollowup({
      companyId: 'c1',
      objectType: 'crm.lead',
      objectId: '9',
      note: 'Check the quote landed',
      dueDate: '2026-08-12',
    })
    const row = await rec.readFollowup(r.externalId)
    expect(row?.note).toBe('Check the quote landed')
  })

  it('creates a lead as a lead, not an opportunity', async () => {
    const { rec, calls } = sys({ 'crm.lead.create': 12 })
    await rec.createLead({ companyId: 'c1', name: 'Bay Front Hotel', source: 'whatsapp' })
    const vals = (calls[0].params.vals_list as Record<string, unknown>[])[0]
    expect(vals.name).toBe('Bay Front Hotel')
    expect(vals.type).toBe('lead')
  })
})

describe('resolveAssignableUser — real+active+internal is necessary but not sufficient (Codex review, PR #155)', () => {
  it('CONTROL — real, active, internal, AND bound to the tenant → resolves', async () => {
    const { rec } = sys(
      { 'res.users.search_read': [{ id: 7, name: 'Ann Owner' }] },
      { verifyStaffBinding: async () => true },
    )
    const r = await rec.resolveAssignableUser('tenant-a', '7')
    expect(r).toEqual({ id: '7', name: 'Ann Owner' })
  })

  it('real, active, internal in Odoo, but NOT bound to this tenant → null, no false positive from Odoo identity alone', async () => {
    const { rec } = sys(
      { 'res.users.search_read': [{ id: 7, name: 'Ann Owner' }] },
      { verifyStaffBinding: async () => false },
    )
    const r = await rec.resolveAssignableUser('tenant-a', '7')
    expect(r).toBeNull()
  })

  it('the tenantId actually reaches verifyStaffBinding, not a hardcoded or swapped value', async () => {
    const seen: Array<{ tenantId: string; odooUserId: number }> = []
    const { rec } = sys(
      { 'res.users.search_read': [{ id: 7, name: 'Ann Owner' }] },
      {
        verifyStaffBinding: async (tenantId: string, odooUserId: number) => {
          seen.push({ tenantId, odooUserId })
          return tenantId === 'tenant-a'
        },
      },
    )
    await rec.resolveAssignableUser('tenant-a', '7')
    await rec.resolveAssignableUser('tenant-b', '7')
    expect(seen).toEqual([
      { tenantId: 'tenant-a', odooUserId: 7 },
      { tenantId: 'tenant-b', odooUserId: 7 },
    ])
  })

  it('no matching Odoo user at all → null, verifyStaffBinding never called (nothing to bind-check)', async () => {
    let called = false
    const { rec } = sys(
      { 'res.users.search_read': [] },
      { verifyStaffBinding: async () => { called = true; return true } },
    )
    const r = await rec.resolveAssignableUser('tenant-a', '999999')
    expect(r).toBeNull()
    expect(called).toBe(false)
  })
})

describe('defaultVerifyStaffBinding (the REAL default, no override) — Codex PR #155 P1', () => {
  it('a deactivated Foundation staff member with an otherwise-matching binding → null, not assignable', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: false })
    // No verifyStaffBinding override here -- this exercises the real
    // defaultVerifyStaffBinding, which must reject on `active: false` even
    // though a binding row genuinely exists (an offboarded staff member
    // whose Odoo account is still active).
    const { rec } = sys({ 'res.users.search_read': [{ id: 7, name: 'Formerly Staff' }] })
    const r = await rec.resolveAssignableUser('tenant-a', '7')
    expect(r).toBeNull()
    expect(findBindingByOdooUserMock).toHaveBeenCalledWith('tenant-a', 7)
  })

  it('CONTROL — an active binding via the real default → resolves', async () => {
    findBindingByOdooUserMock.mockResolvedValue({ id: 'binding-1', active: true })
    const { rec } = sys({ 'res.users.search_read': [{ id: 7, name: 'Ann Owner' }] })
    const r = await rec.resolveAssignableUser('tenant-a', '7')
    expect(r).toEqual({ id: '7', name: 'Ann Owner' })
  })
})

describe('reads are translated into the caller’s vocabulary', () => {
  it('turns stage_id [id, name] into the canonical stage word', async () => {
    const { rec } = sys({
      'crm.lead.search_read': [
        {
          id: 9,
          name: 'Bay Front Hotel',
          stage_id: [2, 'Qualified'],
          user_id: [7, 'Ann'],
          expected_revenue: 4200,
        },
      ],
    })
    const row = await rec.readLead('9')
    expect(row).toMatchObject({
      name: 'Bay Front Hotel',
      stage: 'qualified',
      ownerRef: '7',
      expectedRevenue: '4200',
    })
  })

  it('leaves an unrecognised Odoo stage name alone rather than guessing', async () => {
    const { rec } = sys({
      'crm.lead.search_read': [{ id: 9, name: 'X', stage_id: [8, 'Awaiting Survey'] }],
    })
    expect((await rec.readLead('9'))?.stage).toBe('Awaiting Survey')
  })

  it('exposes project.task.name as title', async () => {
    const { rec } = sys({ 'project.task.search_read': [{ id: 9, name: 'Call back' }] })
    expect((await rec.readTask('9'))?.title).toBe('Call back')
  })

  it('returns null when the record is not there', async () => {
    const { rec } = sys({
      'crm.lead.search_read': [],
      'mail.message.search_read': { records: [] },
    })
    expect(await rec.readLead('9')).toBeNull()
    expect(await rec.readNote('9')).toBeNull()
  })

  it('returns null for a non-numeric id instead of asking Odoo a nonsense question', async () => {
    const { rec, calls } = sys({})
    expect(await rec.readLead('not-an-id')).toBeNull()
    expect(calls).toHaveLength(0)
  })
})

describe('lead.update maps canonical stages onto the tenant’s pipeline', () => {
  it('resolves the stage name to an id before writing', async () => {
    const { rec, calls } = sys({
      'crm.stage.search_read': [{ id: 2 }],
      'crm.lead.write': true,
    })
    const r = await rec.updateLead({ companyId: 'c1', leadId: '9', fields: { stage: 'qualified' } })
    expect(r.externalId).toBe('9')
    expect(calls[0].params.domain).toEqual([['name', '=', 'Qualified']])
    expect((calls[1].params.vals as Record<string, unknown>).stage_id).toBe(2)
  })

  it('honours a tenant stage-name override', async () => {
    const { rec, calls } = sys(
      { 'crm.stage.search_read': [{ id: 5 }], 'crm.lead.write': true },
      { stageNames: { qualified: 'Survey Booked' } },
    )
    await rec.updateLead({ companyId: 'c1', leadId: '9', fields: { stage: 'qualified' } })
    expect(calls[0].params.domain).toEqual([['name', '=', 'Survey Booked']])
  })

  it('refuses — and writes nothing — when the stage does not exist in the pipeline', async () => {
    const { rec, calls } = sys({ 'crm.stage.search_read': [] })
    await expect(
      rec.updateLead({ companyId: 'c1', leadId: '9', fields: { stage: 'won' } }),
    ).rejects.toThrow(/does not exist in this pipeline/)
    expect(calls.map((c) => c.method)).not.toContain('write')
  })

  it('refuses a non-numeric owner rather than silently dropping the change', async () => {
    const { rec } = sys({ 'crm.lead.write': true })
    await expect(
      rec.updateLead({ companyId: 'c1', leadId: '9', fields: { ownerRef: 'ann@example.com' } }),
    ).rejects.toThrow(/res\.users id/)
  })
})

describe('the whole point: down is not the same as refused', () => {
  const cases: [string, () => unknown, boolean][] = [
    ['Odoo 500', () => { throw new OdooApiError(500, { message: 'internal error' }) }, true],
    ['Odoo 503', () => { throw new OdooApiError(503, { message: 'maintenance' }) }, true],
    ['no /json/2 on this plan', () => { throw new OdooNoApiError(404) }, true],
    ['connection refused', () => { throw new Error('fetch failed: ECONNREFUSED') }, true],
    ['DNS failure', () => { throw new Error('getaddrinfo ENOTFOUND odoo.example') }, true],
    [
      'timeout',
      () => {
        const e = new Error('The operation was aborted due to timeout')
        e.name = 'TimeoutError'
        throw e
      },
      true,
    ],
    ['Odoo 403 access rule', () => { throw new OdooApiError(403, { message: 'access denied' }) }, false],
    ['Odoo 400 validation', () => { throw new OdooApiError(400, { message: 'required field' }) }, false],
  ]

  it.each(cases)('%s -> dependency unavailable: %s', async (_label, thrower, isDependency) => {
    const { rec } = sys({ 'crm.lead.create': thrower })
    const err = await rec
      .createLead({ companyId: 'c1', name: 'Bay Front Hotel' })
      .then(() => null)
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect(err instanceof DependencyUnavailable).toBe(isDependency)
  })

  it('names the dependency so an operator knows what to look at', async () => {
    const { rec } = sys({
      'crm.lead.create': () => {
        throw new OdooNoApiError(404)
      },
    })
    await expect(rec.createLead({ companyId: 'c1', name: 'X' })).rejects.toMatchObject({
      dependency: 'odoo-external-api',
    })
  })

  it('treats a missing tenant binding as the dependency being unavailable', async () => {
    const rec = createOdooRecordSystem({
      resolveConfig: async () => {
        throw new Error('no OdooBinding row for this tenant')
      },
      call: async () => 1,
    })
    await expect(rec.createLead({ companyId: 'c1', name: 'X' })).rejects.toMatchObject({
      dependency: 'odoo-binding',
    })
  })

  it('does not report success when Odoo creates without returning an id', async () => {
    const { rec } = sys({ 'crm.lead.create': false })
    await expect(rec.createLead({ companyId: 'c1', name: 'X' })).rejects.toThrow(/returned no id/)
  })

  it('does not report success when message_post returns nothing', async () => {
    const { rec } = sys({ 'res.partner.message_post': null })
    await expect(
      rec.createNote({
        companyId: 'c1',
        objectType: 'res.partner',
        objectId: '1',
        body: 'x',
        authorPrincipalId: 'p',
      }),
    ).rejects.toThrow(/cannot be proven/)
  })

  it('says so plainly when the database has no activity type configured', async () => {
    const { rec } = sys({
      'ir.model.search_read': [{ id: 3 }],
      'mail.activity.type.search_read': [],
    })
    await expect(
      rec.scheduleActivity({
        companyId: 'c1',
        objectType: 'res.partner',
        objectId: '1',
        summary: 's',
        dueDate: '2026-08-05',
      }),
    ).rejects.toThrow(/no mail\.activity\.type could be resolved/)
  })
})

describe('end to end through the governed pipeline', () => {
  function ports(rec: ReturnType<typeof createOdooRecordSystem>): ActionPorts {
    return {
      executors: buildExecutors(rec),
      approvalRequired: () => false,
      findPriorResult: async () => null,
      recordApprovalRequest: async () => 'approval-1',
      objectCompanyId: async () => 'company-epic',
      writeAudit: async () => 'audit-1',
    }
  }

  const proposal = {
    actionType: 'note.create',
    actorPrincipalId: 'principal-7',
    actorRole: 'manager',
    companyId: 'company-epic',
    objectType: 'res.partner',
    objectId: '42',
    payload: { body: 'Customer called about a dropped line' },
    idempotencyKey: 'idem-1',
    correlationId: 'corr-1',
  }

  it('EXECUTED only once the note is read back as the text we sent', async () => {
    const { rec } = sys({
      'res.partner.message_post': 101,
      'mail.message.search_read': [
        { id: 101, body: '<p>Customer called about a dropped line</p>' },
      ],
    })
    const r = await runGovernedAction(proposal, ports(rec))
    expect(r.outcome, r.detail).toBe('EXECUTED')
    expect(r.readback?.body).toBe('Customer called about a dropped line')
  })

  it('READBACK_FAILED when Odoo stored something else', async () => {
    const { rec } = sys({
      'res.partner.message_post': 101,
      'mail.message.search_read': [{ id: 101, body: '<p>something entirely different</p>' }],
    })
    const r = await runGovernedAction(proposal, ports(rec))
    expect(r.outcome).toBe('READBACK_FAILED')
  })

  it('DEPENDENCY_UNAVAILABLE, not EXECUTION_FAILED, when Odoo is down', async () => {
    const { rec } = sys({
      'res.partner.message_post': () => {
        throw new OdooApiError(502, { message: 'bad gateway' })
      },
    })
    const r = await runGovernedAction(proposal, ports(rec))
    expect(r.outcome).toBe('DEPENDENCY_UNAVAILABLE')
    expect(r.detail).toContain('odoo')
  })

  it('EXECUTION_FAILED, not DEPENDENCY_UNAVAILABLE, when Odoo refuses', async () => {
    const { rec } = sys({
      'res.partner.message_post': () => {
        throw new OdooApiError(403, { message: 'access denied' })
      },
    })
    const r = await runGovernedAction(proposal, ports(rec))
    expect(r.outcome).toBe('EXECUTION_FAILED')
  })
})

describe('the boundary', () => {
  it('never opens a socket in this suite — the transport is always injected', () => {
    const src = readFileSync(join(__dirname, 'odoo-record-system.test.ts'), 'utf8')
    // Only the IMPORT BLOCK is checked. Scanning the whole file would match the
    // assertion's own search text, so the test would pass or fail for a reason
    // that has nothing to do with the code under test.
    const imports = src.slice(0, src.indexOf('describe('))
    expect(imports).not.toMatch(/\bjson2Call\b/)
  })

  it('sends no message and touches no messaging provider', () => {
    const src = readFileSync(join(__dirname, 'odoo-record-system.ts'), 'utf8')
    // Comments are stripped FIRST. This file's own docstring explains why the
    // Chatwoot-bound customer tools are deliberately not reused, and prose about
    // a thing is not a call to it. Matching the comment would confuse what the
    // code says with what the code does.
    const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    const code = noComments.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(noComments).not.toMatch(/graph\.facebook\.com|api\.twilio|chatwoot|agents\.epic\.dm/i)
    expect(noComments).not.toMatch(/process\.env/)
  })

  it('never puts the api key into an error message', async () => {
    const { rec } = sys({
      'crm.lead.create': () => {
        throw new OdooApiError(500, { message: 'internal error' })
      },
    })
    const err = await rec.createLead({ companyId: 'c1', name: 'X' }).catch((e: Error) => e)
    expect(String((err as Error).message)).not.toContain(CONFIG.apiKey)
  })
})
