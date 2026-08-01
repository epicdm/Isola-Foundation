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

const query = (over: Partial<ResolvedQuery> = {}): ResolvedQuery => ({ ...QUERY, ...over })

/** The argument is declared so the test can read what the delegate was asked. */
const delegateSpy = () => vi.fn(async (_args: unknown) => [] as unknown[])

function spies() {
  return {
    auditLog: { findMany: delegateSpy() },
    approvalRequest: { findMany: delegateSpy() },
    staffWorkAction: { findMany: delegateSpy() },
    conversationOwnership: { findMany: delegateSpy() },
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
  q: ResolvedQuery = QUERY,
): Promise<Record<string, SourceResult>> {
  const out: Record<string, SourceResult> = {}
  for (const source of build(over, deps)) {
    out[source.name] = await source.read(q)
  }
  return out
}

interface FindManyArgs {
  where: Record<string, unknown>
  orderBy: unknown
  take: number
}

const argsOf = (spy: { findMany: { mock: { calls: unknown[][] } } }): FindManyArgs =>
  spy.findMany.mock.calls[0][0] as FindManyArgs

// ──────────────────────────────────────────────────────────

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
    expect(argsOf(deps.auditLog).where).toMatchObject({ tenant_id: TENANT })
  })
})

describe('every read is scoped to the session tenant', () => {
  it('passes the config tenant to every delegate, newest first', async () => {
    const deps = spies()
    await readAll({ tenantId: 'tenant-other' }, deps)

    for (const delegate of [
      deps.auditLog,
      deps.approvalRequest,
      deps.staffWorkAction,
      deps.conversationOwnership,
    ]) {
      expect(delegate.findMany).toHaveBeenCalledTimes(1)
      const args = argsOf(delegate)
      expect(args.where).toMatchObject({ tenant_id: 'tenant-other' })
      expect(JSON.stringify(args.orderBy)).toContain('desc')
    }
  })

  it('never widens the scope from the query it was handed', async () => {
    const deps = spies()
    // The registry is scoped by its CONFIG, which comes from the session —
    // never by anything a caller could put in a query string.
    await readAll({ tenantId: TENANT }, deps)
    expect(argsOf(deps.auditLog).where.tenant_id).toBe(TENANT)
  })
})

// ── how many rows a source is asked for ──

describe('a source is asked for a bounded number of rows', () => {
  it('REGRESSION: asks for pageSize + 1, not 500', async () => {
    const deps = spies()
    await readAll({}, deps, query({ pageSize: 25 }))

    // Three of the four Prisma sources project created_at AS occurredAt, so the
    // ordering and the cut can go into the query.
    expect(argsOf(deps.auditLog).take).toBe(26)
    expect(argsOf(deps.staffWorkAction).take).toBe(26)
    expect(argsOf(deps.conversationOwnership).take).toBe(26)
  })

  it('follows the page size rather than a constant', async () => {
    for (const [pageSize, take] of [
      [1, 2],
      [10, 11],
      [100, 101],
    ] as const) {
      const deps = spies()
      await readAll({}, deps, query({ pageSize }))
      expect(argsOf(deps.auditLog).take).toBe(take)
    }
  })

  it('orders by occurredAt DESC then id ASC, so the cursor has a stable boundary', async () => {
    const deps = spies()
    await readAll({}, deps)
    expect(argsOf(deps.auditLog).orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }])
  })

  it('leaves the approvals read wide, because created_at is NOT its occurredAt', async () => {
    // projectApprovalRequest reports the DECISION time for anything decided, so
    // a request created months ago and approved a minute ago belongs at the top
    // of the feed and is nowhere near the top by created_at. Cutting this read
    // at pageSize + 1 would drop it silently.
    const deps = spies()
    await readAll({}, deps, query({ pageSize: 25 }))

    expect(deps.approvalRequest.findMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT },
      orderBy: { created_at: 'desc' },
      take: SOURCE_ROW_LIMIT,
    })
  })

  it('stays wide when a filter can only be decided after projection', async () => {
    // Event family, status and ownership are all derived while projecting, so a
    // page cut before they are applied could come back short.
    for (const over of [
      { eventTypes: ['staff.note'] },
      { statuses: ['recorded'] },
      { ownershipStates: ['human'] },
      { actorRef: 'staff:7' },
      { customerId: 'cust-1' },
      { taskId: 'task-9' },
    ] as Partial<ResolvedQuery>[]) {
      const deps = spies()
      await readAll({}, deps, query(over))
      expect(argsOf(deps.auditLog).take).toBe(SOURCE_ROW_LIMIT)
    }
  })
})

describe('the date range and the cursor go into the query', () => {
  it('pushes occurredFrom / occurredTo down as a created_at range', async () => {
    const deps = spies()
    await readAll(
      {},
      deps,
      query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' }),
    )

    const where = argsOf(deps.auditLog).where as { AND?: Record<string, unknown>[] }
    expect(where.AND?.[0]).toEqual({
      created_at: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lte: new Date('2026-07-31T00:00:00.000Z'),
      },
    })
    // ...and the read is still bounded, because nothing needs a wide scan here.
    expect(argsOf(deps.auditLog).take).toBe(26)
  })

  it('pushes the cursor down instead of cutting after the read', async () => {
    const deps = spies()
    const cursor = { occurredAt: '2026-07-20T12:00:00.000Z', activityId: 'audit:42' }
    await readAll({}, deps, query({ cursor }))

    const where = argsOf(deps.auditLog).where as { AND?: Record<string, unknown>[] }
    expect(where.AND?.[0]).toEqual({
      OR: [
        { created_at: { lt: new Date(cursor.occurredAt) } },
        { AND: [{ created_at: new Date(cursor.occurredAt) }, { id: { gt: '42' } }] },
      ],
    })
  })

  it('issues no query at all for a source ?source= excluded', async () => {
    const deps = spies()
    const results = await readAll({}, deps, query({ sourceSystems: ['staff_work_action'] }))

    expect(deps.staffWorkAction.findMany).toHaveBeenCalledTimes(1)
    expect(deps.auditLog.findMany).toHaveBeenCalledTimes(0)
    expect(deps.approvalRequest.findMany).toHaveBeenCalledTimes(0)
    expect(deps.conversationOwnership.findMany).toHaveBeenCalledTimes(0)
    // Excluded is not FAILED: those sources answered, with nothing.
    expect(results.audit_log.status).toBe('ok')
  })

  it('still reports forbidden for audit even when ?source= excludes it', async () => {
    // The permission boundary outranks the filter. Reporting `ok` here would
    // let a filter hide the fact that this session may not read the trail.
    const deps = spies()
    const results = await readAll(
      { canViewAudit: false },
      deps,
      query({ sourceSystems: ['staff_work_action'] }),
    )
    expect(results.audit_log.status).toBe('forbidden')
    expect(deps.auditLog.findMany).toHaveBeenCalledTimes(0)
  })

  it('a cursor from another source still narrows this one', async () => {
    // "approval:9" sorts before "audit:..." on the id tiebreak, so every audit
    // row at that exact instant is still after the cursor and must be included.
    const deps = spies()
    const cursor = { occurredAt: '2026-07-20T12:00:00.000Z', activityId: 'approval:9' }
    await readAll({}, deps, query({ cursor }))

    const where = argsOf(deps.auditLog).where as { AND?: Record<string, unknown>[] }
    expect(where.AND?.[0]).toEqual({ created_at: { lte: new Date(cursor.occurredAt) } })
  })
})
