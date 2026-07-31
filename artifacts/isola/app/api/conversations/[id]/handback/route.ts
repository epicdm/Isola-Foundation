/**
 * POST /api/conversations/[id]/handback — the explicit authorized action that
 * returns a conversation from a human to the AI.
 *
 * Implements the HANDBACK clause of
 * `dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29`.
 *
 * THIS ENDPOINT EXISTS BECAUSE RESOLUTION NO LONGER DOES THIS.
 * Before Commit 2, closing a Chatwoot conversation cleared
 * `human_handling` and the AI silently resumed. Handback is now a
 * deliberate act with an actor, an episode, a reconciliation step and a
 * record — and this route is the only way a dashboard user can perform it.
 *
 * Authorization is two-layer and both layers must pass:
 *   1. A valid Foundation session for the conversation's tenant
 *      (getSessionFromCookie → effectiveTenantId), and the caller must be a
 *      tenant owner or admin. A signed-in user of ANOTHER tenant cannot see
 *      the conversation at all — the lookup is tenant-scoped.
 *   2. `authorizeHandback()` (lib/ownership/authorize.ts), an allow-list of
 *      actor KINDS. A Chatwoot resolution and a Clawith tool call are
 *      enumerated there as explicitly unauthorized, so neither can acquire
 *      handback power by being added as a caller later.
 *
 * Idempotent on `operation_id`: replaying the same request returns
 * `already_applied` and resumes nothing a second time.
 *
 * The response body carries a status and the resulting ownership state. It
 * never carries a token, a Chatwoot credential, or the reconciliation
 * internals.
 */

import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { getSessionFromCookie } from '@/lib/session';
import { prisma } from '@/lib/prisma';
import { audit } from '@/lib/audit';
import { executeHandback } from '@/lib/ownership/handback';
import type { HandbackActor } from '@/lib/ownership/authorize';

/** Maps a handback outcome to an HTTP status. A refusal is a 4xx so a caller
 *  cannot mistake "we declined to resume the AI" for "resumed". */
const STATUS_CODE: Record<string, number> = {
  resumed: 200,
  already_applied: 200,
  not_authorized: 403,
  stale_episode: 409,
  illegal_state: 409,
  unknown_conversation: 404,
  reconciliation_failed: 409,
};

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const correlationId = crypto.randomUUID();

  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) {
    return NextResponse.json({ ok: false, error: 'Unauthorized', correlation_id: correlationId }, { status: 401 });
  }

  const { id } = await params;

  let body: Record<string, unknown> = {};
  try { body = (await req.json()) as Record<string, unknown>; } catch { /* empty body */ }

  const episode = typeof body.episode === 'number' && Number.isInteger(body.episode) && body.episode >= 0
    ? body.episode
    : null;
  const operationId = typeof body.operation_id === 'string' && body.operation_id.trim()
    ? body.operation_id.trim().slice(0, 200)
    : null;
  const reason = typeof body.reason === 'string' && body.reason.trim()
    ? body.reason.trim().slice(0, 500)
    : undefined;

  if (episode === null) {
    return NextResponse.json({ ok: false, error: 'episode required', correlation_id: correlationId }, { status: 400 });
  }
  if (!operationId) {
    return NextResponse.json({ ok: false, error: 'operation_id required', correlation_id: correlationId }, { status: 400 });
  }

  // Tenant-scoped lookup: a session for another tenant simply cannot reach
  // this conversation, so cross-tenant handback is not a check that can be
  // forgotten — it is structurally impossible here.
  const conversation = await prisma.conversation.findFirst({
    where: { id, tenant_id: ctx.effectiveTenantId },
    select: { id: true, tenant_id: true },
  });
  if (!conversation) {
    return NextResponse.json({ ok: false, error: 'not_found', correlation_id: correlationId }, { status: 404 });
  }

  // Only owner/admin map to an authorized actor kind. Everyone else is
  // 'staff', which the allow-list refuses — the refusal is expressed once,
  // in lib/ownership/authorize.ts, not duplicated here.
  const actor: HandbackActor = {
    kind: ctx.isOwner ? 'owner' : ctx.isAdmin ? 'admin' : 'staff',
    ref: `user:${ctx.user.id}`,
    tenantId: ctx.effectiveTenantId,
  };

  const result = await executeHandback({
    tenantId: conversation.tenant_id,
    conversationId: conversation.id,
    episode,
    operationId,
    actor,
    reason,
    correlationId,
  });

  await audit({
    tenantId: conversation.tenant_id,
    actorId: actor.ref,
    action: `conversation.handback.${result.status}`,
    entity: 'conversation',
    entityId: conversation.id,
    requestId: correlationId,
    meta: {
      episode,
      operation_id: operationId,
      resulting_state: result.state,
      resumed_now: result.resumedNow,
      detail: result.detail,
    },
  });

  return NextResponse.json(
    {
      ok: result.ok,
      status: result.status,
      ownership_state: result.state,
      episode: result.episode,
      detail: result.detail,
      correlation_id: correlationId,
    },
    { status: STATUS_CODE[result.status] ?? 500 },
  );
}
