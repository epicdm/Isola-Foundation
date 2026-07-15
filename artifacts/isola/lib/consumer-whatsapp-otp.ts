/**
 * lib/consumer-whatsapp-otp.ts — sends the consumer signup OTP over
 * WhatsApp using the real Meta Graph API (engines/whatsapp.ts), never a
 * mocked/simulated send.
 *
 * ── Sender number (updated 2026-07-12) ─────────────────────────────────────
 * Sends FROM +1 767-818-0001 (phone_number_id 1023804347491554), on WABA
 * 272252189309178 — the number the business owner confirmed is already
 * live on our Meta account. This replaces the earlier "Meta Test Number"
 * (172262922640694) default. The number's WhatsApp Business Profile
 * about/description were updated via the Graph API to EMA branding; a
 * verified display-name change to "EMA" was also submitted
 * (new_name_status: PENDING_REVIEW as of 2026-07-12 — Meta name-change
 * review, not something the API can force-approve instantly).
 *
 * ── AUTHENTICATION template (added 2026-07-12) ──────────────────────────────
 * "ema_otp" (id 1030687663048670) was submitted on WABA 272252189309178 —
 * category AUTHENTICATION, language en_US, add_security_recommendation,
 * code_expiration_minutes 5, one OTP COPY_CODE button — and came back
 * APPROVED immediately. This unlocks reliable "cold" OTP delivery (a
 * brand-new consumer who has never messaged us) via `sendAuthTemplate`,
 * which was not previously possible on this project (no AUTHENTICATION
 * template existed until now).
 *
 * ── Delivery strategy (updated 2026-07-12) ───────────────────────────────
 * ALWAYS send via the approved "ema_otp" AUTHENTICATION template
 * (`sendAuthTemplate`) first, regardless of whether a 24h customer-service
 * window is open. This is deliberate: Meta renders AUTHENTICATION templates
 * as a distinct one-time-code UI with a "Copy code" button (and is the only
 * message type that can drive autofill), whereas a plain free-text send
 * (even inside an open window) renders as an ordinary chat bubble the user
 * has to read and manually copy. An open window used to make us prefer the
 * free-text path — that regressed the UX (owner reported the code arrived
 * as "a regular message, not an OTP") because the copy-code affordance was
 * lost. The open-window free-text path is now ONLY a last-resort fallback,
 * used solely if the template send itself fails.
 */

import { sendText, sendAuthTemplate } from '@/engines/whatsapp';
import { getWhatsAppConfig } from './engines';

const OTP_SENDER_PHONE_NUMBER_ID =
  process.env.EMA_OTP_WHATSAPP_PHONE_NUMBER_ID || '1023804347491554';

const OTP_TEMPLATE_NAME = 'ema_otp';
const OTP_TEMPLATE_LANGUAGE = 'en_US';

function getOtpSenderToken(): string {
  const token = process.env.WHATSAPP_TOKEN || process.env.META_SYSTEM_TOKEN;
  if (!token) {
    throw new Error(
      'No WhatsApp token configured (WHATSAPP_TOKEN / META_SYSTEM_TOKEN) for consumer OTP sending',
    );
  }
  return token;
}

/** Meta's `to` field wants digits only, no leading '+'. */
function toMetaFormat(e164: string): string {
  return e164.replace(/^\+/, '');
}

export interface ConsumerOtpSendResult {
  ok: boolean;
  mechanism: 'auth_template' | 'best_effort_text_fallback';
  status: number;
  messageId?: string;
  error?: string;
  /** true only when the AUTHENTICATION template send itself failed and we fell back to a plain-text send with no copy-code affordance. */
  templateDependencyFlagged: boolean;
}

export async function sendConsumerOtp(
  phoneNumberE164: string,
  code: string,
): Promise<ConsumerOtpSendResult> {
  const phoneId = OTP_SENDER_PHONE_NUMBER_ID;
  const token = getOtpSenderToken();
  const config = getWhatsAppConfig();
  const to = toMetaFormat(phoneNumberE164);

  // Always try the approved AUTHENTICATION template first — it's the only
  // message type that renders a "Copy code" button and can drive autofill.
  const templateResult = await sendAuthTemplate(config, {
    phoneId,
    token,
    to,
    name: OTP_TEMPLATE_NAME,
    language: OTP_TEMPLATE_LANGUAGE,
    code,
  });

  if (templateResult.ok) {
    return {
      ok: true,
      mechanism: 'auth_template',
      status: templateResult.status,
      messageId: templateResult.messageId,
      templateDependencyFlagged: false,
    };
  }

  // Template send failed — fall back to a best-effort free text so the API
  // call itself is never silently skipped, but flag the dependency issue.
  const body = `Your EMA verification code is ${code}. It expires in 5 minutes. Don't share this code with anyone.`;
  const fallback = await sendText(config, { phoneId, token, to, body });
  return {
    ok: fallback.ok,
    mechanism: 'best_effort_text_fallback',
    status: fallback.status,
    messageId: fallback.messageId,
    error: fallback.error || templateResult.error,
    templateDependencyFlagged: true,
  };
}
