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
  /**
   * When true, there is NO default number. If `pinnedPhoneNumberId` is absent
   * the send is refused outright rather than falling back to the tenant
   * earliest-created number.
   *
   * Set for every internal staff notification. On the EPIC tenant the
   * earliest-created number is the CUSTOMER 6737 line, so the old fallback did
   * not degrade gracefully - it messaged an employee from the number customers
   * talk to, and it was one unset environment variable away from doing so.
   */
  forbidDefaultNumber?: boolean;
}

export interface SendWhatsAppResult {
  ok: boolean;
  status: number;
  externalRef?: string;
  error?: string;
}

/**
 * Choose the positional body parameters for this send.
 *
 * An explicit `templateParams` array wins. It was built against a SPECIFIC
 * template's approved body (see `buildStaffTaskTemplateParams`), so it is the
 * only thing that knows how many slots that template actually has. Collapsing
 * every template to a single `summaryLine` is what produced Meta error #132000
 * on `epic_internal_task_v1`, which requires five: the staff dispatch was
 * enqueued, drained, rejected and retried, and no staff member ever received a
 * task. A rejected send is not a delivery problem to escalate to the recipient
 * — it is a payload we built wrong.
 *
 * The `[summaryLine]` fallback is preserved verbatim for the single-parameter
 * voicemail-catch template, which carries no `templateParams` and must keep
 * behaving exactly as before.
 *
 * Exported so the selection rule is unit-testable without mocking Prisma or
 * the Graph API.
 */
export function selectTemplateParams(payload: unknown): string[] {
  const raw = (payload as { templateParams?: unknown } | null | undefined)?.templateParams;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((p) => typeof p === 'string' && p.trim().length > 0)
  ) {
    return raw as string[];
  }
  const summaryLine =
    typeof (payload as { summaryLine?: unknown } | null | undefined)?.summaryLine === 'string'
      ? ((payload as { summaryLine: string }).summaryLine)
      : '';
  return summaryLine ? [summaryLine] : [];
}

/**
 * Choose the QUICK_REPLY button payloads for this send.
 *
 * Same shape of rule as `selectTemplateParams`, and the same reason: only the
 * builder that knows WHICH approved template this row targets knows how many
 * buttons it has. Meta indexes button components positionally and rejects the
 * ENTIRE send if an index has no matching approved button, so an absent or
 * malformed array must mean "send no button components at all" — never a
 * partial or invented one.
 *
 * Returns undefined rather than [] so `sendTemplate` emits no button component
 * for every template that has no buttons, byte-for-byte as before.
 */
export function selectQuickReplyPayloads(payload: unknown): string[] | undefined {
  const raw = (payload as { quickReplyPayloads?: unknown } | null | undefined)
    ?.quickReplyPayloads;
  if (
    Array.isArray(raw) &&
    raw.length > 0 &&
    raw.every((p) => typeof p === 'string' && p.trim().length > 0)
  ) {
    return raw as string[];
  }
  return undefined;
}

export async function sendWhatsApp(input: SendWhatsAppInput): Promise<SendWhatsAppResult> {
  const { tenantId, contact, template, payload, pinnedPhoneNumberId } = input;

  if (input.forbidDefaultNumber && !pinnedPhoneNumberId) {
    return {
      ok: false,
      status: 0,
      error:
        "no explicit sending number for a notification that forbids the default - refusing to fall back to the tenant earliest-created number",
    };
  }

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

  const result = await sendTemplate(getWhatsAppConfig(), {
    phoneId: waNumber.phone_number_id,
    token,
    to: contact.replace(/^\+/, ''),
    name: template,
    language: TEMPLATE_LANGUAGE,
    params: selectTemplateParams(payload),
    quickReplyPayloads: selectQuickReplyPayloads(payload),
  });

  return { ok: result.ok, status: result.status, externalRef: result.messageId, error: result.error };
}
