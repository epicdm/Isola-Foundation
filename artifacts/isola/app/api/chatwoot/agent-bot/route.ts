/**
 * POST /api/chatwoot/agent-bot
 *
 * A2 architecture: Chatwoot OWNS the WhatsApp channel. This app is the AI
 * brain plugged in as Chatwoot agent-bot id 4 "Isola Brain (A2)".
 *
 * Flow: Chatwoot sends all inbox events here → we generate AI replies →
 * POST them back to Chatwoot via the bot token → Chatwoot delivers to WA.
 * We NEVER call the Meta send API for A2 tenants.
 *
 * Auth:  ?secret=<CHATWOOT_BOT_SECRET>  constant-time comparison.
 *
 * ── Reply gate (human_handling flag in OUR database) ──────────────────────
 *
 * The gate is the Conversation.human_handling boolean — NOT Chatwoot
 * conversation status. Chatwoot status is polluted by timeout error-flips
 * ("open by system due to agent error") and must not drive AI silence.
 *
 * Handled events
 * ──────────────
 * message_created (message_type="incoming", !private)
 *   • Dedup by Chatwoot message id (Message.chatwoot_message_id UNIQUE).
 *   • Gate: reply only when Conversation.human_handling === false.
 *   • Governance: consent, active agent, after-hours (→ away message),
 *     owner takeover, AI reply, token metering.
 *   • Cosmetic: if Chatwoot shows "open" while bot is replying, toggle to
 *     "pending" so the UI stays truthful. Human_handling gate is unaffected.
 *
 * message_created (message_type="outgoing", sender is a human user not bot)
 *   • Sets Conversation.human_handling = true (AI silenced for this conv).
 *   • If Chatwoot shows "pending", toggles to "open" (cosmetic UI fix).
 *
 * conversation_status_changed / conversation_resolved
 *   • Sets human_handling = false so AI resumes on the next incoming message.
 *
 * All other events: 200 no-op.
 *
 * Account isolation: looks up ChatwootBinding WHERE mode='a2'; unknown
 * account_ids return 200 immediately so Wave-A tenants are untouched.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateReply } from '@/lib/brain-provider';
import { meterTokens } from '@/lib/meter';

// ── Constants ─────────────────────────────────────────────────────────────────

const CHATWOOT_BASE = 'https://inbox.epic.dm'; // overridden by binding.base_url when available

// ── Auth ──────────────────────────────────────────────────────────────────────

function authenticate(req: NextRequest): boolean {
  const expected = process.env.CHATWOOT_BOT_SECRET;
  if (!expected) {
    console.error('[agent-bot] CHATWOOT_BOT_SECRET not set — rejecting all requests');
    return false;
  }
  const provided = new URL(req.url).searchParams.get('secret') ?? '';
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  if (!authenticate(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let body: Record<string, any>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const event = String(body?.event ?? '');
  console.log('[agent-bot] event:', event, 'keys:', Object.keys(body).join(', '));

  try {
    if (event === 'message_created') {
      const status = await handleMessageCreated(body);
      return NextResponse.json({ ok: status < 400 }, { status });
    }
    if (event === 'conversation_status_changed' || event === 'conversation_resolved') {
      await handleStatusChanged(body, event);
    }
    // All other events: ack 200 and ignore
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error('[agent-bot] unexpected error:', err?.message ?? err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

// ── message_created handler ───────────────────────────────────────────────────

async function handleMessageCreated(body: Record<string, any>): Promise<number> {
  // Filter: handle incoming (customer → bot) and outgoing (human agent reply);
  // drop activity, template, and all other message types.
  const messageType = body.message_type;
  const isIncoming = messageType === 'incoming' || messageType === 0;
  const isOutgoing = messageType === 'outgoing' || messageType === 1;
  if (!isIncoming && !isOutgoing) return 200;
  if (body.private === true) return 200;

  const content: string = (body.content ?? '').trim();
  // Outgoing handoff does not require content; incoming must have it.
  if (!content && isIncoming) return 200;

  // Chatwoot message id — dedup key (incoming only)
  const cwMsgId: number | null = typeof body.id === 'number' ? body.id : null;
  if (cwMsgId === null && isIncoming) {
    console.warn('[agent-bot] message_created missing numeric id — ignoring');
    return 200;
  }

  // Conversation fields
  const conv = body.conversation ?? {};
  const cwConvId: number | null = typeof conv.id === 'number' ? conv.id : null;
  if (cwConvId === null) {
    console.warn('[agent-bot] message_created missing conversation.id — ignoring');
    return 200;
  }

  // Account id — primary: conversation.account_id; fallback: account.id
  const rawAccountId = conv.account_id ?? body.account?.id;
  const accountId = rawAccountId != null ? String(rawAccountId) : '';
  if (!accountId) {
    console.warn('[agent-bot] message_created missing account_id — ignoring');
    return 200;
  }

  // Chatwoot conversation status — used only for cosmetic UI toggles, never for the AI gate.
  const convStatus: string = conv.status ?? '';

  // Sender phone — primary: body.sender; fallback: conv.meta.sender
  const rawPhone: string =
    body.sender?.phone_number ??
    conv.meta?.sender?.phone_number ??
    '';
  const digits = rawPhone.replace(/[^\d]/g, '');
  const customerPhone: string = digits ? '+' + digits : '';
  // Phone is required for incoming (conversation upsert, consent, metering).
  // Outgoing handoff does not need it.
  if (!customerPhone && isIncoming) {
    console.warn('[agent-bot] message_created: no sender phone — ignoring');
    return 200;
  }

  // ── Resolve A2 tenant via ChatwootBinding ─────────────────────────────────
  const binding = await prisma.chatwootBinding.findFirst({
    where: { account_id: accountId, mode: 'a2' },
    include: {
      tenant: {
        include: { agents: true, users: { where: { agent_took_over: true } } },
      },
    },
  });
  if (!binding) {
    // Not an A2 account we manage — ack and ignore (isolation guarantee)
    console.log('[agent-bot] No A2 binding for account', accountId, '— no-op');
    return 200;
  }

  const botToken = process.env.CHATWOOT_AGENTBOT_TOKEN;
  const baseUrl  = binding.base_url || CHATWOOT_BASE;

  // ── Outgoing path: human agent replied → set human_handling=true ──────────
  // The bot's own outgoing replies have sender.type === 'agent_bot'; exclude them.
  if (isOutgoing) {
    const senderType: string = body.sender?.type ?? '';
    if (senderType !== 'agent_bot') {
      // Find local conversation and flip the human_handling flag
      const updated = await prisma.conversation.updateMany({
        where: { tenant_id: binding.tenant.id, chatwoot_conversation_id: cwConvId },
        data:  { human_handling: true },
      });
      if (updated.count > 0) {
        console.log(`[agent-bot] Human reply in conv cw#${cwConvId} — human_handling=true`);
      } else {
        console.log(`[agent-bot] Outgoing for unknown local conv cw#${cwConvId} — no local record yet`);
      }
      // Cosmetic: keep Chatwoot UI truthful — if still "pending", move to "open"
      if (convStatus === 'pending' && botToken) {
        await toggleConvStatus(baseUrl, accountId, cwConvId, 'open', botToken);
      }
    }
    return 200;
  }

  // ── From here on: incoming path only ─────────────────────────────────────
  // cwMsgId is guaranteed non-null for incoming (guarded above).
  const incomingMsgId = cwMsgId as number;

  const { tenant } = binding;
  const tenantId = tenant.id;

  // ── Upsert local conversation (human_handling defaults to false) ──────────
  let conversation = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, chatwoot_conversation_id: cwConvId },
  });
  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        tenant_id:               tenantId,
        chatwoot_conversation_id: cwConvId,
        customer_phone:          customerPhone,
        status:                  'open',
        human_handling:          false,
      },
    });
  }

  // ── Atomic dedup claim (before any processing) ────────────────────────────
  // Message.chatwoot_message_id has a UNIQUE index. First request wins;
  // concurrent/retry deliveries hit P2002 and return 200 immediately.
  try {
    await prisma.message.create({
      data: {
        conversation_id:     conversation.id,
        role:                'user',
        content,
        chatwoot_message_id: incomingMsgId,
      },
    });
  } catch (err: any) {
    if (err?.code === 'P2002') {
      console.log('[agent-bot] Duplicate cwMsgId', incomingMsgId, '— already processed');
      return 200;
    }
    throw err;
  }
  await prisma.conversation.update({
    where: { id: conversation.id },
    data:  { last_message_at: new Date(), customer_phone: customerPhone },
  });

  // ── Human-handling gate (replaces status-based gating) ───────────────────
  // Do NOT consult Chatwoot conversation status here — it is unreliable due to
  // "open by system due to agent error" flips caused by webhook timeouts.
  if (conversation.human_handling) {
    console.log(`[agent-bot] Conv cw#${cwConvId} human_handling=true — bot silent`);
    return 200;
  }

  // ── Consent gate — fail-closed ────────────────────────────────────────────
  const consent = await prisma.consent.upsert({
    where:  { tenant_id_phone: { tenant_id: tenantId, phone: customerPhone } },
    create: { tenant_id: tenantId, phone: customerPhone, status: 'opted_in', source: 'inbound' },
    update: {},
  });
  if (consent.status !== 'opted_in') {
    console.log('[agent-bot] Consent blocked:', customerPhone);
    return 200;
  }

  // ── Agent config ──────────────────────────────────────────────────────────
  const agent = tenant.agents[0];
  if (!agent?.is_active) {
    console.log('[agent-bot] No active agent for tenant', tenantId);
    return 200;
  }

  // ── Owner takeover ────────────────────────────────────────────────────────
  if (tenant.users.length > 0) {
    console.log('[agent-bot] Owner took over — no AI reply for tenant', tenantId);
    return 200;
  }

  // ── After-hours check — send away message instead of silent return ────────
  if (isAfterHours(agent.after_hours_start, agent.after_hours_end, agent.timezone)) {
    const awayMsg: string = (agent as any).away_message?.trim() ?? '';
    if (awayMsg && botToken) {
      // Post away message to Chatwoot (still dedup-protected via incomingMsgId)
      const awayRes = await fetch(
        `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/messages`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', api_access_token: botToken },
          body:    JSON.stringify({ content: awayMsg, message_type: 'outgoing', private: false }),
          signal:  AbortSignal.timeout(15000),
        },
      );
      if (awayRes.ok) {
        console.log(`[agent-bot] After-hours away message sent for tenant ${tenantId}`);
        await prisma.message.create({
          data: { conversation_id: conversation.id, role: 'assistant', content: awayMsg },
        });
      } else {
        const errText = await awayRes.text().catch(() => '');
        console.error(`[agent-bot] Away message POST failed (${awayRes.status}): ${errText}`);
      }
    } else {
      console.log('[agent-bot] After-hours — silent (no away message configured) for tenant', tenantId);
    }
    return 200;
  }

  // ── Cosmetic: Chatwoot shows "open" (error-flip artefact) → restore pending ─
  // Only when we have confirmed human_handling=false and are about to reply.
  // This keeps the Chatwoot UI truthful without gating AI on Chatwoot status.
  if (convStatus === 'open' && botToken) {
    await toggleConvStatus(baseUrl, accountId, cwConvId, 'pending', botToken);
  }

  // ── Typing indicator: on while composing, off no matter how we exit ──────
  // Best-effort only — see toggleTypingStatus() for exactly what this does
  // and does not do (Chatwoot dashboard presence today; NOT yet visible on
  // the customer's WhatsApp app — that propagation is an unmerged upstream
  // Chatwoot feature, see the function doc). Never allowed to block or break
  // the reply itself.
  if (botToken) {
    await toggleTypingStatus(baseUrl, accountId, cwConvId, 'on', botToken);
  }

  try {
    // ── Build conversation history ──────────────────────────────────────────
    const history = await prisma.message.findMany({
      where:   { conversation_id: conversation.id },
      orderBy: { created_at: 'asc' },
      take:    20,
    });
    const aiMessages: { role: 'user' | 'assistant'; content: string }[] =
      history.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    // ── AI call — native Claude by default, or tenant's Flowise flow ────────
    // generateReply() never throws: any Flowise failure falls back to native.
    let reply = '';
    let tokensUsed = 0;
    let model = '';

    // phone_number_id is only used for the hermes per-number gate in
    // generateReply(); A2/Chatwoot-mediated tenants are never on the hermes
    // allowlist, so an empty fallback here is safe (falls straight to native).
    const waNumberForHermesGate = await prisma.whatsAppNumber.findFirst({
      where: { tenant_id: tenantId },
      select: { phone_number_id: true },
    });

    try {
      const result = await generateReply({
        agent: {
          intelligence_tier: agent.intelligence_tier,
          brain_provider:    (agent as any).brain_provider ?? 'native',
          flowise_flow_id:   (agent as any).flowise_flow_id ?? null,
        },
        system:    buildSystemPrompt(agent),
        messages:  aiMessages,
        sessionId: conversation.id, // stable per-conversation key for Flowise memory
        phoneNumberId: waNumberForHermesGate?.phone_number_id ?? '',
        senderPhone: customerPhone,
      });
      reply      = result.text;
      tokensUsed = result.tokensUsed;
      model      = result.model;
    } catch (err: any) {
      console.error('[agent-bot] AI error:', err?.message ?? err);
      return 200; // do not reply with an error message
    }

    if (!reply) return 200;

    // ── Persist AI reply ────────────────────────────────────────────────────
    await prisma.message.create({
      data: {
        conversation_id: conversation.id,
        role:            'assistant',
        content:         reply,
        tokens_used:     tokensUsed,
      },
    });

    // ── Post reply to Chatwoot (Chatwoot delivers to WhatsApp) ─────────────
    if (!botToken) {
      console.error('[agent-bot] CHATWOOT_AGENTBOT_TOKEN not set — cannot post reply');
      return 200;
    }
    const replyRes = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/messages`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({ content: reply, message_type: 'outgoing', private: false }),
        signal:  AbortSignal.timeout(15000),
      },
    );
    if (!replyRes.ok) {
      const errText = await replyRes.text().catch(() => '');
      console.error(`[agent-bot] Chatwoot reply POST failed (${replyRes.status}): ${errText}`);
      // Don't return error — the dedup row is already claimed; avoid retrigger
    } else {
      console.log(`[agent-bot] Reply posted to conv cw#${cwConvId} for account ${accountId}`);
    }

    // ── Meter tokens ─────────────────────────────────────────────────────────
    await meterTokens(tenantId, tokensUsed, model);

    return 200;
  } finally {
    // Always clear typing, even on early return / thrown error — an agent
    // stuck "typing…" forever in the Chatwoot dashboard is worse than none.
    if (botToken) {
      await toggleTypingStatus(baseUrl, accountId, cwConvId, 'off', botToken);
    }
  }
}

// ── conversation_status_changed / conversation_resolved handler ───────────────
// Resolved → clear human_handling so AI resumes on the next incoming message.

async function handleStatusChanged(body: Record<string, any>, event: string) {
  const isResolved = event === 'conversation_resolved' || body.status === 'resolved';
  if (!isResolved) return;

  // Chatwoot sends the conversation object as the root body for this event.
  const cwConvId: number | null =
    typeof body.id === 'number'               ? body.id :
    typeof body.conversation?.id === 'number' ? body.conversation.id : null;
  if (cwConvId === null) return;

  const rawPhone: string = body.meta?.sender?.phone_number ?? '';
  const digits = rawPhone.replace(/[^\d]/g, '');
  const customerPhone: string | null = digits ? '+' + digits : null;

  if (!customerPhone) {
    console.warn('[agent-bot] status_changed: no sender phone for cw#', cwConvId, '— skipping');
    return;
  }

  const updated = await prisma.conversation.updateMany({
    where: { chatwoot_conversation_id: cwConvId, customer_phone: customerPhone },
    data:  { human_handling: false, status: 'resolved' },
  });
  if (updated.count > 0) {
    console.log(`[agent-bot] Conv cw#${cwConvId} resolved — human_handling cleared, AI resumes`);
  }
}

// ── Chatwoot helpers ──────────────────────────────────────────────────────────

async function toggleConvStatus(
  baseUrl:   string,
  accountId: string,
  cwConvId:  number,
  status:    string,
  botToken:  string,
) {
  try {
    const res = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/toggle_status`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({ status }),
        signal:  AbortSignal.timeout(10000),
      },
    );
    if (res.ok) {
      console.log(`[agent-bot] Conv cw#${cwConvId} toggled to ${status}`);
    } else {
      console.warn(`[agent-bot] toggle_status failed (${res.status}):`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn('[agent-bot] toggle_status error:', e?.message);
  }
}

/**
 * Best-effort typing-presence toggle via Chatwoot's `toggle_typing_status`
 * conversation API. Never throws — a failure here must never block or break
 * the actual reply.
 *
 * MECHANISM (verified against our live Chatwoot instance, 2026-07-12):
 *   POST {base}/api/v1/accounts/{account}/conversations/{conv}/toggle_typing_status
 *   { typing_status: 'on'|'off', is_private: false }
 *   — using the SAME CHATWOOT_AGENTBOT_TOKEN already used to post replies.
 *   Confirmed live: this token IS authorized to call it (200 OK against a
 *   real account/conversation) — Chatwoot's agent-bot-typing-status PR
 *   (chatwoot/chatwoot#13705) added that authorization upstream.
 *
 * WHAT THIS DOES vs. DOES NOT DO — read before assuming customers see it:
 *   Chatwoot broadcasts `typing_status` ONLY over its internal WebSocket, to
 *   the Chatwoot agent dashboard and the web-widget channel. As of this
 *   writing, Chatwoot does NOT forward it to WhatsApp Cloud API inboxes —
 *   propagating it to WhatsApp's own `typing_indicator` message type
 *   (https://developers.facebook.com/docs/whatsapp/cloud-api/typing-indicators)
 *   is an OPEN, UNMERGED upstream feature request/PR
 *   (chatwoot/chatwoot#13984 / PR #14236, milestone v4.18.0 at last check).
 *   So today this call makes DineBot (and every other A2 agent) show
 *   "typing…" to anyone watching the Chatwoot dashboard live, but the
 *   WhatsApp customer's phone will NOT show a typing indicator — that part
 *   is out of our control until Chatwoot ships that PR (or we self-host a
 *   patched build). Wiring it now means zero code change is needed on our
 *   side the day that ships — Chatwoot will just start relaying it.
 *
 * Read receipts (blue ticks): Chatwoot's only "mark as read" surface is the
 * PUBLIC widget-facing `update_last_seen` endpoint, meant for the customer's
 * OWN client to report "I've seen this" — there is no agent/bot-side API to
 * mark an inbound WhatsApp message as read on Chatwoot's behalf. We did not
 * wire anything for read receipts because no such mechanism exists in our
 * current Chatwoot A2 setup; calling Meta's Cloud API directly to mark it
 * read would require the A2 tenant's own WhatsApp access token, which
 * Chatwoot owns and we deliberately never touch for A2 tenants (see file
 * header) — bypassing that would be a real architecture change, not a
 * best-effort add-on, so it was left out of this pass. Flag to the user if
 * read receipts specifically are still wanted; it needs its own decision on
 * how to get Meta credentials for the A2 WABA.
 */
async function toggleTypingStatus(
  baseUrl:      string,
  accountId:    string,
  cwConvId:     number,
  typingStatus: 'on' | 'off',
  botToken:     string,
): Promise<void> {
  try {
    const res = await fetch(
      `${baseUrl}/api/v1/accounts/${accountId}/conversations/${cwConvId}/toggle_typing_status`,
      {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', api_access_token: botToken },
        body:    JSON.stringify({ typing_status: typingStatus, is_private: false }),
        signal:  AbortSignal.timeout(8000),
      },
    );
    if (!res.ok) {
      console.warn(`[agent-bot] toggle_typing_status(${typingStatus}) failed (${res.status}):`, await res.text().catch(() => ''));
    }
  } catch (e: any) {
    console.warn(`[agent-bot] toggle_typing_status(${typingStatus}) error:`, e?.message ?? e);
  }
}

// ── Shared helpers (duplicated from lib/agent.ts to avoid refactor) ──────────

function buildSystemPrompt(agent: {
  name:          string;
  greeting:      string;
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
    lines.push(`Soul and guidelines:\n${agent.knowledge_text}`);
  }
  lines.push(
    'Guidelines:',
    '- Keep replies concise and conversational (WhatsApp context).',
    '- Never claim to be human if sincerely asked.',
    '- Reply ONLY with the message for the customer — no narration, no "let me check".',
  );
  return lines.join('\n\n');
}

function isAfterHours(
  start:    string | null,
  end:      string | null,
  timezone: string,
): boolean {
  if (!start || !end) return false;
  try {
    const nowStr = new Date().toLocaleTimeString('en-GB', { timeZone: timezone, hour12: false });
    const [h, m]  = nowStr.split(':').map(Number);
    const nowMins = h * 60 + m;
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const startMins = sh * 60 + sm;
    const endMins   = eh * 60 + em;
    // Overnight range (e.g. 17:00–09:00)
    if (startMins > endMins) return nowMins >= startMins || nowMins < endMins;
    return nowMins >= startMins && nowMins < endMins;
  } catch {
    return false;
  }
}
