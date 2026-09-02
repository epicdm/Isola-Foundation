/**
 * lane2.events.ingest@1 — Foundation accepts what Lane 2 reports and projects it
 * into the activity feed.
 *
 * THIS IS A ONE-WAY DOOR, and it is the whole design.
 *
 * Foundation LEARNS from these events. It does not act on them. There is no
 * reply, no retry, no re-send, no ownership command anywhere in this module —
 * accepting an event returns a receipt, never an instruction. The moment this
 * endpoint can influence a conversation, Foundation is a communications runtime
 * again, and the boundary that took a lane reorientation to draw is gone.
 *
 * Deduplication here is for FOUNDATION'S READ MODEL ONLY. Lane 2 owns transport
 * dedup. If the same event arrives twice we project it once; we do not tell
 * Lane 2 anything about it.
 */

export const EVENT_INGEST_VERSION = 'lane2.events.ingest@1' as const

export const EVENT_TYPES = [
  'channel.health',
  'agent.health',
  'message.inbound.customer',
  'message.internal.user',
  'agent.response',
  'conversation.created',
  'conversation.updated',
  'ownership.ai',
  'ownership.human_takeover',
  'ownership.human_reply',
  'ownership.handback',
  'delivery.success',
  'delivery.failure',
  'provisioning.channel.result',
  'provisioning.agent.result',
] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const ACTOR_CLASSES = ['customer', 'staff', 'agent', 'system'] as const
export type ActorClass = (typeof ACTOR_CLASSES)[number]

export interface Lane2Event {
  eventId: string
  version: string
  sourceSystem: string
  eventType: string
  occurredAt: string
  receivedAt?: string
  companyId: string
  channelBindingId?: string | null
  agentRef?: string | null
  conversationRef?: string | null
  relatedObjects?: Record<string, string>
  actorClass?: string
  payload?: Record<string, unknown>
  correlationId?: string | null
  dedupeKey: string
}

export type IngestRejection =
  | 'unknown_version'
  | 'unknown_event_type'
  | 'unknown_actor_class'
  | 'missing_company'
  | 'missing_dedupe_key'
  | 'missing_event_id'
  | 'bad_timestamp'
  | 'unauthenticated_source'
  | 'payload_contains_credential'

export type IngestResult =
  | { accepted: true; eventId: string; projected: true }
  | { accepted: true; eventId: string; projected: false; reason: 'duplicate' }
  | { accepted: false; rejection: IngestRejection; detail: string }

/** Same credential shapes the channel binding refuses. Lane 2 sanitizes; we verify. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /^EAA[A-Za-z0-9]{20,}/,
  /^gh[pousr]_[A-Za-z0-9]{20,}/,
  /^sk-[A-Za-z0-9_-]{16,}/,
  /^Bearer\s+\S+/i,
  /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
]

function containsCredential(value: unknown, depth = 0): boolean {
  if (depth > 6) return false
  if (typeof value === 'string') return CREDENTIAL_SHAPES.some((r) => r.test(value.trim()))
  if (Array.isArray(value)) return value.some((v) => containsCredential(v, depth + 1))
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) =>
      containsCredential(v, depth + 1),
    )
  }
  return false
}

export interface ProjectedActivity {
  eventId: string
  companyId: string
  type: EventType
  source: string
  actorClass: ActorClass
  occurredAt: Date
  receivedAt: Date
  channelBindingId: string | null
  agentRef: string | null
  conversationRef: string | null
  relatedObjects: Record<string, string>
  correlationId: string | null
  payload: Record<string, unknown>
  /**
   * Lane 2's transport dedup key, carried through so the store can persist it
   * under `@@unique([tenant_id, dedupe_key])`. Optional because the read model
   * itself is keyed on `(tenant_id, event_id)` — a projection built by hand for
   * a fold or a test does not need one.
   */
  dedupeKey?: string
}

export interface IngestPorts {
  /** Verified BEFORE anything is read from the body. */
  sourceIsTrusted(sourceSystem: string): boolean
  seen(dedupeKey: string): Promise<boolean>
  project(activity: ProjectedActivity): Promise<void>
  now(): Date
}

export async function ingestLane2Event(
  event: Lane2Event,
  ports: IngestPorts,
): Promise<IngestResult> {
  // Authenticate the source first. Nothing in an untrusted body is worth parsing.
  if (!event?.sourceSystem || !ports.sourceIsTrusted(event.sourceSystem)) {
    return {
      accepted: false,
      rejection: 'unauthenticated_source',
      detail: `source ${event?.sourceSystem ?? '(none)'} is not trusted`,
    }
  }
  if (event.version !== EVENT_INGEST_VERSION) {
    return {
      accepted: false,
      rejection: 'unknown_version',
      detail: `expected ${EVENT_INGEST_VERSION}, got ${event.version}`,
    }
  }
  if (!event.eventId?.trim()) {
    return { accepted: false, rejection: 'missing_event_id', detail: 'eventId is required' }
  }
  if (!event.dedupeKey?.trim()) {
    return { accepted: false, rejection: 'missing_dedupe_key', detail: 'dedupeKey is required' }
  }
  if (!event.companyId?.trim()) {
    return { accepted: false, rejection: 'missing_company', detail: 'companyId is required' }
  }
  if (!(EVENT_TYPES as readonly string[]).includes(event.eventType)) {
    return {
      accepted: false,
      rejection: 'unknown_event_type',
      detail: `unknown event type ${event.eventType}`,
    }
  }
  const actorClass = event.actorClass ?? 'system'
  if (!(ACTOR_CLASSES as readonly string[]).includes(actorClass)) {
    return {
      accepted: false,
      rejection: 'unknown_actor_class',
      detail: `unknown actor class ${actorClass}`,
    }
  }
  const occurredAt = new Date(event.occurredAt)
  if (Number.isNaN(occurredAt.getTime())) {
    return { accepted: false, rejection: 'bad_timestamp', detail: `bad occurredAt ${event.occurredAt}` }
  }
  if (containsCredential(event.payload)) {
    // Refuse WHOLE rather than redacting: a partially-redacted secret is still a
    // secret, and the refusal must not echo the matched text.
    return {
      accepted: false,
      rejection: 'payload_contains_credential',
      detail: 'payload contains a credential-shaped value and was refused whole',
    }
  }

  if (await ports.seen(event.dedupeKey)) {
    return { accepted: true, eventId: event.eventId, projected: false, reason: 'duplicate' }
  }

  // AWAITED BEFORE THE RECEIPT, deliberately. A receipt that says `projected:
  // true` before the projection has landed is a receipt for something that may
  // never have happened; if this rejects, no accepted receipt is produced at all.
  await ports.project({
    eventId: event.eventId,
    companyId: event.companyId,
    type: event.eventType as EventType,
    source: event.sourceSystem,
    actorClass: actorClass as ActorClass,
    occurredAt,
    receivedAt: event.receivedAt ? new Date(event.receivedAt) : ports.now(),
    channelBindingId: event.channelBindingId ?? null,
    agentRef: event.agentRef ?? null,
    conversationRef: event.conversationRef ?? null,
    relatedObjects: event.relatedObjects ?? {},
    correlationId: event.correlationId ?? null,
    payload: event.payload ?? {},
    dedupeKey: event.dedupeKey,
  })

  return { accepted: true, eventId: event.eventId, projected: true }
}

/* ── Read model projections ────────────────────────────────────────────────── */

export type ConversationOwner = 'ai' | 'human' | 'unknown'

export interface OwnershipState {
  owner: ConversationOwner
  since: Date | null
  /** The event that last moved ownership. Null when nothing has. */
  lastEventId: string | null
}

const OWNERSHIP_BY_TYPE: Partial<Record<EventType, ConversationOwner>> = {
  'ownership.ai': 'ai',
  'ownership.human_takeover': 'human',
  'ownership.human_reply': 'human',
  'ownership.handback': 'ai',
}

/**
 * Fold ownership from the event stream. Events are sorted by occurrence, NOT by
 * arrival — Lane 2 may deliver out of order, and a late-arriving older takeover
 * must not overwrite a newer handback.
 */
export function projectOwnership(events: readonly ProjectedActivity[]): OwnershipState {
  const relevant = events
    .filter((e) => OWNERSHIP_BY_TYPE[e.type] !== undefined)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  const last = relevant[relevant.length - 1]
  if (!last) return { owner: 'unknown', since: null, lastEventId: null }
  return {
    owner: OWNERSHIP_BY_TYPE[last.type] ?? 'unknown',
    since: last.occurredAt,
    lastEventId: last.eventId,
  }
}

export interface ChannelHealthState {
  status: 'healthy' | 'degraded' | 'failed' | 'unknown'
  lastVerifiedAt: Date | null
  detail: string | null
}

export function projectChannelHealth(
  events: readonly ProjectedActivity[],
  channelBindingId: string,
): ChannelHealthState {
  const relevant = events
    .filter((e) => e.type === 'channel.health' && e.channelBindingId === channelBindingId)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime())

  const last = relevant[relevant.length - 1]
  if (!last) return { status: 'unknown', lastVerifiedAt: null, detail: null }

  const raw = String(last.payload.status ?? '')
  const status =
    raw === 'healthy' || raw === 'degraded' || raw === 'failed' ? raw : 'unknown'
  return {
    status,
    lastVerifiedAt: last.occurredAt,
    detail: typeof last.payload.detail === 'string' ? last.payload.detail : null,
  }
}

/** Feed items, newest first, scoped to one company. */
export function projectActivityFeed(
  events: readonly ProjectedActivity[],
  companyId: string,
  limit = 50,
): readonly ProjectedActivity[] {
  return events
    .filter((e) => e.companyId === companyId)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())
    .slice(0, limit)
}
