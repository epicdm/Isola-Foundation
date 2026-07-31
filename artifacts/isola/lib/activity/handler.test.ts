import { describe, expect, it, vi } from 'vitest'

import type { ActivityItem, ActivityPermissions, ActivitySource } from './feed'
import { buildActivityHandler, type ActivityHandlerDeps } from './handler'
import { parseActivityQuery } from './query'
import { SourceForbidden, buildSource } from './sources/shared'

const NOW = new Date('2026-07-31T18:00:00Z')
const TENANT = 'tenant-1'
const OTHER = 'tenant-2'

// Deliberately NOT imported from ./registry: the handler is transport-free and
// database-free, and importing the registry here would drag Prisma into a test
// that has no business knowing a database exists.
const KNOWN = [
  'audit_log',
  'approval_request',
  'staff_work_action',
  'conversation_ownership',
  'lane2',
] as const

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    activityId: 'a1',
    eventType: 'staff.note',
    title: 'Note added',
    summary: 'Customer called about a dropped line',
    sourceSystem: 'foundation',
    provenance: { source: 'foundation', fetchedAt: NOW.toISOString(), trust: 'authoritative' },
    actor: { ref: 'principal-7', label: 'Ann', kind: 'staff' },
    companyId: TENANT,
    customerId: null,
    customerLabel: null,
    relatedObjectType: null,
    relatedObjectId: null,
    occurredAt: '2026-07-31T17:50:00Z',
    receivedAt: '2026-07-31T17:50:05Z',
    status: 'recorded',
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: 'production',
    ...over,
  }
}

/** A real adapter over a list of rows — the same wrapper production uses. */
const rows = (name: string, items: ActivityItem[]): ActivitySource =>
  buildSource<ActivityItem>(name, { list: async () => items, now: () => NOW }, (row) => row)

const refuses = (name: string): ActivitySource =>
  buildSource<ActivityItem>(
    name,
    {
      list: async () => {
        throw new SourceForbidden('audit records are not available to this session')
      },
      now: () => NOW,
    },
    (row) => row,
  )

const explodes = (name: string, message: string): ActivitySource =>
  buildSource<ActivityItem>(
    name,
    {
      list: async () => {
        throw new Error(message)
      },
      now: () => NOW,
    },
    (row) => row,
  )

function permissions(over: Partial<ActivityPermissions> = {}): ActivityPermissions {
  return {
    actorIsActive: async () => true,
    permittedCompanies: async () => [TENANT],
    mayViewCustomer: async () => true,
    mayViewObject: async () => true,
    ...over,
  }
}

const handler = (over: Partial<ActivityHandlerDeps> = {}) =>
  buildActivityHandler({
    sources: [],
    permissions: permissions(),
    now: () => NOW,
    knownSources: KNOWN,
    ...over,
  })

const call = (qs: string, over: Partial<ActivityHandlerDeps> = {}, companyId = TENANT) =>
  handler(over).handle(new URLSearchParams(qs), { companyId })

// ───────────────────────────────────────────────────────────────

describe('a rejected query is named, not swallowed', () => {
  it.each([
    ['nonsense=1', 'nonsense', 'unknown_parameter'],
    ['customer=a&customer=b', 'customer', 'duplicate_parameter'],
    ['customer=', 'customer', 'blank_value'],
    ['customer=has%20a%20space', 'customer', 'malformed_identifier'],
    ['occurredFrom=last%20tuesday', 'occurredFrom', 'invalid_date'],
    [
      'occurredFrom=2026-07-31T00:00:00Z&occurredTo=2026-07-01T00:00:00Z',
      'occurredTo',
      'reversed_date_range',
    ],
    ['source=made_up', 'source', 'invalid_source'],
    ['eventFamily=message.send', 'eventFamily', 'invalid_event_family'],
    ['ownershipState=maybe', 'ownershipState', 'invalid_ownership_state'],
    ['pageSize=0', 'pageSize', 'invalid_page_size'],
    ['pageSize=5000', 'pageSize', 'invalid_page_size'],
    ['cursor=garbage', 'cursor', 'malformed_cursor'],
  ])('%s is a 400 naming the parameter', async (qs, parameter, code) => {
    const r = await call(qs, { sources: [rows('audit_log', [item()])] })
    expect(r.status).toBe(400)
    if (r.kind !== 'invalid_query') throw new Error('expected a rejection')
    expect(r.body.error).toBe('invalid_query')
    expect(r.body.parameter).toBe(parameter)
    expect(r.body.code).toBe(code)
    expect(r.body.detail.length).toBeGreaterThan(0)
  })

  it('does not read a single source when the query never parsed', async () => {
    const read = vi.fn(async () => ({
      status: 'ok' as const,
      items: [],
      fetchedAt: NOW.toISOString(),
    }))
    const r = await call('nonsense=1', { sources: [{ name: 'audit_log', read }] })
    expect(r.status).toBe(400)
    expect(read).not.toHaveBeenCalled()
  })
})

describe('a refusal about the CALLER is a 403', () => {
  it('refuses a company the session may not see, and cannot be widened by a parameter', async () => {
    const r = await call(`company=${OTHER}`, { sources: [rows('audit_log', [item()])] })
    expect(r.status).toBe(403)
    if (r.kind !== 'forbidden') throw new Error('expected a 403')
    expect(r.body.error).toBe('that company is not available to this session')
    // Nothing about the other tenant — not even that it exists.
    expect(JSON.stringify(r.body)).not.toContain(OTHER)
  })

  it('refuses an unknown or inactive actor', async () => {
    const r = await call('', {
      sources: [rows('audit_log', [item()])],
      permissions: permissions({ actorIsActive: async () => false }),
    })
    expect(r.status).toBe(403)
  })
})

describe('nothing answered is 503, never an empty 200', () => {
  it('returns exactly activity_unavailable', async () => {
    const r = await call('', {
      sources: [
        explodes('audit_log', 'ETIMEDOUT'),
        explodes('lane2', 'no Lane-2 event store is configured'),
      ],
    })
    expect(r.status).toBe(503)
    // Exactly this. A body carrying source names or counts would let a caller
    // measure a system they cannot read.
    expect(r.body).toEqual({ error: 'activity_unavailable' })
  })
})

describe('per-source states survive to the wire', () => {
  it('four sources answering and lane2 down is a 200 marked PARTIAL', async () => {
    const r = await call('', {
      sources: [
        rows('audit_log', [item({ activityId: 'au1', sourceSystem: 'audit_log' })]),
        rows('approval_request', [item({ activityId: 'ap1', sourceSystem: 'approval_request' })]),
        rows('staff_work_action', [item({ activityId: 'sw1', sourceSystem: 'staff_work_action' })]),
        rows('conversation_ownership', [
          item({ activityId: 'co1', sourceSystem: 'conversation_ownership' }),
        ]),
        explodes('lane2', 'no Lane-2 event store is configured'),
      ],
    })
    expect(r.status).toBe(200)
    if (r.kind !== 'ok') throw new Error('expected a feed')
    expect(r.body.dataState).toBe('partial')
    expect(r.body.items).toHaveLength(4)
    expect(r.body.sources.map((s) => s.source)).toEqual([...KNOWN])
    expect(r.body.sources.find((s) => s.source === 'lane2')?.state).toBe('unavailable')
    expect(r.body.generatedAt).toBe(NOW.toISOString())
  })

  it('a manager denied the audit trail still gets their feed', async () => {
    const r = await call('', {
      sources: [
        refuses('audit_log'),
        rows('approval_request', [item({ activityId: 'ap1', sourceSystem: 'approval_request' })]),
        rows('lane2', [item({ activityId: 'l1', sourceSystem: 'lane2' })]),
      ],
    })
    // The whole point: a SOURCE-level forbidden is not a REQUEST-level 403.
    expect(r.status).toBe(200)
    if (r.kind !== 'ok') throw new Error('expected a feed')
    expect(r.body.sources.find((s) => s.source === 'audit_log')?.state).toBe('forbidden')
    expect(r.body.items.map((i) => i.activityId).sort()).toEqual(['ap1', 'l1'])
    // Zero audit rows, and no trace of the trail existing.
    expect(r.body.items.filter((i) => i.sourceSystem === 'audit_log')).toHaveLength(0)
  })

  it('forbidden and unavailable are different answers and stay different', async () => {
    const r = await call('', {
      sources: [
        refuses('audit_log'),
        explodes('lane2', 'no Lane-2 event store is configured'),
        rows('approval_request', [item({ activityId: 'ap1', sourceSystem: 'approval_request' })]),
      ],
    })
    if (r.kind !== 'ok') throw new Error('expected a feed')
    const audit = r.body.sources.find((s) => s.source === 'audit_log')
    const lane2 = r.body.sources.find((s) => s.source === 'lane2')
    expect(audit?.state).toBe('forbidden')
    expect(lane2?.state).toBe('unavailable')
    expect(audit?.state).not.toBe(lane2?.state)
    // "You may not see this" carries no operational detail; "this broke" does.
    expect(audit?.detail).toBeUndefined()
    expect(lane2?.detail).toBeTruthy()
  })

  it('a source that throws does not erase the sources that answered', async () => {
    const r = await call('', {
      sources: [
        explodes('audit_log', 'connect ECONNREFUSED 10.0.7.4:5432'),
        rows('approval_request', [item({ activityId: 'ap1', sourceSystem: 'approval_request' })]),
        rows('lane2', [item({ activityId: 'l1', sourceSystem: 'lane2' })]),
      ],
    })
    expect(r.status).toBe(200)
    if (r.kind !== 'ok') throw new Error('expected a feed')
    expect(r.body.dataState).toBe('partial')
    expect(r.body.items.map((i) => i.activityId).sort()).toEqual(['ap1', 'l1'])
  })
})

describe('a failure never describes the machine it happened on', () => {
  it('carries no driver text, no host and no stack frame', async () => {
    const r = await call('', {
      sources: [
        explodes(
          'audit_log',
          'connect ECONNREFUSED 10.0.7.4:5432 db.internal.isola\n    at Socket.onConnect (/srv/app/node_modules/pg/lib/client.js:112:11)',
        ),
        rows('approval_request', [item({ activityId: 'ap1', sourceSystem: 'approval_request' })]),
      ],
    })
    if (r.kind !== 'ok') throw new Error('expected a feed')
    const json = JSON.stringify(r.body)
    expect(json).not.toContain('ECONNREFUSED')
    expect(json).not.toContain('10.0.7.4')
    expect(json).not.toContain('db.internal.isola')
    expect(json).not.toContain('/srv/app')
    expect(json).not.toMatch(/ at \S+:\d+/)
    // Replaced by something an operator can act on, not silence.
    expect(r.body.sources.find((s) => s.source === 'audit_log')?.detail).toBe(
      'the source could not be reached',
    )
  })

  it('an internal failure is a bare 500', async () => {
    const r = await call('', {
      sources: [rows('audit_log', [item()])],
      permissions: permissions({
        actorIsActive: async () => {
          throw new Error('pg: password authentication failed for user isola at db.internal:5432')
        },
      }),
    })
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'internal_error' })
    expect(JSON.stringify(r.body)).not.toContain('password')
  })
})

describe('the cursor the handler hands out is the cursor it will accept', () => {
  const five = Array.from({ length: 5 }, (_, n) =>
    item({
      activityId: `c${n}`,
      sourceSystem: 'approval_request',
      occurredAt: new Date(NOW.getTime() - n * 60_000).toISOString(),
    }),
  )
  const sources = [rows('approval_request', five)]

  it('round-trips through the parser for the same filters', async () => {
    const first = await call('pageSize=2', { sources })
    if (first.kind !== 'ok') throw new Error('expected a feed')
    expect(first.body.nextCursor).not.toBeNull()

    const reparsed = parseActivityQuery(
      new URLSearchParams(`pageSize=2&cursor=${first.body.nextCursor}`),
      { companyId: TENANT, knownSources: KNOWN },
    )
    expect(reparsed.ok).toBe(true)

    const second = await call(`pageSize=2&cursor=${first.body.nextCursor}`, { sources })
    if (second.kind !== 'ok') throw new Error('expected a second page')
    expect(first.body.items.map((i) => i.activityId)).toEqual(['c0', 'c1'])
    expect(second.body.items.map((i) => i.activityId)).toEqual(['c2', 'c3'])
  })

  it('is refused for a different company', async () => {
    const first = await call('pageSize=2', { sources })
    if (first.kind !== 'ok') throw new Error('expected a feed')

    const elsewhere = parseActivityQuery(
      new URLSearchParams(`pageSize=2&cursor=${first.body.nextCursor}`),
      { companyId: OTHER, knownSources: KNOWN },
    )
    expect(elsewhere.ok).toBe(false)
    if (elsewhere.ok) return
    expect(elsewhere.rejection).toBe('malformed_cursor')
    expect(elsewhere.detail).toContain('different set of filters')
  })

  it('is refused when the filters changed, as a 400 on the cursor', async () => {
    const first = await call('pageSize=2', { sources })
    if (first.kind !== 'ok') throw new Error('expected a feed')

    const r = await call(`pageSize=2&customer=cust-1&cursor=${first.body.nextCursor}`, { sources })
    expect(r.status).toBe(400)
    if (r.kind !== 'invalid_query') throw new Error('expected a rejection')
    expect(r.body.parameter).toBe('cursor')
    expect(r.body.code).toBe('malformed_cursor')
  })
})
