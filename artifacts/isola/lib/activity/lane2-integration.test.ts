/**
 * The Lane-2 path END TO END, with nothing stubbed in the middle.
 *
 * An event is ingested through the real `ingestLane2Event`, written through the
 * real `createPrismaProjectionStore`, read back through the real
 * `createLane2Source` and paged through the real feed. Only the Prisma delegate
 * is fake — and it enforces both unique constraints, so the tenant-isolation
 * claims are tested rather than asserted.
 *
 * `sources/lane2-events.test.ts` proves the projection in isolation. This file
 * exists because the interesting failures live in the seams between the three.
 */

import { describe, expect, it } from 'vitest'

import {
  EVENT_INGEST_VERSION,
  ingestLane2Event,
  type Lane2Event,
} from '@/lib/events/ingest'
import {
  createPrismaProjectionStore,
  type ProjectedActivityRow,
  type ProjectionDelegate,
} from '@/lib/events/projection-store'

import {
  getActivityFeed,
  type ActivityQuery,
  type ActivitySource,
  type FeedPorts,
} from './feed'
import { createLane2Source } from './sources/lane2-events'

const NOW = new Date('2026-07-31T18:00:00Z')
const TENANT = 'tenant-1'
const OTHER = 'tenant-2'

/* ── the only fake in the file ──────────────────────────────────────── */

class FakeUniqueViolation extends Error {
  readonly code = 'P2002'
  constructor() {
    super('Unique constraint failed')
    this.name = 'PrismaClientKnownRequestError'
  }
}

interface FindUniqueArgs {
  where: { tenant_id_event_id: { tenant_id: string; event_id: string } }
}
interface CreateArgs {
  data: Omit<ProjectedActivityRow, 'id' | 'created_at'>
}
interface FindManyArgs {
  where: { tenant_id: string; occurred_at?: { gte?: Date; lte?: Date } }
  take: number
}

function fakePrisma() {
  const rows: ProjectedActivityRow[] = []
  let readFailure: Error | null = null

  const delegate: ProjectionDelegate = {
    async findUnique(args) {
      const k = (args as FindUniqueArgs).where.tenant_id_event_id
      return rows.find((r) => r.tenant_id === k.tenant_id && r.event_id === k.event_id) ?? null
    },
    async create(args) {
      const data = (args as CreateArgs).data
      const clash = rows.some(
        (r) =>
          r.tenant_id === data.tenant_id &&
          (r.event_id === data.event_id || r.dedupe_key === data.dedupe_key),
      )
      if (clash) throw new FakeUniqueViolation()
      const row: ProjectedActivityRow = { ...data, id: `row-${rows.length + 1}`, created_at: NOW }
      rows.push(row)
      return row
    },
    async findMany(args) {
      if (readFailure) throw readFailure
      const a = args as FindManyArgs
      let out = rows.filter((r) => r.tenant_id === a.where.tenant_id)
      const range = a.where.occurred_at
      if (range?.gte) out = out.filter((r) => new Date(r.occurred_at) >= range.gte!)
      if (range?.lte) out = out.filter((r) => new Date(r.occurred_at) <= range.lte!)
      out = [...out].sort((x, y) => {
        const delta = new Date(y.occurred_at).getTime() - new Date(x.occurred_at).getTime()
        if (delta !== 0) return delta
        return x.event_id < y.event_id ? -1 : x.event_id > y.event_id ? 1 : 0
      })
      return out.slice(0, a.take)
    },
  }

  return {
    delegate,
    rows,
    failReadsWith(err: Error) {
      readFailure = err
    },
  }
}

/* ── wiring ───────────────────────────────────────────────────────── */

const BASE: Lane2Event = {
  eventId: 'e-1',
  version: EVENT_INGEST_VERSION,
  sourceSystem: 'lane2',
  eventType: 'message.inbound.customer',
  occurredAt: '2026-07-31T17:50:00Z',
  companyId: TENANT,
  channelBindingId: 'cb-1',
  conversationRef: 'conv-9',
  actorClass: 'customer',
  payload: {},
  dedupeKey: 'k-1',
}

function harness(links: { chatwootBaseUrl?: string | null; clawithBaseUrl?: string | null } = {}) {
  const db = fakePrisma()
  const store = createPrismaProjectionStore({ delegate: db.delegate })
  const source = createLane2Source({ store, now: () => NOW, ...links })

  /** The real ingestion path, writing through the real store. */
  async function ingest(over: Partial<Lane2Event> = {}) {
    return ingestLane2Event(
      { ...BASE, ...over },
      {
        sourceIsTrusted: (s) => s === 'lane2',
        // Transport dedup is Lane 2's job; force every event at the store so
        // the store's OWN idempotency is what is under test.
        seen: async () => false,
        project: (a) => store.project(a),
        now: () => NOW,
      },
    )
  }

  return { db, store, source, ingest }
}

const feedPorts = (source: ActivitySource): FeedPorts => ({
  sources: [source],
  permissions: {
    actorIsActive: async () => true,
    permittedCompanies: async () => [TENANT],
    mayViewCustomer: async () => true,
    mayViewObject: async () => true,
  },
  now: () => NOW,
})

const feed = (source: ActivitySource, query: Partial<ActivityQuery> = {}) =>
  getActivityFeed({ companyId: TENANT, ...query }, feedPorts(source))

const query = { companyId: TENANT, pageSize: 25, cursor: null, permittedCompanies: [TENANT] }

/* ── tests ────────────────────────────────────────────────────────── */

describe('an ingested event reaches the feed', () => {
  it('appears through the real source once it has been stored', async () => {
    const h = harness()
    expect((await h.ingest()).accepted).toBe(true)

    const r = await h.source.read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items.map((i) => i.activityId)).toEqual(['lane2:e-1'])
    expect(r.items[0].eventType).toBe('customer.message')
  })

  it('reports ok with NO rows — available-empty is not unavailable', async () => {
    const h = harness()
    const r = await h.source.read(query)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.items).toEqual([])

    const f = await feed(h.source)
    expect(f.ok).toBe(true)
    if (!f.ok) return
    expect(f.dataState).toBe('available_empty')
    expect(f.sources[0]).toMatchObject({ source: 'lane2', state: 'ok' })
  })

  it('a store that cannot answer is unavailable, never an empty history', async () => {
    const h = harness()
    await h.ingest()
    h.db.failReadsWith(new Error('connect ECONNREFUSED 10.0.0.1:5432'))

    const r = await h.source.read(query)
    expect(r.status).toBe('unavailable')

    const f = await feed(h.source)
    expect(f.ok && f.dataState).toBe('unavailable')
  })
})

describe('tenant isolation survives the whole path', () => {
  it('another tenant event is absent, even sharing an event id and dedupe key', async () => {
    const h = harness()
    await h.ingest({ eventId: 'shared', dedupeKey: 'shared-key' })
    await h.ingest({ eventId: 'shared', dedupeKey: 'shared-key', companyId: OTHER })

    // Both were stored — the tenant is in both unique keys.
    expect(h.db.rows).toHaveLength(2)

    const r = await h.source.read(query)
    expect(r.status === 'ok' && r.items.map((i) => i.companyId)).toEqual([TENANT])
  })
})

describe('duplicates collapse', () => {
  it('the same event ingested twice becomes ONE row and ONE feed item', async () => {
    const h = harness()
    await h.ingest()
    await h.ingest()

    expect(h.db.rows).toHaveLength(1)
    const f = await feed(h.source)
    expect(f.ok && f.items).toHaveLength(1)
  })
})

describe('filtering happens on real stored rows', () => {
  it('filters by event family', async () => {
    const h = harness()
    await h.ingest({ eventId: 'msg', dedupeKey: 'k1' })
    await h.ingest({
      eventId: 'agent',
      dedupeKey: 'k2',
      eventType: 'agent.response',
      actorClass: 'agent',
    })

    const only = await feed(h.source, { eventTypes: ['customer.message'] })
    expect(only.ok && only.items.map((i) => i.activityId)).toEqual(['lane2:msg'])

    const both = await feed(h.source)
    expect(both.ok && both.items).toHaveLength(2)
  })

  it('filters by source system', async () => {
    const h = harness()
    await h.ingest()

    const kept = await feed(h.source, { sourceSystems: ['lane2'] })
    expect(kept.ok && kept.items).toHaveLength(1)

    // A filter naming another source excludes every row this one could return.
    const dropped = await feed(h.source, { sourceSystems: ['audit_log'] })
    expect(dropped.ok && dropped.items).toHaveLength(0)
    expect(dropped.ok && dropped.dataState).toBe('available_empty')
  })

  it('filters by occurrence date, not by arrival date', async () => {
    const h = harness()
    await h.ingest({ eventId: 'old', dedupeKey: 'k1', occurredAt: '2026-07-20T10:00:00Z' })
    await h.ingest({ eventId: 'recent', dedupeKey: 'k2', occurredAt: '2026-07-31T10:00:00Z' })

    const r = await feed(h.source, { from: '2026-07-25T00:00:00Z' })
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['lane2:recent'])
  })
})

describe('ordering and paging', () => {
  it('a late arrival lands in its HISTORICAL place, not at the top', async () => {
    const h = harness()
    await h.ingest({
      eventId: 'newer',
      dedupeKey: 'k1',
      occurredAt: '2026-07-31T17:00:00Z',
      receivedAt: '2026-07-31T17:00:05Z',
    })
    await h.ingest({
      // Happened first, turned up last.
      eventId: 'older',
      dedupeKey: 'k2',
      occurredAt: '2026-07-31T09:00:00Z',
      receivedAt: '2026-07-31T17:59:00Z',
    })

    const r = await feed(h.source)
    expect(r.ok && r.items.map((i) => i.activityId)).toEqual(['lane2:newer', 'lane2:older'])
    expect(r.ok && r.items[1].occurredAt).toBe('2026-07-31T09:00:00.000Z')
    expect(r.ok && r.items[1].receivedAt).toBe('2026-07-31T17:59:00.000Z')
  })

  it('pages with a cursor without repeating or skipping a row', async () => {
    const h = harness()
    await h.ingest({ eventId: 'a', dedupeKey: 'k1', occurredAt: '2026-07-31T12:00:00Z' })
    await h.ingest({ eventId: 'b', dedupeKey: 'k2', occurredAt: '2026-07-31T13:00:00Z' })
    await h.ingest({ eventId: 'c', dedupeKey: 'k3', occurredAt: '2026-07-31T14:00:00Z' })

    const page1 = await feed(h.source, { pageSize: 2 })
    expect(page1.ok).toBe(true)
    if (!page1.ok) return
    expect(page1.items.map((i) => i.activityId)).toEqual(['lane2:c', 'lane2:b'])
    expect(page1.nextCursor).toBeTruthy()

    const page2 = await feed(h.source, { pageSize: 2, cursor: page1.nextCursor })
    expect(page2.ok).toBe(true)
    if (!page2.ok) return
    expect(page2.items.map((i) => i.activityId)).toEqual(['lane2:a'])
    expect(page2.nextCursor).toBeNull()
  })
})

describe('what the row says', () => {
  it('an unrecognised channel health status stays UNKNOWN through the whole path', async () => {
    const h = harness()
    await h.ingest({
      eventId: 'h1',
      dedupeKey: 'k1',
      eventType: 'channel.health',
      actorClass: 'system',
      payload: { status: 'weird-new-value' },
    })

    const r = await feed(h.source)
    expect(r.ok && r.items[0].status).toBe('unknown')
    expect(r.ok && r.items[0].status).not.toBe('healthy')
  })

  it('offers no deep link when no base URL is configured', async () => {
    const h = harness()
    await h.ingest()
    const r = await feed(h.source)
    expect(r.ok && r.items[0].nativeLinks).toEqual([])
  })

  it('offers a link built from the stored conversation reference when one is', async () => {
    const h = harness({ chatwootBaseUrl: 'https://chat.example' })
    await h.ingest()
    const r = await feed(h.source)
    expect(r.ok && r.items[0].nativeLinks[0]).toMatchObject({
      system: 'chatwoot',
      href: 'https://chat.example/app/conversations/conv-9',
    })
  })
})
