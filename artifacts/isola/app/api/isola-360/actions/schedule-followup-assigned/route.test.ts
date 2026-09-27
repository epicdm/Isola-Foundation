import { beforeEach, describe, expect, it, vi } from 'vitest'

const M = vi.hoisted(() => ({
  runCustomerAction: vi.fn(),
  readCustomer: vi.fn(async () => [{ id: 42 }]),
  odooCall: vi.fn(async () => [{ company_id: [7, 'EPIC Communications Inc'] }]),
  odooBindingFindUnique: vi.fn(async () => ({
    tenant_id: 'tenant-epic-1',
    url: 'https://epic-communications-inc.odoo.com',
    db: 'epic',
    login: 'followup-bot@epic.dm',
    api_key_enc: 'encrypted-blob',
  })),
  decryptSecret: vi.fn(() => 'decrypted-key-never-asserted-in-tests'),
  getOdooConfig: vi.fn((cfg: unknown) => ({ ...(cfg as object), configured: true })),
  checkOdooPolicy: vi.fn(),
  resolveAuthorizedCompany: vi.fn(async () => ({ ok: true, companyId: 7 })),
  companyIdOf: vi.fn((v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null)),
}))

vi.mock('@/lib/governed/customer-actions', () => ({ runCustomerAction: M.runCustomerAction }))
vi.mock('@/lib/prisma', () => ({ prisma: { odooBinding: { findUnique: M.odooBindingFindUnique } } }))
vi.mock('@/lib/tenant-secrets', () => ({ decryptSecret: M.decryptSecret }))
vi.mock('@/lib/engines', () => ({ getOdooConfig: M.getOdooConfig }))
vi.mock('@/lib/agent-tools', () => ({ checkOdooPolicy: M.checkOdooPolicy }))
vi.mock('@/lib/workspace/business-briefing', () => ({
  resolveAuthorizedCompany: M.resolveAuthorizedCompany,
  companyIdOf: M.companyIdOf,
}))
vi.mock('@/lib/context/customer-sources', () => ({
  odooCallerFor: vi.fn(() => M.odooCall),
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
const HERMES_TOKEN = 'hermes-followup-token-xyz'
const AGENT_ID = '21fa3ed2-9071-4c5f-b71d-014a77c4738d'

beforeEach(() => {
  M.runCustomerAction.mockReset()
  M.readCustomer.mockReset().mockResolvedValue([{ id: 42 }])
  M.odooCall.mockReset().mockResolvedValue([{ company_id: [7, 'EPIC Communications Inc'] }])
  M.odooBindingFindUnique.mockReset().mockResolvedValue({
    tenant_id: TENANT_ID,
    url: 'https://epic-communications-inc.odoo.com',
    db: 'epic',
    login: 'followup-bot@epic.dm',
    api_key_enc: 'encrypted-blob',
  })
  M.decryptSecret.mockReset().mockReturnValue('decrypted-key-never-asserted-in-tests')
  M.getOdooConfig.mockReset().mockImplementation((cfg: unknown) => ({ ...(cfg as object), configured: true }))
  M.checkOdooPolicy.mockReset()
  M.resolveAuthorizedCompany.mockReset().mockResolvedValue({ ok: true, companyId: 7 })
  M.companyIdOf.mockReset().mockImplementation((v: unknown) => (Array.isArray(v) && typeof v[0] === 'number' ? v[0] : null))
  vi.stubEnv('ISOLA_360_SERVICE_TENANT_ID', TENANT_ID)
  vi.stubEnv('ISOLA_360_HERMES_FOLLOWUP_TOKEN', HERMES_TOKEN)
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

describe('POST /api/isola-360/actions/schedule-followup-assigned -- auth, dedicated credential only', () => {
  it('REFUSAL: no bearer -> 401, runCustomerAction never called', async () => {
    const { status } = await post(validBody())
    expect(status).toBe(401)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: wrong bearer -> 401', async () => {
    const { status } = await post(validBody(), bearer('not-the-real-token'))
    expect(status).toBe(401)
  })

  it('Codex round 4 P1 REFUSAL: this route never accepts a session cookie, of any kind -- there is no fallback path to it at all', async () => {
    const { status } = await post(validBody(), { cookie: 'isola_session=fake-admin-owner-session' })
    expect(status).toBe(401)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('Codex round 4 P1 REFUSAL: a shared ISOLA_360_SERVICE_TOKEN (the Customer 360 read surface credential) does NOT authenticate here -- a genuinely separate credential, not a relabelled member of that pool', async () => {
    vi.stubEnv('ISOLA_360_SERVICE_TOKEN', 'some-read-scoped-portal-token')
    const { status } = await post(validBody(), bearer('some-read-scoped-portal-token'))
    expect(status).toBe(401)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: unconfigured token never authenticates, even against an empty presented value', async () => {
    vi.stubEnv('ISOLA_360_HERMES_FOLLOWUP_TOKEN', '')
    const { status } = await post(validBody(), bearer(''))
    expect(status).toBe(401)
  })

  it('REFUSAL: no ISOLA_360_SERVICE_TENANT_ID configured -> 401, even with the right bearer', async () => {
    vi.stubEnv('ISOLA_360_SERVICE_TENANT_ID', '')
    const { status } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(401)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('CONTROL: the dedicated credential authenticates and resolves actorRole to "manager", never "owner"', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status } = await post(validBody(), bearer(HERMES_TOKEN))
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
    await post(validBody({ paperclipAgentId: AGENT_ID }), bearer(HERMES_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ actorPrincipalId: `hermes:epic-business-assistant:${AGENT_ID}` }),
      expect.anything(),
    )
  })

  it('REFUSAL: a non-UUID paperclipAgentId is refused -- cannot smuggle an arbitrary principal string', async () => {
    const { status } = await post(validBody({ paperclipAgentId: 'not-a-uuid; DROP TABLE' }), bearer(HERMES_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: missing paperclipAgentId', async () => {
    const { status } = await post(validBody({ paperclipAgentId: undefined }), bearer(HERMES_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })
})

describe('Codex round 4 P2: idempotency key is namespaced to close the ledger collision risk', () => {
  it('the caller-supplied idempotencyKey reaches runCustomerAction prefixed hermes: -- cannot collide with a plain staff-supplied key', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ idempotencyKey: 'idem-raw-1' }), bearer(HERMES_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'hermes:idem-raw-1' }),
      expect.anything(),
    )
  })
})

describe('malformed body shapes', () => {
  it('REFUSAL: a syntactically valid JSON `null` body -> 400, not an uncaught 500', async () => {
    const { status, body } = await post('null', bearer(HERMES_TOKEN))
    expect(status).toBe(400)
    expect(body.error).toMatch(/JSON body/)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('REFUSAL: a JSON array body -> 400, not an uncaught 500', async () => {
    const { status, body } = await post('[1,2,3]', bearer(HERMES_TOKEN))
    expect(status).toBe(400)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('CONTROL: a numeric customerId (as Hermes would actually send it, matching context/create-followup) is accepted, not rejected', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status } = await post(validBody({ customerId: 42 }), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(M.runCustomerAction).toHaveBeenCalledWith(expect.objectContaining({ customerId: '42' }), expect.anything())
  })
})

describe('required fields, correlationId is never generated', () => {
  it.each(['customerId', 'note', 'dueDate', 'assigneeRef', 'idempotencyKey', 'correlationId'])(
    'REFUSAL: missing %s -> 400, runCustomerAction never called',
    async (field) => {
      const { status } = await post(validBody({ [field]: undefined }), bearer(HERMES_TOKEN))
      expect(status).toBe(400)
      expect(M.runCustomerAction).not.toHaveBeenCalled()
    },
  )

  it('the caller-supplied correlationId (the Paperclip run id) passes through UNCHANGED, never regenerated', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ correlationId: 'run-specific-id-999' }), bearer(HERMES_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: 'run-specific-id-999' }),
      expect.anything(),
    )
  })
})

describe('the action type and payload are fixed, not caller-suppliable', () => {
  it('actionType is always followup.scheduleAssigned, and payload carries exactly note/dueDate/assigneeRef', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    await post(validBody({ note: 'N', dueDate: '2026-11-01', assigneeRef: '99' }), bearer(HERMES_TOKEN))
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
    await post(validBody({ actionType: 'business_field.update' } as any), bearer(HERMES_TOKEN))
    expect(M.runCustomerAction).toHaveBeenCalledWith(
      expect.objectContaining({ actionType: 'followup.scheduleAssigned' }),
      expect.anything(),
    )
  })
})

describe('tenant + company boundary proven before proposing', () => {
  it('a customerId not found in this tenant\'s Odoo -> 404, runCustomerAction never reached', async () => {
    M.readCustomer.mockResolvedValueOnce([])
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('Odoo unreachable while checking the customer -> dependency_unavailable, not a crash, not a write attempt', async () => {
    M.readCustomer.mockRejectedValueOnce(new Error('timeout'))
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('no OdooBinding row for this tenant -> dependency_unavailable', async () => {
    M.odooBindingFindUnique.mockResolvedValueOnce(null as any)
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('Codex round 4 P1: the credential\'s authorized company cannot be resolved (multi-company or unscoped) -> dependency_unavailable, never a guess', async () => {
    M.resolveAuthorizedCompany.mockResolvedValueOnce({ ok: false } as any)
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(body.lifecycle).toBe('dependency_unavailable')
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('Codex round 4 P1 REFUSAL: a customer in a DIFFERENT company than the credential is authorized for -> 404, never proposed', async () => {
    M.resolveAuthorizedCompany.mockResolvedValueOnce({ ok: true, companyId: 7 })
    M.odooCall.mockResolvedValueOnce([{ company_id: [99, 'Some Other Company'] }])
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(404)
    expect(body.error).toMatch(/not found/)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('a customer with no resolvable company_id at all -> 404, never proposed (never included on a missing value)', async () => {
    M.odooCall.mockResolvedValueOnce([{ company_id: false }] as any)
    const { status } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(404)
    expect(M.runCustomerAction).not.toHaveBeenCalled()
  })

  it('CONTROL: a customer in the SAME company the credential is authorized for proceeds normally', async () => {
    M.resolveAuthorizedCompany.mockResolvedValueOnce({ ok: true, companyId: 7 })
    M.odooCall.mockResolvedValueOnce([{ company_id: [7, 'EPIC Communications Inc'] }])
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(M.runCustomerAction).toHaveBeenCalled()
  })
})

describe('the outcome is passed straight through, same contract as the generic actions route', () => {
  it('CONTROL: a completed_verified outcome reports success:true and the readback proof', async () => {
    M.runCustomerAction.mockResolvedValueOnce(validOutcome())
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
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
    const { status, body } = await post(validBody(), bearer(HERMES_TOKEN))
    expect(status).toBe(200)
    expect(body.success).toBe(false)
    expect(body.lifecycle).toBe('permission_denied')
  })
})
