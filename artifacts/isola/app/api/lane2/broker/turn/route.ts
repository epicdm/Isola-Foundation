/**
 * POST /api/lane2/broker/turn
 *
 * Implements the Foundation-side half of
 * `dec-deepseek-foundation-brokered-clawith-refactor-2026-08-02`: the
 * DeepSeek lane2 adapter (thin edge — callback auth, normalization, durable
 * reservation, idempotency, retry, Chatwoot delivery) submits a normalized
 * Chatwoot event here. Foundation, and ONLY Foundation, resolves tenant,
 * agent and business identity, invokes the existing accepted Clawith
 * contract, records audit/correlation, and returns the authoritative
 * outcome. Foundation NEVER calls Chatwoot from this route — delivery stays
 * the adapter's job, gated by the adapter's own OUTBOUND_ENABLED.
 *
 * Independent of the production native-reply path: this route does not
 * import or touch lib/clawith/gate.ts, ISOLA_AI_LOOP_ENABLED, or door 5:46.
 * AgentBot 4 and inbox 46 share no code or state with this file.
 *
 * A caller-supplied agentId/tenantId is not representable in the accepted
 * envelope below by design — the adapter may send transport identifiers
 * (account/inbox/conversation/contact/message ids) but never an identity or
 * permission assertion. Foundation resolves the permitted agent itself from
 * ChatwootBinding + ClawithBinding, the same authoritative rows the existing
 * production a2 path already trusts (lib/chatwoot-binding-resolution.ts).
 *
 * KNOWN, DOCUMENTED SCOPE LIMITS for this bounded release (not silently
 * substituted — flagged so the next release knows exactly what is missing):
 *   1. Agent resolution requires an EXPLICIT ChatwootBinding.agent_id for
 *      mode='lane2'. No implicit tenant-default-agent fallback.
 *   2. UPDATED (xp-foundation-agent-exposure-enforcement-2026-08-04): the
 *      ratified PUBLIC/INTERNAL agent_exposure_policy is now implemented as
 *      a code-level policy source (lib/clawith/agent-exposure-policy.ts) —
 *      not yet the DB-backed table a full admin-manageable release needs
 *      (that migration remains separately authorized and unbuilt). This
 *      route calls the same authorizeCustomerDispatch() gate every
 *      customer/public dispatch path uses (lib/clawith/customer-exposure-
 *      gate.ts) immediately before invokeClawithGated below, so even the
 *      explicitly-bound agent this route already restricted itself to must
 *      also be classified enabled PUBLIC for this tenant.
 *   3. Customer identity resolution is honestly `unavailable` — no Customer/
 *      CRM binding is wired for lane2 conversations yet. Never fabricated.
 *   4. No local Conversation/ownership-state tracking for lane2 turns in
 *      this release — `ownershipState` is fixed at 'AI_OWNED' (the only
 *      state that permits an AI customer reply at all; buildClawithRequest
 *      itself refuses every other value). Human-handoff awareness for lane2
 *      conversations stays adapter-local (ownership-handoff.js) until
 *      Foundation grows a real Conversation record for this path.
 *   5. Idempotent retries return a generic `duplicate_suppressed` outcome,
 *      not the original computed result — no result cache was added to keep
 *      this release migration-free and stateless.
 */

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveActiveBinding } from '@/lib/chatwoot-binding-resolution';
import { claimInboundMessageId } from '@/lib/inbound-dedup';
import { audit } from '@/lib/audit';
import { invokeClawithGated } from '@/lib/clawith/invoke';
import { authorizeCustomerDispatch } from '@/lib/clawith/customer-exposure-gate';
import { isLane2BrokerDoor } from '@/lib/lane2/broker-allowlist';
import {
  readLane2BrokerSignatureHeaders,
  verifyLane2BrokerSignature,
} from '@/lib/lane2/broker-auth';

const LANE2_MODE = 'lane2';
const HANDLED_EVENT_TYPES = new Set(['message_created']);

interface Lane2BrokerEnvelope {
  accountId: string | number;
  inboxId: string | number;
  conversationId: string | number;
  contactId: string | number;
  messageId: string | number;
  message: string;
  eventType: string;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  transportTimestamp?: string | null;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

function validateEnvelope(body: unknown): { ok: true; envelope: Lane2BrokerEnvelope } | { ok: false; field: string } {
  if (!body || typeof body !== 'object') return { ok: false, field: 'body' };
  const b = body as Record<string, unknown>;
  for (const field of ['accountId', 'inboxId', 'conversationId', 'contactId', 'messageId']) {
    const v = b[field];
    if (v === null || v === undefined || (typeof v !== 'string' && typeof v !== 'number')) {
      return { ok: false, field };
    }
    if (typeof v === 'string' && v.trim() === '') return { ok: false, field };
  }
  if (!isNonEmptyString(b.message)) return { ok: false, field: 'message' };
  if (!isNonEmptyString(b.eventType)) return { ok: false, field: 'eventType' };

  return {
    ok: true,
    envelope: {
      accountId: b.accountId as string | number,
      inboxId: b.inboxId as string | number,
      conversationId: b.conversationId as string | number,
      contactId: b.contactId as string | number,
      messageId: b.messageId as string | number,
      message: b.message as string,
      eventType: b.eventType as string,
      correlationId: typeof b.correlationId === 'string' ? b.correlationId : null,
      idempotencyKey: typeof b.idempotencyKey === 'string' ? b.idempotencyKey : null,
      transportTimestamp: typeof b.transportTimestamp === 'string' ? b.transportTimestamp : null,
    },
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawBody = await req.text();

  // ── Auth first, before any parsing of body content or DB work. ──────────
  const { signature, timestamp } = readLane2BrokerSignatureHeaders(req.headers);
  const authResult = verifyLane2BrokerSignature({
    rawBody,
    signature,
    timestamp,
    secret: process.env.LANE2_BROKER_SHARED_SECRET,
  });
  if (!authResult.ok) {
    console.error(`[lane2-broker] auth rejected: ${authResult.reason}`);
    return NextResponse.json({ ok: false, outcome: 'unauthorized' }, { status: 401 });
  }

  let parsedBody: unknown;
  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch {
    return NextResponse.json({ ok: false, outcome: 'malformed_body' }, { status: 400 });
  }

  const validated = validateEnvelope(parsedBody);
  if (!validated.ok) {
    return NextResponse.json(
      { ok: false, outcome: 'invalid_envelope', field: validated.field },
      { status: 400 },
    );
  }
  const envelope = validated.envelope;

  // All other event types: acknowledged, not processed — mirrors the
  // existing webhook convention (app/api/chatwoot/agent-bot/route.ts).
  if (!HANDLED_EVENT_TYPES.has(envelope.eventType)) {
    return NextResponse.json({ ok: true, outcome: 'ignored_event_type' }, { status: 200 });
  }

  // ── Door allowlist — independent of the production native-reply gate. ──
  if (!isLane2BrokerDoor(envelope.accountId, envelope.inboxId)) {
    return NextResponse.json({ ok: false, outcome: 'door_not_allowed' }, { status: 200 });
  }

  // ── Idempotency — duplicate Chatwoot events must create ONE invocation. ─
  const dedupeKey = envelope.idempotencyKey ?? String(envelope.messageId);
  const alreadyClaimed = await claimInboundMessageId(`lane2:${dedupeKey}`);
  if (alreadyClaimed) {
    return NextResponse.json(
      { ok: true, outcome: 'duplicate_suppressed', duplicate: true },
      { status: 200 },
    );
  }

  const correlationId = envelope.correlationId?.trim() || `lane2-${dedupeKey}`;

  // ── Tenant resolution — authoritative, from Foundation's own bindings. ──
  // The adapter's accountId/inboxId are transport hints only; they select
  // WHICH registration to look up, never which identity to trust.
  const bindings = await prisma.chatwootBinding.findMany({
    where: { inbox_id: String(envelope.inboxId), mode: LANE2_MODE },
    include: { tenant: true, agent: true },
  });
  const binding = resolveActiveBinding(bindings);

  if (!binding || binding.tenant.status !== 'active') {
    await audit({
      actorId: 'lane2-broker',
      tenantId: binding?.tenant.id,
      action: 'lane2.broker.turn.refused',
      entity: 'chatwoot_binding',
      requestId: correlationId,
      meta: { outcome: 'tenant_unresolved', accountId: envelope.accountId, inboxId: envelope.inboxId },
    });
    return NextResponse.json({ ok: false, outcome: 'tenant_unresolved', correlationId }, { status: 200 });
  }
  const tenant = binding.tenant;

  // ── Agent resolution — explicit binding only, never a fallback guess. ──
  const agent = binding.agent;
  if (!agent || !agent.is_active || agent.brain_provider !== 'clawith') {
    await audit({
      actorId: 'lane2-broker',
      tenantId: tenant.id,
      action: 'lane2.broker.turn.refused',
      entity: 'chatwoot_binding',
      entityId: binding.id,
      requestId: correlationId,
      meta: { outcome: 'agent_unresolved' },
    });
    return NextResponse.json({ ok: false, outcome: 'agent_unresolved', correlationId }, { status: 200 });
  }

  // ── Clawith identity — the SAME binding the existing a2 path trusts. ───
  const clawithBinding =
    (await prisma.clawithBinding.findFirst({ where: { tenant_id: tenant.id, agent_id: agent.id } })) ??
    (await prisma.clawithBinding.findFirst({ where: { tenant_id: tenant.id, agent_id: null } }));

  if (!clawithBinding) {
    await audit({
      actorId: 'lane2-broker',
      tenantId: tenant.id,
      action: 'lane2.broker.turn.refused',
      entity: 'agent',
      entityId: agent.id,
      requestId: correlationId,
      meta: { outcome: 'clawith_binding_unresolved' },
    });
    return NextResponse.json({ ok: false, outcome: 'clawith_binding_unresolved', correlationId }, { status: 200 });
  }

  // ── B2: Foundation-owned customer exposure gate ─────────────────────────
  // This route bypasses lib/brain-provider.ts's generateReply() (it invokes
  // invokeClawithGated directly), so it is a second explicit call site for
  // the same reusable exposure decision — not a duplicate policy, one
  // resolver (lib/clawith/agent-exposure-policy.ts) consulted from every
  // customer/public dispatch shape this codebase has.
  const dispatchAuth = await authorizeCustomerDispatch({
    foundationTenantId: tenant.id,
    requestedFoundationAgentId: agent.id,
    agentActive: agent.is_active,
    clawithBinding: { tenant_id: clawithBinding.tenant_id, clawith_agent_id: clawithBinding.clawith_agent_id },
    correlationId,
    source: 'lane2_broker',
    contactRef: String(envelope.contactId),
  });
  if (!dispatchAuth.allowed) {
    return NextResponse.json(
      { ok: false, outcome: 'exposure_denied', reason: dispatchAuth.reason, correlationId },
      { status: 200 },
    );
  }

  // ── Invoke the existing, accepted, fail-closed Clawith contract. ───────
  const outcome = await invokeClawithGated({
    tenantId: tenant.id,
    bindingTenantId: tenant.id,
    conversationTenantId: tenant.id,
    businessId: clawithBinding.paperclip_company_id,
    chatwootAccountId: String(envelope.accountId),
    inboxId: String(envelope.inboxId),
    conversationId: String(envelope.conversationId),
    inboundMessageId: String(envelope.messageId),
    contactRef: String(envelope.contactId),
    customerMessage: envelope.message,
    history: [],
    designatedAgentId: clawithBinding.clawith_agent_id,
    ownershipState: 'AI_OWNED',
    correlationId,
  });

  await audit({
    actorId: 'lane2-broker',
    tenantId: tenant.id,
    action: 'lane2.broker.turn',
    entity: 'conversation',
    entityId: String(envelope.conversationId),
    requestId: correlationId,
    meta: {
      outcome: outcome.kind,
      accountId: envelope.accountId,
      inboxId: envelope.inboxId,
      agentId: clawithBinding.clawith_agent_id,
      needsHandoff: outcome.needsHandoff,
    },
  });

  return NextResponse.json(
    {
      ok: outcome.kind !== 'safe_unavailable' && outcome.kind !== 'suppressed',
      outcome: outcome.kind,
      correlationId,
      tenantId: tenant.id,
      agentId: clawithBinding.clawith_agent_id,
      // Explicit, honest state — never fabricated. See scope-limit #3 above.
      customerId: null,
      customerState: 'unavailable',
      text: outcome.text,
      needsHandoff: outcome.needsHandoff,
    },
    { status: 200 },
  );
}
