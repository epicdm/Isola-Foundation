/**
 * lane2.events.projection@1 — where `IngestPorts.project` actually writes, and
 * where `Lane2ProjectionStore` actually reads.
 *
 * ONE TABLE, TWO CONTRACTS
 * ------------------------
 * The write side and the read side live in the same file because they are the
 * same table. A projection whose reader disagrees with its writer about column
 * names, scoping or ordering is how a feed starts lying quietly.
 *
 * WHY THE WRITE FAILS CLOSED
 * --------------------------
 * `project()` is idempotent on identity `(tenant_id, event_id)`. An identical
 * replay is a success and leaves one row — that is the whole point of an
 * upsert. But when the SAME identity arrives carrying MATERIALLY DIFFERENT
 * content, this throws `ProjectionConflict` instead of overwriting.
 *
 * Overwriting would mean the earlier accepted event vanishes from history with
 * no record that it ever existed: the feed would show one version, the audit
 * question "what did we actually receive?" would have no answer, and the
 * substitution would leave no trace anywhere. Refusing is loud, recoverable and
 * leaves the first row intact. A genuine content change from Lane 2 is a NEW
 * event with a new `event_id`, not a rewrite of an old one.
 *
 * The comparison is a hash of `(eventType, sourceSystem, occurredAt, dedupeKey,
 * payload, relatedObjects)`. `receivedAt` is deliberately NOT in it: arrival
 * time legitimately differs between replays and is provenance, not identity.
 *
 * NOTHING HERE ACTS
 * -----------------
 * This module stores and returns rows. It sends nothing, retries nothing and
 * owns no conversation — the same one-way door `lib/events/ingest.ts` draws.
 */

import { createHash } from 'node:crypto'

import type { ResolvedQuery } from '@/lib/activity/feed'
import { LANE2_SOURCE, type Lane2ProjectionStore } from '@/lib/activity/sources/lane2-events'
import type { ActorClass, EventType, ProjectedActivity } from '@/lib/events/ingest'

/**
 * RETENTION AND DELETION — what is decided, and what deliberately is not.
 *
 * - TENANT DELETION CASCADES. `projected_activity.tenant_id` is declared
 *   `onDelete: Cascade`, so deleting a Tenant removes its projected rows in the
 *   same transaction. There is no state where activity outlives the tenant it
 *   describes, and no orphan row pointing at an id that no longer resolves.
 *
 * - COMPANY DELETION FOLLOWS THE TENANT. `ProjectedActivity.companyId` IS the
 *   tenant id in this schema; there is no separate company table to delete
 *   from, so company removal is tenant removal and is covered by the cascade.
 *
 * - RETENTION DURATION IS POLICY-NOT-YET-SET. There is no TTL, no scheduled
 *   prune and no archival window in this module, because none has been
 *   ratified. A default invented here would silently delete history somebody
 *   may be relying on, at a boundary where nobody would look for it. When a
 *   duration is decided it belongs in a migration and a decision record, not in
 *   a constant in this file.
 *
 * - GOVERNED / PRIVACY DELETION is by `tenant_id` plus `conversation_ref`. That
 *   pair is the narrowest thing a subject-erasure request can actually name,
 *   and the index supporting it exists for exactly this reason.
 *
 * - REPLAY AFTER A DELIBERATE DELETION RE-CREATES THE ROW. The upsert is keyed
 *   on identity, not on "have we ever seen this", so a re-delivered Lane-2
 *   event lands again. That is INTENTIONAL: this table is a projection of what
 *   Lane 2 reported, not a tombstone log. An erasure that must survive replay
 *   needs a suppression list, which does not exist yet and is not being faked
 *   here — pretending otherwise would promise a deletion guarantee the system
 *   cannot keep.
 */

/** Raised when one identity is asked to hold two different events. */
export class ProjectionConflict extends Error {
  readonly tenantId: string
  readonly eventId: string

  constructor(tenantId: string, eventId: string, detail: string) {
    // The message carries hashes and identifiers only. Echoing the differing
    // payload back would put customer content into a log line.
    super(
      `projected activity ${eventId} already exists for this tenant with different content (${detail})`,
    )
    this.name = 'ProjectionConflict'
    this.tenantId = tenantId
    this.eventId = eventId
  }
}

/**
 * How many rows one read may return. Mirrors `SOURCE_ROW_LIMIT` in
 * `lib/activity/registry.ts` and is duplicated rather than imported: the
 * registry imports this module, and a cycle between them would be worse than a
 * repeated number.
 */
export const PROJECTION_ROW_LIMIT = 500

/** The row as the database holds it. Snake case, because the columns are. */
export interface ProjectedActivityRow {
  id?: string
  tenant_id: string
  event_id: string
  dedupe_key: string
  event_type: string
  source_system: string
  actor_class: string
  occurred_at: Date | string
  received_at: Date | string
  channel_binding_id: string | null
  agent_ref: string | null
  conversation_ref: string | null
  correlation_id: string | null
  related_objects: unknown
  payload: unknown
  created_at?: Date | string
}

/**
 * The narrow slice of the Prisma model delegate this module uses. Narrow on
 * purpose: a test satisfies it with an in-memory fake, and nothing here can
 * reach a write method that is not in the type — there is no `delete`, no
 * `update` and no `deleteMany` on it, so this module cannot remove history.
 */
export interface ProjectionDelegate {
  findUnique(args: unknown): Promise<ProjectedActivityRow | null>
  create(args: unknown): Promise<ProjectedActivityRow>
  findMany(args: unknown): Promise<ProjectedActivityRow[]>
}

export interface ProjectionStoreDeps {
  /** Injected by tests and by any caller that owns its own client. */
  delegate?: ProjectionDelegate
}

/** Both halves of the contract, in one object. */
export interface PrismaProjectionStore extends Lane2ProjectionStore {
  project(activity: ProjectedActivity): Promise<void>
  read(query: ResolvedQuery): Promise<ProjectedActivity[]>
}

/* ── helpers ────────────────────────────────────────────────────────── */

function toDate(value: Date | string): Date {
  const d = value instanceof Date ? value : new Date(value)
  return Number.isNaN(d.getTime()) ? new Date(0) : d
}

const toIso = (value: Date | string): string => toDate(value).toISOString()

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function asStringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(asRecord(value))) {
    if (v === null || v === undefined || typeof v === 'object') continue
    out[k] = String(v)
  }
  return out
}

/**
 * Stable serialisation: keys sorted, so two objects that differ only in the
 * order their keys were written hash identically. Without this, a replay whose
 * JSON round-tripped through a different driver would look like a conflict.
 */
function canonical(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

interface ContentParts {
  eventType: string
  sourceSystem: string
  occurredAt: string
  dedupeKey: string
  payload: unknown
  relatedObjects: unknown
}

function contentHash(parts: ContentParts): string {
  return createHash('sha256').update(canonical(parts)).digest('hex')
}

/**
 * Lane 2's transport dedup key travels with the projection when ingestion
 * supplies it. When it does not, the event's own id is used: the column is NOT
 * NULL, and inventing a random value would defeat the unique constraint it
 * exists to serve.
 */
function dedupeKeyOf(activity: ProjectedActivity): string {
  return activity.dedupeKey?.trim() || activity.eventId
}

function hashOfActivity(activity: ProjectedActivity, dedupeKey: string): string {
  return contentHash({
    eventType: activity.type,
    sourceSystem: activity.source,
    occurredAt: toIso(activity.occurredAt),
    dedupeKey,
    payload: asRecord(activity.payload),
    relatedObjects: asStringMap(activity.relatedObjects),
  })
}

function hashOfRow(row: ProjectedActivityRow): string {
  return contentHash({
    eventType: row.event_type,
    sourceSystem: row.source_system,
    occurredAt: toIso(row.occurred_at),
    dedupeKey: row.dedupe_key,
    payload: asRecord(row.payload),
    relatedObjects: asStringMap(row.related_objects),
  })
}

/** Prisma reports a unique-constraint violation as P2002. */
function isUniqueViolation(err: unknown): boolean {
  return Boolean(err) && typeof err === 'object' && (err as { code?: unknown }).code === 'P2002'
}

function rowDataFor(activity: ProjectedActivity, dedupeKey: string) {
  return {
    tenant_id: activity.companyId,
    event_id: activity.eventId,
    dedupe_key: dedupeKey,
    event_type: activity.type,
    source_system: activity.source,
    actor_class: activity.actorClass,
    occurred_at: toDate(activity.occurredAt),
    received_at: toDate(activity.receivedAt),
    channel_binding_id: activity.channelBindingId ?? null,
    agent_ref: activity.agentRef ?? null,
    conversation_ref: activity.conversationRef ?? null,
    correlation_id: activity.correlationId ?? null,
    related_objects: asStringMap(activity.relatedObjects),
    payload: asRecord(activity.payload),
  }
}

/** Database row → the shape the rest of Foundation already speaks. */
export function toProjectedActivity(row: ProjectedActivityRow): ProjectedActivity {
  return {
    eventId: row.event_id,
    companyId: row.tenant_id,
    type: row.event_type as EventType,
    source: row.source_system,
    actorClass: row.actor_class as ActorClass,
    occurredAt: toDate(row.occurred_at),
    receivedAt: toDate(row.received_at),
    channelBindingId: row.channel_binding_id ?? null,
    agentRef: row.agent_ref ?? null,
    conversationRef: row.conversation_ref ?? null,
    relatedObjects: asStringMap(row.related_objects),
    correlationId: row.correlation_id ?? null,
    payload: asRecord(row.payload),
    dedupeKey: row.dedupe_key,
  }
}

const identityWhere = (tenantId: string, eventId: string) => ({
  tenant_id_event_id: { tenant_id: tenantId, event_id: eventId },
})

/**
 * Imported on FIRST USE, not at module load. A caller that injects its own
 * delegate must never cause a PrismaClient to be constructed — that is what
 * makes these paths testable without a database.
 */
async function realDelegate(): Promise<ProjectionDelegate> {
  const { prisma } = await import('@/lib/prisma')
  return (prisma as unknown as { projectedActivity: ProjectionDelegate }).projectedActivity
}

/* ── the store ──────────────────────────────────────────────────────── */

export function createPrismaProjectionStore(
  deps: ProjectionStoreDeps = {},
): PrismaProjectionStore {
  const delegate = async (): Promise<ProjectionDelegate> => deps.delegate ?? realDelegate()

  function assertSameContent(
    stored: ProjectedActivityRow,
    incomingHash: string,
    tenantId: string,
    eventId: string,
  ): void {
    const storedHash = hashOfRow(stored)
    if (storedHash === incomingHash) return
    throw new ProjectionConflict(
      tenantId,
      eventId,
      `stored ${storedHash.slice(0, 12)} vs incoming ${incomingHash.slice(0, 12)}`,
    )
  }

  return {
    async project(activity: ProjectedActivity): Promise<void> {
      const d = await delegate()
      const tenantId = activity.companyId
      const eventId = activity.eventId
      const dedupeKey = dedupeKeyOf(activity)
      const incomingHash = hashOfActivity(activity, dedupeKey)

      const existing = await d.findUnique({ where: identityWhere(tenantId, eventId) })
      if (existing) {
        // Identical replay: nothing to do, one row, success.
        assertSameContent(existing, incomingHash, tenantId, eventId)
        return
      }

      try {
        await d.create({ data: rowDataFor(activity, dedupeKey) })
      } catch (err) {
        if (!isUniqueViolation(err)) throw err

        // Two writers raced, or the dedupe key is already spoken for by a
        // different event. Re-read on identity to tell those apart.
        const raced = await d.findUnique({ where: identityWhere(tenantId, eventId) })
        if (!raced) {
          throw new ProjectionConflict(
            tenantId,
            eventId,
            'dedupe key is already held by a different event in this tenant',
          )
        }
        assertSameContent(raced, incomingHash, tenantId, eventId)
      }
    },

    async read(query: ResolvedQuery): Promise<ProjectedActivity[]> {
      // The feed filters on the SOURCE name (`lane2`), not on the row's own
      // `source_system` (`whatsapp`, `chatwoot`, ...). Pushing `sourceSystems`
      // down to the column would silently drop every row. What CAN be answered
      // here is the whole-source question: a filter that excludes this source
      // excludes every row it could return.
      if (query.sourceSystems?.length && !query.sourceSystems.includes(LANE2_SOURCE)) {
        return []
      }

      // `eventTypes` are feed families, not Lane-2 types, and the mapping
      // between them is private to the Lane-2 source. Filtering there rather
      // than guessing a reverse mapping here keeps one definition of a family.
      const occurredAt: { gte?: Date; lte?: Date } = {}
      const from = query.from ? new Date(query.from) : null
      const to = query.to ? new Date(query.to) : null
      if (from && !Number.isNaN(from.getTime())) occurredAt.gte = from
      if (to && !Number.isNaN(to.getTime())) occurredAt.lte = to

      const d = await delegate()

      // A throw from here is NOT caught. `buildSource` turns it into
      // `unavailable`; swallowing it into `[]` would report "nothing happened"
      // when the truth is "we could not find out".
      const rows = await d.findMany({
        where: {
          tenant_id: query.companyId,
          ...(occurredAt.gte || occurredAt.lte ? { occurred_at: occurredAt } : {}),
        },
        // The second key is not decoration: two events in the same millisecond
        // must come back in the same order every time or paging cannot promise
        // a stable boundary.
        orderBy: [{ occurred_at: 'desc' }, { event_id: 'asc' }],
        take: PROJECTION_ROW_LIMIT,
      })

      // An empty result is an EMPTY RESULT. It is available-and-empty, never
      // unavailable.
      return rows.map(toProjectedActivity)
    },
  }
}
