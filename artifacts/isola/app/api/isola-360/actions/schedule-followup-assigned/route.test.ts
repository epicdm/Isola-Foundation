import { beforeEach, describe, expect, it, vi } from 'vitest'

const M = vi.hoisted(() => ({
  runCustomerAction: vi.fn(),
  resolveOdooConfigForTenant: vi.fn(async () => ({ some: 'config' })),
  readCustomer: vi.fn(async () => [{ id: 42 }]),
  getSessionFromCookie: vi.fn(async () => null),
}))

vi.mock('@/lib/governed/customer-actions', () => ({ runCustomerAction: M.runCustomerAction }))
// resolveCaller falls through to the session-cookie door when no bearer is
// presented, which calls Next.js's request-scoped cookies() API -- not
// available outside a real request context in this unit test. Mocked to
// "no session" (null), matching real production behaviour for a request
// with neither a valid bearer nor a valid cookie: 401, same as unmocked.
vi.mock('@/lib/session', () => ({ getSessionFromCookie: M.getSessionFromCookie }))
vi.mock('@/lib/permissions', () => ({ getMembershipRole: vi.fn(async () => null) }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: M.resolveOdooConfigForTenant }))
vi.mock('@/lib/context/customer-sources', () => ({
  odooCallerFor: (config: unknown) => config,
  parseCustomerId: (v: unknown) => {
    const n = Number(v)
    return Number.isSafeInteger(n) && n > 0 ? n : null
  },
  readCustomer: M.readCustomer,
}))
vi.mock('@/lib/governed/executors', () => ({ buildExecutors: () => [] }))
vi.mock('@/lib/governed/executors/odoo-record-system', () => ({ createOdooRecordSystem: () => ({}) }))
vi.mock('@/lib/operations/ledger', () => ({ prismaLedgerStore: {} }))

const TENANT_ID = 'tenant-epic-1'
const SERVICE_TOKEN = 'hermes-service-token-xyz'
const AGENT_ID = '21fa3ed2-9071-4c5f-b71d-014a77c4738d'

beforeEach(() => {
  M.runCustomerAction.mockReset()
  M.resolveOdooConfigForTenant.mockReset().mockResolvedValue({ some: 'config' })
  M.readCustomer.mockReset().mockResolvedValue([{ id: 42 }])
  M.getSessionFromCookie.mockReset().mockResolvedValue(null)
  vi.stubEnv('ISOLA_360_SERVICE_ENABLED', 'true')
  vi.stubEnv('ISOLA_360_SERVICE_TENANT_ID', TENANT_ID)
  vi.stubEnv('ISOLA_360_SERVICE_TOKEN', SERVICE_TOKEN)
})

function validOutcome() {
  return {
    version: 'customer-actions@1',
    actionType: 'followup.scheduleAssigned',
    correlationId: 'run-abc',
    operationId: 'op_1',
    auditRef: 'op_1',
    lifecycle: 'completed_verified',
    presentation: {
      success: true,
      label: 'Scheduled',
      marker: 'ok',
      tone: 'positive',
      terminal: true,
      retryWrite: false,
      retryReadback: false,
      escalate: false,
      showsPriorResult: false,
    },
    detail: 'Scheduled and assigned.',
    readbackProven: true,
    approvalRef: null,
    priorReadback: null,
  }
}

async function post(body: unknown, headers: Record<string, string> = {}) {
  vi.resetModules()
  const { POST } = await import('./route')
  const { NextRequest } = await import('next/server')
  const res = await POST(
    new NextRequest('https://foundation.epic.dm/api/isola-360/actions/schedule-followup-assigned', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: await res.json() }
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}` }
}

const validBody = (over: Record<string, unknown> = {}) => ({
  customerId: '42',
  note: 'call back re: renewal',
  dueDate: '2026-10-01',
  assigneeRef: '7',
  idempotencyKey: 'idem-1',
  correlationId: 'run-abc',
  paperclipAgentId: AGENT_ID,
  ...over,
})

describe('POST /api/isola-360/actions/schedule-followup-assigned -- auth', () => {
  it('REFUSAL: no bearer -> 401, runCustomerAction never called', async () => {
    const { status } = await post(validBody())
    expect(status).toBe(401)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: wrong bearer -> 401', async () => {
    const { status } = await post(validBody(), bearer('not-the-real-token'))
    expect(status).toBe(401)
  })

  it('Codex P1 REFUSAL: a real session-cookie caller (manager or owner) is refused outright, never silently downgraded to the service path', async () => {
    M.getSessionFromCookie.mockResolvedValueOnce({
      identityId: 'ident-1',
      effectiveTenantId: TENANT_ID,
      isAdmin: true,
      isOwner: true,
      user: { id: 'user-real-owner', tenant_id: TENANT_ID },
    } as any)
    const { status, body } = await post(validBody(), { cookie: 'isola_session=fake' })
    expect(status).toBe(403)
    expect(body.error).toBe('Forbidden')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('CONTROL: the real service door authenticates and resolves actorRole to "manager", never "owner"', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorRole: 'manager', tenantId: TENANT_ID, companyId: TENANT_ID }),
      expect.anything(),
    )
  })
})

describe('actor identity is constructed, never accepted as-is', () => {
  it('builds actorPrincipalId as hermes:epic-business-assistant:<paperclipAgentId>', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ paperclipAgentId: AGENT_ID }), bearer(SERVICE_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorPrincipalId: `hermes:epic-business-assistant:${AGENT_ID}` }),
      expect.anything(),
    )
  })

  it('REFUSAL: a non-UUID paperclipAgentId is refused -- cannot smuggle an arbitrary principal string', async () => {
    const { status } = await post(validBody({ paperclipAgentId: 'not-a-uuid; DROP TABLE' }), bearer(SERVICE_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: missing paperclipAgentId', async () => {
    const { status } = await post(validBody({ paperclipAgentId: undefined }), bearer(SERVICE_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })
})

describe('Codex P2: malformed body shapes', () => {
  it('REFUSAL: a syntactically valid JSON `null` body -> 400, not an uncaught 500', async () => {
    const { status, body } = await post('null', bearer(SERVICE_TOKEN))
    expect(status).toBe(400)
    expect(body.error).toMatch(/JSON body/)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: a JSON array body -> 400, not an uncaught 500', async () => {
    const { status } = await post('[1,2,3]', bearer(SERVICE_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('CONTROL: a numeric customerId (as Hermes would actually send it, matching context/create-followup) is accepted, not rejected', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status } = await post(validBody({ customerId: 42 }), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(M.runCustomerAction).toHaveBeenCalledWith(expect.objectContaining({ customerId: '42' }), expect.anything())
  })
})

describe('required fields, correlationId is never generated', () => {
  it.each(['customerId', 'note', 'dueDate', 'assigneeRef', 'idempotencyKey', 'correlationId'])(
    'REFUSAL: missing %s -> 400, runCustomerAction never called',
    async (field) => {
      const { status } = await post(validBody({ [field]: undefined }), bearer(SERVICE_TOKEN))
      expect(status).toBe(400)
      expect(M.runCustomerAction).not.toHaveBeenCalled()
    },
  )

  it('the caller-supplied correlationId (the Paperclip run id) passes through UNCHANGED, never regenerated', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ correlationId: 'run-specific-id-999' }), bearer(SERVICE_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'run-specific-id-999' }),
      expect.anything(),
    )
  })
})

describe('the action type and payload are fixed, not caller-suppliable', () => {
  it('actionType is always followup.scheduleAssigned, and payload carries exactly note/dueDate/assigneeRef', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ note: 'N', dueDate: '2026-11-01', assigneeRef: '99' }), bearer(SERVICE_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: 'followup.scheduleAssigned',
        payload: { note: 'N', dueDate: '2026-11-01', assigneeRef: '99' },
      }),
      expect.anything(),
    )
  })

  it('a caller-supplied actionType in the body is ignored -- there is no field for it', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ actionType: 'business_field.update' } as any), bearer(SERVICE_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'followup.scheduleAssigned' }),
      expect.anything(),
    )
  })
})

describe('tenant boundary proven before proposing', () => {
  it('a customerId not found in this tenant\'s Odoo -> 404, runCustomerAction never reached', async () => {
    M.readCustomer.mockResolvedValueOnce([])
    const { status, body } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('Odoo unreachable while checking the customer -> dependency_unavailable, not a crash, not a write attempt', async () => {
    M.readCustomer.mockRejectedValueOnce(new Error('timeout'))
    const { status, body } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('the system of record cannot be resolved for this tenant -> dependency_unavailable', async () => {
    M.resolveOdooConfigForTenant.mockRejectedValueOnce(new Error('no config'))
    const { status, body } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })
})

describe('the outcome is passed straight through, same contract as the generic actions route', () => {
  it('CONTROL: a completed_verified outcome reports success:true and the readback proof', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status, body } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.readbackProven).toBe(true)
    expect(body.lifecycle).toBe('completed_verified')
  })

  it('a permission_denied outcome from the governed runtime is surfaced honestly, not upgraded to success', async () => {
    M.runCustomerAction.mockResolvedValueOnce({
      ...validOutcome(),
      lifecycle: 'permission_denied',
      presentation: { ...validOutcome().presentation, success: false },
      readbackProven: false,
    })
    const { status, body } = await post(validBody(), bearer(SERVICE_TOKEN))
    expect(status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('permission_denied')
  })
})
