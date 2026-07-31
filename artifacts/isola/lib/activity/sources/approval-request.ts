/**
 * ApprovalRequest → activity.
 *
 * `payload` is NEVER projected. It holds the exact approved parameters, which
 * for a voice route includes a forwarding number — a real phone number belonging
 * to a real person. The activity feed needs to say a decision happened and what
 * it was about; it does not need the parameters.
 *
 * `token` is a single-use redemption secret and is not read here at all.
 */

import type { ActivityItem, EventType, ResolvedQuery } from '../feed'
import { actorKindOf, buildSource, iso, summarise, type SourceDeps } from './shared'

export const APPROVAL_SOURCE = 'approval_request'

export interface ApprovalRequestRow {
  id: string
  tenant_id: string
  action: string
  target_entity: string | null
  target_id: string | null
  status: string
  requested_by: string
  decided_by: string | null
  decided_at: Date | null
  consumed_at: Date | null
  expires_at: Date
  created_at: Date
}

interface Shape {
  eventType: EventType
  title: string
  status: string
}

/**
 * There is no `approval.expired` event family, and inventing one would put a
 * value in the feed that no filter can name. An expiry is a request that ended
 * without approval, so it reports as rejected with its own explicit status.
 */
function shapeOf(row: ApprovalRequestRow, now: Date): Shape {
  switch (row.status) {
    case 'approved':
      return { eventType: 'approval.approved', title: 'Approved', status: 'approved' }
    case 'consumed':
      return {
        eventType: 'approval.approved',
        title: 'Approved and used',
        status: 'consumed',
      }
    case 'denied':
      return { eventType: 'approval.rejected', title: 'Rejected', status: 'denied' }
    case 'expired':
      return {
        eventType: 'approval.rejected',
        title: 'Expired without a decision',
        status: 'expired',
      }
    default:
      // Deny by default: a pending request whose deadline has passed is not
      // still waiting, whatever the column happens to say.
      if (row.expires_at.getTime() <= now.getTime()) {
        return {
          eventType: 'approval.rejected',
          title: 'Expired without a decision',
          status: 'expired',
        }
      }
      return { eventType: 'approval.requested', title: 'Waiting for approval', status: 'pending' }
  }
}

export function projectApprovalRequest(row: ApprovalRequestRow, now: Date): ActivityItem {
  const shape = shapeOf(row, now)
  const decided = row.decided_at ?? row.consumed_at
  // The event is the DECISION when one exists, otherwise the request.
  const occurredAt = iso(shape.status === 'pending' ? row.created_at : (decided ?? row.created_at))

  return {
    activityId: `approval:${row.id}`,
    eventType: shape.eventType,
    title: shape.title,
    summary: summarise(row.action),
    sourceSystem: APPROVAL_SOURCE,
    provenance: {
      source: APPROVAL_SOURCE,
      fetchedAt: occurredAt,
      trust: 'authoritative',
      upstreamRef: null,
    },
    actor: {
      ref: row.decided_by ?? row.requested_by,
      label: row.decided_by ?? row.requested_by,
      kind: actorKindOf(row.decided_by ?? row.requested_by),
    },
    companyId: row.tenant_id,
    customerId: null,
    customerLabel: null,
    relatedObjectType: row.target_entity,
    relatedObjectId: row.target_id,
    occurredAt,
    receivedAt: iso(row.created_at),
    status: shape.status,
    ownershipState: null,
    availableActions: [],
    nativeLinks: [],
    dataMode: 'production',
  }
}

export function createApprovalRequestSource(deps: SourceDeps<ApprovalRequestRow>) {
  return buildSource(APPROVAL_SOURCE, deps, (row: ApprovalRequestRow, _q: ResolvedQuery) =>
    projectApprovalRequest(row, deps.now()),
  )
}
