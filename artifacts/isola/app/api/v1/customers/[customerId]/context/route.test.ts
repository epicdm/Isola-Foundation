import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionMock, requireWorkspaceAccessMock, json2CallMock, resolveOdooConfigMock } =
  vi.hoisted(() => ({
    getSessionMock: vi.fn(),
    requireWorkspaceAccessMock: vi.fn(),
    json2CallMock: vi.fn(),
    resolveOdooConfigMock: vi.fn(),
  }))

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }))
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }))
vi.mock('@/lib/engine-bindings', () => ({ resolveOdooConfigForTenant: resolveOdooConfigMock }))

// Partial: the error CLASSES are real, because sanitiseOdooFailure branches on
// them and a stubbed class would make every failure take the generic path.
vi.mock('@/engines/odoo', async (orig) => {
  const actual = await orig<typeof import('@/engines/odoo')>()
  return { ...actual, json2Call: json2CallMock }
})

vi.mock('@/lib/prisma', () => {
  const findMany = async () => [] as unknown[]
  return {
    prisma: {
      auditLog: { findMany },
      approvalRequest: { findMany },
      staffWorkAction: { findMany },
      conversationOwnershipTransition: { findMany },
      customerToolOperation: { findMany },
    },
    default: {},
  }
})

import { GET } from './route'

const TENANT = 'tenant-1'
const ODOO = 'https://tenant.odoo.com'

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

const request = (qs = '') => new Request(`http://localhost/api/v1/customers/42/context${qs}`)
const params = (customerId = '42') => ({ params: Promise.resolve({ customerId }) })

const session = { effectiveTenantId: TENANT, user: { id: 'user-1' } }

const allow = (level: 'manager' | 'owner' = 'manager', canViewAudit = false) => ({
  ok: true,
  authz: { level, basis: 'membership', membershipRole: 'admin', canViewAudit, canViewConfiguration: false },
})

/** Every model answers; res.partner distinguishes the customer from its contacts. */
function odooAnswers(over: Record<string, unknown[]> = {}) {
  json2CallMock.mockImplementation(async (_cfg, model: string, _m: string, p: Record<string, unknown>) => {
    if (model === 'res.partner') {
      const domain = JSON.stringify(p.domain ?? [])
      if (domain.includes('parent_id')) return over.contacts ?? []
      return over.partner ?? [PARTNER]
    }
    if (model === 'crm.lead') return over.leads ?? []
    if (model === 'helpdesk.ticket') return over.tickets ?? []
    return []
  })
}

beforeEach(() => {
  getSessionMock.mockReset()
  requireWorkspaceAccessMock.mockReset()
  json2CallMock.mockReset()
  resolveOdooConfigMock.mockReset()
  resolveOdooConfigMock.mockResolvedValue({ url: ODOO, apiKey: 'k', db: 'd' })
})

/* ── the guard, before anything is parsed ──────────────────────────────────*/

describe('authentication comes before everything else', () => {
  it('answers 401 with no session, whatever the customer id looks like', async () => {
    getSessionMock.mockResolvedValue(null)

    const res = await GET(request(), params('not-a-number'))

    expect(res.status).toBe(401)
    // A malformed id must not produce a DIFFERENT status to an anonymous caller.
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('answers 403 for an authenticated reader without the manager role', async () => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not have access to this workspace.',
      authz: {},
    })

    const res = await GET(request(), params())

    expect(res.status).toBe(403)
    expect(json2CallMock).not.toHaveBeenCalled()
  })

  it('refuses an unusable customer reference before it reaches a domain', async () => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())

    const res = await GET(request(), params("1 OR 1=1"))

    expect(res.status).toBe(404)
    expect(json2CallMock).not.toHaveBeenCalled()
  })
})

/* ── the answer ────────────────────────────────────────────────────────────*/

describe('a customer that exists', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())
    odooAnswers()
  })

  it('returns every expected section, including the ones with no source', async () => {
    const res = await GET(request(), params())
    const body = await res.json()

    expect(res.status).toBe(200)
    // 15, not the historical 12 — orders/calls/files joined the promised
    // section set in dec-c360-design-defines-the-target-find-the-data-2026-09-04.
    // invoices left the "no source" list the same pass (account.move adapter).
    expect(Object.keys(body.sections).sort()).toEqual(
      [
        'activity',
        'calls',
        'contacts',
        'customer',
        'devices',
        'files',
        'invoices',
        'issues',
        'notes',
        'opportunities',
        'orders',
        'pbx',
        'recentActions',
        'services',
        'tasks',
      ].sort(),
    )
    for (const name of ['services', 'devices', 'pbx', 'notes', 'calls', 'files']) {
      expect(body.sections[name].state).toBe('unavailable')
      expect(body.sections[name].records).toEqual([])
    }
  })

  it('offers the seven governed actions and no others', async () => {
    const res = await GET(request(), params())
    const body = await res.json()

    expect(body.availableActions.map((a: { actionType: string }) => a.actionType).sort()).toEqual(
      [
        'activity.schedule',
        // S8-W1. Offered here because this surface's role may propose it; the
        // send itself is only reachable from the C360 panel's confirm flow.
        'document.send',
        'followup.schedule',
        'lead.create',
        'lead.update',
        'note.create',
        'task.create',
      ].sort(),
    )
  })

  it('links records to the instance the tenant is actually bound to', async () => {
    const res = await GET(request(), params())
    const body = await res.json()

    expect(body.sections.customer.records[0].link).toBe(`${ODOO}/odoo/res.partner/42`)
  })
})

/* ── the boundary ──────────────────────────────────────────────────────────*/

describe('the tenant comes from the session and nowhere else', () => {
  it('resolves the Odoo binding for the SESSION tenant', async () => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())
    odooAnswers()

    await GET(request('?company=someone-else'), params())

    expect(resolveOdooConfigMock).toHaveBeenCalledWith(TENANT)
    expect(resolveOdooConfigMock).not.toHaveBeenCalledWith('someone-else')
  })

  it('answers 404 when the customer is not in this tenant instance', async () => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())
    odooAnswers({ partner: [] })

    const res = await GET(request(), params())
    const body = await res.json()

    expect(res.status).toBe(404)
    // The same wording an absent customer gets. No enumeration oracle.
    expect(body.error).toBe('not found, or not available to you')
  })
})

/* ── the confusion this whole mutation exists to prevent ───────────────────*/

describe('an outage is not a verdict about the customer', () => {
  beforeEach(() => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())
  })

  it('does NOT answer 404 when Odoo could not be reached', async () => {
    json2CallMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443'))

    const res = await GET(request(), params())
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.sections.customer.state).toBe('unavailable')
    expect(body.sections.customer.state).not.toBe('empty')
    expect(body.sections.customer.records).toEqual([])
  })

  it('does not put driver text into the response', async () => {
    json2CallMock.mockRejectedValue(new Error('connect ECONNREFUSED 10.1.2.3:443'))

    const body = await (await GET(request(), params())).json()

    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(body)).not.toContain('10.1.2.3')
  })

  it('reports every section as unavailable when the tenant has no Odoo binding at all', async () => {
    resolveOdooConfigMock.mockRejectedValue(new Error('no binding row and no platform default'))

    const res = await GET(request(), params())
    const body = await res.json()

    expect(res.status).toBe(200)
    for (const name of ['customer', 'contacts', 'opportunities', 'issues']) {
      expect(body.sections[name].state).toBe('unavailable')
    }
    // And with no instance URL, nothing anywhere carries a fabricated link.
    expect(JSON.stringify(body.sections)).not.toContain('/odoo/')
  })

  it('names what was lost, so the screen can say the picture is incomplete', async () => {
    json2CallMock.mockRejectedValue(new Error('timeout'))

    const body = await (await GET(request(), params())).json()

    expect(body.provenance.degraded).toEqual(expect.arrayContaining(['customer', 'opportunities', 'issues']))
  })
})

/* ── nothing invented ──────────────────────────────────────────────────────*/

describe('the response carries no fixture data', () => {
  it('returns zero records when nothing answered', async () => {
    getSessionMock.mockResolvedValue(session)
    requireWorkspaceAccessMock.mockResolvedValue(allow())
    json2CallMock.mockRejectedValue(new Error('down'))

    const body = await (await GET(request(), params())).json()

    for (const section of Object.values(body.sections) as { records: unknown[] }[]) {
      expect(section.records).toEqual([])
    }
  })
})
