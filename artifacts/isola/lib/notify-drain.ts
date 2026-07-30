/**
 * NotificationOutbox drain worker — claims due rows, sends via the channel
 * adapter, and records the outcome. Mirrors pollTenantVoicemails()'s shape:
 * a plain exported async fn invoked once per call by the internal route,
 * not a long-running loop.
 *
 * Atomic claim: an updateMany keyed on (id, state=<the state it was
 * selected in>) — if count !== 1, another drain run already claimed this
 * row first, and this run skips it. Mirrors the ApprovalRequest redemption
 * pattern in lib/voice-routing-service.ts, preventing a double-send if two
 * drain invocations overlap.
 */

import { prisma } from './prisma';
import { audit } from './audit';
import { sendWhatsApp } from './notify-whatsapp';
import { isStaffNotification, resolveStaffChannel } from "@/lib/staff-ops/staff-channel";

const BATCH_SIZE = 25;

function backoffMs(attemptCount: number): number {
  return Math.min(60_000 * 2 ** (attemptCount - 1), 60 * 60_000); // 1m,2m,4m... capped at 1h
}

export interface DrainNotificationOutboxResult {
  claimed: number;
  sent: number;
  failed: number;
  deadLettered: number;
  errors: string[];
}

export async function drainNotificationOutbox(): Promise<DrainNotificationOutboxResult> {
  const result: DrainNotificationOutboxResult = {
    claimed: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
    errors: [],
  };

  const now = new Date();
  const due = await prisma.notificationOutbox.findMany({
    where: {
      state: { in: ['pending', 'failed'] },
      OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }],
    },
    orderBy: { created_at: 'asc' },
    take: BATCH_SIZE,
  });

  for (const row of due) {
    const claim = await prisma.notificationOutbox.updateMany({
      where: { id: row.id, state: row.state },
      data: { state: 'sending' },
    });
    if (claim.count !== 1) {
      continue; // lost the race to another drain run — it owns this row now
    }
    result.claimed++;

    try {
      if (row.channel !== 'whatsapp') {
        throw new Error(`unsupported channel: ${row.channel}`);
      }

      // When STAFF_NOTIFICATION_PHONE_NUMBER_ID is set and this row carries a
      // work reference (the marker Wave 1 sets on internal staff notifications),
      // pin the send to that specific number. For every other notification the
      // field is absent and pinnedPhoneNumberId stays undefined, preserving
      // today's earliest-created-number behaviour exactly.
      // An internal staff notification goes out on the EXPLICITLY configured
      // staff channel or it does not go out. The previous rule pinned the
      // configured number when one was set and otherwise fell through to
      // sendWhatsApps default - the tenant earliest-created number, which on
      // the EPIC tenant is the CUSTOMER 6737 line. That is not a graceful
      // degradation, it is messaging an employee from the customer-facing
      // number, and a single unset environment variable was all it took.
      // Now an unresolved staff channel fails this row with a truthful reason
      // an operator can act on.
      const staffChannel = isStaffNotification(row) ? resolveStaffChannel() : null;
      if (staffChannel && !staffChannel.ok) {
        throw new Error(staffChannel.reason);
      }
      const send = await sendWhatsApp({
        tenantId: row.tenant_id,
        contact: row.contact,
        template: row.template,
        payload: row.payload,
        pinnedPhoneNumberId: staffChannel?.ok ? staffChannel.phoneNumberId : undefined,
        forbidDefaultNumber: Boolean(staffChannel),
      });

      if (!send.ok) {
        throw new Error(send.error || `send failed (status ${send.status})`);
      }

      // Wave 1: a send that reports success with no provider message id is
      // UNRECONCILABLE FOREVER — there is no join key, so no wa-status callback
      // can ever reach this row and its true delivery state stays unknown for
      // good. That has to be a logged, queryable failure rather than a silent
      // pass. It does NOT fail the send (the message may well have gone), but
      // it is recorded on the audit trail, not merely shouted into stdout.
      if (!send.externalRef) {
        console.error(
          `[notify-drain][wamid_missing] outbox=${row.id} tenant=${row.tenant_id} template=${row.template} — send reported ok with no provider message id; this row can never be reconciled`,
        );
        await audit({
          tenantId: row.tenant_id,
          actorId: 'system:notify-drain',
          action: 'notification_outbox.wamid_missing',
          entity: 'NotificationOutbox',
          entityId: row.id,
          meta: { channel: row.channel, template: row.template, status: send.status },
        });
      }

      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          state: 'sent',
          sent_at: new Date(),
          external_ref: send.externalRef,
          // `accepted` — Meta returned 2xx and gave us a wamid. NOT delivered.
          // The provider's own callback is the only thing allowed to move this
          // further; see lib/staff-ops/delivery-status.ts for why the outbox's
          // `state` and the provider's `provider_status` are kept apart.
          provider_status: 'accepted',
        },
      });

      await audit({
        tenantId: row.tenant_id,
        actorId: 'system:notify-drain',
        action: 'notification_outbox.sent',
        entity: 'NotificationOutbox',
        entityId: row.id,
        meta: { channel: row.channel, externalRef: send.externalRef, providerStatus: 'accepted' },
      });

      result.sent++;
    } catch (err: any) {
      const attemptCount = row.attempt_count + 1;
      const deadLetter = attemptCount >= row.max_attempts;
      const failureReason = err?.message ?? 'unknown error';

      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: {
          state: deadLetter ? 'dead_letter' : 'failed',
          attempt_count: attemptCount,
          failure_reason: failureReason,
          next_attempt_at: deadLetter ? null : new Date(Date.now() + backoffMs(attemptCount)),
        },
      });

      await audit({
        tenantId: row.tenant_id,
        actorId: 'system:notify-drain',
        action: deadLetter ? 'notification_outbox.dead_letter' : 'notification_outbox.failed',
        entity: 'NotificationOutbox',
        entityId: row.id,
        meta: { channel: row.channel, attemptCount, failureReason },
      });

      if (deadLetter) {
        result.deadLettered++;
      } else {
        result.failed++;
      }
      result.errors.push(`${row.id}: ${failureReason}`);
    }
  }

  return result;
}
