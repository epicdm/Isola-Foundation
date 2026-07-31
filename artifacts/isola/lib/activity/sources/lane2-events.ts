/**
 * Lane-2 events → activity.
 *
 * WHERE THE ROWS COME FROM
 * ------------------------
 * Only from `ProjectedActivity` — the shape `lib/events/ingest.ts` produces
 * AFTER a Lane-2 event has passed Foundation's own validation. This adapter
 * never reaches Chatwoot, Meta, Clawith or any provider. A test greps for it.
 *
 * A THING THAT IS TRUE TODAY AND SHOULD NOT BE HIDDEN
 * --------------------------------------------------
 * `IngestPorts.project` is a port with no implementation, and no table stores
 * `ProjectedActivity`. So there is no Lane-2 history to read yet. Rather than
 * pretend, `nullLane2Store` reports UNAVAILABLE with the reason written out. An
 * empty list would read on screen as "the customer said nothing today", which is
 * a different and much worse claim than "we are not storing this yet".
 *
 * When Lane 2 lands a store, implement `Lane2ProjectionStore` and pass it in.
 * Nothing else in this file changes.
 */

import type { EventType as Lane2EventType, ProjectedActivity } from '@/lib/events/ingest'

import type { ActivityItem, EventType, OwnershipState, ResolvedQuery } from '../feed'
import { actorKindOf, buildSource, deepLink, iso, summarise, type SourceDeps } from './shared'

export const LANE2_SOURCE = 'lane2'

/** The read side of what `IngestPorts.project` writes. */
export interface Lane2ProjectionStore {
  read(query: ResolvedQuery): Promise<ProjectedActivity[]>
}

/** Normalised health. `not_configured` is a real answer, not a missing one. */
export const HEALTH_STATES = [
  'healthy',
  'degraded',
  'unavailable',
  'stale',
  'unknown',
  'not_configured',
] as const
export type HealthState = (typeof HEALTH_STATES)[number]

/**
 * Anything unrecognised is UNKNOWN. Reading an unfamiliar status as healthy is
 * the failure mode that lets a dead channel look fine on a dashboard.
 */
export function normaliseHealth(raw: unknown): HealthState {
  const s = String(raw ?? '').toLowerCase()
  if (s === 'healthy' || s === 'ok' || s === 'up') return 'healthy'
  if (s === 'degraded' || s === 'partial') return 'degraded'
  if (s === 'failed' || s === 'unavailable' || s === 'down') return 'unavailable'
  if (s === 'stale') return 'stale'
  if (s === 'not_configured' || s === 'unconfigured') return 'not_configured'
  return 'unknown'
}

/**
 * Only the 15 types ingestion actually accepts. Anything absent from this map is
 * a type ingestion does not persist, and inventing a family for it would put a
 * value in the feed that no filter can name.
 */
const FAMILY: Readonly<Partial<Record<Lane2EventType, EventType>>> = {
  'message.inbound.customer': 'customer.message',
  'message.internal.user': 'ownership.human_reply',
  'agent.response': 'clawith.activity',
  'conversation.created': 'clawith.activity',
  'conversation.updated': 'clawith.activity',
  'ownership.ai': 'ownership.handback',
  'ownership.human_takeover': 'ownership.human_takeover',
  'ownership.human_reply': 'ownership.human_reply',
  'ownership.handback': 'ownership.handback',
  'channel.health': 'channel.health',
  'agent.health': 'agent.health',
  'delivery.failure': 'channel.health',
}

const TITLE: Readonly<Partial<Record<Lane2EventType, string>>> = {
  'message.inbound.customer': 'Customer got in touch',
  'message.internal.user': 'A person replied',
  'agent.response': 'The agent answered',
  'conversation.created': 'Conversation started',
  'conversation.updated': 'Conversation updated',
  'ownership.ai': 'The AI is answering',
  'ownership.human_takeover': 'A person took over',
  'ownership.human_reply': 'A person replied',
  'ownership.handback': 'Handed back to the AI',
  'channel.health': 'Channel health',
  'agent.health': 'Agent health',
  'delivery.failure': 'A message could not be delivered',
}

function ownershipFor(type: Lane2EventType): OwnershipState | null {
  if (type === 'ownership.human_takeover' || type === 'ownership.human_reply') return 'human'
  if (type === 'ownership.ai' || type === 'ownership.handback') return 'ai'
  if (type === 'message.internal.user') return 'human'
  return null
}

/**
 * What an operator may see about an event.
 *
 * Message BODIES do not appear here, nor does agent reasoning, nor a system
 * prompt, nor any unreviewed payload field. The feed's job is to say something
 * happened and let a permitted person open the real system to read it.
 */
function summaryFor(activity: ProjectedActivity): string {
  const p = activity.payload ?? {}
  switch (activity.type) {
    case 'channel.health':
    case 'agent.health':
      return summarise(
        `${normaliseHealth(p.status)}${typeof p.detail === 'string' ? ` — ${p.detail}` : ''}`,
      )
    case 'delivery.failure':
      return summarise(typeof p.reason === 'string' ? p.reason : 'delivery failed')
    case 'message.inbound.customer':
      return summarise(`Inbound message on ${activity.source}`)
    case 'agent.response':
      return summarise(`Agent replied on ${activity.source}`)
    default:
      return summarise(typeof p.reason === 'string' ? p.reason : activity.type)
  }
}

function statusFor(activity: ProjectedActivity): string {
  if (activity.type === 'channel.health' || activity.type === 'agent.health') {
    return normaliseHealth(activity.payload?.status)
  }
  return activity.type
}

export interface Lane2Deps extends Omit<SourceDeps<ProjectedActivity>, 'list'> {
  store: Lane2ProjectionStore
  chatwootBaseUrl?: string | null
  clawithBaseUrl?: string | null
}

export function projectLane2Activity(
  activity: ProjectedActivity,
  links: { chatwootBaseUrl?: string | null; clawithBaseUrl?: string | null } = {},
): ActivityItem | null {
  const eventType = FAMILY[activity.type]
  // Ingestion accepted it, but this feed has no family for it. Dropping is
  // honest; inventing a family is not.
  if (!eventType) return null

  const related = activity.relatedObjects ?? {}
  const relatedEntry = Object.entries(related)[0] ?? null

  const nativeLinks = [
    // Only from an authoritative reference the projection actually carries.
    ...(activity.conversationRef
      ? deepLink(
          'chatwoot',
          'Open in Chatwoot',
          links.chatwootBaseUrl,
          `/app/conversations/${encodeURIComponent(activity.conversationRef)}`,
        )
      : []),
    ...(activity.agentRef
      ? deepLink(
          'clawith',
          'Open in Clawith',
          links.clawithBaseUrl,
          `/agents/${encodeURIComponent(activity.agentRef)}`,
        )
      : []),
  ]

  return {
    activityId: `lane2:${activity.eventId}`,
    eventType,
    title: TITLE[activity.type] ?? 'Lane-2 event',
    summary: summaryFor(activity),
    sourceSystem: LANE2_SOURCE,
    provenance: {
      source: activity.source || LANE2_SOURCE,
      fetchedAt: iso(activity.receivedAt),
      // Lane 2 tells us what happened elsewhere. That is reported, not
      // authoritative, and a duplicate from a system of record should win.
      trust: 'reported',
      upstreamRef: activity.correlationId,
    },
    actor: {
      ref: activity.agentRef ?? activity.actorClass,
      label: activity.agentRef ?? activity.actorClass,
      kind: activity.actorClass === 'customer' ? 'customer' : actorKindOf(activity.agentRef ?? ''),
    },
    companyId: activity.companyId,
    customerId: related.customerId ?? null,
    customerLabel: null,
    relatedObjectType: relatedEntry ? relatedEntry[0] : activity.conversationRef ? 'conversation' : null,
    relatedObjectId: relatedEntry ? relatedEntry[1] : activity.conversationRef,
    // When it HAPPENED. Arrival is provenance only, so a late event lands in its
    // historical place instead of at the top of the page.
    occurredAt: iso(activity.occurredAt),
    receivedAt: iso(activity.receivedAt),
    status: statusFor(activity),
    ownershipState: ownershipFor(activity.type),
    availableActions: [],
    nativeLinks,
    dataMode: 'production',
  }
}

/**
 * The store that exists today: none. Reports why, rather than reporting silence.
 */
export const nullLane2Store: Lane2ProjectionStore = {
  async read() {
    throw new Error('no Lane-2 event store is configured')
  },
}

export function createLane2Source(deps: Lane2Deps) {
  return buildSource<ProjectedActivity>(
    LANE2_SOURCE,
    {
      now: deps.now,
      mode: deps.mode,
      staleReason: deps.staleReason,
      list: async (query) => {
        const rows = await deps.store.read(query)
        // Scoped HERE, not left for the feed to clean up afterwards, and
        // de-duplicated on the identity ingestion already assigned.
        const seen = new Set<string>()
        const scoped: ProjectedActivity[] = []
        for (const row of rows) {
          if (row.companyId !== query.companyId) continue
          if (!query.permittedCompanies.includes(row.companyId)) continue
          if (seen.has(row.eventId)) continue
          seen.add(row.eventId)
          scoped.push(row)
        }
        return scoped
      },
    },
    (row) =>
      projectLane2Activity(row, {
        chatwootBaseUrl: deps.chatwootBaseUrl,
        clawithBaseUrl: deps.clawithBaseUrl,
      }),
  )
}
