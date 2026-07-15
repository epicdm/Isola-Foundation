/**
 * AI agent runtime — handles inbound WhatsApp messages.
 *
 * Flow: route tenant → consent gate → after-hours → owner takeover →
 *       build context → Anthropic → send reply → mirror Chatwoot → meter.
 *
 * Engine clients (magnus, fiserv, whatsapp, chatwoot, odoo) are imported
 * from /engines/ AS-IS — not rewritten, not reimplemented.
 */

import { prisma } from './prisma';
import { TIER_MODELS } from './ai';
import { generateReply } from './brain-provider';
import { getWhatsAppConfig, getChatwootConfig } from './engines';
import { meterTokens } from './meter';
import { EPIC_MAIN_PHONE_NUMBER_ID, EPIC_FB_LINKED_PHONE_NUMBER_ID } from './epic-seed-data';

// EPIC's business numbers (3742, 1568) are a 24/7 AI line — the after-hours
// window must never mute the AI reply for these. "Business hours" stays a
// concept for a future human-handoff signal only; it must not gate the AI.
// Do NOT add EMA (1023804347491554) here — its after-hours behavior is
// unchanged and intentional.
const ALWAYS_ON_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  EPIC_MAIN_PHONE_NUMBER_ID,     // 975632242309171 — 3742
  EPIC_FB_LINKED_PHONE_NUMBER_ID, // 294957850360835 — 1568
]);

// Engine clients — imported as-is, not modified
import { sendText } from '@/engines/whatsapp';
import {
  upsertContact,
  getContactConversations,
  createConversation,
  addMessage,
} from '@/engines/chatwoot';

// ── Public entry point ────────────────────────────────────────────────────────

export async function handleInboundWhatsApp(params: {
  phoneNumberId: string;
  from: string;       // as sent by Meta (digits only, no +)
  body: string;
  waMessageId: string;
}): Promise<void> {
  const { phoneNumberId, from, body, waMessageId } = params;

  // ── 1. Route: resolve tenant from phone_number_id ─────────────────────────
  const waNumber = await prisma.whatsAppNumber.findUnique({
    where: { phone_number_id: phoneNumberId },
    include: {
      tenant: {
        include: {
          agents: true,
          chatwoot_binding: true,
        },
      },
    },
  });

  if (!waNumber) {
    console.warn('[agent] No tenant registered for phone_number_id:', phoneNumberId);
    return;
  }
  const { tenant } = waNumber;
  // Normalise to E.164 for all internal use
  const customerPhone = from.startsWith('+') ? from : `+${from}`;

  // ── 2. Consent gate — FAIL CLOSED ─────────────────────────────────────────
  // First inbound message = implicit opt-in (WhatsApp Business policy).
  // Subsequent messages: never change status — only an explicit opt-out changes it.
  const consent = await prisma.consent.upsert({
    where: { tenant_id_phone: { tenant_id: tenant.id, phone: customerPhone } },
    create: {
      tenant_id: tenant.id,
      phone: customerPhone,
      status: 'opted_in',
      source: 'inbound',
    },
    update: {}, // do NOT override an existing opted_out status
  });

  if (consent.status !== 'opted_in') {
    console.log(`[agent] Consent blocked: ${customerPhone} opted-out for tenant ${tenant.id}`);
    return;
  }

  // ── 3. Get agent config ───────────────────────────────────────────────────
  const agent = tenant.agents[0];
  if (!agent?.is_active) {
    console.log('[agent] No active agent for tenant', tenant.id);
    return;
  }

  // ── 4. After-hours check ──────────────────────────────────────────────────
  // ALWAYS_ON numbers (EPIC 3742/1568) are a 24/7 AI line — never mute the
  // AI reply based on time of day. "Business hours" is reserved for a future
  // human-handoff signal only, not for gating whether the AI responds.
  if (
    !ALWAYS_ON_PHONE_NUMBER_IDS.has(phoneNumberId) &&
    isAfterHours(agent.after_hours_start, agent.after_hours_end, agent.timezone)
  ) {
    console.log('[agent] After-hours — mirroring to Chatwoot without AI reply');
    await mirrorInbound(tenant, waNumber, customerPhone, body, waMessageId, null);
    return;
  }

  // ── 5. Owner takeover — any owner in this tenant took over? ───────────────
  const ownerTookOver = await prisma.user.findFirst({
    where: { tenant_id: tenant.id, agent_took_over: true },
  });
  if (ownerTookOver) {
    console.log('[agent] Owner took over — mirroring only, no AI reply');
    await mirrorInbound(tenant, waNumber, customerPhone, body, waMessageId, null);
    return;
  }

  // ── 6. Get / create local conversation record ─────────────────────────────
  const conversation = await getOrCreateConversation({
    tenantId: tenant.id,
    whatsappNumberId: waNumber.id,
    customerPhone,
  });

  // ── 7. Persist incoming message — atomic dedup claim ─────────────────────
  // Message.wa_message_id has a UNIQUE index. The first request to insert wins;
  // a concurrent or retry delivery hits P2002 and we return 200 immediately,
  // before the AI is ever called. This is the race-safe dedup gate.
  try {
    await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        role: 'user',
        content: body,
        wa_message_id: waMessageId,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      console.log('[agent] Duplicate wamid', waMessageId, '— already processed, skipping');
      return;
    }
    throw err; // unexpected DB error — bubble up
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { last_message_at: new Date() },
  });

  // ── 8. Mirror inbound to Chatwoot ─────────────────────────────────────────
  // Returns the effective Chatwoot conversation id (existing or newly created).
  // Captured here so step 13 can use it even when the id was null on this turn
  // (i.e. first-ever message — mirrorInbound creates and persists the conv id).
  const effectiveCwConvId = await mirrorInbound(
    tenant,
    waNumber,
    customerPhone,
    body,
    waMessageId,
    conversation.chatwoot_conversation_id,
  );

  // ── 8b. Per-conversation human takeover ───────────────────────────────────
  // A human agent has claimed this conversation in Chatwoot — mirror only, no AI.
  if (conversation.human_handling) {
    console.log('[agent] Human handling active for conversation', conversation.id, '— no AI reply');
    return;
  }

  // ── 9. Build AI context (history + system prompt) ─────────────────────────
  const history = await prisma.message.findMany({
    where: { conversation_id: conversation.id },
    orderBy: { created_at: 'asc' },
    take: 20,
  });

  const aiMessages: { role: 'user' | 'assistant'; content: string }[] =
    history.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  // ── 10. Generate reply via the brain-provider socket ──────────────────────
  // Honors agent.brain_provider (native | flowise | hermes). generateReply()
  // never throws — any flowise/hermes failure falls back to native inside it.
  let reply = '';
  let tokensUsed = 0;
  let replyModel = TIER_MODELS[agent.intelligence_tier] ?? TIER_MODELS['standard'];

  try {
    const result = await generateReply({
      agent,
      system: buildSystemPrompt(agent),
      messages: aiMessages,
      sessionId: conversation.id,
      phoneNumberId: waNumber.phone_number_id,
      senderPhone: customerPhone,
    });
    reply = result.text;
    tokensUsed = result.tokensUsed;
    replyModel = result.model;
  } catch (err: any) {
    console.error('[agent] AI error:', err?.message ?? err);
    // Cannot generate a reply — do NOT send anything (honest escalation)
    return;
  }

  if (!reply) return;

  // ── 11. Persist AI reply ──────────────────────────────────────────────────
  await prisma.message.create({
    data: {
      conversation_id: conversation.id,
      role: 'assistant',
      content: reply,
      tokens_used: tokensUsed,
    },
  });

  // ── 12. Send WhatsApp reply — engine client used as-is ────────────────────
  // Resolve the outbound token: if token_env is set on the number row, use the
  // env var it names — but ONLY if the name matches the strict allowlist prefix
  // (META_* or WHATSAPP_*). This prevents an attacker-controlled token_env value
  // from reading unrelated process secrets (e.g. SESSION_SECRET, DATABASE_URL).
  const waConfig = getWhatsAppConfig();
  const TOKEN_ENV_ALLOWLIST = /^(META_|WHATSAPP_)/;
  let effectiveToken: string;
  if (waNumber.token_env) {
    if (!TOKEN_ENV_ALLOWLIST.test(waNumber.token_env)) {
      console.error(`[agent] token_env "${waNumber.token_env}" rejected — must start with META_ or WHATSAPP_`);
      return; // fail-closed: do not send with wrong credentials
    }
    const resolved = process.env[waNumber.token_env];
    if (!resolved) {
      console.error(`[agent] token_env "${waNumber.token_env}" is set but env var is empty or missing — aborting send`);
      return; // fail fast rather than send with no token
    }
    effectiveToken = resolved;
  } else {
    effectiveToken = waNumber.access_token;
  }
  const sendResult = await sendText(waConfig, {
    phoneId: waNumber.phone_number_id,
    token: effectiveToken,
    to: from, // Meta expects without leading +
    body: reply,
  });

  if (!sendResult.ok) {
    console.error('[agent] WhatsApp send failed:', sendResult.error);
  }

  // ── 13. Mirror AI reply in Chatwoot ───────────────────────────────────────
  // Use effectiveCwConvId (returned from step 8) so we mirror even on the first
  // turn of a conversation, when conversation.chatwoot_conversation_id was still
  // null in memory but mirrorInbound has since created and persisted the conv id.
  if (effectiveCwConvId !== null && tenant.chatwoot_binding) {
    const cwConfig = getChatwootConfig(tenant.chatwoot_binding);
    await addMessage(
      cwConfig,
      effectiveCwConvId,
      reply,
      'outgoing',
      { source_id: 'isola-bot' }, // loop-prevention: Chatwoot webhook will echo this back; skip it
    ).catch((e: Error) => console.warn('[agent] Chatwoot outgoing mirror failed:', e.message));
  }

  // ── 14. Meter tokens ──────────────────────────────────────────────────────
  await meterTokens(tenant.id, tokensUsed, replyModel);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSystemPrompt(agent: {
  name: string;
  greeting: string;
  business_info: string;
  knowledge_text: string;
}): string {
  const lines: string[] = [
    `You are ${agent.name}, an AI assistant for this business.`,
  ];
  if (agent.greeting?.trim()) {
    lines.push(`Greeting style: ${agent.greeting}`);
  }
  if (agent.business_info?.trim()) {
    lines.push(`About the business:\n${agent.business_info}`);
  }
  if (agent.knowledge_text?.trim()) {
    lines.push(`Knowledge base:\n${agent.knowledge_text}`);
  }
  lines.push(
    'Guidelines:',
    '- Keep replies concise and conversational (WhatsApp context).',
    '- If you cannot answer, say so honestly and offer to escalate.',
    '- Never claim to be human if sincerely asked.',
    '- Do not discuss competitors or make promises you cannot keep.',
  );
  return lines.join('\n\n');
}

function isAfterHours(
  start: string | null,
  end: string | null,
  timezone: string,
): boolean {
  if (!start || !end) return false;
  try {
    const nowStr = new Date().toLocaleTimeString('en-GB', {
      timeZone: timezone,
      hour12: false,
    });
    const [h, m] = nowStr.split(':').map(Number);
    const nowMins = h * 60 + m;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins = eh * 60 + em;
    if (startMins <= endMins) {
      return nowMins >= startMins && nowMins < endMins;
    }
    // Overnight range e.g. 22:00–08:00
    return nowMins >= startMins || nowMins < endMins;
  } catch {
    return false;
  }
}

async function getOrCreateConversation(params: {
  tenantId: string;
  whatsappNumberId: string;
  customerPhone: string;
}) {
  const existing = await prisma.conversation.findFirst({
    where: {
      tenant_id: params.tenantId,
      customer_phone: params.customerPhone,
      status: 'open',
    },
  });
  if (existing) return existing;

  return prisma.conversation.create({
    data: {
      tenant_id: params.tenantId,
      whatsapp_number_id: params.whatsappNumberId,
      customer_phone: params.customerPhone,
      status: 'open',
    },
  });
}

async function mirrorInbound(
  tenant: {
    id: string;
    chatwoot_binding: {
      base_url: string;
      account_id: string;
      token: string;
      inbox_id: string | null;
    } | null;
  },
  waNumber: { phone_number_id: string },
  customerPhone: string,
  body: string,
  _waMessageId: string,
  existingChatwootConvId: number | null,
): Promise<number | null> {
  if (!tenant.chatwoot_binding) return null;
  const cwConfig = getChatwootConfig(tenant.chatwoot_binding);

  // Tracked outside try/catch so it can be returned to the caller even if
  // addMessage fails — the conv id is still valid for the AI-reply mirror.
  let effectiveConvId: number | null = existingChatwootConvId;

  try {
    const chatwootContactId = await upsertContact(cwConfig, customerPhone);

    if (!effectiveConvId && tenant.chatwoot_binding.inbox_id) {
      const inboxId = parseInt(tenant.chatwoot_binding.inbox_id, 10);
      const existing = await getContactConversations(cwConfig, chatwootContactId);
      const open = existing.find((c) => c.inbox_id === inboxId && c.status === 'open');
      if (open) {
        effectiveConvId = open.id;
      } else {
        const created = await createConversation(cwConfig, chatwootContactId, inboxId);
        effectiveConvId = created.id;
      }

      // Persist the Chatwoot conversation id in our local record
      await prisma.conversation.updateMany({
        where: {
          tenant_id: tenant.id,
          customer_phone: customerPhone,
          status: 'open',
          chatwoot_conversation_id: null,
        },
        data: { chatwoot_conversation_id: effectiveConvId },
      });
    }

    if (effectiveConvId) {
      await addMessage(cwConfig, effectiveConvId, body, 'incoming');
    }
  } catch (e: any) {
    console.warn('[agent] Chatwoot inbound mirror failed:', e?.message);
  }

  return effectiveConvId;
}
