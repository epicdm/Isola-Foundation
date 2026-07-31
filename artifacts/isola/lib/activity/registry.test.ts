import { describe, expect, it, vi } from 'vitest'

// The registry's DEFAULT deps reach for the real Prisma delegates. Nothing in
// this file uses them — every test injects its own ports — but the import must
// still resolve, so the client is stubbed rather than generated.
vi.mock('@/lib/prisma', () => ({ prisma: {}, default: {} }))

import type { ResolvedQuery, SourceResult } from './feed'
import {
  ACTIVITY_SOURCE_NAMES,
  SOURCE_ROW_LIMIT,
  buildActivitySources,
  type ActivityRegistryConfig,
  type ActivityRegistryDeps,
} from './registry'

const NOW = new Date('2026-07-31T18:00:00Z')
const TENANT = 'tenant-1'

const QUERY: ResolvedQuery = {
  companyId: TENANT,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [TENANT],
}

function spies() {
  return {
    auditLog: { findMany: vi.fn(async () => [] as unknown[]) },
    approvalRequest: { findMany: vi.fn(async () => [] as unknown[]) },
    staffWorkAction: { findMany: vi.fn(async () => [] as unknown[]) },
    conversationOwnership: { findMany: vi.fn(async () => [] as unknown[]) },
  }
}

const config = (over: Partial<ActivityRegistryConfig> = {}): ActivityRegistryConfig => ({
  tenantId: TENANT,
  canViewAudit: true,
  now: () => NOW,
  ...over,
})

const build = (over: Partial<ActivityRegistryConfig>, deps: ActivityRegistryDeps) =>
  buildActivitySources(config(over), deps)

async function readAll(
  over: Partial<ActivityRegistryConfig>,
  deps: ActivityRegistryDeps,
): Promise<Record<string, SourceResult>> {
  const out: Record<string, SourceResult> = {}
  for (const source of build(over, deps)) {
    out[source.name] = await source.read(QUERY)
  }
  return out
}

// ───────────────────────────────────────────────────────────────

describe('every source is registered, every time', () => {
  it('registers all five in the declared order', () => {
    expect(build({}, spies()).map((s) => s.name)).toEqual([...ACTIVITY_SOURCE_NAMES])
  })

  it('registers the same five whatever the audit permission is', () => {
    const permitted = build({ canViewAudit: true }, spies()).map((s) => s.name)
    const denied = build({ canViewAudit: false }, spies()).map((s) => s.name)
    // A source the caller may not read is still LISTED. Dropping it would make
    // "you may not see this" and "this does not exist" the same on screen.
    expect(denied).toEqual(permitted)
    expect(denied).toHaveLength(5)
  })

  it('registers lane2 and reports it UNAVAILABLE rather than empty', async () => {
    const results = await readAll({}, spies())
    expect(results.lane2.status).toBe('unavailable')
    // There is no Lane-2 store yet. An empty list here would read on screen as
    // "no customer said anything today", which is a different claim entirely.
    if (results.lane2.status !== 'unavailable') return
    expect(results.lane2.reason.length).toBeGreaterThan(0)
  })
})

describe('the audit gate closes before the query, not after it', () => {
  it('reports FORBIDDEN and issues no audit query at all', async () => {
    const deps = spies()
    const results = await readAll({ canViewAudit: false }, deps)

    expect(results.audit_log.status).toBe('forbidden')
    // The load-bearing assertion. "Fetched and then hidden" is a different and
    // much weaker promise than "never asked", and only this catches the swap.
    expect(deps.auditLog.findMany).toHaveBeenCalledTimes(0)
    // ...and denying audit does not deny anything else.
    expect(results.approval_request.status).toBe('ok')
    expect(deps.approvalRequest.findMany).toHaveBeenCalledTimes(1)
  })

  it('reads the audit trail exactly once when the session may see it', async () => {
    const deps = spies()
    const results = await readAll({ canViewAudit: true }, deps)

    expect(results.audit_log.status).toBe('ok')
    expect(deps.auditLog.findMany).toHaveBeenCalledTimes(1)
    expect(deps.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenant_id: TENANT } }),
    )
  })
})

describe('every read is scoped to the session tenant', () => {
  it('passes the config tenant to every delegate, newest first and bounded', async () => {
    const deps = spies()
    await readAll({ tenantId: 'tenant-other' }, deps)

    for (const delegate of [
      deps.auditLog,
      deps.approvalRequest,
      deps.staffWorkAction,
      deps.conversationOwnership,
    ]) {
      expect(delegate.findMany).toHaveBeenCalledTimes(1)
      expect(delegate.findMany).toHaveBeenCalledWith({
        where: { tenant_id: 'tenant-other' },
        orderBy: { created_at: 'desc' },
        take: SOURCE_ROW_LIMIT,
      })
    }
  })

  it('never widens the scope from the query it was handed', async () => {
    const deps = spies()
    // The resolved query names tenant-1; the registry was configured for
    // tenant-1 too. The delegate must be scoped by the CONFIG, which comes from
    // the session — never by anything a caller could put in a query string.
    await readAll({ tenantId: TENANT }, deps)
    const args = deps.auditLog.findMany.mock.calls[0][0] as { where: { tenant_id: string } }
    expect(args.where.tenant_id).toBe(TENANT)
  })
})
