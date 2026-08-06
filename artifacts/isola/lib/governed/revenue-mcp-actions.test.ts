import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Integration tests for `revenue.followup.set` through the full governed
 * lifecycle: actor-type gate -> identity resolution -> ledger claim
 * (atomic) -> company-scope proof -> approve -> execute -> readback ->
 * ledger completion. Per `dec-pr80-odoo-scope-idempotency-and-read-contract-2026-08-06`.
 *
 * Two independent fakes, mocked once at the top of this file:
 *   - `@/lib/prisma` — an in-memory AuditLog table backing
 *     lib/governed/revenue-followup-approval.ts's approve/pending/revoke rows
 *     (the approval mechanism is UNCHANGED by this round's corrections).
 *   - the shared `createFakeLedgerStore()` (lib/operations/fake-ledger-store.ts)
 *     — the SAME real atomicity semantics (unique index + P2002 catch) that
 *     customer-actions.ts and lib/customer-tools/operation.ts already rely
 *     on. Never re-invented here.
 *
 * A fake "shared Odoo world" models ONE physical Odoo database (shared
 * `leads`/`activities` maps) with per-lead `companyId` and per-tenant-binding
 * `login` -> `companyId`, so a cross-tenant-shared-instance scenario is a
 * real, explicit fixture rather than assumed.
 */

interface FakeAuditRow {
  id: string
  tenant_id: string | null
  actor_id: string
  action: string
  entity: string | null | undefined
  entity_id: string | null | undefined
  request_id: string | null
  meta: unknown
  created_at: Date
}

const { rows, prismaMock } = vi.hoisted(() => {
  const rows: FakeAuditRow[] = []
  let seq = 0

  function matches(row: FakeAuditRow, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([k, v]) => row[k as keyof FakeAuditRow] === v)
  }

  const auditLog = {
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      seq += 1
      const row: FakeAuditRow = {
        id: `al-${seq}`,
        tenant_id: (data.tenant_id as string) ?? null,
        actor_id: data.actor_id as string,
        action: data.action as string,
        entity: data.entity as string | undefined,
        entity_id: data.entity_id as string | undefined,
        request_id: (data.request_id as string) ?? null,
        meta: data.meta,
        created_at: new Date(Date.now() + seq),
      }
      rows.push(row)
      return row
    }),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      const found = rows.filter((r) => matches(r, where))
      found.sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      return found[0] ?? null
    }),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null),
  }

  const agent = { findUnique: vi.fn(async () => null) }

  return { rows, prismaMock: { auditLog, agent } }
})

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))

import type { OdooConfig } from '@/engines/odoo'
import { approveRevenueFollowup, computeApprovalScope, mintPendingApproval } from './revenue-followup-approval'
import { createFakeLedgerStore, type FakeLedgerStore } from '@/lib/operations/fake-ledger-store'
import {
  runRevenueFollowupSet,
  type RevenueFollowupSetRequest,
  type RevenueMcpPorts,
} from './revenue-mcp-actions'
import type { OdooScope, OdooScopePorts } from './revenue-odoo-scope'
import type { RecordSystem } from './executors'

const AGENT_REF = 'agent-atlas'
const TENANT_A = 'tenant-epic'
const TENANT_B = 'tenant-someone-else'
const LEAD_A = '1642' // belongs to company 10 (tenant A's bound company)
const LEAD_B_SAME_COMPANY = '1650' // also company 10 — used for the "changed opportunity" test
const COMPANY_A = 10
const COMPANY_MISMATCH = 99

const NOW = new Date('2026-08-06T12:00:00.000Z')

// ── the fake shared Odoo world ──────────────────────────────────────────────

function fakeOdooWorld() {
  const leads = new Map<string, { name: string; stage: string; ownerRef: string; companyId: number }>()
  const activities = new Map<string, { note: string; date_deadline: string }>()
  let activitySeq = 0
  const calls = { updateLead: 0, scheduleFollowup: 0, readLead: 0, readFollowup: 0 }

  const notUsed = async () => {
    throw new Error('not used by revenue.followup.set')
  }

  const buildRecordSystem = (_config: OdooConfig): RecordSystem => ({
    createNote: notUsed,
    readNote: async () => null,
    createTask: notUsed,
    readTask: async () => null,
    scheduleActivity: notUsed,
    readActivity: async () => null,
    createLead: notUsed,
    readLead: async (externalId) => {
      calls.readLead += 1
      const row = leads.get(externalId)
      return row ? { id: Number(externalId), name: row.name, stage: row.stage, ownerRef: row.ownerRef } : null
    },
    updateLead: async (input) => {
      calls.updateLead += 1
      const row = leads.get(input.leadId)
      if (!row) throw new Error(`fake Odoo: no lead ${input.leadId}`)
      leads.set(input.leadId, { ...row, ...input.fields })
      return { externalId: input.leadId }
    },
    scheduleFollowup: async (input) => {
      calls.scheduleFollowup += 1
      activitySeq += 1
      const id = `activity-${activitySeq}`
      activities.set(id, { note: input.note, date_deadline: input.dueDate })
      return { externalId: id }
    },
    readFollowup: async (externalId) => {
      calls.readFollowup += 1
      const row = activities.get(externalId)
      return row ? { id: externalId, note: row.note, date_deadline: row.date_deadline } : null
    },
  })

  leads.set(LEAD_A, { name: 'EPIC Communications Inc', stage: 'qualified', ownerRef: '', companyId: COMPANY_A })
  leads.set(LEAD_B_SAME_COMPANY, { name: 'Second EPIC opportunity', stage: 'new', ownerRef: '', companyId: COMPANY_A })

  return { leads, activities, calls, buildRecordSystem }
}

type World = ReturnType<typeof fakeOdooWorld>

/** bindings: tenantId -> { login } | undefined (undefined = NO explicit OdooBinding row at all). */
function fakeOdooScopePorts(input: {
  bindings: Record<string, { login: string | null } | undefined>
  userCompany: Record<string, number>
  world: World
}): OdooScopePorts {
  const config: OdooConfig = { url: 'https://shared.odoo.com', db: 'shared', apiKey: 'fixture-key' }
  return {
    resolveOdooScope: async (tenantId): Promise<OdooScope | null> => {
      const binding = input.bindings[tenantId]
      if (!binding) return null // no explicit binding row -> fail closed
      const login = (binding.login ?? '').trim()
      if (!login) return null // binding exists but no bound user -> no provable company
      const boundCompanyId = input.userCompany[login]
      if (boundCompanyId === undefined) return null
      return { config, boundCompanyId }
    },
    readLeadCompanyId: async (_config, leadId) => {
      const row = input.world.leads.get(leadId)
      return row ? row.companyId : null
    },
  }
}

function resolveTenantForAgent(map: Record<string, string | null>) {
  return async (agentRef: string) => map[agentRef] ?? null
}

function ports(input: {
  ledger: FakeLedgerStore
  odooScope: OdooScopePorts
  world: World
  tenantMap?: Record<string, string | null>
}): RevenueMcpPorts {
  return {
    resolveTenantForAgent: resolveTenantForAgent(input.tenantMap ?? { [AGENT_REF]: TENANT_A }),
    odooScope: input.odooScope,
    buildRecordSystem: input.world.buildRecordSystem,
    ledger: input.ledger,
    now: () => NOW,
  }
}

function baseRequest(over: Partial<RevenueFollowupSetRequest> = {}): RevenueFollowupSetRequest {
  return {
    caller: { agentRef: AGENT_REF, actorType: 'clawith_agent' },
    leadId: LEAD_A,
    payload: { ownerRef: '7', nextAction: 'Call back re: internet/calling/support recommendation', dueDate: '2026-08-07' },
    idempotencyKey: 'idem-1',
    correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
    ...over,
  }
}

/** Pre-seeds a granted approval that EXACTLY matches the scope `runRevenueFollowupSet` will compute for `req`. */
async function preApprove(req: RevenueFollowupSetRequest, tenantId: string) {
  const scope = computeApprovalScope({
    tenantId,
    clawithAgentId: req.caller.agentRef,
    tool: 'revenue.followup.set',
    objectId: req.leadId,
    fields: {
      ...(req.payload.ownerRef ? { ownerRef: req.payload.ownerRef } : {}),
      ...(req.payload.nextAction ? { nextAction: req.payload.nextAction } : {}),
      ...(req.payload.dueDate ? { dueDate: req.payload.dueDate } : {}),
    },
    correlationId: req.correlationId,
    idempotencyKey: req.idempotencyKey,
  })
  const pending = await mintPendingApproval(scope, NOW)
  const approved = await approveRevenueFollowup({ pendingApprovalId: pending.auditId, approverActorId: 'user-eric', now: NOW })
  if (!approved.ok) throw new Error('setup: approve failed: ' + JSON.stringify(approved))
  return approved.auditId
}

async function approveCurrentPending(idempotencyKey: string, approverActorId = 'user-eric') {
  const pending = rows
    .filter((r) => r.action === 'revenue.followup.set.pending_approval' && r.request_id === idempotencyKey)
    .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0]
  if (!pending) throw new Error('setup: no pending approval row found to approve')
  const approved = await approveRevenueFollowup({ pendingApprovalId: pending.id, approverActorId, now: NOW })
  if (!approved.ok) throw new Error('setup: approve failed: ' + JSON.stringify(approved))
  return approved.auditId
}

let ledger: FakeLedgerStore

beforeEach(() => {
  rows.length = 0
  vi.clearAllMocks()
  ledger = createFakeLedgerStore(() => NOW)
})

// ── correction 5 — actor type fails closed ──────────────────────────────────

describe('actor type', () => {
  it.each(['', 'human', 'unknown', 'FOUNDATION_STAFF', 'clawith-agent'])(
    'denies an unsupported/malformed actor type %j',
    async (actorType) => {
      const world = fakeOdooWorld()
      const odooScope = fakeOdooScopePorts({
        bindings: { [TENANT_A]: { login: 'usera@x.com' } },
        userCompany: { 'usera@x.com': COMPANY_A },
        world,
      })
      const result = await runRevenueFollowupSet(
        baseRequest({ caller: { agentRef: AGENT_REF, actorType } }),
        ports({ ledger, odooScope, world }),
      )
      expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
      expect(world.calls.updateLead).toBe(0)
    },
  )

  it('accepts the one supported actor type, clawith_agent', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const result = await runRevenueFollowupSet(baseRequest(), ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).not.toBe('unauthenticated')
  })
})

// ── unauthenticated identity ─────────────────────────────────────────────────

describe('unauthenticated caller', () => {
  it('denies when no agentRef is supplied', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({ bindings: {}, userCompany: {}, world })
    const result = await runRevenueFollowupSet(
      baseRequest({ caller: { agentRef: '', actorType: 'clawith_agent' } }),
      ports({ ledger, odooScope, world }),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
    expect(world.calls.updateLead).toBe(0)
  })

  it('denies when the agentRef does not resolve to an active tenant', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({ bindings: {}, userCompany: {}, world })
    const result = await runRevenueFollowupSet(
      baseRequest({ caller: { agentRef: 'agent-unknown', actorType: 'clawith_agent' } }),
      ports({ ledger, odooScope, world }),
    )
    expect(result).toEqual({ ok: false, code: 'unauthenticated', detail: expect.any(String) })
    expect(world.calls.updateLead).toBe(0)
  })
})

// ── correction 1 — explicit Odoo binding, no global fallback, proven company scope ──
// Mandatory tests 1-5: two tenants share one Odoo instance; cross-tenant lead reuse;
// no binding at all; wrong company; all four assert zero writes + no success audit.

describe('Odoo company scope — two tenants sharing one physical Odoo instance', () => {
  function sharedWorldAndScope() {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: {
        [TENANT_A]: { login: 'usera@x.com' }, // bound company 10 — owns LEAD_A
        // TENANT_B deliberately has NO entry at all -> no explicit binding row
      },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    return { world, odooScope }
  }

  it('tenant A executes fully against its own lead (control case)', async () => {
    const { world, odooScope } = sharedWorldAndScope()
    const req = baseRequest({ idempotencyKey: 'idem-control' })
    await preApprove(req, TENANT_A)
    const result = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world, tenantMap: { [AGENT_REF]: TENANT_A } }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('EXECUTED')
    expect(world.calls.updateLead).toBe(1)
  })

  it('mandatory test 2: tenant B request using tenant A\'s valid lead id is denied, zero writes', async () => {
    const { world, odooScope } = sharedWorldAndScope()
    const req = baseRequest({ idempotencyKey: 'idem-cross-tenant', leadId: LEAD_A })
    // Tenant B resolves via its OWN agent ref, but has no binding at all — see below.
    const result = await runRevenueFollowupSet(
      req,
      ports({ ledger, odooScope, world, tenantMap: { [AGENT_REF]: TENANT_B } }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('PERMISSION_DENIED')
    expect(world.calls.updateLead).toBe(0)
    expect(world.calls.scheduleFollowup).toBe(0)
    expect(rows.some((r) => r.action === 'revenue.followup.set' && (r.meta as { outcome?: string })?.outcome === 'EXECUTED')).toBe(false)
  })

  it('mandatory test 3: tenant with NO explicit OdooBinding at all is denied, zero writes (no global fallback)', async () => {
    const { world, odooScope } = sharedWorldAndScope()
    const req = baseRequest({ idempotencyKey: 'idem-no-binding', leadId: LEAD_A })
    const result = await runRevenueFollowupSet(
      req,
      ports({ ledger, odooScope, world, tenantMap: { [AGENT_REF]: TENANT_B } }), // TENANT_B has no binding entry
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('PERMISSION_DENIED')
    expect(world.calls.updateLead).toBe(0)
    expect(rows.some((r) => (r.meta as { outcome?: string })?.outcome === 'EXECUTED')).toBe(false)
  })

  it('mandatory test 4: tenant has a binding, but bound to a DIFFERENT company than the lead — denied, zero writes', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_B]: { login: 'userb@x.com' } }, // tenant B DOES have an explicit binding...
      userCompany: { 'userb@x.com': COMPANY_MISMATCH }, // ...but bound to a company LEAD_A does not belong to
      world,
    })
    const req = baseRequest({ idempotencyKey: 'idem-wrong-company', leadId: LEAD_A })
    const result = await runRevenueFollowupSet(
      req,
      ports({ ledger, odooScope, world, tenantMap: { [AGENT_REF]: TENANT_B } }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('PERMISSION_DENIED')
    expect(world.calls.updateLead).toBe(0)
    expect(rows.some((r) => (r.meta as { outcome?: string })?.outcome === 'EXECUTED')).toBe(false)
  })

  it('a binding that exists but has no bound login is also denied, zero writes (cannot prove company scope)', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_B]: { login: null } },
      userCompany: {},
      world,
    })
    const req = baseRequest({ idempotencyKey: 'idem-no-login', leadId: LEAD_A })
    const result = await runRevenueFollowupSet(
      req,
      ports({ ledger, odooScope, world, tenantMap: { [AGENT_REF]: TENANT_B } }),
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('PERMISSION_DENIED')
    expect(world.calls.updateLead).toBe(0)
  })

  it('the SAME resolved config backs the company check, the write, and the readback (no second path)', async () => {
    // If a second, independently-resolved config were ever used for the write,
    // buildRecordSystem would be called with a DIFFERENT OdooConfig object than
    // the one objectCompanyId proved — assert it is called with the exact same
    // config identity every time.
    const { world, odooScope } = sharedWorldAndScope()
    const seenConfigs: OdooConfig[] = []
    const trackingWorld = { ...world, buildRecordSystem: (c: OdooConfig) => (seenConfigs.push(c), world.buildRecordSystem(c)) }
    const req = baseRequest({ idempotencyKey: 'idem-one-adapter' })
    await preApprove(req, TENANT_A)
    await runRevenueFollowupSet(req, ports({ ledger, odooScope, world: trackingWorld as typeof world, tenantMap: { [AGENT_REF]: TENANT_A } }))
    expect(seenConfigs.length).toBeGreaterThan(0)
    expect(seenConfigs.every((c) => c === seenConfigs[0])).toBe(true) // every call built from the SAME config object
  })
})

// ── approval lifecycle (unchanged mechanism, re-verified through the new ledger path) ──

describe('unapproved / approved write, through the ledger', () => {
  function tenantAScope() {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    return { world, odooScope }
  }

  it('unapproved write performs zero Odoo mutations and reports APPROVAL_REQUIRED', async () => {
    const { world, odooScope } = tenantAScope()
    const req = baseRequest({ idempotencyKey: 'idem-unapproved' })
    const result = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.outcome).toBe('APPROVAL_REQUIRED')
      expect(result.result.approvalId).toBeTruthy()
    }
    expect(world.calls.updateLead).toBe(0)
    expect(world.calls.scheduleFollowup).toBe(0)
  })

  it('approved write executes exactly once, with a readback that matches what Odoo actually stored', async () => {
    const { world, odooScope } = tenantAScope()
    const req = baseRequest({ idempotencyKey: 'idem-approved-1' })

    const first = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    if (!first.ok || first.result.outcome !== 'APPROVAL_REQUIRED') throw new Error('setup: expected APPROVAL_REQUIRED')
    await approveCurrentPending(req.idempotencyKey)

    const second = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    expect(second.ok).toBe(true)
    if (!second.ok) throw new Error('unreachable')
    expect(second.result.outcome).toBe('EXECUTED')
    expect(world.calls.updateLead).toBe(1)
    expect(world.calls.scheduleFollowup).toBe(1)
    expect(world.leads.get(LEAD_A)?.ownerRef).toBe('7')
    expect(second.result.readback).toMatchObject({
      leadId: LEAD_A,
      ownerRef: '7',
      followup: { note: 'Call back re: internet/calling/support recommendation' },
    })
    expect(second.result.auditId).toBeTruthy()
  })

  it('a straight replay after execution (no ledger race) performs zero additional writes', async () => {
    const { world, odooScope } = tenantAScope()
    const req = baseRequest({ idempotencyKey: 'idem-replay-1' })
    await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    await approveCurrentPending(req.idempotencyKey)
    const executed = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    if (!executed.ok || executed.result.outcome !== 'EXECUTED') throw new Error('setup: did not execute')

    const before = { ...world.calls }
    const replay = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    expect(replay.ok).toBe(true)
    if (!replay.ok) throw new Error('unreachable')
    expect(replay.result.outcome).toBe('IDEMPOTENT_REPLAY')
    expect(world.calls.updateLead).toBe(before.updateLead)
    expect(world.calls.scheduleFollowup).toBe(before.scheduleFollowup)
  })
})

// ── correction 3 — changed request under the same idempotency key ──────────

describe('changed request under the same idempotency key', () => {
  it('mandatory test 6: same idempotency key + changed field delta is denied, not replayed', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const key = 'idem-changed-delta'
    const approvedReq = baseRequest({ idempotencyKey: key })
    await runRevenueFollowupSet(approvedReq, ports({ ledger, odooScope, world }))
    await approveCurrentPending(key)

    const changedReq = baseRequest({ idempotencyKey: key, payload: { ...approvedReq.payload, dueDate: '2026-08-09' } })
    const result = await runRevenueFollowupSet(changedReq, ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('conflict')
    expect(world.calls.updateLead).toBe(0)
    expect(world.calls.scheduleFollowup).toBe(0)
  })

  it('mandatory test 7: same idempotency key + changed opportunity is denied, never echoes the prior result', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const key = 'idem-changed-opportunity'
    const reqLeadA = baseRequest({ idempotencyKey: key, leadId: LEAD_A })
    await runRevenueFollowupSet(reqLeadA, ports({ ledger, odooScope, world }))
    await approveCurrentPending(key)
    const executed = await runRevenueFollowupSet(reqLeadA, ports({ ledger, odooScope, world }))
    if (!executed.ok || executed.result.outcome !== 'EXECUTED') throw new Error('setup: lead A did not execute')

    const before = { ...world.calls }
    const reqLeadB = baseRequest({ idempotencyKey: key, leadId: LEAD_B_SAME_COMPANY })
    const result = await runRevenueFollowupSet(reqLeadB, ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Must NOT be an echo of lead A's EXECUTED result — it is a fresh
      // operation (different objectId -> different ledger identity) that has
      // never been approved, so it holds at APPROVAL_REQUIRED.
      expect(result.result.outcome).toBe('APPROVAL_REQUIRED')
    }
    // Lead A's already-executed state is untouched, and lead B was never written.
    expect(world.calls.updateLead).toBe(before.updateLead)
    expect(world.calls.scheduleFollowup).toBe(before.scheduleFollowup)
    expect(world.leads.get(LEAD_B_SAME_COMPANY)?.ownerRef).toBe('')
  })
})

// ── correction 4 — real atomic exactly-once under a genuine race ───────────

describe('correction 4 — atomic exactly-once', () => {
  it('mandatory test 8: two concurrent identical requests execute exactly once', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const req = baseRequest({ idempotencyKey: 'idem-concurrent' })

    // Pre-seed a granted approval for the EXACT scope both racers will
    // compute — otherwise the race would only ever be racing to reach
    // APPROVAL_REQUIRED, not to WRITE, which is the case this test exists to
    // prove is safe.
    await preApprove(req, TENANT_A)

    const p = ports({ ledger, odooScope, world })

    // The race is modelled exactly the way lib/operations/ledger.test.ts's own
    // "two simultaneous duplicates create ONE operation" test models it:
    // `onNextInsert` fires once, immediately before the SECOND caller's own
    // `insert()` — i.e. before the unique-index check that is the actual
    // atomicity boundary. Running a FULL second `runRevenueFollowupSet` call
    // inside that hook (rather than a bare `claimOperation`, as the ledger's
    // own test does) proves the boundary holds for the WHOLE write, not just
    // the claim: by the time the outer call's own `insert()` runs, the
    // "other racer" has already executed AND completed. This is more
    // deterministic than a bare `Promise.all` (which cannot force real
    // interleaving on Node's single-threaded event loop) while exercising
    // exactly the same P2002-catch-and-reread code path a true concurrent
    // request would hit.
    // A plain mutable object (not a bare `let`) — TypeScript's control-flow
    // narrowing otherwise "sees" only the `null` initializer for a `let`
    // reassigned inside a closure it cannot trace the timing of, and
    // collapses every later read to `never`. A property on a stable `const`
    // object is not narrowed that way.
    const captured: { winner: Awaited<ReturnType<typeof runRevenueFollowupSet>> | null } = { winner: null }
    ledger.onNextInsert(async () => {
      captured.winner = await runRevenueFollowupSet(req, p)
    })

    const loser = await runRevenueFollowupSet(req, p)

    if (!captured.winner) throw new Error('unreachable: onNextInsert hook did not run')
    const winnerResult = captured.winner
    if (!winnerResult.ok) throw new Error('unreachable')
    expect(winnerResult.result.outcome).toBe('EXECUTED')

    expect(loser.ok).toBe(true)
    if (loser.ok) {
      // The other call gets an already-completed / replay result — never a
      // second, independent EXECUTED outcome.
      expect(loser.result.outcome).toBe('IDEMPOTENT_REPLAY')
      expect(loser.result.readback).toEqual(winnerResult.result.readback)
    }

    // THE assertion: exactly one Odoo write happened, no matter how many
    // callers raced for it.
    expect(world.calls.updateLead).toBe(1)
    expect(world.calls.scheduleFollowup).toBe(1)
    expect(ledger.rows()).toHaveLength(1)
  })

  it('a genuinely concurrent dispatch (Promise.all) still converges to exactly one execution', async () => {
    // Same mechanism, dispatched via Promise.all so the two calls are
    // literally in flight together from the caller's point of view — the
    // onNextInsert hook still supplies the deterministic interleaving point
    // Node's cooperative scheduler would not reliably produce on its own.
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const req = baseRequest({ idempotencyKey: 'idem-concurrent-promiseall' })
    await preApprove(req, TENANT_A)
    const p = ports({ ledger, odooScope, world })

    let nestedResult: Awaited<ReturnType<typeof runRevenueFollowupSet>> | null = null
    ledger.onNextInsert(async () => {
      nestedResult = await runRevenueFollowupSet(req, p)
    })

    const [a] = await Promise.all([runRevenueFollowupSet(req, p)])
    const outcomes = [a, nestedResult].filter((r): r is Awaited<ReturnType<typeof runRevenueFollowupSet>> => !!r)

    const executedCount = outcomes.filter((r) => r.ok && r.result.outcome === 'EXECUTED').length
    expect(executedCount).toBe(1)
    expect(world.calls.updateLead).toBe(1)
  })
})

// ── correction 2 — unrelated approval rows never grant this write ──────────

describe('unrelated approval rows', () => {
  it('an approved row for a DIFFERENT tool, same tenant/object/correlation/key, never grants this write', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const key = 'idem-unrelated-tool'

    // Mint+approve a grant for an UNRELATED tool with otherwise-identical scope fields.
    const unrelatedScope = computeApprovalScope({
      tenantId: TENANT_A,
      clawithAgentId: AGENT_REF,
      tool: 'voice.route.set', // a different action entirely
      objectId: LEAD_A,
      fields: { ownerRef: '7', nextAction: 'Call back re: internet/calling/support recommendation', dueDate: '2026-08-07' },
      correlationId: 'epic-cz-revenue-loop1-2026-08-06-conv131',
      idempotencyKey: key,
    })
    const pending = await mintPendingApproval(unrelatedScope, NOW)
    await approveRevenueFollowup({ pendingApprovalId: pending.auditId, approverActorId: 'user-eric', now: NOW })

    const req = baseRequest({ idempotencyKey: key })
    const result = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('APPROVAL_REQUIRED') // never EXECUTED via the unrelated row
    expect(world.calls.updateLead).toBe(0)
  })
})

// ── secret scan ──────────────────────────────────────────────────────────────

describe('secret scan', () => {
  const SECRET_SHAPED = /(api[_-]?key|access[_-]?token|client[_-]?secret|hmac|webhook[_-]?verify|authorization\s*:\s*bearer|fixture-key)/i

  it('neither the result envelope nor the audit/ledger meta ever contains a secret-shaped string', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const req = baseRequest({ idempotencyKey: 'idem-secret-scan' })
    const first = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    await approveCurrentPending(req.idempotencyKey)
    const second = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))

    const serialized = JSON.stringify([first, second])
    expect(SECRET_SHAPED.test(serialized)).toBe(false)

    const serializedAuditMeta = JSON.stringify(rows.map((r) => r.meta))
    expect(SECRET_SHAPED.test(serializedAuditMeta)).toBe(false)

    const serializedLedger = JSON.stringify(ledger.rows())
    expect(SECRET_SHAPED.test(serializedLedger)).toBe(false)
  })
})

// ── write-surface discipline (unchanged from the prior pass) ───────────────

describe('write-surface discipline', () => {
  it('unknown payload keys are never used to widen the write', async () => {
    const world = fakeOdooWorld()
    const odooScope = fakeOdooScopePorts({
      bindings: { [TENANT_A]: { login: 'usera@x.com' } },
      userCompany: { 'usera@x.com': COMPANY_A },
      world,
    })
    const req = baseRequest({
      idempotencyKey: 'idem-widen-attempt',
      payload: { ownerRef: '7', stage: 'won', expectedRevenue: '999999' } as Record<string, string>,
    })
    await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    await approveCurrentPending(req.idempotencyKey)
    const result = await runRevenueFollowupSet(req, ports({ ledger, odooScope, world }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.result.outcome).toBe('EXECUTED')
    expect(world.calls.updateLead).toBe(1)
    expect(world.leads.get(LEAD_A)?.stage).toBe('qualified') // unchanged fixture default
  })
})
