import { describe, expect, it } from 'vitest'

import type { ResolvedQuery } from '@/lib/activity/feed'

import type { ProjectedActivity } from './ingest'
import {
  createPrismaProjectionStore,
  ProjectionConflict,
  PROJECTION_ROW_LIMIT,
  type ProjectedActivityRow,
  type ProjectionDelegate,
} from './projection-store'

const TENANT = 'tenant-1'
const OTHER = 'tenant-2'

/* ── an in-memory Postgres, as far as this module can tell ─────────────────── */

/** Shaped like Prisma's own: the store recognises a conflict by `code`. */
class FakeUniqueViolation extends Error {
  readonly code = 'P2002'
  constructor(readonly target: string[]) {
    super(`Unique constraint failed on ${target.join(', ')}`)
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
  orderBy: ReadonlyArray<Record<string, string>>
  take: number
}

function fakePrisma() {
  const rows: ProjectedActivityRow[] = []
  const findManyArgs: FindManyArgs[] = []
  let readFailure: Error | null = null

  const delegate: ProjectionDelegate = {
    async findUnique(args) {
      const key = (args as FindUniqueArgs).where.tenant_id_event_id
      return (
        rows.find((r) => r.tenant_id === key.tenant_id && r.event_id === key.event_id) ?? null
      )
    },

    async create(args) {
      const data = (args as CreateArgs).data
      // BOTH constraints, both scoped by tenant. If either were global the
      // cross-tenant tests below would fail, which is the point of writing them.
      if (rows.some((r) => r.tenant_id === data.tenant_id && r.event_id === data.event_id)) {
        throw new FakeUniqueViolation(['tenant_id', 'event_id'])
      }
      if (rows.some((r) => r.tenant_id === data.tenant_id && r.dedupe_key === data.dedupe_key)) {
        throw new FakeUniqueViolation(['tenant_id', 'dedupe_key'])
      }
      const row: ProjectedActivityRow = {
        ...data,
        id: `row-${rows.length + 1}`,
        created_at: new Date('2026-07-31T18:00:00Z'),
      }
      rows.push(row)
      return row
    },

    async findMany(args) {
      const a = args as FindManyArgs
      findManyArgs.push(a)
      if (readFailure) throw readFailure

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
    findManyArgs,
    failReadsWith(err: Error) {
      readFailure = err
    },
  }
}

function activity(over: Partial<ProjectedActivity> = {}): ProjectedActivity {
  return {
    eventId: 'evt-1',
    companyId: TENANT,
    type: 'message.inbound.customer',
    source: 'whatsapp',
    actorClass: 'customer',
    occurredAt: new Date('2026-07-31T17:50:00Z'),
    receivedAt: new Date('2026-07-31T17:50:03Z'),
    channelBindingId: 'cb-1',
    agentRef: null,
    conversationRef: 'conv-9',
    relatedObjects: {},
    correlationId: 'corr-1',
    payload: { preview: 'my line is down' },
    dedupeKey: 'wamid-1',
    ...over,
  }
}

const query = (over: Partial<ResolvedQuery> = {}): ResolvedQuery => ({
  companyId: TENANT,
  pageSize: 25,
  cursor: null,
  permittedCompanies: [TENANT],
  ...over,
})

/* ── writing ────────────────────────────────────────────────────────── */

describe('projecting is idempotent on identity', () => {
  it('persists a first projection exactly once', async () => {
    const db = fakePrisma()
    await createPrismaProjectionStore({ delegate: db.delegate }).project(activity())

    expect(db.rows).toHaveLength(1)
    expect(db.rows[0]).toMatchObject({
      tenant_id: TENANT,
      event_id: 'evt-1',
      dedupe_key: 'wamid-1',
      event_type: 'message.inbound.customer',
      source_system: 'whatsapp',
      actor_class: 'customer',
      conversation_ref: 'conv-9',
    })
  })

  it('an identical replay succeeds and still leaves ONE row', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    await expect(store.project(activity())).resolves.toBeUndefined()

    expect(db.rows).toHaveLength(1)
  })

  it('a replay that only differs in ARRIVAL time is still the same event', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    // receivedAt legitimately differs between deliveries, so it is not part of
    // identity content — this must not be treated as a conflict.
    await store.project(activity({ receivedAt: new Date('2026-07-31T19:30:00Z') }))

    expect(db.rows).toHaveLength(1)
  })
})

describe('conflicting content FAILS CLOSED', () => {
  it('throws ProjectionConflict rather than overwriting the first row', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    await expect(
      store.project(activity({ payload: { preview: 'something else entirely' } })),
    ).rejects.toBeInstanceOf(ProjectionConflict)

    // The earlier accepted event must still be there, unmodified.
    expect(db.rows).toHaveLength(1)
    expect(db.rows[0].payload).toEqual({ preview: 'my line is down' })
  })

  it.each([
    ['a different occurredAt', { occurredAt: new Date('2026-07-30T00:00:00Z') }],
    ['a different event type', { type: 'agent.response' as const }],
    ['a different source system', { source: 'telegram' }],
    ['a different dedupe key', { dedupeKey: 'wamid-other' }],
    ['different related objects', { relatedObjects: { customerId: 'cust-3' } }],
  ])('%s under the same identity is a conflict', async (_label, patch) => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    await expect(store.project(activity(patch))).rejects.toBeInstanceOf(ProjectionConflict)
    expect(db.rows).toHaveLength(1)
  })

  it('never echoes the differing payload back in the error message', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    await expect(
      store.project(activity({ payload: { preview: 'card 4111 1111 1111 1111' } })),
    ).rejects.toThrow(/^(?!.*4111).*$/)
  })

  it('a second event claiming a used dedupe key in the SAME tenant is refused', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity())
    await expect(
      store.project(activity({ eventId: 'evt-2', dedupeKey: 'wamid-1' })),
    ).rejects.toBeInstanceOf(ProjectionConflict)
    expect(db.rows).toHaveLength(1)
  })

  it('propagates a failure that is NOT a unique violation', async () => {
    const store = createPrismaProjectionStore({
      delegate: {
        async findUnique() {
          return null
        },
        async create() {
          throw new Error('connect ECONNREFUSED 10.0.0.1:5432')
        },
        async findMany() {
          return []
        },
      },
    })
    await expect(store.project(activity())).rejects.toThrow(/ECONNREFUSED/)
  })
})

describe('the tenant is in BOTH keys', () => {
  it('the same event_id in another tenant is a SEPARATE row', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity({ eventId: 'shared-evt' }))
    await store.project(activity({ eventId: 'shared-evt', companyId: OTHER }))

    expect(db.rows).toHaveLength(2)
    expect(db.rows.map((r) => r.tenant_id).sort()).toEqual([TENANT, OTHER].sort())
  })

  it('the same dedupe_key in another tenant is a SEPARATE row', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity({ eventId: 'a', dedupeKey: 'shared-key' }))
    await store.project(activity({ eventId: 'b', dedupeKey: 'shared-key', companyId: OTHER }))

    expect(db.rows).toHaveLength(2)
  })
})

describe('what gets written', () => {
  it('keeps the event OCCURRENCE time; arrival never replaces it', async () => {
    const db = fakePrisma()
    await createPrismaProjectionStore({ delegate: db.delegate }).project(
      activity({
        // A late arrival: it happened this morning, it turned up this evening.
        occurredAt: new Date('2026-07-31T09:00:00Z'),
        receivedAt: new Date('2026-07-31T17:59:00Z'),
      }),
    )

    expect(new Date(db.rows[0].occurred_at).toISOString()).toBe('2026-07-31T09:00:00.000Z')
    expect(new Date(db.rows[0].received_at).toISOString()).toBe('2026-07-31T17:59:00.000Z')
  })

  it('falls back to the event id when no dedupe key travelled with the projection', async () => {
    const db = fakePrisma()
    await createPrismaProjectionStore({ delegate: db.delegate }).project(
      activity({ dedupeKey: undefined }),
    )
    // NOT NULL in the schema, so it must be something deterministic.
    expect(db.rows[0].dedupe_key).toBe('evt-1')
  })

  it('the persisted row carries no credential-shaped key or value', async () => {
    const db = fakePrisma()
    await createPrismaProjectionStore({ delegate: db.delegate }).project(activity())

    const serialised = JSON.stringify(db.rows[0]).toLowerCase()
    for (const forbidden of ['authorization', 'token', 'cookie', 'bearer', 'password', 'secret']) {
      expect(serialised).not.toContain(forbidden)
    }
    expect(serialised).not.toMatch(/eaa[a-z0-9]{20,}|gh[pousr]_[a-z0-9]{20,}|sk-[a-z0-9_-]{16,}/)
  })
})

/* ── reading ────────────────────────────────────────────────────────── */

describe('reading is tenant-scoped, ordered and bounded', () => {
  it('never returns another tenant rows', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(activity({ eventId: 'mine' }))
    await store.project(activity({ eventId: 'theirs', companyId: OTHER, dedupeKey: 'k-2' }))

    const rows = await store.read(query())
    expect(rows.map((r) => r.eventId)).toEqual(['mine'])

    // And the scope is asked for at the DELEGATE, not filtered afterwards.
    expect(db.findManyArgs[0].where.tenant_id).toBe(TENANT)
  })

  it('orders by occurrence descending, then by event id ascending', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })
    const sameMoment = new Date('2026-07-31T12:00:00Z')

    await store.project(
      activity({ eventId: 'older', dedupeKey: 'k1', occurredAt: new Date('2026-07-31T09:00:00Z') }),
    )
    await store.project(activity({ eventId: 'b', dedupeKey: 'k2', occurredAt: sameMoment }))
    await store.project(activity({ eventId: 'a', dedupeKey: 'k3', occurredAt: sameMoment }))

    const rows = await store.read(query())
    // The tie is broken by event id, so the order is stable across reads.
    expect(rows.map((r) => r.eventId)).toEqual(['a', 'b', 'older'])
    expect(db.findManyArgs[0].orderBy).toEqual([{ occurred_at: 'desc' }, { event_id: 'asc' }])
  })

  it('bounds the read so one tenant cannot pull the whole table', async () => {
    const db = fakePrisma()
    await createPrismaProjectionStore({ delegate: db.delegate }).read(query())
    expect(db.findManyArgs[0].take).toBe(PROJECTION_ROW_LIMIT)
    expect(PROJECTION_ROW_LIMIT).toBe(500)
  })

  it('applies the occurrence window the query carries', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })

    await store.project(
      activity({ eventId: 'before', dedupeKey: 'k1', occurredAt: new Date('2026-07-29T12:00:00Z') }),
    )
    await store.project(
      activity({ eventId: 'inside', dedupeKey: 'k2', occurredAt: new Date('2026-07-31T12:00:00Z') }),
    )

    const rows = await store.read(
      query({ from: '2026-07-30T00:00:00Z', to: '2026-08-01T00:00:00Z' }),
    )
    expect(rows.map((r) => r.eventId)).toEqual(['inside'])
  })

  it('returns nothing when the query excludes this source entirely', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })
    await store.project(activity())

    expect(await store.read(query({ sourceSystems: ['audit_log'] }))).toEqual([])
    // It did not even ask the database.
    expect(db.findManyArgs).toHaveLength(0)

    expect(await store.read(query({ sourceSystems: ['lane2'] }))).toHaveLength(1)
  })

  it('an empty table is an EMPTY LIST, not a failure', async () => {
    const db = fakePrisma()
    const rows = await createPrismaProjectionStore({ delegate: db.delegate }).read(query())
    expect(rows).toEqual([])
  })

  it('a failing read THROWS, so the source can report unavailable', async () => {
    const db = fakePrisma()
    db.failReadsWith(new Error('connect ECONNREFUSED 10.0.0.1:5432'))
    // Swallowing this into [] would say "nothing happened" when the truth is
    // "we could not find out".
    await expect(createPrismaProjectionStore({ delegate: db.delegate }).read(query())).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })

  it('round-trips a row back into the shape the rest of Foundation speaks', async () => {
    const db = fakePrisma()
    const store = createPrismaProjectionStore({ delegate: db.delegate })
    await store.project(activity())

    const [row] = await store.read(query())
    expect(row).toMatchObject({
      eventId: 'evt-1',
      companyId: TENANT,
      type: 'message.inbound.customer',
      source: 'whatsapp',
      actorClass: 'customer',
      channelBindingId: 'cb-1',
      conversationRef: 'conv-9',
      correlationId: 'corr-1',
      dedupeKey: 'wamid-1',
    })
    expect(row.occurredAt).toBeInstanceOf(Date)
    expect(row.receivedAt).toBeInstanceOf(Date)
  })
})
