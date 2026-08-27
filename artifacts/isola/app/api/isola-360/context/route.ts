import { NextRequest, NextResponse } from 'next/server';
import { getSessionFromCookie } from '@/lib/session';
import { getMembershipRole } from '@/lib/permissions';
import { prisma } from '@/lib/prisma';
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings';
import { readCustomer360 } from '@/lib/customer-360/odoo-projection';
import type { ChatwootContextHint } from '@/lib/customer-360/chatwoot-context';
import type { Customer360Response } from '@/lib/customer-360/contracts';

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

function parseHint(value: unknown): ChatwootContextHint | null {
  if (!value || typeof value !== 'object') return null;
  const input = value as Record<string, unknown>;
  const accountIdHint = positiveInt(input.accountIdHint);
  const inboxIdHint = positiveInt(input.inboxIdHint);
  const conversationDisplayIdHint = positiveInt(input.conversationDisplayIdHint);
  return accountIdHint && inboxIdHint && conversationDisplayIdHint
    ? { accountIdHint, inboxIdHint, conversationDisplayIdHint }
    : null;
}

export async function POST(req: NextRequest) {
  const ctx = await getSessionFromCookie(req.headers.get('cookie') ?? '');
  if (!ctx) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const membershipRole = await getMembershipRole(ctx.identityId, ctx.effectiveTenantId);
  const homeOwner = ctx.user.tenant_id === ctx.effectiveTenantId && ctx.isOwner;
  if (!ctx.isAdmin && !homeOwner && !membershipRole) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const hint = parseHint(body?.hint);
  if (!hint) return NextResponse.json({ error: 'Invalid Chatwoot context' }, { status: 400 });

  // The browser supplies locators only. The tenant comes from the Isola session;
  // both the Chatwoot door and conversation must independently belong to it.
  const binding = await prisma.chatwootBinding.findFirst({
    where: {
      tenant_id: ctx.effectiveTenantId,
      account_id: String(hint.accountIdHint),
      inbox_id: String(hint.inboxIdHint),
    },
    select: { id: true },
  });
  if (!binding) {
    return NextResponse.json<Customer360Response>({
      state: 'not-linked',
      message: 'This Chatwoot inbox is not linked to the current Isola workspace.',
    });
  }

  const conversation = await prisma.conversation.findFirst({
    where: {
      tenant_id: ctx.effectiveTenantId,
      chatwoot_conversation_id: hint.conversationDisplayIdHint,
    },
    select: {
      id: true,
      customer_phone: true,
      messages: {
        where: { role: 'user' },
        orderBy: { created_at: 'desc' },
        take: 1,
        select: { content: true },
      },
    },
  });
  if (!conversation) {
    return NextResponse.json<Customer360Response>({
      state: 'not-linked',
      message: 'This conversation has not reached the Isola customer mirror yet.',
    });
  }

  try {
    const config = await resolveOdooConfigForTenant(ctx.effectiveTenantId);
    const snapshot = await readCustomer360(config, conversation.customer_phone, {
      displayId: hint.conversationDisplayIdHint,
      currentRequest: conversation.messages[0]?.content ?? null,
    });
    if (!snapshot) {
      return NextResponse.json<Customer360Response>({
        state: 'not-found',
        message: 'No Odoo customer matched this conversation. Review identity before creating anything.',
      });
    }
    return NextResponse.json<Customer360Response>({ state: 'ready', snapshot });
  } catch {
    return NextResponse.json<Customer360Response>({
      state: 'unavailable',
      message: 'Odoo is not answering. No customer action was attempted.',
    }, { status: 503 });
  }
}
