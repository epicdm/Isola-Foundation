import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSessionMock, requireWorkspaceAccessMock } = vi.hoisted(() => ({
  getSessionMock: vi.fn(),
  requireWorkspaceAccessMock: vi.fn(),
}))

vi.mock('@/lib/session', () => ({ getSession: getSessionMock }))
vi.mock('@/lib/workspace/authz', () => ({ requireWorkspaceAccess: requireWorkspaceAccessMock }))

// The registry's default deps reach for the real delegates. Stubbed so this
// test exercises the ROUTE — auth, scoping, status mapping — and not a database.
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

const SOURCE_NAMES = [
  'audit_log',
  'approval_request',
  'staff_work_action',
  'conversation_ownership',
  'lane2',
  'customer_tool_operation',
]

const request = (qs = '') => new Request(`http://localhost/api/v1/activity${qs}`)

const allow = (canViewAudit: boolean) => ({
  ok: true,
  authz: {
    level: 'manager',
    basis: 'membership',
    membershipRole: 'admin',
    canViewAudit,
    canViewConfiguration: false,
  },
})

beforeEach(() => {
  getSessionMock.mockReset()
  requireWorkspaceAccessMock.mockReset()
})

// ───────────────────────────────────────────────────────────────

describe('authentication happens before anything is parsed', () => {
  it('answers 401 and describes nothing', async () => {
    getSessionMock.mockResolvedValue(null)

    const res = await GET(request())
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body).toEqual({ error: 'Unauthorized' })

    const json = JSON.stringify(body)
    // No source names, no source states, no counts, no timestamps. An
    // unauthenticated caller learns that they are unauthenticated and nothing
    // whatever about the system behind the door.
    for (const name of SOURCE_NAMES) expect(json).not.toContain(name)
    for (const state of ['"ok"', 'stale', 'unavailable', 'forbidden', 'partial', 'available']) {
      expect(json).not.toContain(state)
    }
    expect(json).not.toMatch(/\d/)
    expect(requireWorkspaceAccessMock).not.toHaveBeenCalled()
  })

  it('a session with no tenant is 401, not a feed', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: null })
    const res = await GET(request())
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
  })

  it('a bad cursor from an anonymous caller is still 401, never 400', async () => {
    getSessionMock.mockResolvedValue(null)

    for (const qs of ['?cursor=garbage', '?nonsense=1', '?pageSize=5000']) {
      const res = await GET(request(qs))
      // 400 here would tell an anonymous caller which cursors and filters were
      // once real — an existence oracle built out of input validation.
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'Unauthorized' })
    }
  })
})

describe('role is checked before the feed is built', () => {
  it('answers 403 with the guard wording', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: 'You do not have access to this workspace.',
      authz: { level: 'denied' },
    })

    const res = await GET(request())
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'You do not have access to this workspace.' })
  })

  it('asks for MANAGER, not owner', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue(allow(false))

    await GET(request())
    expect(requireWorkspaceAccessMock).toHaveBeenCalledWith(
      { effectiveTenantId: TENANT },
      'manager',
    )
  })
})

describe('a permitted session gets the feed', () => {
  it('answers 200 with every source reported', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue(allow(true))

    const res = await GET(request('?pageSize=10'))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.version).toBe('activity.feed@1')
    expect(body.sources.map((s: { source: string }) => s.source)).toEqual(SOURCE_NAMES)
    expect(typeof body.generatedAt).toBe('string')
    expect(body.nextCursor).toBeNull()
    // Lane 2 has no store: partial, not empty, not a 500.
    expect(body.dataState).toBe('partial')
  })

  it('a manager without audit permission still gets a 200 feed', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue(allow(false))

    const res = await GET(request())
    expect(res.status).toBe(200)

    const body = await res.json()
    const audit = body.sources.find((s: { source: string }) => s.source === 'audit_log')
    expect(audit.state).toBe('forbidden')
    expect(body.items).toHaveLength(0)
  })

  it('still refuses a query it cannot parse, once the caller is known', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue(allow(true))

    const res = await GET(request('?nonsense=1'))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_query', parameter: 'nonsense' })
  })

  it('a company parameter cannot widen past the session tenant', async () => {
    getSessionMock.mockResolvedValue({ effectiveTenantId: TENANT })
    requireWorkspaceAccessMock.mockResolvedValue(allow(true))

    const res = await GET(request('?company=tenant-2'))
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain('tenant-2')
  })
})

describe('the route is transport only', () => {
  const src = readFileSync(join(__dirname, 'route.ts'), 'utf8')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

  it('imports no provider client and issues no query of its own', () => {
    expect(code).not.toMatch(/\bprisma\./)
    expect(code).not.toMatch(
      /from\s+['"][^'"]*(chatwoot|clawith|whatsapp|meta|graph|twilio)[^'"]*['"]/i,
    )
    expect(code).not.toMatch(/\bfetch\s*\(/)
  })

  it('performs no ownership action', () => {
    expect(code).not.toMatch(/\b(takeOver|takeover|handback|handoff|sendMessage|assign)\s*\(/i)
  })

  it('never reads the tenant from the query string', () => {
    expect(code).toContain('ctx.effectiveTenantId')
    expect(code).not.toMatch(/searchParams\.get\(\s*['"](company|tenant|tenantId)['"]/)
  })
})
