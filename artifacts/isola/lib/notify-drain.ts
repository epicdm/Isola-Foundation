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

      const send = await sendWhatsApp({
        tenantId: row.tenant_id,
        contact: row.contact,
        template: row.template,
        payload: row.payload,
      });

      if (!send.ok) {
        throw new Error(send.error || `send failed (status ${send.status})`);
      }

      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { state: 'sent', sent_at: new Date(), external_ref: send.externalRef },
      });

      await audit({
        tenantId: row.tenant_id,
        actorId: 'system:notify-drain',
        action: 'notification_outbox.sent',
        entity: 'NotificationOutbox',
        entityId: row.id,
        meta: { channel: row.channel, externalRef: send.externalRef },
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
