import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  DependencyUnavailable,
  runGovernedAction,
  type ActionOutcome,
  type ActionPorts,
  type ActionProposal,
  type ActionResult,
  type ApprovalVerdict,
} from '../action'
import { buildExecutors, type RecordSystem } from './index'

/**
 * Every executor is walked through EVERY outcome. The point is not coverage for
 * its own sake: each row here is a way a real action can end badly, and the test
 * proves the caller is told which one it was instead of a generic failure.
 */

const COMPANY = 'company-epic'
const OTHER_COMPANY = 'company-someone-else'

type Fault =
  | 'none'
  | 'dependency_down'
  | 'write_refused'
  | 'readback_null'
  | 'readback_throw'
  | 'readback_mismatch'

/** Sentinel used to simulate "the record came back, but not with what we wrote". */
const TAMPERED = {
  body: 'TAMPERED',
  title: 'TAMPERED',
  summary: 'TAMPERED',
  name: 'TAMPERED',
  stage: 'lost',
  note: 'TAMPERED',
}

function fakeRecordSystem(fault: Fault = 'none') {
  const rows = new Map<string, Record<string, unknown>>()
  // A lead that already exists, so lead.update has something to change.
  rows.set('lead-9', { externalId: 'lead-9', name: 'Bay Front Hotel', stage: 'new' })

  let seq = 0
  const state = { writeAttempts: 0 }

  async function write(kind: string, row: Record<string, unknown>, forcedId?: string) {
    state.writeAttempts += 1
    if (fault === 'dependency_down') {
      throw new DependencyUnavailable('odoo', 'connect ECONNREFUSED')
    }
    if (fault === 'write_refused') {
      throw new Error('odoo rejected the write: field is read-only')
    }
    const externalId = forcedId ?? `${kind}-${++seq}`
    rows.set(externalId, { ...(rows.get(externalId) ?? {}), externalId, ...row })
    return { externalId }
  }

  async function read(externalId: string) {
    if (fault === 'readback_throw') throw new Error('odoo read timed out')
    if (fault === 'readback_null') return null
    const row = rows.get(externalId) ?? null
    if (row && fault === 'readback_mismatch') return { ...row, ...TAMPERED }
    return row
  }

  const rec: RecordSystem = {
    createNote: (i) => write('note', { ...i }),
    readNote: read,
    createTask: (i) => write('task', { ...i }),
    readTask: read,
    scheduleActivity: (i) => write('activity', { ...i }),
    readActivity: read,
    createLead: (i) => write('lead', { ...i }),
    readLead: read,
    updateLead: (i) => write('lead', { ...i.fields }, i.leadId),
    scheduleFollowup: (i) => write('followup', { ...i }),
    readFollowup: read,
  }

  return { rec, rows, state }
}

interface PortOpts {
  approvalFor?: string[]
  verdict?: ApprovalVerdict
  prior?: ActionResult | null
  objectCompany?: string | null
}

function buildPorts(rec: RecordSystem, opts: PortOpts = {}) {
  const audits: { outcome: ActionOutcome; detail: string }[] = []
  const ports: ActionPorts = {
    executors: buildExecutors(rec),
    approvalRequired: (actionType) => (opts.approvalFor ?? []).includes(actionType),
    findPriorResult: async () => opts.prior ?? null,
    recordApprovalRequest: async () => 'approval-1',
    objectCompanyId: async () =>
      opts.objectCompany === undefined ? COMPANY : opts.objectCompany,
    writeAudit: async (entry) => {
      audits.push({ outcome: entry.outcome, detail: entry.detail })
      return `audit-${audits.length}`
    },
  }
  if (opts.verdict) ports.approvalVerdict = async () => opts.verdict as ApprovalVerdict
  return { ports, audits }
}

interface Case {
  actionType: string
  objectType: string
  objectId: string
  actorRole: string
  valid: Record<string, unknown>
  invalid: Record<string, unknown>
  invalidDetail: RegExp
  matchField: string
}

const CASES: Case[] = [
  {
    actionType: 'note.create',
    objectType: 'res.partner',
    objectId: 'partner-1',
    actorRole: 'staff',
    valid: { body: 'Customer called about a dropped line' },
    invalid: { body: '   ' },
    invalidDetail: /body is required/,
    matchField: 'body',
  },
  {
    actionType: 'task.create',
    objectType: 'res.partner',
    objectId: 'partner-1',
    actorRole: 'staff',
    valid: { title: 'Call the customer back', dueDate: '2026-08-04' },
    invalid: { title: 'Call the customer back', dueDate: 'sometime next week' },
    invalidDetail: /dueDate is not a valid date/,
    matchField: 'title',
  },
  {
    actionType: 'activity.schedule',
    objectType: 'res.partner',
    objectId: 'partner-1',
    actorRole: 'manager',
    valid: { summary: 'Site visit', dueDate: '2026-08-05T09:00:00Z' },
    invalid: { summary: 'Site visit' },
    invalidDetail: /dueDate is required/,
    matchField: 'summary',
  },
  {
    actionType: 'lead.create',
    objectType: 'res.company',
    objectId: COMPANY,
    actorRole: 'staff',
    valid: { name: 'Bay Front Hotel', source: 'whatsapp' },
    invalid: { name: '' },
    invalidDetail: /name is required/,
    matchField: 'name',
  },
  {
    actionType: 'lead.update',
    objectType: 'crm.lead',
    objectId: 'lead-9',
    actorRole: 'manager',
    valid: { stage: 'qualified' },
    invalid: {},
    invalidDetail: /at least one field to update is required/,
    matchField: 'stage',
  },
  {
    actionType: 'followup.schedule',
    objectType: 'crm.lead',
    objectId: 'lead-9',
    actorRole: 'staff',
    valid: { note: 'Check whether the quote landed', dueDate: '2026-08-12' },
    invalid: { note: 'Check whether the quote landed', dueDate: 'whenever' },
    invalidDetail: /dueDate is required/,
    matchField: 'note',
  },
]

function proposalFor(c: Case, over: Partial<ActionProposal> = {}): ActionProposal {
  return {
    actionType: c.actionType,
    actorPrincipalId: 'principal-7',
    actorRole: c.actorRole,
    companyId: COMPANY,
    objectType: c.objectType,
    objectId: c.objectId,
    payload: c.valid,
    idempotencyKey: `idem-${c.actionType}`,
    correlationId: 'corr-1',
    ...over,
  }
}

describe.each(CASES)('$actionType', (c) => {
  it('executes and reads back a valid proposal', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome, r.detail).toBe('EXECUTED')
    expect(r.readback).not.toBeNull()
    expect(String(r.readback?.[c.matchField])).toBe(String(c.valid[c.matchField]))
    expect(state.writeAttempts).toBe(1)
    expect(audits.at(-1)?.outcome).toBe('EXECUTED')
  })

  it('refuses a malformed payload for the stated reason, and writes nothing', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c, { payload: c.invalid }), ports)

    expect(r.outcome).toBe('VALIDATION_FAILED')
    expect(r.detail).toMatch(c.invalidDetail)
    expect(state.writeAttempts).toBe(0)
    expect(audits.at(-1)?.outcome).toBe('VALIDATION_FAILED')
  })

  it('refuses a role that is not allowed to propose it', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c, { actorRole: 'guest' }), ports)

    expect(r.outcome).toBe('PERMISSION_DENIED')
    expect(state.writeAttempts).toBe(0)
    expect(audits.at(-1)?.outcome).toBe('PERMISSION_DENIED')
  })

  it('refuses an object belonging to another company, and writes nothing', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec, { objectCompany: OTHER_COMPANY })

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('PERMISSION_DENIED')
    expect(state.writeAttempts).toBe(0)
    expect(audits.at(-1)?.outcome).toBe('PERMISSION_DENIED')
  })

  it('gives a missing object and a foreign object the SAME refusal wording', async () => {
    const { rec: recA } = fakeRecordSystem()
    const { rec: recB } = fakeRecordSystem()
    const missing = await runGovernedAction(
      proposalFor(c),
      buildPorts(recA, { objectCompany: null }).ports,
    )
    const foreign = await runGovernedAction(
      proposalFor(c),
      buildPorts(recB, { objectCompany: OTHER_COMPANY }).ports,
    )

    // Different wording here would let a caller probe for record ids that exist
    // in someone else's company.
    expect(missing.detail).toBe(foreign.detail)
    expect(missing.outcome).toBe('PERMISSION_DENIED')
  })

  it('holds for approval instead of executing when approval is required', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec, { approvalFor: [c.actionType] })

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('APPROVAL_REQUIRED')
    expect(r.approvalId).toBe('approval-1')
    expect(state.writeAttempts).toBe(0)
    expect(audits.at(-1)?.outcome).toBe('APPROVAL_REQUIRED')
  })

  it('executes once approval has been granted', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports } = buildPorts(rec, {
      approvalFor: [c.actionType],
      verdict: { state: 'granted', approvalId: 'approval-42' },
    })

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome, r.detail).toBe('EXECUTED')
    expect(state.writeAttempts).toBe(1)
  })

  it('executes nothing when approval has been rejected', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec, {
      approvalFor: [c.actionType],
      verdict: { state: 'rejected', approvalId: 'approval-42', reason: 'not this customer' },
    })

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('APPROVAL_REJECTED')
    expect(r.detail).toContain('not this customer')
    expect(state.writeAttempts).toBe(0)
    expect(audits.at(-1)?.outcome).toBe('APPROVAL_REJECTED')
  })

  it('replays a duplicate idempotency key without executing again', async () => {
    const { rec, state } = fakeRecordSystem()
    const prior: ActionResult = {
      version: 'governed-action@1',
      outcome: 'EXECUTED',
      actionType: c.actionType,
      idempotencyKey: `idem-${c.actionType}`,
      correlationId: 'corr-1',
      riskLevel: 'low',
      readback: { externalId: 'already-there' },
      auditId: 'audit-earlier',
      detail: 'executed and read back already-there',
    }
    const { ports, audits } = buildPorts(rec, { prior })

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('IDEMPOTENT_REPLAY')
    expect(r.readback).toEqual({ externalId: 'already-there' })
    expect(state.writeAttempts).toBe(0)
    // A replay is not a new business event, so it writes no new audit row.
    expect(audits).toHaveLength(0)
  })

  it('replays before it judges permission, so a retry cannot flip to denied', async () => {
    const { rec } = fakeRecordSystem()
    const prior: ActionResult = {
      version: 'governed-action@1',
      outcome: 'EXECUTED',
      actionType: c.actionType,
      idempotencyKey: `idem-${c.actionType}`,
      correlationId: 'corr-1',
      riskLevel: 'low',
      readback: { externalId: 'already-there' },
      auditId: 'audit-earlier',
      detail: 'executed and read back already-there',
    }
    const { ports } = buildPorts(rec, { prior })

    const r = await runGovernedAction(proposalFor(c, { actorRole: 'guest' }), ports)

    expect(r.outcome).toBe('IDEMPOTENT_REPLAY')
  })

  it('reports DEPENDENCY_UNAVAILABLE when the system of record is unreachable', async () => {
    const { rec } = fakeRecordSystem('dependency_down')
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('DEPENDENCY_UNAVAILABLE')
    expect(r.detail).toContain('odoo')
    expect(r.readback).toBeNull()
    expect(audits.at(-1)?.outcome).toBe('DEPENDENCY_UNAVAILABLE')
  })

  it('reports EXECUTION_FAILED when the write itself is refused', async () => {
    const { rec } = fakeRecordSystem('write_refused')
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('EXECUTION_FAILED')
    expect(r.readback).toBeNull()
    expect(audits.at(-1)?.outcome).toBe('EXECUTION_FAILED')
  })

  it('does NOT claim success when the record cannot be read back', async () => {
    const { rec } = fakeRecordSystem('readback_null')
    const { ports, audits } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.readback).toBeNull()
    expect(audits.at(-1)?.outcome).toBe('READBACK_FAILED')
  })

  it('does NOT claim success when the readback throws, and names the written id', async () => {
    const { rec } = fakeRecordSystem('readback_throw')
    const { ports } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.detail).toMatch(/^wrote .+ but readback threw/)
  })

  it('does NOT claim success when the record comes back with different content', async () => {
    const { rec } = fakeRecordSystem('readback_mismatch')
    const { ports } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c), ports)

    expect(r.outcome).toBe('READBACK_FAILED')
    expect(r.detail).toMatch(/did not match/)
  })

  it('refuses a proposal with no idempotency key', async () => {
    const { rec, state } = fakeRecordSystem()
    const { ports } = buildPorts(rec)

    const r = await runGovernedAction(proposalFor(c, { idempotencyKey: '' }), ports)

    expect(r.outcome).toBe('VALIDATION_FAILED')
    expect(r.detail).toContain('idempotencyKey')
    expect(state.writeAttempts).toBe(0)
  })

  it('writes exactly one audit row per non-replay outcome', async () => {
    const { rec } = fakeRecordSystem()
    const { ports, audits } = buildPorts(rec)

    await runGovernedAction(proposalFor(c), ports)

    expect(audits).toHaveLength(1)
    expect(audits[0].detail.length).toBeGreaterThan(0)
  })
})

describe('the executor set as a whole', () => {
  it('declares exactly the six Foundation-owned actions', () => {
    const { rec } = fakeRecordSystem()
    expect(buildExecutors(rec).map((e) => e.actionType).sort()).toEqual([
      'activity.schedule',
      'followup.schedule',
      'lead.create',
      'lead.update',
      'note.create',
      'task.create',
    ])
  })

  it('declares no communications action', () => {
    const { rec } = fakeRecordSystem()
    const types = buildExecutors(rec).map((e) => e.actionType)
    for (const t of types) {
      expect(t).not.toMatch(/message|whatsapp|chat|conversation|inbox|reply|send|handover|takeover/i)
    }
  })

  it('refuses an action type nobody declared, rather than inventing one', async () => {
    const { rec } = fakeRecordSystem()
    const { ports } = buildPorts(rec)
    const r = await runGovernedAction(
      proposalFor(CASES[0], { actionType: 'message.send' }),
      ports,
    )
    expect(r.outcome).toBe('VALIDATION_FAILED')
    expect(r.detail).toContain('no executor declared')
  })

  it('performs no communications side effect — the source has no transport in it', () => {
    const src = readFileSync(join(__dirname, 'index.ts'), 'utf8')
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '')
      .replace(/'[^']*'/g, "''")
      .replace(/"[^"]*"/g, '""')

    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\b(axios|https?)\./)
    expect(code).not.toMatch(/\b(sendMessage|sendReply|deliver|enqueueMessage)\s*\(/)
    expect(src).not.toMatch(/graph\.facebook\.com|api\.twilio|chatwoot|agents\.epic\.dm/i)
    expect(src).not.toMatch(/process\.env/)
  })
})
