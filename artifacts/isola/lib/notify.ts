/**
 * NotificationOutbox enqueue — durable, idempotent, consent-checked outbound
 * send queue. enqueueNotification() is the ONLY way to add work; the drain
 * worker (lib/notify-drain.ts) is the only thing that sends it.
 *
 * Consent gate is fail-closed: 'owner_self_notification' (the tenant owner
 * being notified about their own business, e.g. a missed-call alert) skips
 * the check. Every other consentBasis requires an opted_in Consent row for
 * (tenant_id, contact) — absent or opted_out means the notification is
 * dropped, not queued.
 *
 * Idempotent insert relies on NotificationOutbox's
 * @@unique([tenant_id, dedupe_key]) — a duplicate dedupeKey hits P2002 and
 * is reported as a no-op rather than double-enqueuing.
 */

import { prisma } from './prisma';
import { audit } from './audit';

export interface EnqueueNotificationParams {
  tenantId: string;
  contact: string;
  channel: string;
  consentBasis: string;
  template: string;
  payload?: Record<string, unknown>;
  dedupeKey: string;
}

export type EnqueueNotificationResult =
  | { enqueued: true; id: string }
  | { enqueued: false; reason: 'consent_denied' | 'duplicate' };

export async function enqueueNotification(
  params: EnqueueNotificationParams,
): Promise<EnqueueNotificationResult> {
  const { tenantId, contact, channel, consentBasis, template, payload, dedupeKey } = params;

  if (consentBasis !== 'owner_self_notification') {
    const consent = await prisma.consent.findUnique({
      where: { tenant_id_phone: { tenant_id: tenantId, phone: contact } },
    });
    if (!consent || consent.status !== 'opted_in') {
      console.info(
        `[notify] consent denied — tenant=${tenantId} contact=${contact} basis=${consentBasis}`,
      );
      return { enqueued: false, reason: 'consent_denied' };
    }
  }

  try {
    const row = await prisma.notificationOutbox.create({
      data: {
        tenant_id: tenantId,
        contact,
        channel,
        consent_basis: consentBasis,
        template,
        payload: (payload ? JSON.parse(JSON.stringify(payload)) : {}) as any,
        dedupe_key: dedupeKey,
        state: 'pending',
        next_attempt_at: new Date(),
      },
    });

    await audit({
      tenantId,
      actorId: 'system:notify',
      action: 'notification_outbox.enqueued',
      entity: 'NotificationOutbox',
      entityId: row.id,
      meta: { channel, template, consentBasis, dedupeKey },
    });

    return { enqueued: true, id: row.id };
  } catch (err: any) {
    if (err?.code === 'P2002') {
      console.info(
        `[notify] duplicate enqueue skipped — tenant=${tenantId} dedupeKey=${dedupeKey}`,
      );
      return { enqueued: false, reason: 'duplicate' };
    }
    throw err;
  }
}
