/**
 * status-ingest-ports.ts — the Prisma-backed implementation of StatusIngestPorts.
 *
 * Kept separate from `status-ingest.ts` so the wiring stays testable with no
 * database. This file is the only place in the staff-ops lane that touches
 * `NotificationOutbox` rows for delivery status.
 */

import { prisma } from '../prisma'
import { audit } from '../audit'
import type { ProviderStatus, DispatchRowSnapshot } from './delivery-status'
import type { StatusIngestPorts } from './status-ingest'

export function createStatusIngestPorts(): StatusIngestPorts {
  return {
    async findByProviderMessageId(wamid: string): Promise<DispatchRowSnapshot | null> {
      const row = await prisma.notificationOutbox.findFirst({
        where: { external_ref: wamid },
        select: {
          id: true,
          tenant_id: true,
          provider_status: true,
          correlation_id: true,
        },
      })
      if (!row) return null

      // "Has the staff member already acted on this episode?" — answered from
      // the action ledger, never from the notification row itself. A late
      // `failed` is still recorded, but a reader must be able to see that the
      // person demonstrably received it.
      const actionCount = row.correlation_id
        ? await prisma.staffWorkAction.count({
            where: { correlation_id: row.correlation_id, applied_at: { not: null } },
          })
        : 0

      return {
        id: row.id,
        tenantId: row.tenant_id,
        providerStatus: (row.provider_status as ProviderStatus | null) ?? null,
        staffActionRecorded: actionCount > 0,
        correlationId: row.correlation_id,
      }
    },

    async applyDecision(decision, event) {
      await prisma.notificationOutbox.update({
        where: { id: decision.rowId },
        data: {
          provider_status: decision.nextStatus,
          ...(decision.setDeliveredAt ? { delivered_at: new Date() } : {}),
          ...(decision.setFailedAt ? { failed_at: new Date() } : {}),
          provider_error_code: decision.errorCode,
          provider_error_detail: decision.errorDetail,
        },
      })

      const tenantRow = await prisma.notificationOutbox.findUnique({
        where: { id: decision.rowId },
        select: { tenant_id: true },
      })
      if (!tenantRow) return

      await audit({
        tenantId: tenantRow.tenant_id,
        actorId: 'system:wa-status',
        action: `notification_outbox.provider_${decision.nextStatus}`,
        entity: 'NotificationOutbox',
        entityId: decision.rowId,
        meta: {
          providerMessageId: event.providerMessageId,
          errorCode: decision.errorCode,
          errorDetail: decision.errorDetail,
          lateFailureAfterAction: decision.lateFailureAfterAction,
        },
      })

      if (decision.lateFailureAfterAction) {
        console.error(
          `[staff-ops][wa-status] LATE FAILURE after a recorded staff action — outbox=${decision.rowId} wamid=${event.providerMessageId} code=${decision.errorCode ?? 'none'}. The failure is recorded; do NOT read it as "the staff member never received this".`,
        )
      }
    },

    onUnmatched(event) {
      // Error level, deliberately. A terminal callback with no matching
      // dispatch is either a send we failed to record or a send from another
      // system on the same WABA. Both need a human; neither may be silent.
      console.error(
        `[staff-ops][wa-status][unmatched] no notification matched wamid=${event.providerMessageId} status=${event.status} code=${event.errorCode ?? 'none'} recipient=${event.recipientId ?? 'unknown'} — nothing written`,
      )
    },
  }
}
