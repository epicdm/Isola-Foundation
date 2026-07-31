/**
 * POST /api/chatwoot/webhook
 *
 * Receives Chatwoot outgoing-webhook events and forwards human-agent replies
 * back to the customer over WhatsApp.
 *
 * Auth: ?secret=<CHATWOOT_WEBHOOK_SECRET> query param. Fail-closed (401) if
 * the secret env var is unset or the value does not match.
 *
 * Handled events
 * ──────────────
 * message_created
 *   • message_type == outgoing (Chatwoot integer 1 or string 'outgoing')
 *   • private == false
 *   • content_attributes.source_id !== 'isola-bot'  ← loop-prevention sentinel
 *     (AI replies are mirrored with this attribute so the echo is ignored here)
 *   → resolves tenant via ChatwootBinding.account_id
 *   → atomically claims dedup anchor (Message.chatwoot_message_id unique insert)
 *     BEFORE sending — retries on the same cwMessageId are idempotent (200)
 *   → sends to customer via WhatsApp sendText
 *   → on WA send failure: releases the anchor + returns 503 so Chatwoot retries
 *   → records a HUMAN_OWNED ownership transition (AI suspended for this
 *     conversation); Conversation.human_handling is written as its projection
 *
 * conversation_status_changed (status = resolved)
 *   → resolves tenant via account_id (hard-required; no tenantless fallback)
 *   → records the resolution. On an authoritative door ownership does NOT
 *     move and the AI does not resume; on a legacy door the historical
 *     human_handling clear is preserved exactly
 *
 * Security notes
 * ──────────────
 * • Constant-time secret comparison to prevent timing oracle on CHATWOOT_WEBHOOK_SECRET.
 * • Token resolution follows the same TOKEN_ENV_ALLOWLIST gate as lib/agent.ts.
 * • Resolved-event handler always scopes updates to (tenant_id, chatwoot_conversation_id)
 *   — never a bare chatwoot_conversation_id query which would cross tenant boundaries.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { getWhatsAppConfig } from '@/lib/engines';
import { sendText } from '@/engines/whatsapp';
import { ownershipIsAuthoritative } from '@/lib/ownership/authority';
import { readOwnership } from '@/lib/ownership/state';
import { recordHumanReply, recordResolution } from '@/lib/ownership/transitions';

const TOKEN_ENV_ALLOWLIST = /^(META_|WHATSAPP_)/;

// ── Auth ──────────────────────────────────────────────────────────────────────

function authenticate(req: NextRequest): boolean {
  const expected = process.env.CHATWOOT_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[chatwoot/webhook] CHATWOOT_WEBHOOK_SECRET is not set — rejecting');
    return false;
  }
  const provided = new URL(req.url).searchParams.get('secret') ?? '';
  // Constant-time comparison to prevent timing attacks
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

  const event = body?.event as string;

  try {
    if (event === 'message_created') {
      const status = await handleMessageCreated(body);
      return NextResponse.json({ ok: status < 400 }, { status });
    }
    if (event === 'conversation_status_changed' || event === 'conversation_resolved') {
      await handleConversationStatusChanged(body, event);
    }
    // All other events: ack 200 and ignore
    return NextResponse.json({ ok: true });
  } catch (err: any) {
    // Unexpected error — return 500 so Chatwoot retries where applicable
    console.error('[chatwoot/webhook] unexpected error:', err?.message ?? err);
    return NextResponse.json({ error: 'internal error' }, { status: 500 });
  }
}

// ── message_created ───────────────────────────────────────────────────────────

/**
 * Returns an HTTP status code:
 *   200 — success or intentionally ignored (duplicate, not our account, filtered)
 *   503 — transient failure (WhatsApp send failed) — Chatwoot should retry
 */
async function handleMessageCreated(body: Record<string, any>): Promise<number> {
  // Filter: only outgoing, non-private, non-bot messages
  const isOutgoing = body.message_type === 1 || body.message_type === 'outgoing';
  if (!isOutgoing) return 200;
  if (body.private === true) return 200;

  // Loop prevention: skip messages this app sent (AI outgoing mirror)
  if (body.content_attributes?.source_id === 'isola-bot') {
    console.log('[chatwoot/webhook] Skipping isola-bot echo (loop prevention)');
    return 200;
  }

  const content: string = (body.content ?? '').trim();
  if (!content) return 200;

  // Chatwoot message id (integer) — dedup key
  const cwMessageId: number | null = typeof body.id === 'number' ? body.id : null;
  if (cwMessageId === null) {
    console.warn('[chatwoot/webhook] message_created event missing numeric id — ignoring');
    return 200;
  }

  // Resolve tenant from ChatwootBinding.account_id
  const accountId = String(body.account?.id ?? body.conversation?.account_id ?? '');
  if (!accountId) {
    console.warn('[chatwoot/webhook] Cannot determine account_id from event — ignoring');
    return 200;
  }
  const binding = await prisma.chatwootBinding.findFirst({
    where: { account_id: accountId },
  });
  if (!binding) {
    // Not a tenant we manage — ack and ignore
    return 200;
  }

  // Customer phone (E.164 with '+' as sent by Chatwoot)
  const customerPhone: string = body.conversation?.meta?.sender?.phone_number ?? '';
  if (!customerPhone) {
    console.warn('[chatwoot/webhook] Cannot determine customer phone from event — ignoring');
    return 200;
  }
  // WhatsApp API wants E.164 digits without the leading '+'
  const toDigits = customerPhone.replace(/^\+/, '');

  const cwConvId: number | null =
    typeof body.conversation?.id === 'number' ? body.conversation.id : null;

  // Resolve or create local conversation (ensures a stable FK for the dedup anchor)
  const localConv = await resolveOrCreateLocalConversation({
    tenantId: binding.tenant_id,
    customerPhone,
    cwConvId,
  });

  // Resolve WhatsAppNumber — prefer the one linked to this conversation
  let waNumber = null;
  if (localConv.whatsapp_number_id) {
    waNumber = await prisma.whatsAppNumber.findUnique({
      where: { id: localConv.whatsapp_number_id },
    });
  }
  if (!waNumber) {
    waNumber = await prisma.whatsAppNumber.findFirst({
      where: { tenant_id: binding.tenant_id },
    });
  }
  if (!waNumber) {
    console.error('[chatwoot/webhook] No WhatsAppNumber for tenant', binding.tenant_id);
    return 200; // config gap — acking to avoid infinite retries
  }

  // Resolve outbound token (same allowlist gate as lib/agent.ts)
  let effectiveToken: string;
  if (waNumber.token_env) {
    if (!TOKEN_ENV_ALLOWLIST.test(waNumber.token_env)) {
      console.error(
        `[chatwoot/webhook] token_env "${waNumber.token_env}" rejected — must start with META_ or WHATSAPP_`,
      );
      return 200;
    }
    const resolved = process.env[waNumber.token_env];
    if (!resolved) {
      console.error(
        `[chatwoot/webhook] token_env "${waNumber.token_env}" is set but env var is empty`,
      );
      return 200;
    }
    effectiveToken = resolved;
  } else {
    effectiveToken = waNumber.access_token;
  }

  // ── Atomic dedup anchor claim (before sending) ────────────────────────────
  // Insert the Message row with chatwoot_message_id NOW. If another request is
  // processing the same cwMessageId concurrently, one of them will hit the
  // unique constraint and return 200 without sending. The winner proceeds.
  let claimedMessageId: string;
  try {
    const claimed = await prisma.message.create({
      data: {
        conversation_id:     localConv.id,
        role:                'assistant',
        content,
        chatwoot_message_id: cwMessageId,
      },
    });
    claimedMessageId = claimed.id;
  } catch (err: any) {
    if (err?.code === 'P2002') {
      // Unique constraint: this message was already processed — idempotent ack
      console.log('[chatwoot/webhook] Duplicate cwMessageId', cwMessageId, '— already sent');
      return 200;
    }
    throw err; // unexpected DB error — bubble to outer catch → 500
  }

  // ── Send to customer over WhatsApp ────────────────────────────────────────
  const waConfig = getWhatsAppConfig();
  const result = await sendText(waConfig, {
    phoneId: waNumber.phone_number_id,
    token:   effectiveToken,
    to:      toDigits,
    body:    content,
  });

  if (!result.ok) {
    // Transient failure — release the dedup anchor so Chatwoot can retry cleanly
    await prisma.message.delete({ where: { id: claimedMessageId } }).catch(() => null);
    console.error('[chatwoot/webhook] WhatsApp send failed:', result.error);
    return 503; // tell Chatwoot to retry
  }

  console.log(
    `[chatwoot/webhook] Human reply sent to ${customerPhone} via phone_id ${waNumber.phone_number_id}`,
  );

  // Mark the conversation as human-handled — AI will not auto-reply while this
  // is true. Kept as the LEGACY-REGIME FAIL-SAFE: this path serves doors where
  // the boolean is still the reply gate, so it must not become conditional on
  // the ownership engine succeeding.
  await prisma.conversation
    .update({
      where: { id: localConv.id },
      data:  { human_handling: true, last_message_at: new Date() },
    })
    .catch((e: Error) =>
      console.warn('[chatwoot/webhook] human_handling update failed:', e.message),
    );

  // Durable ownership record for the same fact: a human replied, so a human
  // owns this conversation, in a numbered episode. Best-effort and separately
  // caught — a ledger failure must never weaken the silence above.
  try {
    const owned = await prisma.conversation.findUnique({
      where:  { id: localConv.id },
      select: { id: true, tenant_id: true, ownership_state: true, ownership_episode: true, human_handling: true },
    });
    if (owned) {
      const view = readOwnership(owned);
      await recordHumanReply({
        tenantId:       owned.tenant_id,
        conversationId: owned.id,
        operationId:    `human_reply:mirror:${cwMessageId}`,
        currentState:   view.state,
        currentEpisode: view.episode,
        actorRef:       'chatwoot_user:mirrored_outgoing',
      });
    }
  } catch (e) {
    console.warn('[chatwoot/webhook] ownership transition failed:', (e as Error).message);
  }

  return 200;
}

// ── conversation_status_changed ───────────────────────────────────────────────

async function handleConversationStatusChanged(
  body: Record<string, any>,
  event: string,
) {
  // Diagnostic: log top-level keys so payload shape changes are visible in logs.
  console.log('[chatwoot/webhook] status body keys:', Object.keys(body));

  // For conversation_resolved the event name itself encodes resolution —
  // status fields may be absent. For conversation_status_changed we still
  // check the status field to filter out pending/open transitions.
  const isResolvedEvent = event === 'conversation_resolved';
  const status: string = body.status ?? body.conversation?.status ?? '';
  if (!isResolvedEvent && status !== 'resolved') return;

  // Conversation id: body.id is the top-level Chatwoot conversation id when
  // Chatwoot sends the conversation object as the root body. Fall back to the
  // nested form in case the shape ever changes.
  const cwConvId: number | null =
    typeof body.id === 'number'               ? body.id :
    typeof body.conversation?.id === 'number' ? body.conversation.id : null;
  if (cwConvId === null) {
    console.warn('[chatwoot/webhook] conversation_status_changed: cannot determine conversation id — ignoring');
    return;
  }

  // ── Tenant-safe resolution WITHOUT requiring account_id ───────────────────
  //
  // Root cause: on conversation_status_changed Chatwoot sends the conversation
  // object as the top-level body. account_id is NOT present at any of the
  // previously checked paths (body.account_id, body.account.id, etc.), so the
  // old tenant lookup always failed and human_handling never cleared.
  //
  // Fix: resolve the local Conversation using two reliable payload fields:
  //   cwConvId          — body.id (the Chatwoot conversation integer id)
  //   customerPhone     — body.meta.sender.phone_number (normalized to +E.164)
  //
  // Together they uniquely identify the row without needing account_id.
  // If the phone is absent (edge case), fall back to cwConvId alone — the risk
  // of a cross-tenant hit is low (different Chatwoot instances rarely share
  // integer ids) and it's still better than silently doing nothing.

  // Normalize phone to +E.164 (digits only after +) so it matches exactly what
  // is stored in Conversation.customer_phone by the inbound WA path.
  const rawPhone: string = body.meta?.sender?.phone_number ?? '';
  const digits = rawPhone.replace(/[^\d]/g, '');
  const customerPhone: string | null = digits ? '+' + digits : null;

  let updated: { count: number };

  if (customerPhone) {
    // Primary path: (chatwoot_conversation_id, customer_phone) uniquely identifies
    // the row across all tenants — no account_id required.
    //
    // Resolution no longer decides ownership. Each matched row is recorded
    // through the ownership engine, which applies the historical
    // human_handling clear ONLY on a legacy door — and on an authoritative
    // door leaves response authority exactly where it is, so closing a ticket
    // cannot re-arm an automated brain.
    const locals = await prisma.conversation.findMany({
      where:  { chatwoot_conversation_id: cwConvId, customer_phone: customerPhone },
      select: {
        id: true, tenant_id: true, chatwoot_inbox_id: true,
        chatwoot_binding_id: true, ownership_episode: true,
      },
    });
    for (const local of locals) {
      let resolvedAccountId: string | null = null;
      if (local.chatwoot_binding_id) {
        const b = await prisma.chatwootBinding.findUnique({
          where:  { id: local.chatwoot_binding_id },
          select: { account_id: true },
        });
        resolvedAccountId = b?.account_id ?? null;
      }
      const authoritative =
        resolvedAccountId !== null && ownershipIsAuthoritative(resolvedAccountId, local.chatwoot_inbox_id);
      await recordResolution({
        tenantId:       local.tenant_id,
        conversationId: local.id,
        operationId:    `resolution:${cwConvId}:${local.ownership_episode ?? 0}`,
        authoritative,
      });
    }
    updated = { count: locals.length };
  } else {
    // Phone absent: refuse to update rather than risk a cross-tenant mutation on
    // bare chatwoot_conversation_id (the field is only unique per tenant).
    console.warn(
      '[chatwoot/webhook] conversation_status_changed: no sender phone in body.meta for ' +
      'cw#' + cwConvId + ' — skipping update to avoid cross-tenant risk',
    );
    return;
  }

  if (updated.count > 0) {
    console.log(
      `[chatwoot/webhook] Conv cw#${cwConvId} resolved — human_handling cleared, AI can resume`,
    );
  } else {
    console.warn(
      `[chatwoot/webhook] Conv cw#${cwConvId} resolve event received but no local row matched`,
    );
  }
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Find the local Conversation record for this Chatwoot conversation.
 * Lookup order: by chatwoot_conversation_id → by open phone → create new.
 * Always returns a record so the caller has a stable FK for the dedup anchor.
 */
async function resolveOrCreateLocalConversation(params: {
  tenantId:      string;
  customerPhone: string;
  cwConvId:      number | null;
}) {
  const { tenantId, customerPhone, cwConvId } = params;

  // 1. Exact match by Chatwoot conversation id + tenant
  if (cwConvId !== null) {
    const byConvId = await prisma.conversation.findFirst({
      where: { tenant_id: tenantId, chatwoot_conversation_id: cwConvId },
    });
    if (byConvId) return byConvId;
  }

  // 2. Open conversation for this phone number
  const byPhone = await prisma.conversation.findFirst({
    where: { tenant_id: tenantId, customer_phone: customerPhone, status: 'open' },
    orderBy: { last_message_at: 'desc' },
  });
  if (byPhone) {
    // Backfill the Chatwoot id if we now have it
    if (cwConvId !== null && byPhone.chatwoot_conversation_id === null) {
      return prisma.conversation.update({
        where: { id: byPhone.id },
        data: { chatwoot_conversation_id: cwConvId },
      });
    }
    return byPhone;
  }

  // 3. Create a stub conversation so dedup always has a FK anchor.
  //    whatsapp_number_id left null (nullable) — filled in on the next inbound WA message.
  return prisma.conversation.create({
    data: {
      tenant_id:               tenantId,
      customer_phone:          customerPhone,
      chatwoot_conversation_id: cwConvId ?? undefined,
      status:                  'open',
    },
  });
}
