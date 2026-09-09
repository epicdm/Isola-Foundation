import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LIFECYCLE_PRESENTATION, type ActionLifecycleState } from '@/lib/customer-workspace/contract'

const {
  getSessionMock,
  requireWorkspaceAccessMock,
  json2CallMock,
  resolveOdooConfigMock,
  resolveOdooConfigWriteMock,
  rows,
} = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
  json2CallMock: vi.fn(),
  resolveOdooConfigMock: vi.fn(),
  resolveOdooConfigWriteMock: vi.fn(),
  rows: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }))
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }))

// The two resolvers are stubbed; everything else -- including
// isOdooBindingRequiredError and the error class the refusal is recognised by
// -- is the REAL module. A test that supplied its own recogniser would be
// asserting against itself.
vi.mock('@/lib/engine-bindings', async (orig) => {
  const actual = await orig<typeof import('@/lib/engine-bindings')>()
  return {
    ...actual,
    resolveOdooConfigForTenant: resolveOdooConfigMock,
    resolveOdooConfigForTenantWrite: resolveOdooConfigWriteMock,
  }
})

vi.mock('@/engines/odoo', async (orig) => {
  const actual = await orig<typeof import('@/engines/odoo')>()
  return { ...actual, json2Call: json2CallMock }
})

/** An in-memory stand-in for the one table the shared ledger writes to. */
vi.mock('@/lib/prisma', () => {
  let seq = 0
  return {
    prisma: {
      customerToolOperation: {
        findFirst: async ({ where }: { where: Record<string, unknown> }) =>
          rows.find(
            (r) => r.tenant_id === where.tenant_id && r.operation_id === where.operation_id,
          ) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `rec-${++seq}`, claimed_at: new Date(), completed_at: null, ...data }
          rows.push(row)
          return row
        },
        update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = rows.find((r) => r.id === where.id)
          if (!row) throw new Error('no row')
          Object.assign(row, data)
          return row
        },
        findMany: async () => [],
      },
      odooBinding: { findUnique: async () => null },
    },
    default: {},
  }
})

import { OdooBindingRequiredError, TENANT_NOT_BOUND } from '@/lib/engine-bindings'

import { POST } from './route'

const TENANT = 'tenant-1'
const PARTNER = {
  id: 42,
  name: 'Marigot Hardware',
  email: null,
  phone: null,
  city: null,
  street: null,
  is_company: true,
  parent_id: false,
  active: true,
}

const session = { effectiveTenantId: TENANT, user: { id: 'user-1' } }
const allow = () => ({
  ok: true,
  authz: { level: 'manager', basis: 'membership', membershipRole: 'admin', canViewAudit: false, canViewConfiguration: false },
})

const params = (customerId = '42') => ({ params: Promise.resolve({ customerId }) })

const post = (body: unknown, customerId = '42') =>
  POST(
    new Request(`http://localhost/api/v1/customers/${customerId}/actions`, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    params(customerId),
  )

const note = (over: Record<string, unknown> = {}) => ({
  actionType: 'note.create',
  payload: { body: 'called the customer back' },
  idempotencyKey: `k-${Math.random()}`,
  ...over,
})

/** The customer exists; nothing else answers unless a test says so. */
function customerExists() {
  json2CallMock.mockImplementation(async (_cfg, model: string) => {
    if (model === 'res.partner') return [PARTNER]
    return []
  })
}

beforeEach(() => {
  rows.length = 0
  getSessionMock.mockReset()
  requireWorkspaceAccessMock.mockReset()
  json2CallMock.mockReset()
  resolveOdooConfigMock.mockReset()
  resolveOdooConfigWriteMock.mockReset()
  resolveOdooConfigMock.mockResolvedValue({ url: 'https://tenant.odoo.com', apiKey: 'k', db: 'd' })
  resolveOdooConfigWriteMock.mockResolvedValue({ url: 'https://tenant.odoo.com', apiKey: 'k', db: 'd' })
  getSessionMock.mockResolvedValue(session)
  requireWorkspaceAccessMock.mockResolvedValue(allow())
})

/* ── guards ───────────────────────────────────────────────────────────*/

describe('nothing is proposed before the reader is known', () => {
  it('answers 401 with no session and never reads the body', async () => {
    getSessionMock.mockResolvedValue(null)

    const res = await post(note())

    expect(res.status).toBe(401)
    expect(json2CallMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('answers 403 without the manager role', async () => {
    requireWorkspaceAccessMock.mockResolvedValue({ ok: false, status: 403, error: 'nope', authz: {} })

    const res = await post(note())

    expect(res.status).toBe(403)
    expect(rows).toHaveLength(0)
  })

  it('answers 404 for an unusable customer reference', async () => {
    const res = await post(note(), 'not-an-id')

    expect(res.status).toBe(404)
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})

/* ── the request itself being wrong is a 4xx ───────────────────────────────*/

describe('a malformed request is a 4xx, and an action outcome is not', () => {
  it('rejects a body that is not JSON', async () => {
    expect((await post('{{{')).status).toBe(400)
  })

  it('requires an actionType', async () => {
    expect((await post({ payload: {} , idempotencyKey: 'k' })).status).toBe(400)
  })

  it('requires an idempotency key rather than minting one per attempt', async () => {
    const res = await post({ actionType: 'note.create', payload: { body: 'x' } })
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error).toContain('idempotencyKey')
  })
})

/* ── the tenant boundary ───────────────────────────────────────────────*/

describe('a customer outside this tenant cannot be acted on', () => {
  it('answers 404 and never touches the ledger', async () => {
    json2CallMock.mockResolvedValue([])

    const res = await post(note())
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body.error).toBe('not found, or not available to you')
    expect(rows).toHaveLength(0)
  })

  it('resolves the system of record for the SESSION tenant, through the WRITE door', async () => {
    customerExists()

    await post(note())

    expect(resolveOdooConfigWriteMock).toHaveBeenCalledWith(TENANT)
    // The read resolver is the one that falls back to the deployment default.
    // A write must never reach it.
    expect(resolveOdooConfigMock).not.toHaveBeenCalled()
  })
})

/* ── a write must name its tenant, not inherit it ────────────────────────────*/

describe('a tenant with no binding row is refused before anything is written', () => {
  it('answers 200, names the reason, and never reaches Odoo or the ledger', async () => {
    customerExists()
    resolveOdooConfigWriteMock.mockRejectedValue(
      new OdooBindingRequiredError(TENANT, `tenant ${TENANT} has no OdooBinding row`),
    )

    const res = await post(note())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.reason).toBe(TENANT_NOT_BOUND)
    // Asserted on the mocks, not on the body: nothing was asked of Odoo and no
    // operation was claimed.
    expect(json2CallMock).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })

  it('CONTROL: a BOUND tenant is served, reaches Odoo, and reaches the ledger', async () => {
    customerExists()

    const body = await (await post(note())).json()

    expect(json2CallMock).toHaveBeenCalled()
    expect(rows).toHaveLength(1)
    expect(body.reason).toBeUndefined()
  })

  it('is not reported as an outage — an unreachable Odoo still says so in its own words', async () => {
    customerExists()
    resolveOdooConfigWriteMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:5432'))

    const body = await (await post(note())).json()

    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(body.reason).toBeUndefined()
    expect(LIFECYCLE_PRESENTATION[body.lifecycle as ActionLifecycleState].retryWrite).toBe('safe')
  })

  it('the unbound refusal does not advise a retry the way an outage does', async () => {
    customerExists()
    resolveOdooConfigWriteMock.mockRejectedValue(new OdooBindingRequiredError(TENANT, 'unbound'))

    const body = await (await post(note())).json()
    const lifecycle = body.lifecycle as ActionLifecycleState

    expect(lifecycle).not.toBe('dependency_unavailable')
    expect(LIFECYCLE_PRESENTATION[lifecycle].retryWrite).toBe('unsafe')
    expect(LIFECYCLE_PRESENTATION[lifecycle].escalate).toBe(true)
    expect(LIFECYCLE_PRESENTATION[lifecycle].success).toBe(false)
  })
})

/* ── the assertion this route exists for ───────────────────────────────────*/

describe('the status line never carries the verdict', () => {
  it('answers 200 with success:false when the system of record is unreachable', async () => {
    json2CallMock.mockImplementation(async (_c, model: string) => {
      if (model === 'res.partner') return [PARTNER]
      throw new Error('connect ECONNREFUSED 10.1.2.3:443')
    })

    const res = await post(note())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(body.retryWrite).toBe('safe')
  })

  it('answers 200 with success:false when the details are invalid', async () => {
    customerExists()

    const res = await post(note({ payload: { body: '' } }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('validation_failed')
    expect(body.detail).toBe('body is required')
  })

  it('answers 200 with success:false and holds an approval-gated action', async () => {
    customerExists()

    const res = await post(note({ actionType: 'lead.update', payload: { stage: 'qualified' } }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('approval_required')
    expect(body.approvalRef).toBeTruthy()
  })

  it('refuses note.add, which has no executor behind it', async () => {
    customerExists()

    const res = await post(note({ actionType: 'note.add' }))
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.lifecycle).toBe('validation_failed')
    expect(body.success).toBe(false)
    expect(rows).toHaveLength(0)
  })

  it('emits success straight from the contract, so only one state can carry it', async () => {
    customerExists()

    const res = await post(note({ payload: { body: '' } }))
    const body = await res.json()
    const lifecycle = body.lifecycle as ActionLifecycleState

    expect(body.success).toBe(LIFECYCLE_PRESENTATION[lifecycle].success)
    expect(body.label).toBe(LIFECYCLE_PRESENTATION[lifecycle].label)
    expect(body.marker).toBe(LIFECYCLE_PRESENTATION[lifecycle].marker)
  })

  it('never conveys the outcome by colour', async () => {
    customerExists()

    const body = await (await post(note({ payload: { body: '' } }))).json()

    expect(JSON.stringify(body)).not.toMatch(/\b(red|green|amber|yellow|orange)\b/i)
  })
})

/* ── the shared ledger ────────────────────────────────────────────────*/

describe('the shared ledger is the one that is used', () => {
  it('returns the ledger identifier for an action that reached it', async () => {
    json2CallMock.mockImplementation(async (_c, model: string) => {
      if (model === 'res.partner') return [PARTNER]
      throw new Error('down')
    })

    const body = await (await post(note())).json()

    expect(body.operationId).toMatch(/^op_/)
    expect(body.auditRef).toBeTruthy()
    expect(rows).toHaveLength(1)
    expect(rows[0].tenant_id).toBe(TENANT)
  })

  it('replays a repeated key instead of acting twice', async () => {
    json2CallMock.mockImplementation(async (_c, model: string) => {
      if (model === 'res.partner') return [PARTNER]
      throw new Error('down')
    })
    const payload = note({ idempotencyKey: 'stable-key' })

    const first = await (await post(payload)).json()
    const second = await (await post(payload)).json()

    expect(first.operationId).toBe(second.operationId)
    expect(rows).toHaveLength(1)
    // The first attempt failed, so this is a re-attempt rather than a replay of
    // a completed result -- and either way it is not reported as a success.
    expect(second.success).toBe(false)
  })

  it('writes no ledger row for a request that was never valid', async () => {
    customerExists()

    await post(note({ actionType: 'not.a.real.action' }))

    expect(rows).toHaveLength(0)
  })
})
