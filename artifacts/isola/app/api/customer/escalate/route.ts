/**
 * POST /api/customer/escalate — governed `escalate_to_human` tool endpoint
 * for the public Clawith agent (EMA), called via the deepseek MCP
 * customer-tools server. Authenticated with the SAME
 * ISOLA_CUSTOMER_TOOLS_TOKEN used by /api/customer/account — the public
 * agent holds no other credential (def-clawith-escalate-tool-no-chatwoot-wiring-2026-07-21).
 *
 * Ownership is resolved ENTIRELY server-side from `conversation_ref` — an
 * opaque, short-lived, scoped-capability token (lib/escalation-ref.ts) bound
 * at mint time to purpose, tenant, Clawith agent, ChatwootBinding, inbox,
 * Conversation and a correlation id. Foundation mints it per turn and hands
 * it to the agent ONLY via the Isola bridge's per-turn runtime instruction
 * (isola_bridge.py's caller_directive channel — never a raw conversation/
 * tenant/account/inbox id, and never a value the agent could forge or reuse
 * past its TTL). The caller supplies no tenant/company/account/inbox/
 * conversation id; any such field in the request body is ignored. Every
 * bound field is RE-CHECKED against the conversation's current state below
 * (not just "does the token exist") — a mismatch on any of them (wrong
 * purpose, wrong tenant, wrong Clawith agent, wrong binding, wrong inbox)
 * fails closed as `ref_scope_mismatch`, distinct from `binding_unresolved`
 * (which means Foundation itself cannot determine a consistent binding for
 * this conversation at all). The Chatwoot account_id/base_url/bot token come
 * ONLY from Conversation.chatwoot_binding_id — the exact ChatwootBinding
 * snapshotted onto the conversation at webhook time (see agent-bot/route.ts)
 * — never a fresh tenant-wide ChatwootBinding lookup, which is ambiguous
 * once a tenant owns more than one active a2 binding (S4 per-agent
 * routing).
 *
 * IMPORTANT — this is a scoped capability check, NOT independent agent
 * authentication (def-clawith-escalation-shared-token-no-agent-principal-
 * 2026-07-21): mcp-isola-customer-tools still authenticates every call with
 * ONE shared bearer token (ISOLA_CUSTOMER_TOOLS_TOKEN) for every tenant and
 * agent. The scoped ref proves the bearer was handed THIS exact reference
 * for THIS exact turn and closes the cross-tenant/cross-agent/cross-binding
 * ambiguity that a raw id would leave open — it does not prove the HTTP
 * request itself originated from the specific Clawith execution named in
 * the ref, as opposed to some other holder of the same shared token replaying
 * a leaked reference before it expires. Do not weaken these checks, and do
 * not present them elsewhere as solving that remaining gap.
 *
 * Effects (idempotent — safe to retry with the same still-valid conversation_ref):
 *   1. An ownership transition to HUMAN_REQUESTED, claimed EXACTLY ONCE on
 *      the scoped ref's own correlation id (lib/ownership/transitions.ts).
 *      This is the authoritative silence gate; `Conversation.human_handling`
 *      is written as its projection and is no longer the authority.
 *      Suppression is in force before step 2 runs.
 *   2. ONLY on the winning claim: surfaceHandoff() with an escalation-specific
 *      note (lib/chatwoot-handoff.ts), then a transition to HUMAN_OWNED
 *      recording that assignment and context publication completed. Gating
 *      the side effects on the claim is what makes a duplicate escalation
 *      produce one assignment, one private note and at most one handoff
 *      message — a property of the claim rather than of surfaceHandoff()'s
 *      own best-effort single-fire heuristics.
 *
 * HAND-BACK IS NO LONGER IMPLICIT. Before Commit 2, conversation_resolved
 * cleared human_handling and the AI silently resumed. It no longer does on a
 * door where the ownership model is authoritative: only an explicit
 * authorized handback (POST /api/conversations/[id]/handback) can return
 * response authority to the brain, and only after reconciliation succeeds.
 *
 * Every response (success or failure) carries a correlation_id for tracing a
 * single tool call end-to-end across these logs and Chatwoot.
 */
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { prisma } from '@/lib/prisma';
import { surfaceHandoff } from '@/lib/chatwoot-handoff';
import { resolveEscalationRef } from '@/lib/escalation-ref';
import { audit } from '@/lib/audit';
import { requestHumanOwnership, confirmHumanOwnership } from '@/lib/ownership/transitions';

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

/** Two-level ClawithBinding lookup mirroring agent-bot/route.ts's own
 *  resolution order: per-agent binding first, tenant-level fallback second.
 *  Used only to find the CURRENT expected clawith_agent_id for a
 *  conversation's agent, to compare against the ref's snapshot. */
async function currentClawithAgentId(tenantId: string, agentId: string | null): Promise<string | null> {
  if (agentId) {
    const perAgent = await prisma.clawithBinding.findUnique({ where: { agent_id: agentId } });
    if (perAgent) return perAgent.clawith_agent_id;
  }
  const perTenant = await prisma.clawithBinding.findFirst({ where: { tenant_id: tenantId, agent_id: null } });
  return perTenant?.clawith_agent_id ?? null;
}

export async function POST(req: NextRequest) {
  const correlationId = crypto.randomUUID();
  if (!authed(req)) return fail(401, 'bad_auth', correlationId);

  let body: any = {};
  try { body = await req.json(); } catch { /* treat as empty body */ }

  const conversationRef: string | null =
    typeof body?.conversation_ref === 'string' && body.conversation_ref.trim()
      ? body.conversation_ref.trim()
      : null;
  const summary: string | null =
    typeof body?.summary === 'string' && body.summary.trim()
      ? body.summary.trim().slice(0, 2000)
      : null;

  if (!conversationRef) return fail(400, 'conversation_ref required', correlationId);

  // Ownership resolution — entirely server-side, from the opaque ref alone.
  // Nothing else in `body` (conversation_id, tenant_id, account_id,
  // inbox_id, etc.) is ever read past this point.
  const resolved = await resolveEscalationRef(conversationRef);
  if (!resolved) return fail(404, 'unknown_or_expired_conversation_ref', correlationId);
  if (resolved.purpose !== 'escalate_to_human') {
    return fail(400, 'malformed_conversation_ref', correlationId);
  }

  const conversation = await prisma.conversation.findUnique({ where: { id: resolved.conversationId } });
  if (!conversation) return fail(404, 'unknown_conversation', correlationId);
  if (conversation.chatwoot_conversation_id === null) {
    return fail(409, 'conversation_not_chatwoot_backed', correlationId);
  }
  // Cross-tenant fail-closed — the ref's own snapshot must still agree with
  // the conversation it resolves to.
  if (resolved.tenantId !== conversation.tenant_id) {
    return fail(403, 'ref_scope_mismatch', correlationId);
  }

  // Binding resolution — from the conversation's OWN stored snapshot only,
  // never a fresh tenant-wide lookup. A tenant can own more than one active
  // a2 ChatwootBinding (S4 per-agent routing); querying by tenant_id alone
  // is exactly the ambiguity class that already caused two live incidents
  // on the inbound path (2026-07-01, 2026-07-20) before it was fixed there
  // by keying on the webhook's own inbox_id. Escalation must fail closed
  // rather than guess when the snapshot is missing or inconsistent — there
  // is no live inbox_id to fall back to here (unlike the inbound webhook,
  // which always carries one).
  if (!conversation.chatwoot_binding_id) {
    return fail(409, 'binding_unresolved', correlationId);
  }
  const binding = await prisma.chatwootBinding.findUnique({
    where:   { id: conversation.chatwoot_binding_id },
    include: { tenant: true },
  });
  if (
    !binding ||
    binding.mode !== 'a2' ||
    binding.tenant_id !== conversation.tenant_id ||
    binding.tenant.status !== 'active' ||
    (conversation.chatwoot_inbox_id !== null && conversation.chatwoot_inbox_id !== binding.inbox_id)
  ) {
    return fail(409, 'binding_unresolved', correlationId);
  }

  // Cross-binding / cross-inbox / cross-agent fail-closed — the ref must
  // still name the SAME binding, inbox and Clawith agent the conversation
  // resolves to right now. A mismatch here means either a ref minted for a
  // different conversation/agent is being replayed, or the tenant's binding
  // was rebound between mint and use — either way, deny rather than guess.
  if (resolved.chatwootBindingId !== conversation.chatwoot_binding_id) {
    return fail(403, 'ref_scope_mismatch', correlationId);
  }
  if (
    resolved.chatwootInboxId !== null &&
    conversation.chatwoot_inbox_id !== null &&
    resolved.chatwootInboxId !== conversation.chatwoot_inbox_id
  ) {
    return fail(403, 'ref_scope_mismatch', correlationId);
  }
  const expectedClawithAgentId = await currentClawithAgentId(conversation.tenant_id, binding.agent_id);
  if (!expectedClawithAgentId || resolved.clawithAgentId !== expectedClawithAgentId) {
    return fail(403, 'ref_scope_mismatch', correlationId);
  }

  const botToken = process.env.CHATWOOT_AGENTBOT_TOKEN;
  if (!botToken) return fail(500, 'bot_token_not_configured', correlationId);

  // ── 1. Ownership transition — the authoritative silence gate ─────────────
  //
  // The escalation OPERATION identity is the scoped ref's own correlation id.
  // It is minted once per turn and is stable for the life of that ref, so a
  // retried MCP tool call presenting the same still-valid conversation_ref
  // claims the SAME operation — one transition, one episode.
  //
  // Written BEFORE the Chatwoot surfacing below. The reverse order leaves a
  // window in which the bot can answer a conversation already handed to a
  // person.
  const transition = await requestHumanOwnership({
    tenantId:       conversation.tenant_id,
    conversationId: conversation.id,
    operationId:    resolved.correlationId,
    reason:         'clawith_escalate_to_human',
    actorRef:       'clawith:escalate_to_human',
    correlationId,
  });
  if (transition.status === 'unknown_conversation') {
    return fail(409, 'ownership_unresolved', correlationId);
  }
  const alreadyEscalated = transition.status !== 'applied';

  // ── 2. Surface into Chatwoot — ONLY on the winning claim ─────────────────
  if (!alreadyEscalated) {
    const note = summary
      ? `🙋 Customer requested a human — escalate_to_human invoked.\n\n${summary}`
      : '🙋 Customer requested a human — escalate_to_human invoked.';
    const surface = await surfaceHandoff(
      binding.base_url,
      binding.account_id,
      conversation.chatwoot_conversation_id,
      botToken,
      note,
    );

    // Context publication completed → HUMAN_OWNED. Replies stay suppressed
    // either way (HUMAN_REQUESTED is excluded from AI_REPLY_OWNERSHIP_STATES
    // too); this records that a person can now actually see the conversation,
    // which is the precondition a later handback reconciles against.
    //
    // GATED on the surface actually landing. Previously this ran
    // unconditionally because surfaceHandoff returned void and swallowed its
    // own failures, so Foundation recorded HUMAN_OWNED even when nothing
    // reached Chatwoot. Same posture as the gateway's `handoff_blocked`:
    // telling a customer their conversation is with a team member when it is
    // not is a lie they cannot check.
    //
    // The reason no longer says "assignment". Foundation issues NO Chatwoot
    // assignment call — the team assignment seen in production is Chatwoot
    // automation rule #3 reacting to the status reopen. Claiming an assignment
    // we do not perform is what made the ownership audit unfalsifiable.
    // Historical rows carry `chatwoot_assignment_and_context_published`;
    // readers must accept both.
    if (surface.surfaced) {
      await confirmHumanOwnership({
        tenantId:       conversation.tenant_id,
        conversationId: conversation.id,
        operationId:    `${resolved.correlationId}:assigned`,
        episode:        transition.episode,
        reason:         'chatwoot_context_published',
        actorRef:       'clawith:escalate_to_human',
        correlationId,
      });
    } else {
      // Fail closed and loud. Ownership stays at HUMAN_REQUESTED: the AI is
      // still silent, but nothing claims a person is on it.
      await audit({
        tenantId:  conversation.tenant_id,
        actorId:   'clawith:escalate_to_human',
        action:    'escalate_to_human.surface_failed',
        entity:    'conversation',
        entityId:  conversation.id,
        requestId: correlationId,
        meta:      {
          note_posted:   surface.notePosted,
          label_applied: surface.labelApplied,
          status_opened: surface.statusOpened,
          episode:       transition.episode,
        },
      });
    }
  }

  await audit({
    tenantId:  conversation.tenant_id,
    actorId:   'clawith:escalate_to_human',
    action:    'escalate_to_human.invoked',
    entity:    'conversation',
    entityId:  conversation.id,
    requestId: correlationId,
    meta:      {
      already_escalated: alreadyEscalated,
      has_summary:       summary !== null,
      ownership_state:   transition.state,
      ownership_episode: transition.episode,
      claim:             transition.status,
    },
  });

  // Never return the decoded ownership payload (conversation/tenant/binding/
  // inbox id) — status + correlation_id is the entire contract the MCP tool
  // and agent ever see.
  return NextResponse.json({
    ok:             true,
    status:         alreadyEscalated ? 'already_escalated' : 'escalated',
    correlation_id: correlationId,
  });
}
