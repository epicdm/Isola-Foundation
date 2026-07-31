import { describe, expect, it } from 'vitest'

import {
  ACTIONS_BY_ROLE,
  RESOLVE_CONTEXT_VERSION,
  resolveContext,
  type ChannelBindingRecord,
  type PrincipalRecord,
  type ResolveContextPorts,
} from './resolve-context'

const PRINCIPAL: PrincipalRecord = {
  id: 'p-1',
  displayName: 'Test Staff',
  role: 'staff',
  companyId: 'co-1',
  active: true,
}

const BINDING: ChannelBindingRecord = {
  id: 'cb-1',
  companyId: 'co-1',
  classification: 'internal_private',
  clawithAgentRef: 'agent-ref',
  chatwootTeamRef: 'team-ref',
  fresh: true,
}

function ports(over: Partial<ResolveContextPorts> = {}): ResolveContextPorts {
  return {
    loadPrincipal: async () => PRINCIPAL,
    loadObject: async (type, id) => ({ type, id, companyId: 'co-1', relatedObjectIds: { service: 's-9' } }),
    loadChannelBinding: async () => BINDING,
    agentIsBoundToCompany: async () => true,
    workspaceUrlFor: (t, id) => `/workspace/${t}/${id}`,
    newAuditRef: (c) => `audit:${c}`,
    ...over,
  }
}

const REQ = { principalId: 'p-1', correlationId: 'c-1' }

describe('resolve-context — happy path', () => {
  it('resolves identity, company, role and permitted actions', async () => {
    const r = await resolveContext(REQ, ports())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.context.version).toBe(RESOLVE_CONTEXT_VERSION)
    expect(r.context.companyId).toBe('co-1')
    expect(r.context.role).toBe('staff')
    expect(r.context.permittedActions).toEqual(ACTIONS_BY_ROLE.staff)
    expect(r.context.auditRef).toBe('audit:c-1')
  })

  it('returns the workspace url and related objects for a selected object', async () => {
    const r = await resolveContext(
      { ...REQ, selectedObjectType: 'customer', selectedObjectId: 'cust-7' },
      ports(),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.context.selectedObject).toEqual({ type: 'customer', id: 'cust-7' })
    expect(r.context.workspaceUrl).toBe('/workspace/customer/cust-7')
    expect(r.context.relatedObjectIds.service).toBe('s-9')
  })

  it('returns SAFE binding references only', async () => {
    const r = await resolveContext({ ...REQ, channelBindingId: 'cb-1' }, ports())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.context.bindings.clawithAgentRef).toBe('agent-ref')
    expect(JSON.stringify(r.context)).not.toMatch(/secret|token|key=/i)
  })

  it('marks only the approval-gated actions the role actually holds', async () => {
    const r = await resolveContext(REQ, ports({ loadPrincipal: async () => PRINCIPAL }))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // staff holds none of the approval-gated actions
    expect(r.context.actionsRequiringApproval).toEqual([])
  })
})

describe('resolve-context — negative cases', () => {
  it('unknown identity', async () => {
    const r = await resolveContext(REQ, ports({ loadPrincipal: async () => null }))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('unknown_identity')
  })

  it('inactive user', async () => {
    const r = await resolveContext(
      REQ,
      ports({ loadPrincipal: async () => ({ ...PRINCIPAL, active: false }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('inactive_user')
  })

  it('principal with no company', async () => {
    const r = await resolveContext(
      REQ,
      ports({ loadPrincipal: async () => ({ ...PRINCIPAL, companyId: '' }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('no_company')
  })

  it('binding belonging to another company', async () => {
    const r = await resolveContext(
      { ...REQ, channelBindingId: 'cb-1' },
      ports({ loadChannelBinding: async () => ({ ...BINDING, companyId: 'co-2' }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('company_mismatch')
  })

  it('stale binding', async () => {
    const r = await resolveContext(
      { ...REQ, channelBindingId: 'cb-1' },
      ports({ loadChannelBinding: async () => ({ ...BINDING, fresh: false }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('stale_binding')
  })

  it('agent not bound to this company', async () => {
    const r = await resolveContext(
      { ...REQ, requestingAgentRef: 'other-agent' },
      ports({ agentIsBoundToCompany: async () => false }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('unauthorized_agent')
  })

  it('invalid object type', async () => {
    const r = await resolveContext(
      { ...REQ, selectedObjectType: 'spaceship', selectedObjectId: 'x' },
      ports(),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('invalid_object_type')
  })

  it('missing half of a selection', async () => {
    const r = await resolveContext({ ...REQ, selectedObjectType: 'customer' }, ports())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('missing_context')
  })

  it('cross-company object access', async () => {
    const r = await resolveContext(
      { ...REQ, selectedObjectType: 'customer', selectedObjectId: 'cust-7' },
      ports({ loadObject: async (t, id) => ({ type: t, id, companyId: 'co-2' }) }),
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('unauthorized_object')
  })

  it('DOES NOT leak whether a foreign record exists', async () => {
    const foreign = await resolveContext(
      { ...REQ, selectedObjectType: 'customer', selectedObjectId: 'cust-7' },
      ports({ loadObject: async (t, id) => ({ type: t, id, companyId: 'co-2' }) }),
    )
    const absent = await resolveContext(
      { ...REQ, selectedObjectType: 'customer', selectedObjectId: 'cust-7' },
      ports({ loadObject: async () => null }),
    )
    expect(foreign.ok).toBe(false)
    expect(absent.ok).toBe(false)
    if (foreign.ok || absent.ok) return
    // Same refusal AND same public message: no enumeration oracle.
    expect(foreign.refusal).toBe(absent.refusal)
    expect(foreign.publicDetail).toBe(absent.publicDetail)
  })

  it('requires a correlation id', async () => {
    const r = await resolveContext({ principalId: 'p-1', correlationId: '' }, ports())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.refusal).toBe('missing_context')
  })
})

describe('resolve-context — authorization cannot come from the request', () => {
  it('ignores any role or action claimed in the payload', async () => {
    const hostile = {
      ...REQ,
      role: 'owner',
      permittedActions: ['approval.override'],
      companyId: 'co-2',
    } as never
    const r = await resolveContext(hostile, ports())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.context.role).toBe('staff')
    expect(r.context.companyId).toBe('co-1')
    expect(r.context.permittedActions).not.toContain('approval.override')
  })

  it('role action sets are strictly nested', () => {
    for (const a of ACTIONS_BY_ROLE.staff) expect(ACTIONS_BY_ROLE.manager).toContain(a)
    for (const a of ACTIONS_BY_ROLE.manager) expect(ACTIONS_BY_ROLE.owner).toContain(a)
    expect(ACTIONS_BY_ROLE.staff).not.toContain('approval.override')
    expect(ACTIONS_BY_ROLE.manager).not.toContain('approval.override')
  })
})
