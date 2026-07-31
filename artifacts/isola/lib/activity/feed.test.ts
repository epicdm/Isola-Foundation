import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  ACTIVITY_FEED_VERSION,
  EVENT_TYPES,
  MAX_PAGE_SIZE,
  compareItems,
  decodeCursor,
  dedupe,
  deriveDataState,
  encodeCursor,
  getActivityFeed,
  type ActivityItem,
  type ActivityPermissions,
  type ActivityQuery,
  type ActivitySource,
  type EventType,
  type FeedPorts,
  type SourceResult,
} from './feed'

const NOW = new Date('2026-07-31T18:00:00Z')
const COMPANY = 'company-epic'
const OTHER = 'company-someone-else'

function item(over: Partial<ActivityItem> = {}): ActivityItem {
  return {
    activityId: 'a1',
    eventType: 'staff.note',
    title: 'Note added',
    summary: 'Customer called about a dropped line',
    sourceSystem: 'foundation',
    provenance: { source: 'foundation', fetchedAt: NOW.toISOString(), trust: 'authoritative' },
    actor: { ref: 'principal-7', label: 'Ann', kind: 'staff' },
    companyId: COMPANY,
    customerId: 'cust-1',
    customerLabel: 'Bay Front Hotel',
    relatedObjectType: 'task',
    relatedObjectId: 'task-1',
    occurredAt: '2026-07-31T17:50:00Z',
    receivedAt: '2026-07-31T17:50:05Z',
    status: 'recorded',
    ownershipState: null,
    availableActions: [],
    nativeLinks: [{ system: 'odoo', label: 'Open task', href: 'https://odoo.example/task/1' }],
    dataMode: 'production',
    ...over,
  }
}

const source = (name: string, result: SourceResult | (() => Promise<SourceResult>)): ActivitySource => ({
  name,
  fetch: typeof result === 'function' ? result : async () => result,
})

const ok = (items: ActivityItem[], mode?: 'production' | 'fixture'): SourceResult => ({
  status: 'ok',
  items,
  fetchedAt: NOW.toISOString(),
  ...(mode ? { mode } : {}),
})

function permissions(over: Partial<ActivityPermissions> = {}): ActivityPermissions {
  return {
    actorIsActive: async () => true,
    permittedCompanies: async () => [COMPANY],
    mayViewCustomer: async () => true,
    mayViewObject: async () => true,
    ...over,
  }
}

const ports = (sources: ActivitySource[], perms = permissions()): FeedPorts => ({
  sources,
  permissions: perms,
  now: () => NOW,
})

const run = (q: Partial<ActivityQuery>, p: FeedPorts) =>
  getActivityFeed({ companyId: COMPANY, ...q }, p)

// ───────────────────────────────────────────────────────────────

describe('recent work across a permitted company', () => {
  it('returns records and says so', async () => {
    const r = await run({}, ports([source('foundation', ok([item()]))]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.version).toBe(ACTIVITY_FEED_VERSION)
    expect(r.dataState).toBe('available_with_records')
    expect(r.items).toHaveLength(1)
    expect(r.items[0].freshness.ageSeconds).toBe(600)
    expect(r.items[0].availableActions).toContain('note.create')
    expect(r.items[0].nativeLinks[0].system).toBe('odoo')
  })

  it('an empty feed is EMPTY, not broken', async () => {
    const r = await run({}, ports([source('foundation', ok([]))]))
    expect(r.ok && r.dataState).toBe('available_empty')
  })
})

describe('the event families the workbench must be able to show', () => {
  it.each(EVENT_TYPES)('carries %s', async (eventType) => {
    const r = await run(
      { eventTypes: [eventType] },
      ports([source('s', ok([item({ activityId: eventType, eventType: eventType as EventType })]))]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items).toHaveLength(1)
    expect(r.items[0].eventType).toBe(eventType)
  })

  it('refuses an event type nobody defined instead of quietly returning nothing', async () => {
    const r = await run({ eventTypes: ['message.send'] }, ports([source('s', ok([item()]))]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('invalid_filter')
  })
})

describe('filters', () => {
  const items = [
    item({ activityId: 'a1', customerId: 'cust-1', relatedObjectType: 'task', relatedObjectId: 't1', status: 'open' }),
    item({ activityId: 'a2', customerId: 'cust-2', relatedObjectType: 'service', relatedObjectId: 's9', status: 'closed', eventType: 'lead.created' }),
    item({ activityId: 'a3', customerId: 'cust-1', relatedObjectType: 'issue', relatedObjectId: 'i4', sourceSystem: 'lane2', status: 'open' }),
  ]
  const p = () => ports([source('s', ok(items))])

  it.each([
    ['customer', { customerId: 'cust-1' }, ['a1', 'a3']],
    ['task', { taskId: 't1' }, ['a1']],
    ['service', { serviceId: 's9' }, ['a2']],
    ['issue', { issueId: 'i4' }, ['a3']],
    ['status', { statuses: ['closed'] }, ['a2']],
    ['source system', { sourceSystems: ['lane2'] }, ['a3']],
    ['event type', { eventTypes: ['lead.created'] }, ['a2']],
  ])('filters by %s', async (_label, q, expected) => {
    const r = await run(q, p())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map((i) => i.activityId).sort()).toEqual(expected)
  })

  it('combines filters', async () => {
    const r = await run({ customerId: 'cust-1', statuses: ['open'], sourceSystems: ['lane2'] }, p())
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['a3'])
  })

  it('filters by date range on when it HAPPENED', async () => {
    const r = await run(
      { from: '2026-07-31T17:00:00Z', to: '2026-07-31T17:55:00Z' },
      ports([
        source('s', ok([item({ activityId: 'old', occurredAt: '2026-07-30T10:00:00Z' }), item({ activityId: 'new' })])),
      ]),
    )
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['new'])
  })

  it('refuses an unparseable date rather than ignoring it', async () => {
    const r = await run({ from: 'last tuesday' }, ports([source('s', ok([item()]))]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.detail).toMatch(/from is not a valid date/)
  })
})

describe('ordering — by when it happened, not when we heard', () => {
  it('a late-arriving older event does not jump to the top', async () => {
    const older = item({
      activityId: 'older',
      occurredAt: '2026-07-31T10:00:00Z',
      receivedAt: '2026-07-31T17:59:00Z', // arrived a moment ago
    })
    const newer = item({
      activityId: 'newer',
      occurredAt: '2026-07-31T17:00:00Z',
      receivedAt: '2026-07-31T17:00:01Z',
    })
    const r = await run({}, ports([source('s', ok([older, newer]))]))
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['newer', 'older'])
  })

  it('breaks ties on the same instant deterministically', () => {
    const a = item({ activityId: 'b', occurredAt: '2026-07-31T17:00:00Z' })
    const b = item({ activityId: 'a', occurredAt: '2026-07-31T17:00:00Z' })
    expect([a, b].sort(compareItems).map((i) => i.activityId)).toEqual(['a', 'b'])
    expect([b, a].sort(compareItems).map((i) => i.activityId)).toEqual(['a', 'b'])
  })
})

describe('duplicate events', () => {
  it('keeps the source with the better claim to know', () => {
    const reported = item({ activityId: 'x', sourceSystem: 'lane2', provenance: { source: 'lane2', fetchedAt: NOW.toISOString(), trust: 'reported' }, title: 'reported' })
    const authoritative = item({ activityId: 'x', sourceSystem: 'odoo', provenance: { source: 'odoo', fetchedAt: NOW.toISOString(), trust: 'authoritative' }, title: 'authoritative' })
    expect(dedupe([reported, authoritative])).toHaveLength(1)
    expect(dedupe([reported, authoritative])[0].title).toBe('authoritative')
    expect(dedupe([authoritative, reported])[0].title).toBe('authoritative')
  })

  it('collapses the same event delivered by two sources', async () => {
    const dup = item({ activityId: 'same' })
    const r = await run({}, ports([source('a', ok([dup])), source('b', ok([{ ...dup }]))]))
    expect(r.ok && r.items).toHaveLength(1)
  })
})

describe('source states are never flattened', () => {
  it('one failed source and one good source is PARTIAL, not a full feed', async () => {
    const r = await run(
      {},
      ports([source('good', ok([item()])), source('bad', { status: 'unavailable', reason: 'odoo timed out' })]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dataState).toBe('partial')
    expect(r.items).toHaveLength(1)
    expect(r.sources.find((s) => s.source === 'bad')).toMatchObject({
      state: 'unavailable',
      detail: 'odoo timed out',
    })
  })

  it('every source down is UNAVAILABLE, never an empty list', async () => {
    const r = await run({}, ports([source('a', { status: 'unavailable', reason: 'down' })]))
    expect(r.ok && r.dataState).toBe('unavailable')
    expect(r.ok && r.items).toHaveLength(0)
  })

  it('a source that THROWS is unavailable, not empty', async () => {
    const r = await run(
      {},
      ports([
        source('boom', async () => {
          throw new Error('connection reset')
        }),
      ]),
    )
    expect(r.ok && r.dataState).toBe('unavailable')
    expect(r.ok && r.sources[0].detail).toBe('connection reset')
  })

  it('a forbidden source is FORBIDDEN, not not-found and not empty', async () => {
    const r = await run({}, ports([source('audit', { status: 'forbidden' })]))
    expect(r.ok && r.dataState).toBe('forbidden')
  })

  it('stale data is labelled stale rather than presented as current', async () => {
    const r = await run(
      {},
      ports([
        source('cache', {
          status: 'stale',
          items: [item()],
          fetchedAt: NOW.toISOString(),
          reason: 'serving the last good read',
        }),
      ]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dataState).toBe('stale')
    expect(r.items[0].freshness.stale).toBe(true)
  })

  it('an old read is stale even when the source did not say so', async () => {
    const r = await run(
      {},
      ports([source('slow', { status: 'ok', items: [item()], fetchedAt: '2026-07-31T17:00:00Z' })]),
    )
    expect(r.ok && r.dataState).toBe('stale')
  })

  it('fixture data is never presented as production data', async () => {
    const r = await run({}, ports([source('seed', ok([item()], 'fixture'))]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.dataState).toBe('fixture')
    expect(r.containsFixture).toBe(true)
  })

  it('fixture is still flagged when the overall state is partial', async () => {
    const r = await run(
      {},
      ports([source('seed', ok([item()], 'fixture')), source('bad', { status: 'unavailable', reason: 'x' })]),
    )
    expect(r.ok && r.dataState).toBe('partial')
    expect(r.ok && r.containsFixture).toBe(true)
  })

  it.each([
    [[{ source: 's', state: 'ok' as const }], 1, 'available_with_records'],
    [[{ source: 's', state: 'ok' as const }], 0, 'available_empty'],
    [[{ source: 's', state: 'unavailable' as const }], 0, 'unavailable'],
    [[{ source: 's', state: 'forbidden' as const }], 0, 'forbidden'],
  ])('derives the data state directly', (reports, count, expected) => {
    expect(deriveDataState(reports, count)).toBe(expected)
  })
})

describe('permission filtering', () => {
  it('refuses a company the actor may not see, with wording that reveals nothing', async () => {
    const r = await run({ companyId: OTHER }, ports([source('s', ok([item()]))]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('unauthorized_company')
    expect(r.detail).toBe('that company is not available to this session')
  })

  it('gives a non-existent company the SAME answer as a forbidden one', async () => {
    const p = ports([source('s', ok([item()]))])
    const forbidden = await run({ companyId: OTHER }, p)
    const nonsense = await run({ companyId: 'company-does-not-exist' }, p)
    expect(forbidden.ok).toBe(false)
    expect(nonsense.ok).toBe(false)
    if (forbidden.ok || nonsense.ok) return
    expect(forbidden.detail).toBe(nonsense.detail)
  })

  it('refuses an inactive staff user', async () => {
    const r = await run({}, ports([source('s', ok([item()]))], permissions({ actorIsActive: async () => false })))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('unknown_or_inactive_actor')
  })

  it('drops another company’s activity even when a source hands it over', async () => {
    const r = await run(
      {},
      ports([source('leaky', ok([item({ activityId: 'mine' }), item({ activityId: 'theirs', companyId: OTHER })]))]),
    )
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['mine'])
  })

  it('a forbidden object is ABSENT — not a redacted row', async () => {
    const r = await run(
      {},
      ports(
        [source('s', ok([item({ activityId: 'ok1' }), item({ activityId: 'secret', relatedObjectId: 'task-99' })]))],
        permissions({ mayViewObject: async (_t, id) => id !== 'task-99' }),
      ),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.map((i) => i.activityId)).toEqual(['ok1'])
    // Nothing about the hidden row survives: no title, no time, no source, no link.
    expect(JSON.stringify(r.items)).not.toContain('task-99')
    expect(JSON.stringify(r.items)).not.toContain('secret')
  })

  it('a forbidden customer is absent too', async () => {
    const r = await run(
      {},
      ports(
        [source('s', ok([item({ activityId: 'a', customerId: 'cust-1' }), item({ activityId: 'b', customerId: 'cust-9' })]))],
        permissions({ mayViewCustomer: async (id) => id !== 'cust-9' }),
      ),
    )
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['a'])
  })

  it('forbidden rows cannot be counted through pagination', async () => {
    const items = Array.from({ length: 6 }, (_, n) =>
      item({
        activityId: `a${n}`,
        relatedObjectId: n % 2 === 0 ? 'allowed' : 'blocked',
        occurredAt: new Date(NOW.getTime() - n * 60_000).toISOString(),
      }),
    )
    const r = await run(
      { pageSize: 2 },
      ports([source('s', ok(items))], permissions({ mayViewObject: async (_t, id) => id === 'allowed' })),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    // Three visible rows, page size two: exactly one more page. If filtering ran
    // after paging, the first page would be short and the shortfall would count
    // the hidden rows.
    expect(r.items).toHaveLength(2)
    expect(r.nextCursor).not.toBeNull()
  })

  it('does not leak native links for objects the actor may not see', async () => {
    const r = await run(
      {},
      ports(
        [source('s', ok([item({ activityId: 'hidden', relatedObjectId: 'task-99' })]))],
        permissions({ mayViewObject: async () => false }),
      ),
    )
    expect(r.ok && r.items).toHaveLength(0)
  })

  it('rejects a malformed object filter rather than matching everything', async () => {
    const r = await run({ companyId: '   ' }, ports([source('s', ok([item()]))]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('invalid_filter')
  })
})

describe('cursor pagination', () => {
  const many = Array.from({ length: 7 }, (_, n) =>
    item({ activityId: `a${n}`, occurredAt: new Date(NOW.getTime() - n * 60_000).toISOString() }),
  )

  it('walks every record exactly once, with no duplicates and none missing', async () => {
    const p = ports([source('s', ok(many))])
    const seen: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard++) {
      const r: Awaited<ReturnType<typeof getActivityFeed>> = await run({ pageSize: 3, cursor }, p)
      expect(r.ok).toBe(true)
      if (!r.ok) break
      seen.push(...r.items.map((i) => i.activityId))
      cursor = r.nextCursor
      if (!cursor) break
    }
    expect(seen).toEqual(many.map((i) => i.activityId))
    expect(new Set(seen).size).toBe(many.length)
  })

  it('is deterministic — the same cursor returns the same page', async () => {
    const p = ports([source('s', ok(many))])
    const first = await run({ pageSize: 3 }, p)
    expect(first.ok).toBe(true)
    if (!first.ok || !first.nextCursor) throw new Error('expected a next page')
    const a = await run({ pageSize: 3, cursor: first.nextCursor }, p)
    const b = await run({ pageSize: 3, cursor: first.nextCursor }, p)
    expect(a.ok && b.ok && JSON.stringify(a) === JSON.stringify(b)).toBe(true)
  })

  it('has no next cursor on the last page', async () => {
    const r = await run({ pageSize: 100 }, ports([source('s', ok(many))]))
    expect(r.ok && r.nextCursor).toBeNull()
  })

  it('bounds the page size', async () => {
    const lots = Array.from({ length: 150 }, (_, n) =>
      item({ activityId: `b${n}`, occurredAt: new Date(NOW.getTime() - n * 1000).toISOString() }),
    )
    const r = await run({ pageSize: 5000 }, ports([source('s', ok(lots))]))
    expect(r.ok && r.items.length).toBe(MAX_PAGE_SIZE)
  })

  it('rejects a cursor that is not one of ours', async () => {
    const r = await run({ cursor: 'not-a-cursor' }, ports([source('s', ok(many))]))
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.refusal).toBe('invalid_cursor')
  })

  it('round-trips a cursor', () => {
    const c = { occurredAt: '2026-07-31T17:00:00Z', activityId: 'a1' }
    expect(decodeCursor(encodeCursor(c))).toEqual(c)
    expect(decodeCursor('%%%')).toBeNull()
  })
})

describe('governed action and approval lifecycle rows', () => {
  it('shows a completed action with its readback status', async () => {
    const r = await run(
      { eventTypes: ['governed.action.completed'] },
      ports([
        source(
          'foundation',
          ok([item({ activityId: 'done', eventType: 'governed.action.completed', status: 'EXECUTED', summary: 'note read back as written' })]),
        ),
      ]),
    )
    expect(r.ok && r.items[0].status).toBe('EXECUTED')
  })

  it('a failed action is not dressed up as a success', async () => {
    const r = await run(
      {},
      ports([source('foundation', ok([item({ activityId: 'bad', eventType: 'governed.action.failed', status: 'READBACK_FAILED' })]))]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items[0].status).toBe('READBACK_FAILED')
    expect(r.items[0].eventType).toBe('governed.action.failed')
  })

  it('carries the approval lifecycle in order', async () => {
    const stages: EventType[] = ['approval.requested', 'approval.approved', 'approval.rejected']
    const rows = stages.map((eventType, n) =>
      item({ activityId: eventType, eventType, occurredAt: new Date(NOW.getTime() - n * 60_000).toISOString() }),
    )
    const r = await run({}, ports([source('foundation', ok(rows))]))
    expect(r.ok && r.items.map((i) => i.eventType)).toEqual(stages)
  })

  it('carries a normalised Lane-2 event with its ownership state', async () => {
    const r = await run(
      {},
      ports([
        source(
          'lane2',
          ok([
            item({
              activityId: 'ho',
              eventType: 'ownership.human_takeover',
              sourceSystem: 'lane2',
              ownershipState: 'human',
              provenance: { source: 'lane2', fetchedAt: NOW.toISOString(), trust: 'reported' },
            }),
          ]),
        ),
      ]),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items[0].ownershipState).toBe('human')
    expect(r.items[0].provenance.trust).toBe('reported')
  })
})

describe('the feed reads and does nothing else', () => {
  const src = readFileSync(join(__dirname, 'feed.ts'), 'utf8')
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const code = noComments.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""')

  it('sends nothing, writes nothing and reaches no network', () => {
    expect(code).not.toMatch(/\bfetch\s*\(/)
    expect(code).not.toMatch(/\b(sendMessage|sendReply|deliver|assign|takeOver|forceHandback|resumeAi)\s*\(/)
    expect(code).not.toMatch(/\bprisma\./)
  })

  it('offers no action that would message a customer', () => {
    const { ACTIONS_BY_EVENT } = require('./feed') as typeof import('./feed')
    for (const actions of Object.values(ACTIONS_BY_EVENT)) {
      for (const a of actions) {
        expect(a).not.toMatch(/message|reply|send|whatsapp|handover|takeover/i)
      }
    }
  })
})
