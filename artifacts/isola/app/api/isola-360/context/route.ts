import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveOdooConfigForTenant } from '@/lib/engine-bindings';
import { readCustomer360, readCustomer360ById } from '@/lib/customer-360/odoo-projection';
import { resolveCaller } from '@/lib/customer-360/route-context';
import type { ChatwootContextHint } from '@/lib/customer-360/chatwoot-context';
import type { Customer360Response } from '@/lib/customer-360/contracts';

/**
 * The customerId door.
 *
 * `tenantId` is the CALLER's, never the body's. It selects which Odoo instance
 * is read, and that is the whole cross-tenant boundary: a customer belonging to
 * another tenant is not hidden from this reader, it is absent from the instance
 * this caller can reach.
 *
 * "Could not ask" and "there is no such customer" stay distinct, because a
 * reader who confuses them concludes the customer does not exist during an
 * outage — the defect this whole workspace exists to prevent.
 */
async function respondForCustomerId(tenantId: string, customerId: number) {
  try {
    const config = await resolveOdooConfigForTenant(tenantId);
    const snapshot = await readCustomer360ById(config, customerId, {
      displayId: null,
      currentRequest: null,
    });
    if (!snapshot) {
      return NextResponse.json<Customer360Response>({
        state: 'not-found',
        message: 'That customer is not available on this workspace.',
      });
    }
    return NextResponse.json<Customer360Response>({ state: 'ready', snapshot });
  } catch {
    return NextResponse.json<Customer360Response>(
      {
        state: 'unavailable',
        message: 'Odoo is not answering, so this customer could not be read.',
      },
      { status: 503 },
    );
  }
}

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
  // WHO is calling, and WHICH tenant they may read. Either door — a browser
  // session cookie, or a per-tenant service token. Neither takes the tenant
  // from anything in the body.
  const resolved = await resolveCaller(req);
  if (!resolved.ok) return resolved.response;
  const caller = resolved.caller;

  const body = await req.json().catch(() => null);

  // TWO LOCATORS, ONE COCKPIT.
  //
  // `customerId` is the portal's door: a customer list emits a locator and the
  // cockpit consumes it (dec-c360-reconcile-...-not-duplicate). `hint` is
  // Chatwoot's. Both name WHICH customer; neither names WHOSE — that is the
  // caller's tenant, resolved above, and it scopes every read below.
  const customerId = positiveInt(body?.customerId);
  if (customerId !== null) {
    return respondForCustomerId(caller.tenantId, customerId);
  }

  const hint = parseHint(body?.hint);
  if (!hint) {
    return NextResponse.json(
      { error: 'Provide either a customerId or a Chatwoot context' },
      { status: 400 },
    );
  }

  // The Chatwoot door is for a signed-in operator inside a conversation. A
  // service token has no conversation, and letting one address a conversation
  // would widen the surface past the read the portal actually needs.
  if (caller.kind !== 'session') {
    return NextResponse.json(
      { error: 'Provide either a customerId or a Chatwoot context' },
      { status: 400 },
    );
  }

  const ctx = { effectiveTenantId: caller.tenantId };

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
