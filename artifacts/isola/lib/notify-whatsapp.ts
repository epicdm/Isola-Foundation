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
}

export interface SendWhatsAppResult {
  ok: boolean;
  status: number;
  externalRef?: string;
  error?: string;
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  const { tenantId, contact, template, payload } = input;

  // Resolve the tenant's own WhatsApp number to send FROM. Most tenants
  // have exactly one; if there are several, the earliest-created wins
  // (matches the "primary number" assumption used elsewhere in this app).
  const waNumber = await prisma.whatsAppNumber.findFirst({
    where: { tenant_id: tenantId },
    orderBy: { created_at: 'asc' },
    select: { phone_number_id: true, access_token: true, token_env: true },
  });
  if (!waNumber) {
    return { ok: false, status: 0, error: `no WhatsAppNumber configured for tenant ${tenantId}` };
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
