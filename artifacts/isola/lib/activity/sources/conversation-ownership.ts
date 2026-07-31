/**
 * ConversationOwnershipTransition → activity.
 *
 * THIS ADAPTER REPORTS. IT DOES NOT ACT.
 * It performs no takeover, no handback, no assignment, no AI resume and sends
 * no message. Those are Lane 2's, and a feed that could perform them would be a
 * second control surface for the thing that decides who is talking to a
 * customer. A test greps this file for exactly those calls.
 */

import type { ActivityItem, EventType, OwnershipState, ResolvedQuery } from '../feed'
import { actorKindOf, buildSource, deepLink, iso, summarise, type SourceDeps } from './shared'

export const OWNERSHIP_SOURCE = 'conversation_ownership'

export interface OwnershipTransitionRow {
  id: string
  tenant_id: string
  conversation_id: string
  episode: number
  from_state: string
  to_state: string
  reason: string
  operation_id: string
  operation_kind: string
  actor_ref: string | null
  correlation_id: string | null
  created_at: Date
}

/** The normalised lifecycle. Anything outside it is unknown, not assumed. */
export const LIFECYCLE_STATES = [
  'ai_owned',
  'handoff_requested',
  'human_owned',
  'handback_ready',
  'ai_resumed',
] as const
export type LifecycleState = (typeof LIFECYCLE_STATES)[number] | 'unknown'

const STATE_ALIASES: Readonly<Record<string, LifecycleState>> = {
  ai: 'ai_owned',
  ai_owned: 'ai_owned',
  handoff_requested: 'handoff_requested',
  escalated: 'handoff_requested',
  human: 'human_owned',
  human_owned: 'human_owned',
  handback_ready: 'handback_ready',
  ai_resumed: 'ai_resumed',
}

export function normaliseState(raw: string): LifecycleState {
  return STATE_ALIASES[raw?.toLowerCase?.() ?? ''] ?? 'unknown'
}

/**
 * An unrecognised state must not be shown as AI-owned. "We do not know who is
 * answering this customer" is a thing an operator needs to be told.
 */
function ownershipOf(state: LifecycleState): OwnershipState {
  if (state === 'human_owned' || state === 'handback_ready') return 'human'
  if (state === 'ai_owned' || state === 'ai_resumed') return 'ai'
  return 'unknown'
}

interface Shape {
  eventType: EventType
  title: string
}

function shapeOf(to: LifecycleState, operationKind: string): Shape {
  if (/reply|human_reply|dashboard_reply/i.test(operationKind)) {
    return { eventType: 'ownership.human_reply', title: 'A person replied' }
  }
  switch (to) {
    case 'human_owned':
      return { eventType: 'ownership.human_takeover', title: 'A person took over' }
    case 'handoff_requested':
      return { eventType: 'ownership.human_takeover', title: 'Handover requested' }
    case 'handback_ready':
      return { eventType: 'ownership.handback', title: 'Ready to hand back to the AI' }
    case 'ai_resumed':
    case 'ai_owned':
      return { eventType: 'ownership.handback', title: 'The AI is answering again' }
    default:
      return { eventType: 'ownership.handback', title: 'Ownership changed — state not recognised' }
  }
}

export interface OwnershipDeps extends SourceDeps<OwnershipTransitionRow> {
  /** Omitted when no base URL is configured. A fabricated link is worse than none. */
  chatwootBaseUrl?: string | null
}

export function projectOwnershipTransition(
  row: OwnershipTransitionRow,
  chatwootBaseUrl?: string | null,
): ActivityItem {
  const to = normaliseState(row.to_state)
  const from = normaliseState(row.from_state)
  const shape = shapeOf(to, row.operation_kind)
  const occurredAt = iso(row.created_at)
  const actorRef = row.actor_ref ?? 'system'

  return {
    activityId: `ownership:${row.id}`,
    eventType: shape.eventType,
    title: shape.title,
    // The reason is why response authority moved — the business impact an
    // operator is scanning for. No message content, ever.
    summary: summarise(`${from} → ${to}${row.reason ? ` — ${row.reason}` : ''}`),
    sourceSystem: OWNERSHIP_SOURCE,
    provenance: {
      source: OWNERSHIP_SOURCE,
      fetchedAt: occurredAt,
      trust: 'authoritative',
      upstreamRef: row.correlation_id,
    },
    actor: { ref: actorRef, label: actorRef, kind: actorKindOf(actorRef) },
    companyId: row.tenant_id,
    customerId: null,
    customerLabel: null,
    relatedObjectType: 'conversation',
    relatedObjectId: row.conversation_id,
    occurredAt,
    receivedAt: occurredAt,
    status: to,
    ownershipState: ownershipOf(to),
    availableActions: [],
    nativeLinks: deepLink(
      'chatwoot',
      'Open in Chatwoot',
      chatwootBaseUrl,
      `/app/conversations/${encodeURIComponent(row.conversation_id)}`,
    ),
    dataMode: 'production',
  }
}

export function createOwnershipSource(deps: OwnershipDeps) {
  return buildSource(OWNERSHIP_SOURCE, deps, (row: OwnershipTransitionRow, _q: ResolvedQuery) =>
    projectOwnershipTransition(row, deps.chatwootBaseUrl),
  )
}
