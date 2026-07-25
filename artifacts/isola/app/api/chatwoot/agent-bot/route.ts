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
 * Auth:  HMAC-SHA256 signature over `${timestamp}.${rawBody}`, sent by Chatwoot
 *        (>= 4.13) as X-Chatwoot-Signature / X-Chatwoot-Timestamp and verified
 *        against CHATWOOT_BOT_SIGNING_SECRET — see lib/chatwoot-webhook-signature.ts.
 *        The old `?secret=` query parameter is accepted ONLY while
 *        CHATWOOT_ALLOW_LEGACY_QUERY_SECRET=true, to keep the bot serving
 *        across the cutover. Once outgoing_url has been stripped of ?secret=
 *        and signed deliveries are confirmed, unset that flag.
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
 *   • Cross-path dedup by Meta wamid (Chatwoot's `source_id` field) via
 *     InboundDedup — see the P0 note below and lib/inbound-dedup.ts.
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
 * Inbox isolation: looks up ChatwootBinding WHERE mode='a2' by inbox_id (not
 * account_id — Chatwoot inbox ids are meant to be unique platform-wide, and
 * multiple A2 tenants can share one Chatwoot account, so account-only lookup
 * is ambiguous — see the resolution block below for the 2026-07-01 incident
 * this mirrors from bff-v2). Unknown inbox_ids return 200 immediately so
 * Wave-A tenants and unrelated inboxes are untouched.
 *
 * That "unique" assumption isn't actually enforced anywhere, and did fail in
 * practice (2026-07-20: a retired tenant's stale binding collided with the
 * active tenant's on inbox 3, and non-deterministically won). If more than
 * one binding matches, resolveActiveBinding() (lib/chatwoot-binding-
 * resolution.ts) picks deterministically: active tenant status first, then
 * most-recently-updated, then binding id — never DB scan order.
 *
 * ── P0 (2026-07-15): cross-path double-reply ──────────────────────────────
 * A single inbound WhatsApp message to number 9043 produced TWO AI replies.
 * Root cause: this path's dedup (Message.chatwoot_message_id) and the direct
 * WA webhook path's dedup (lib/agent.ts, Message.wa_message_id) are two
 * DIFFERENT local keys. If the same physical Meta message reaches BOTH paths,
 * each claims its own id and both dedup checks pass independently — two AI
 * replies for one inbound message. Fix: also claim the underlying Meta wamid
 * (surfaced by Chatwoot as `source_id` on the message payload for
 * channel-native messages) in the shared InboundDedup table, at the earliest
 * safe point, before any DB write. See lib/inbound-dedup.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { generateReply } from '@/lib/brain-provider';
import { meterTokens } from '@/lib/meter';
import { claimInboundMessageId } from '@/lib/inbound-dedup';
import { toggleConvStatus, surfaceHandoff } from '@/lib/chatwoot-handoff';
import { resolveActiveBinding } from '@/lib/chatwoot-binding-resolution';
import { stampLeadContext } from '@/lib/chatwoot-lead-context';
import { SALES_TENANT_IDS } from '@/lib/claim-guard';
import {
  verifyChatwootSignature,
  readSignatureHeaders,
} from '@/lib/chatwoot-webhook-signature';
import { buildEscalationCard } from '@/lib/escalation-card';
import { detectEscalationIntent } from '@/lib/escalation-intent';

// ── Constants ─────────────────────────────────────────────────────────────────

const CHATWOOT_BASE = 'https://inbox.epic.dm'; // overridden by binding.base_url when available

// ── Auth ──────────────────────────────────────────────────────────────────────

type AuthResult =
  | { ok: true; via: 'signature' | 'legacy-query' }
  | { ok: false; reason: string };

/**
 * Preferred: HMAC signature (Chatwoot >= 4.13, verified on 4.16.1).
 * Transitional: `?secret=` in the URL, allowed ONLY while
 * CHATWOOT_ALLOW_LEGACY_QUERY_SECRET is explicitly enabled.
 *
 * A request that CARRIES a signature must have a VALID one — we never fall
 * back to the query secret in that case, because a present-but-wrong signature
 * is a tampering signal, not a client that forgot to sign.
 */
function authenticate(req: NextRequest, rawBody: string): AuthResult {
  const { signature, timestamp } = readSignatureHeaders(req.headers);

  if (signature || timestamp) {
    const result = verifyChatwootSignature({
      rawBody,
      signature,
      timestamp,
      secret: process.env.CHATWOOT_BOT_SIGNING_SECRET,
    });
    return result.ok ? { ok: true, via: 'signature' } : { ok: false, reason: result.reason };
  }

  if (process.env.CHATWOOT_ALLOW_LEGACY_QUERY_SECRET !== 'true') {
    return { ok: false, reason: 'unsigned-and-legacy-disabled' };
  }

  const expected = process.env.CHATWOOT_BOT_SECRET;
  if (!expected) return { ok: false, reason: 'no-legacy-secret-configured' };

  const provided = new URL(req.url).searchParams.get('secret') ?? '';
  if (provided.length !== expected.length) return { ok: false, reason: 'legacy-mismatch' };
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0
    ? { ok: true, via: 'legacy-query' }
    : { ok: false, reason: 'legacy-mismatch' };
}

// ── POST handler ──────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  // The signature covers the RAW body, so it must be read as text and verified
  // BEFORE parsing. Re-serialising parsed JSON does not reproduce the bytes
  // Chatwoot signed.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const auth = authenticate(req, rawBody);
  if (!auth.ok) {
    // Logged server-side only. The response never says which check failed.
    console.warn('[agent-bot] rejected delivery:', auth.reason);
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (auth.via === 'legacy-query') {
    console.warn('[agent-bot] delivery authenticated by LEGACY query secret — ' +
      'this path is being retired; set the bot secret and drop ?secret= from outgoing_url');
  }

  let body: Record<string, any>;
  try {
    body = JSON.parse(rawBody);
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

  // ── Cross-path idempotency gate (Meta wamid) — earliest safe point ───────
  // Chatwoot's own WhatsApp Cloud API channel integration surfaces the
  // ORIGINAL Meta message id in `source_id` on the message payload for
  // inbound channel messages. If the SAME physical message also arrives (or
  // has already arrived) via the direct webhook path (lib/agent.ts,
  // app/api/webhooks/whatsapp), that path claims the identical InboundDedup
  // row this claims here — so only ONE of the two paths proceeds to reply.
  // This is ADDITIVE to — not a replacement for — the chatwoot_message_id
  // dedup below, which still protects against Chatwoot's own webhook retries
  // independent of any cross-path duplication.
  //
  // NOTE (unverified live): `source_id` is Chatwoot's documented field name
  // for the channel-native message id; confirm against a captured live
  // payload before merge. If the field name differs, claimInboundMessageId
  // is called with null and always returns false (safe no-op) — the existing
  // chatwoot_message_id dedup still applies either way.
  const metaSourceId: string | null =
    typeof body.source_id === 'string' && body.source_id ? body.source_id : null;
  if (isIncoming && (await claimInboundMessageId(metaSourceId))) {
    console.log('[agent-bot] Duplicate inbound (cross-path dedup) source_id', metaSourceId, '— dropping');
    return 200;
  }

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
  // Resolve by the SPECIFIC Chatwoot inbox this event came from — not by
  // account id alone. Multiple tenants can share one Chatwoot account (e.g.
  // several A2 tenants live on account 5), so accountId-only lookup is
  // ambiguous and can silently resolve to the wrong tenant's agent/token.
  // Matches the fix bff-v2 already shipped after a live incident (2026-07-01:
  // 295-6737 and EMA shared account 5; accountId-only resolution there picked
  // the wrong tenant's stale token). Chatwoot inbox ids are unique platform-
  // wide, so inbox_id alone is a safe, unambiguous lookup key.
  const inboxId: string | null =
    conv.inbox_id != null ? String(conv.inbox_id) :
    body.inbox_id != null  ? String(body.inbox_id)  : null;
  if (!inboxId) {
    console.warn('[agent-bot] message_created missing inbox_id — cannot safely resolve tenant, ignoring');
    return 200;
  }
  const bindings = await prisma.chatwootBinding.findMany({
    where: { inbox_id: inboxId, mode: 'a2' },
    include: {
      tenant: {
        include: { agents: true, users: { where: { agent_took_over: true } } },
      },
      // Per-inbox agent override (S4): when agent_id is set on the binding,
      // use that specific agent instead of tenant.agents[0]. Null → unchanged behaviour.
      agent: true,
    },
  });
  const binding = resolveActiveBinding(bindings);
  if (!binding) {
    // Not an A2 inbox we manage — ack and ignore (isolation guarantee)
    console.log('[agent-bot] No A2 binding for inbox', inboxId, '(account', accountId + ') — no-op');
    return 200;
  }
  if (bindings.length > 1) {
    console.warn(
      `[agent-bot] Multiple A2 bindings for inbox ${inboxId} (account ${accountId}) — ` +
        `resolved to tenant ${binding.tenant_id} (status=${binding.tenant.status}); others: ` +
        bindings
          .filter((b) => b.id !== binding.id)
          .map((b) => `${b.tenant_id}(${b.tenant.status})`)
          .join(', '),
    );
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
        chatwoot_inbox_id:       inboxId,
        chatwoot_binding_id:     binding.id,
      },
    });
    // Lead-pipeline context capture (Lane 1 Task 3) — stamp once, on the
    // first inbound message of a brand-new conversation. Scoped to the sales
    // tenants only: this webhook is the single chokepoint for ALL A2 tenant
    // traffic, and pilot_stage/source only mean something for the founding-
    // pilot sales pipeline on Chatwoot account 5.
    if (SALES_TENANT_IDS.has(tenantId) && botToken) {
      await stampLeadContext(baseUrl, accountId, cwConvId, botToken, content);
    }
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
    data:  {
      last_message_at:     new Date(),
      customer_phone:      customerPhone,
      // Refresh/backfill the binding snapshot on every inbound message —
      // cheap, and the only place a legacy (pre-snapshot) conversation ever
      // gets a value here, from the one unambiguous signal available: this
      // message's own live inbox_id.
      chatwoot_inbox_id:   inboxId,
      chatwoot_binding_id: binding.id,
    },
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
  // S4: if this inbox has a pinned agent_id, use that agent directly;
  // otherwise fall back to the tenant's first agent (existing behaviour).
  const agent = (binding as any).agent ?? tenant.agents[0];
  if (!agent || !agent.is_active) {
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

    // Resolve the Clawith identity only when actually needed.
    // S4 two-level lookup:
    //   1. Per-agent binding — ClawithBinding WHERE agent_id = agent.id (unique index).
    //      Lets two agents on the same tenant dispatch to different Clawith identities.
    //   2. Per-tenant fallback — ClawithBinding WHERE tenant_id = tenantId AND agent_id IS NULL.
    //      Exactly the current behaviour when no per-agent row exists.
    const brainProvider: string = (agent as any).brain_provider ?? 'native';
    let clawithBindingRow: { clawith_agent_id: string; paperclip_agent_id: string; paperclip_company_id: string } | null = null;
    let odooBindingRow: { url: string; db: string; login: string | null; api_key_enc: string } | null = null;
    if (brainProvider === 'clawith') {
      // 1. Agent-specific binding (new)
      clawithBindingRow = await prisma.clawithBinding.findUnique({
        where: { agent_id: agent.id },
      });
      // 2. Tenant-level fallback (existing behaviour — agent_id IS NULL rows)
      if (!clawithBindingRow) {
        clawithBindingRow = await prisma.clawithBinding.findFirst({
          where: { tenant_id: tenantId, agent_id: null },
        });
      }

      // Resolve the tenant's Odoo binding so Clawith uses the tenant's own
      // Odoo connection instead of its hardcoded sandbox credentials.
      // Omitted entirely when no binding exists — Clawith falls back to sandbox.
      odooBindingRow = await prisma.odooBinding.findUnique({
        where: { tenant_id: tenantId },
        select: { url: true, db: true, login: true, api_key_enc: true },
      });
    }

    // Decrypt the Odoo API key outside the try/catch so a decryption failure
    // surfaces clearly rather than being swallowed as an AI error.
    let odooBindingInput: import('@/lib/brain-provider').OdooBindingInput | null = null;
    if (odooBindingRow) {
      const { decryptSecret } = await import('@/lib/tenant-secrets');
      odooBindingInput = {
        url:      odooBindingRow.url,
        db:       odooBindingRow.db,
        login:    odooBindingRow.login,
        password: decryptSecret(odooBindingRow.api_key_enc),
      };
    }

    // Mint a fresh opaque escalation ref for this turn — ONLY the Clawith path
    // ever gets one; the bridge hands it to the agent (never a raw
    // conversation/tenant/account/inbox id) so escalate_to_human can resolve
    // ownership server-side from the ref alone (lib/escalation-ref.ts). Scoped
    // to purpose/tenant/agent/binding/inbox/conversation at mint time — bound
    // to `binding.id`/`inboxId` (this request's OWN live values, just
    // persisted onto the conversation above), not the possibly-stale
    // in-memory `conversation.*` snapshot from before that update.
    let conversationRef: string | null = null;
    let escalationCorrelationId: string | null = null;
    if (clawithBindingRow) {
      const { mintEscalationRefIfAllowed } = await import('@/lib/escalation-ref');
      const mint = await mintEscalationRefIfAllowed({
        phoneNumberId:     waNumberForHermesGate?.phone_number_id ?? '',
        tenantId,
        conversationId:    conversation.id,
        clawithAgentId:    clawithBindingRow.clawith_agent_id,
        chatwootBindingId: binding.id,
        chatwootInboxId:   inboxId ?? null,
      });
      conversationRef = mint.token;
      escalationCorrelationId = mint.correlationId;
    }

    let needsHandoff = false;

    try {
      const result = await generateReply({
        agent: {
          id:                 agent.id,
          intelligence_tier: agent.intelligence_tier,
          brain_provider:    brainProvider,
          flowise_flow_id:   (agent as any).flowise_flow_id ?? null,
        },
        system:    buildSystemPrompt(agent),
        messages:  aiMessages,
        sessionId: conversation.id, // stable per-conversation key for Flowise/Clawith memory
        phoneNumberId: waNumberForHermesGate?.phone_number_id ?? '',
        senderPhone: customerPhone,
        tenantId,
        clawithBinding: clawithBindingRow
          ? {
              clawith_agent_id:     clawithBindingRow.clawith_agent_id,
              paperclip_agent_id:   clawithBindingRow.paperclip_agent_id,
              paperclip_company_id: clawithBindingRow.paperclip_company_id,
            }
          : null,
        odooBinding: odooBindingInput,
        conversationRef,
        escalationCorrelationId,
      });
      reply       = result.text;
      tokensUsed  = result.tokensUsed;
      model       = result.model;
      needsHandoff = result.needsHandoff === true;
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

    // ── Surface handoff (Clawith needs_handoff) — INTO Chatwoot, not a separate ping ──
    // Conversation.human_handling remains the ONLY gate on whether the bot may
    // keep replying (set true exclusively by an actual human reply, above).
    // This is a visibility signal for a human to look, not a silence switch —
    // the bot still answers subsequent messages unless/until a human replies.
    if (needsHandoff && botToken) {
      // The note carries WHAT the customer wanted, not just that a handoff
      // happened — a Chatwoot automation rule can only insert static text, so
      // the content of the handoff is ours to compose. Routing and labelling
      // stay with Chatwoot (see the "Escalation - route to human" rule).
      const intent = detectEscalationIntent(content, tenantId);
      const card = buildEscalationCard({
        customerMessage: content,
        aiReply: reply,
        reason: intent.escalate ? intent.category : null,
        contactName: typeof body.sender?.name === 'string' ? body.sender.name : null,
        contactPhone:
          typeof body.sender?.phone_number === 'string' ? body.sender.phone_number : null,
      });
      await surfaceHandoff(baseUrl, accountId, cwConvId, botToken, card);
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
// toggleConvStatus / surfaceHandoff live in lib/chatwoot-handoff.ts (extracted
// so surfaceHandoff's single-fire behavior is unit-testable — route.ts may
// only export HTTP method handlers per Next.js App Router rules).

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
