/**
 * WhatsApp channel adapter for NotificationOutbox — the single place that
 * turns an outbox row (or deliverCatch's legacy direct-send path in
 * lib/voicemail-poller.ts) into a Meta template send. Both callers resolve
 * the tenant's WhatsAppNumber the same way and share this one sendTemplate
 * call so there is exactly one place with the actual send logic.
 */

import { prisma } from './prisma';
import { sendTemplate } from '@/engines/whatsapp';
import { getWhatsAppConfig } from './engines';

const TEMPLATE_LANGUAGE = process.env.VOICEMAIL_CATCH_TEMPLATE_LANGUAGE || 'en_US';

export interface SendWhatsAppInput {
  tenantId: string;
  contact: string; // destination phone, leading '+' optional
  template: string;
  payload: unknown; // v1 contract: { summaryLine: string, ... }
  /** When set, send FROM this specific phone_number_id instead of the
   *  tenant's earliest-created number. The number must belong to tenantId —
   *  if it does not exist or belongs to another tenant the send fails hard
   *  with no fallback. Set by the drain for internal staff notifications when
   *  STAFF_NOTIFICATION_PHONE_NUMBER_ID is configured. */
  pinnedPhoneNumberId?: string;
}

export interface SendWhatsAppResult {
  ok: boolean;
  status: number;
  externalRef?: string;
  error?: string;
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  const { tenantId, contact, template, payload, pinnedPhoneNumberId } = input;

  // Resolve the tenant's own WhatsApp number to send FROM.
  //
  // When pinnedPhoneNumberId is set (internal staff notifications), look up
  // that exact number scoped to this tenant. If it does not exist or belongs
  // to a different tenant, fail with a clear error — no silent fallback.
  //
  // When it is unset, keep the original behaviour: earliest-created number
  // wins (matches the "primary number" assumption used elsewhere in this app).
  let waNumber: { phone_number_id: string; access_token: string | null; token_env: string | null } | null;

  if (pinnedPhoneNumberId) {
    waNumber = await prisma.whatsAppNumber.findFirst({
      where: { phone_number_id: pinnedPhoneNumberId, tenant_id: tenantId },
      select: { phone_number_id: true, access_token: true, token_env: true },
    });
    if (!waNumber) {
      return {
        ok: false,
        status: 0,
        error: `STAFF_NOTIFICATION_PHONE_NUMBER_ID=${pinnedPhoneNumberId} does not exist or does not belong to tenant ${tenantId} — refusing to fall back to tenant default number`,
      };
    }
  } else {
    waNumber = await prisma.whatsAppNumber.findFirst({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
      select: { phone_number_id: true, access_token: true, token_env: true },
    });
    if (!waNumber) {
      return { ok: false, status: 0, error: `no WhatsAppNumber configured for tenant ${tenantId}` };
    }
  }
  const token = waNumber.token_env ? process.env[waNumber.token_env] : waNumber.access_token;
  if (!token) {
    return { ok: false, status: 0, error: `WhatsAppNumber for tenant ${tenantId} has no resolvable token` };
  }

  const summaryLine = typeof (payload as any)?.summaryLine === 'string' ? (payload as any).summaryLine : '';

  const result = await sendTemplate(getWhatsAppConfig(), {
    phoneId: waNumber.phone_number_id,
    token,
    to: contact.replace(/^\+/, ''),
    name: template,
    language: TEMPLATE_LANGUAGE,
    params: summaryLine ? [summaryLine] : [],
  });

  return { ok: result.ok, status: result.status, externalRef: result.messageId, error: result.error };
}
