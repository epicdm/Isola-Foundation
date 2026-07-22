/**
 * Opaque per-turn escalation reference for the public Clawith agent (EMA).
 *
 * The agent is never handed a raw conversation/tenant/account/inbox id.
 * Instead, each time a turn is routed through the Isola bridge (see
 * tryIsolaBridge() in brain-provider.ts), Foundation mints a short-lived
 * opaque token scoped as a capability to exactly one purpose
 * ("escalate_to_human"), tenant, Clawith agent, ChatwootBinding, inbox and
 * Conversation. The bridge hands ONLY that token (plus a non-secret
 * correlation id for tracing) to the agent as part of its per-turn runtime
 * instruction (isola_bridge.py's existing caller_directive channel — the
 * same mechanism already used to hand the agent the caller's verified phone
 * number, never a hidden tool argument the agent could omit or forge).
 *
 * /api/customer/escalate resolves ownership from this token alone and
 * re-checks every bound field against the conversation's CURRENT state,
 * failing closed on any mismatch (cross-tenant, cross-agent, cross-binding,
 * cross-inbox, wrong purpose, expired). It never trusts a client-supplied
 * conversation/tenant/account/inbox id.
 *
 * IMPORTANT — this is a scoped capability, not an independent agent
 * credential: possession of a valid, unexpired token proves the bearer was
 * handed THIS exact reference for THIS exact turn, but mcp-isola-customer-
 * tools still authenticates every call with one shared bearer token for
 * every tenant/agent (def-clawith-escalation-shared-token-no-agent-principal-
 * 2026-07-21). Do not document or treat a valid token as proof of caller
 * identity beyond that.
 */
import { randomBytes, randomUUID } from 'crypto';
import { prisma } from './prisma';
import { ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS } from './brain-provider';

const ESCALATION_REF_TTL_MS = 15 * 60 * 1000; // 15 min — one agent turn, generously bounded
const ESCALATE_TO_HUMAN_PURPOSE = 'escalate_to_human';

export interface CreateEscalationRefParams {
  tenantId: string;
  conversationId: string;
  /** ClawithBinding.clawith_agent_id resolved for THIS turn — snapshotted so a
   *  later agent rebind can be detected and rejected on resolve. */
  clawithAgentId: string;
  /** Conversation.chatwoot_binding_id snapshot — must still match on resolve. */
  chatwootBindingId: string;
  /** Conversation.chatwoot_inbox_id snapshot — must still match on resolve
   *  when both the ref and the conversation carry one. */
  chatwootInboxId: string | null;
}

export interface EscalationRefMint {
  /** The opaque capability itself — handed to the agent, never logged/returned to the customer. */
  token: string;
  /** Non-secret per-turn trace id — safe to log/forward, never usable to resolve the ref. */
  correlationId: string;
}

export async function createEscalationRef(params: CreateEscalationRefParams): Promise<EscalationRefMint> {
  const token = randomBytes(32).toString('base64url'); // 256-bit opaque reference
  const correlationId = randomUUID();
  await prisma.escalationRef.create({
    data: {
      purpose:             ESCALATE_TO_HUMAN_PURPOSE,
      tenant_id:           params.tenantId,
      conversation_id:     params.conversationId,
      clawith_agent_id:    params.clawithAgentId,
      chatwoot_binding_id: params.chatwootBindingId,
      chatwoot_inbox_id:   params.chatwootInboxId,
      correlation_id:      correlationId,
      token,
      expires_at:          new Date(Date.now() + ESCALATION_REF_TTL_MS),
    },
  });
  return { token, correlationId };
}

export interface MintEscalationRefIfAllowedParams extends CreateEscalationRefParams {
  /** Meta phone_number_id for this turn — gates the mint via
   *  ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS (see brain-provider.ts doc
   *  comment). brain_provider='clawith' + a resolved ClawithBinding means a
   *  tenant/number is on Clawith; it does NOT mean the EscalationRef
   *  hardening migration + bridge patches are deployed for that number —
   *  those are two independent readiness axes, and conflating them crashed
   *  every inbound message on an already-live Clawith number with
   *  `column EscalationRef.purpose does not exist`
   *  (defect-foundation-migration-resolved-without-execution-2026-07-22). */
  phoneNumberId: string;
}

/** Mints an EscalationRef only when phoneNumberId is on the allowlist;
 *  otherwise skips the mint and returns nulls — never throws. Callers
 *  should treat a null token exactly like the pre-existing "no Clawith
 *  binding" case: the turn proceeds without a conversationRef. */
export async function mintEscalationRefIfAllowed(
  params: MintEscalationRefIfAllowedParams,
): Promise<{ token: string | null; correlationId: string | null }> {
  if (!ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS.has(params.phoneNumberId)) {
    console.warn(
      `[escalation-ref] phone_number_id ${params.phoneNumberId || '(none)'} is not on the escalation-ref allowlist — skipping EscalationRef mint, no conversationRef this turn`,
    );
    return { token: null, correlationId: null };
  }
  const { phoneNumberId: _phoneNumberId, ...mintParams } = params;
  return createEscalationRef(mintParams);
}

export interface ResolvedEscalationRef {
  purpose: string;
  tenantId: string;
  conversationId: string;
  clawithAgentId: string;
  chatwootBindingId: string;
  chatwootInboxId: string | null;
  correlationId: string;
}

/** Resolves a token to its full bound scope, or null if unknown/expired.
 *  Callers MUST still re-check every field against current state — this
 *  only proves the token exists and hasn't expired, not that the scope it
 *  names is still valid (e.g. the conversation's binding may have changed
 *  since mint). Never log or return this object's contents to the customer. */
export async function resolveEscalationRef(token: string): Promise<ResolvedEscalationRef | null> {
  const row = await prisma.escalationRef.findUnique({ where: { token } });
  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) return null;
  return {
    purpose:           row.purpose,
    tenantId:          row.tenant_id,
    conversationId:    row.conversation_id,
    clawithAgentId:    row.clawith_agent_id,
    chatwootBindingId: row.chatwoot_binding_id,
    chatwootInboxId:   row.chatwoot_inbox_id,
    correlationId:     row.correlation_id,
  };
}
