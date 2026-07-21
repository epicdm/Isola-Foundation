/**
 * POST /api/customer/escalate — governed `escalate_to_human` tool endpoint
 * for the public Clawith agent (EMA), called via the deepseek MCP
 * customer-tools server. Authenticated with the SAME
 * ISOLA_CUSTOMER_TOOLS_TOKEN used by /api/customer/account — the public
 * agent holds no other credential (def-clawith-escalate-tool-no-chatwoot-wiring-2026-07-21).
 *
 * Ownership is resolved ENTIRELY server-side from `conversation_id` — the
 * opaque per-conversation id we ourselves handed Clawith as `sessionId` in
 * generateReply() (see app/api/chatwoot/agent-bot/route.ts). The caller
 * supplies no tenant/company/account/inbox id; any such field in the request
 * body is ignored. Conversation.tenant_id -> ChatwootBinding (mode='a2') is
 * the only path to an account_id/base_url/bot token, exactly as the agent-bot
 * webhook itself resolves them.
 *
 * Effects (idempotent — safe to retry with the same conversation_id):
 *   1. Conversation.human_handling = true — the ONE authoritative silence
 *      gate (stronger than the existing soft needs_handoff -> surfaceHandoff()
 *      path, which only flags a conversation for review and never silences
 *      the bot). Hand-back is unchanged: conversation_resolved still clears
 *      this flag (handleStatusChanged() in the agent-bot route) — no new
 *      state machine.
 *   2. surfaceHandoff() with an escalation-specific note — reuses the
 *      existing single-fire label/note/status-toggle contract
 *      (lib/chatwoot-handoff.ts). If needs_handoff already surfaced this
 *      conversation (ai-handoff label present), this step is a deliberate
 *      no-op — human_handling is still set either way.
 *
 * Every response (success or failure) carries a correlation_id for tracing a
 * single tool call end-to-end across these logs and Chatwoot.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { surfaceHandoff } from '@/lib/chatwoot-handoff';
import { resolveActiveBinding } from '@/lib/chatwoot-binding-resolution';
import { audit } from '@/lib/audit';

function ctEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function authed(req: NextRequest): boolean {
  const exp = process.env.ISOLA_CUSTOMER_TOOLS_TOKEN || '';
  if (!exp) return false; // fail closed when unset
  const h = req.headers.get('authorization') ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? ctEq(m[1], exp) : false;
}

function fail(status: number, error: string, correlationId: string) {
  return NextResponse.json({ ok: false, error, correlation_id: correlationId }, { status });
}

export async function POST(req: NextRequest) {
  const correlationId = crypto.randomUUID();
  if (!authed(req)) return fail(401, 'bad_auth', correlationId);

  let body: any = {};
  try { body = await req.json(); } catch { /* treat as empty body */ }

  const conversationId: string | null =
    typeof body?.conversation_id === 'string' && body.conversation_id.trim()
      ? body.conversation_id.trim()
      : null;
  const summary: string | null =
    typeof body?.summary === 'string' && body.summary.trim()
      ? body.summary.trim().slice(0, 2000)
      : null;

  if (!conversationId) return fail(400, 'conversation_id required', correlationId);

  // Ownership resolution — entirely server-side. Nothing else in `body`
  // (tenant_id, account_id, inbox_id, etc.) is ever read past this point.
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) return fail(404, 'unknown_conversation', correlationId);
  if (conversation.chatwoot_conversation_id === null) {
    return fail(409, 'conversation_not_chatwoot_backed', correlationId);
  }

  const bindings = await prisma.chatwootBinding.findMany({
    where:   { tenant_id: conversation.tenant_id, mode: 'a2' },
    include: { tenant: true },
  });
  const binding = resolveActiveBinding(bindings);
  if (!binding) return fail(409, 'no_chatwoot_binding', correlationId);

  const botToken = process.env.CHATWOOT_AGENTBOT_TOKEN;
  if (!botToken) return fail(500, 'bot_token_not_configured', correlationId);

  const alreadyEscalated = conversation.human_handling === true;

  // 1. Silence gate — set unconditionally; a no-op update if already true.
  await prisma.conversation.update({
    where: { id: conversation.id },
    data:  { human_handling: true },
  });

  // 2. Surface into Chatwoot for a human — single-fire, reuses the existing contract.
  const note = summary
    ? `🙋 Customer requested a human — escalate_to_human invoked.\n\n${summary}`
    : '🙋 Customer requested a human — escalate_to_human invoked.';
  await surfaceHandoff(
    binding.base_url,
    binding.account_id,
    conversation.chatwoot_conversation_id,
    botToken,
    note,
  );

  await audit({
    tenantId:  conversation.tenant_id,
    actorId:   'clawith:escalate_to_human',
    action:    'escalate_to_human.invoked',
    entity:    'conversation',
    entityId:  conversation.id,
    requestId: correlationId,
    meta:      { already_escalated: alreadyEscalated, has_summary: summary !== null },
  });

  return NextResponse.json({
    ok:             true,
    status:         alreadyEscalated ? 'already_escalated' : 'escalated',
    correlation_id: correlationId,
    conversation_id: conversation.id,
  });
}
