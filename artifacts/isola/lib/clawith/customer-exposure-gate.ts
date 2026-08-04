/**
 * B2 — the one reusable server-side exposure decision every public/customer
 * dispatch path consults before a Clawith agent is invoked.
 *
 * Called from lib/brain-provider.ts generateReply() — the single chokepoint
 * both live customer paths (app/api/chatwoot/agent-bot/route.ts and the
 * direct WhatsApp webhook via lib/agent.ts) already funnel through — and
 * from app/api/lane2/broker/turn/route.ts, which calls invokeClawithGated()
 * directly and therefore never passes through generateReply().
 *
 * A public invocation is authorized only when ALL of:
 *   1. A Foundation tenant was resolved for this request at all.
 *   2. The requested Foundation Agent is active.
 *   3. A ClawithBinding was resolved AND belongs to that same tenant (never
 *      a cross-tenant binding — same failure class as the 2026-07-01
 *      account-5 incident this codebase has hardened against elsewhere).
 *   4. resolveAgentExposure() classifies the binding's clawith_agent_id as
 *      PUBLIC and enabled for this tenant.
 *
 * Human-takeover ("no human-takeover rule blocks automation") and
 * inbox/channel-binding matching are deliberately NOT re-checked here: both
 * callers already enforce them upstream, before generateReply()/this gate is
 * ever reached (see lib/agent.ts's legacyHumanHandlingSuppresses early
 * return and app/api/chatwoot/agent-bot/route.ts's ownership suppression
 * check; the Chatwoot/inbox binding itself is what resolved the
 * ClawithBinding this gate receives). Re-deriving either here would be a
 * second, possibly-diverging copy of logic this codebase already treats as
 * a single source of truth — this gate's job is the exposure decision only.
 *
 * On denial: the caller must NEVER send the customer's message to the
 * denied agent, and must never silently substitute a different (e.g.
 * INTERNAL) agent. Falling through to the existing native-reply fallback
 * (or, for the gated inbox-46 loop, the existing suppressed/safe-unavailable
 * outcome) is correct — that is the same "existing handoff behaviour" every
 * other Clawith failure mode already produces, so a customer never receives
 * a raw provider/runtime detail because of an exposure refusal.
 */

import { audit } from '../audit';
import { resolveAgentExposure } from './agent-exposure-policy';

export type CustomerDispatchDenialReason =
  | 'no_foundation_tenant'
  | 'agent_inactive'
  | 'no_clawith_binding'
  | 'binding_tenant_mismatch'
  | 'not_public_classified';

export type CustomerDispatchSource = 'direct_whatsapp' | 'chatwoot_a2' | 'lane2_broker';

export interface CustomerDispatchAuthorization {
  allowed: boolean;
  reason: CustomerDispatchDenialReason | null;
}

export interface AuthorizeCustomerDispatchParams {
  /** Foundation's own Tenant.id, resolved from the door (WhatsAppNumber /
   *  ChatwootBinding) that received this message — never a Clawith-side id. */
  foundationTenantId: string;
  requestedFoundationAgentId: string;
  agentActive: boolean;
  /** The resolved ClawithBinding row's identifying fields, or null when none
   *  resolved. */
  clawithBinding: { tenant_id: string; clawith_agent_id: string } | null;
  /** Per-turn correlation id — reused as AuditLog.request_id on denial. */
  correlationId: string;
  source: CustomerDispatchSource;
  /** Non-secret contact reference for the audit actor — never a raw phone
   *  number or other PII (mirrors lib/escalation-ref.ts's contact_ref
   *  discipline). Optional: not every caller has resolved one yet. */
  contactRef?: string | null;
}

async function deny(
  reason: CustomerDispatchDenialReason,
  params: AuthorizeCustomerDispatchParams,
  extra?: Record<string, unknown>,
): Promise<CustomerDispatchAuthorization> {
  await audit({
    tenantId: params.foundationTenantId || undefined,
    actorId: params.contactRef ? `contact:${params.contactRef}` : 'system:clawith',
    action: 'clawith.exposure.customer_denied',
    entity: 'clawith_binding',
    entityId: params.clawithBinding?.clawith_agent_id ?? params.requestedFoundationAgentId ?? undefined,
    requestId: params.correlationId,
    meta: {
      reason,
      source: params.source,
      requestedFoundationAgentId: params.requestedFoundationAgentId || null,
      requestedClawithAgentId: params.clawithBinding?.clawith_agent_id ?? null,
      ...extra,
    },
  });
  return { allowed: false, reason };
}

export async function authorizeCustomerDispatch(
  params: AuthorizeCustomerDispatchParams,
): Promise<CustomerDispatchAuthorization> {
  const { foundationTenantId, agentActive, clawithBinding } = params;

  if (!foundationTenantId?.trim()) {
    return deny('no_foundation_tenant', params);
  }
  if (!agentActive) {
    return deny('agent_inactive', params);
  }
  if (!clawithBinding) {
    return deny('no_clawith_binding', params);
  }
  if (clawithBinding.tenant_id !== foundationTenantId) {
    return deny('binding_tenant_mismatch', params, { bindingTenantId: clawithBinding.tenant_id });
  }

  const resolution = resolveAgentExposure({
    foundationTenantId,
    clawithAgentId: clawithBinding.clawith_agent_id,
  });
  if (!resolution.matched || !resolution.enabled || resolution.classification !== 'PUBLIC') {
    return deny('not_public_classified', params, {
      policyMatched: resolution.matched,
      policyEnabled: resolution.enabled,
      resolvedClassification: resolution.classification,
    });
  }

  return { allowed: true, reason: null };
}
