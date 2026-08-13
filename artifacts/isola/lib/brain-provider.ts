/**
 * Brain-provider abstraction.
 *
 * Per-tenant choice of reply runtime:
 *   native  (default) → lib/ai.ts chatComplete() — Anthropic Claude, unchanged.
 *   flowise           → external self-hosted Flowise chatflow, called over HTTP.
 *   hermes            → external CC-owned Hermes agent, routed through bff-v2, called over HTTP.
 *   clawith           → Clawith, called DIRECTLY (no bff-v2 hop). The contained v1.11.0
 *                       tryIsolaBridge() is the DEFAULT for every clawith number
 *                       (2026-07-18 legacy retirement). tryClawithLegacy() (original
 *                       runtime.epic.dm/api/internal/dispatch contract) is retained ONLY as an
 *                       env-gated rollback (ISOLA_LEGACY_CLAWITH_FALLBACK=1) and is never
 *                       reached by default. ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS documents the
 *                       always-on contained floor (allowlisted numbers can never regress to legacy).
 *
 * Contract: generateReply() ALWAYS resolves — it never throws. Any Flowise,
 * Hermes, or Clawith failure (timeout, non-2xx, empty text, network error)
 * falls back to the native runtime transparently so callers (the agent-bot
 * route, the direct WhatsApp webhook handler) do not need to know which
 * provider actually answered.
 *
 * This module wraps lib/ai.ts; it does not modify it. lib/engines.ts is
 * untouched — Flowise/Hermes are not "setup checklist" engines, they're a
 * per-tenant reply runtime choice.
 *
 * HERMES PER-NUMBER GATE: hermes is only ever attempted for phone_number_ids
 * in HERMES_ALLOWED_PHONE_NUMBER_IDS below. This is a deliberate second gate
 * on top of the agent's brain_provider column — the same shared-WABA app-level
 * webhook risk documented for the EMA sales number (see memory: "the 3742
 * trap") means a tenant-scoped column alone is not defense enough; a
 * hardcoded allowlist keyed on the Meta-issued phone_number_id ensures
 * flipping one tenant to hermes can never affect another number, even by
 * misconfiguration.
 */

import { chatComplete, TIER_MODELS } from './ai';
import { decryptSecret } from './tenant-secrets';
import { prisma } from './prisma';
import { guardReply, SALES_TENANT_IDS, DEFLECTION as GUARD_ERROR_DEFLECTION } from './claim-guard';
import { detectEscalationIntent } from './escalation-intent';
import { detectEscalationClaim } from './escalation-claim';
import { detectProviderFailure } from './provider-failure';
import { recordClawithFailure } from './clawith/alert';
import { ClawithFailure } from './clawith/errors';
import { audit } from './audit';
import { isAiLoopGatedDoor } from './clawith/gate';
import type { OwnershipState } from './ownership/state';
import { invokeClawithGated } from './clawith/invoke';
import type { ClawithFailureRecord } from './clawith/invoke';
import type { ClawithToolDefinition } from './clawith/contract';
import { authorizeCustomerDispatch } from './clawith/customer-exposure-gate';
import type { CustomerDispatchAuthorization } from './clawith/customer-exposure-gate';

const FLOWISE_TIMEOUT_MS = 20_000;
// Hermes agent replies in ~10-45s; 50s gives headroom before falling back to
// native so a slow-but-healthy reply is never mistaken for a dead endpoint.
const HERMES_TIMEOUT_MS = 50_000;

/** Generalized Hermes endpoint (non-secret) — ONE path for every hermes
 * number. The endpoint itself resolves which account/persona to use from
 * the `phone_number_id` in the request body (per CC: 975632242309171 +
 * 294957850360835 → epic-business, 1023804347491554 → ema-customer).
 * Going live for a new number is just adding its phone_number_id to
 * HERMES_ALLOWED_PHONE_NUMBER_IDS below plus flipping that tenant's
 * Agent.brain_provider — never a separate URL configuration step, and
 * still gated by the allowlist regardless of this default. Superseded the
 * former EMA-specific `/api/internal/ema/invoke` path (2026-07-13) — every
 * hermes number, including EMA, now calls this same URL. */
const DEFAULT_HERMES_AGENT_URL = 'https://bff.epic.dm/api/internal/agent/invoke';

/** Only these Meta phone_number_ids may ever be routed to Hermes. */
export const HERMES_ALLOWED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  '1023804347491554', // EMA sales / onboarding number, +17678180001
  '975632242309171',  // EPIC main, +17678183742
  '294957850360835',  // EPIC FB-linked, +17672851568 — inbound-reply only, see epic-seed-data.ts
]);

/**
 * The always-on floor of Meta phone_number_ids routed to the new v1.11.0
 * Isola bridge (tryIsolaBridge). Every other clawith-provider number falls
 * through to tryClawithLegacy (the original runtime.epic.dm/api/internal/
 * dispatch contract) unchanged — this is the per-number cutover gate so
 * flipping the bridge live for one number can never affect another tenant's
 * already-working clawith integration (mirrors HERMES_ALLOWED_PHONE_NUMBER_IDS
 * above, same rationale).
 */
const _BRIDGE_ALLOWED_HARDCODED: readonly string[] = [
  '1023804347491554', // EMA sales / onboarding number, +17678180001 — v1.11.0 cutover
  '278390858690809',  // EPIC 295-6737, +17672956737 — v1.11.0 contained cutover (2026-07-18)
];

/**
 * Additional Meta phone_number_ids may be added at runtime via the
 * ISOLA_BRIDGE_ALLOWED_PNIDS env var (comma-separated) so a future number
 * goes live on the contained bridge with only a Replit Secret + restart —
 * no code deploy. The hardcoded list above is the always-on floor; env
 * entries are additive and never remove a hardcoded one.
 */
export const ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  ..._BRIDGE_ALLOWED_HARDCODED,
  ...(process.env.ISOLA_BRIDGE_ALLOWED_PNIDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
]);

/**
 * Per-number gate for the hardened EscalationRef mint (lib/escalation-ref.ts
 * createEscalationRef). That mint requires migration
 * 20260721020000_harden_escalation_ref (EscalationRef.purpose/
 * clawith_agent_id/chatwoot_binding_id/chatwoot_inbox_id/correlation_id) to
 * exist on the target database, plus the clawith-v1110 bridge/MCP patches
 * under patches/clawith-v1110/ to be applied on deepseek — none of that has
 * shipped yet (see patches/clawith-v1110/README.md "Deployment order").
 * Deliberately empty until that rollout lands: a Clawith-bound tenant/number
 * existing today (brain_provider='clawith' + ClawithBinding resolved) is a
 * separate, already-live axis from "is the escalation-ref hardening ready,"
 * and conflating the two crashed every inbound message on an already-live
 * Clawith number with `column EscalationRef.purpose does not exist`.
 * Mirrors HERMES_ALLOWED_PHONE_NUMBER_IDS / ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS
 * above: hardcoded floor + additive env var, so going live needs no code deploy.
 */
const _ESCALATION_REF_ALLOWED_HARDCODED: readonly string[] = [
  // deliberately empty — do not add a phone_number_id here until migration
  // 20260721020000_harden_escalation_ref is applied against production AND
  // the clawith-v1110 bridge/MCP patches are live for that number.
];

export const ESCALATION_REF_ALLOWED_PHONE_NUMBER_IDS: ReadonlySet<string> = new Set([
  ..._ESCALATION_REF_ALLOWED_HARDCODED,
  ...(process.env.ESCALATION_REF_ALLOWED_PNIDS?.split(',').map((s) => s.trim()).filter(Boolean) ?? []),
]);

export interface BrainReplyResult {
  text: string;
  tokensUsed: number;
  model: string;
  /** Which runtime actually produced the reply — 'native' may be a fallback. */
  provider: 'native' | 'flowise' | 'hermes' | 'clawith';
  /** True when the brain flagged this conversation for human review. Only
   * Clawith emits this today; threaded through generically so callers
   * (the agent-bot route) can surface it regardless of which provider set it. */
  needsHandoff?: boolean;
  /** Opaque action payload some providers may return alongside the reply.
   * Not acted on by Foundation today — this socket remains text-only I/O. */
  actions?: unknown;
  /** GATED AI-LOOP ONLY. True when Foundation must send the customer NOTHING
   *  this turn — a recorded failure or a tool-only turn. Never set while the
   *  ISOLA_AI_LOOP_ENABLED gate is off, so no existing caller can observe it.
   *  Callers that ignore it fall back to the pre-existing `if (!reply) return`
   *  behaviour, which is the same outcome by a weaker route. */
  suppressCustomerReply?: boolean;
  /** GATED AI-LOOP ONLY. The classified Clawith failure behind a safe
   *  unavailability reply or a suppressed turn. Present ONLY when the brain
   *  genuinely failed — its absence on a `provider:'clawith'` result means
   *  Clawith actually answered. */
  clawithFailure?: ClawithFailureRecord;
}

/** GATED AI-LOOP ONLY. The conversation-identifying context the structured
 *  contract requires and the legacy text bridge never carried. Optional on
 *  purpose: every existing caller of generateReply() omits it and is therefore
 *  bit-for-bit unaffected. */
export interface GatedLoopContext {
  chatwootAccountId: string;
  inboxId: string | null;
  /** Tenant recorded on the ChatwootBinding that received this message. */
  bindingTenantId: string;
  /** Tenant recorded on the local Conversation row. */
  conversationTenantId: string;
  conversationId: string;
  inboundMessageId: string;
  contactRef: string;
  businessId: string;
  knowledgeScopeIds?: string[];
  /** Tools Foundation will authorise THIS turn. Empty until Commit 3. */
  allowedTools?: ClawithToolDefinition[];
  /**
   * The conversation's AUTHORITATIVE ownership state, read from
   * Conversation.ownership_state (Commit 2). Required, not defaulted: a
   * caller that cannot say who owns the conversation must not be able to get
   * a customer-facing turn by omission. buildClawithRequest() rejects every
   * non-AI state, so a HUMAN state reaching here fails the request closed
   * rather than producing a reply into a conversation a person owns.
   */
  ownershipState: OwnershipState;
  timezone?: string;
  locale?: string;
}

export interface BrainAgent {
  id: string;
  intelligence_tier: string;
  brain_provider: string;       // 'native' | 'flowise' | 'hermes' | 'clawith'
  flowise_flow_id: string | null;
  /** Required for the B2 customer exposure gate (an inactive agent is never
   *  an authorized dispatch target, regardless of classification). */
  is_active: boolean;
}

/** Tenant's Clawith identity, resolved from the ClawithBinding table. */
export interface ClawithBindingInput {
  /** ClawithBinding.tenant_id — required so the B2 exposure gate can prove
   *  this binding belongs to the SAME Foundation tenant as `tenantId` below,
   *  not just that some binding was resolved. */
  tenant_id: string;
  clawith_agent_id: string;
  paperclip_agent_id: string;
  paperclip_company_id: string;
}

/** Tenant's Odoo connection, resolved from the OdooBinding table.
 *  When present, passed to Clawith so it uses the tenant's own Odoo
 *  instead of its hardcoded sandbox credentials. */
export interface OdooBindingInput {
  url: string;
  db: string;
  login: string | null;
  /** Plaintext API key — caller must decrypt before passing here. */
  password: string;
}

/**
 * Generate a reply for one incoming message, honoring the agent's configured
 * brain_provider with strict fallback-to-native on any Flowise/Hermes failure.
 */
export async function generateReply(params: {
  agent: BrainAgent;
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  /** Stable per-conversation key so Flowise/Hermes memory keeps context. Also used
   *  as the AuditLog entity_id when the claim-guard blocks a reply below. */
  sessionId: string;
  /** Meta phone_number_id this reply is being generated for — required for the hermes per-number gate. */
  phoneNumberId: string;
  /** E.164 sender phone, forwarded verbatim to Hermes/Clawith. */
  senderPhone: string;
  /** Tenant id — scopes the claim-guard (see lib/claim-guard.ts) to the sales tenants only. */
  tenantId: string;
  /** Tenant's Clawith identity — required for brain_provider='clawith'; null/absent falls back to native. */
  clawithBinding?: ClawithBindingInput | null;
  /** Tenant's Odoo connection — when present, Clawith uses the tenant's own Odoo instead of its sandbox. */
  odooBinding?: OdooBindingInput | null;
  /** Opaque per-turn escalation ref (lib/escalation-ref.ts), forwarded to the
   *  Isola bridge only — null/absent for every non-clawith provider. */
  conversationRef?: string | null;
  /** Non-secret correlation id minted alongside conversationRef — forwarded to
   *  the Isola bridge for cross-system tracing. Never used to resolve
   *  ownership; distinct from conversationRef itself. */
  escalationCorrelationId?: string | null;
  /** GATED AI-LOOP ONLY — see GatedLoopContext. Absent for every existing caller. */
  gatedLoop?: GatedLoopContext | null;
}): Promise<BrainReplyResult> {
  const { agent, system, messages, sessionId, phoneNumberId, senderPhone, tenantId, clawithBinding, odooBinding, conversationRef, escalationCorrelationId, gatedLoop } = params;
  const model = TIER_MODELS[agent.intelligence_tier] ?? TIER_MODELS['standard'];

  let result: BrainReplyResult | null = null;
  /** Set only on the gated inbox-46 path. While true, the native fallback
   *  below is UNREACHABLE — that is the entire point of §6. */
  let gatedFailClosed = false;

  // ── B2: Foundation-owned customer exposure gate ──────────────────────────
  // Decided ONCE, before either Clawith call shape below runs — this makes
  // generateReply() the single reusable choke point B2 requires for both
  // live customer paths (the Chatwoot A2 webhook and the direct WhatsApp
  // webhook), since both funnel every clawith turn through this function.
  // A denial never throws and never picks a different agent — it only
  // withholds the clawithBinding this turn would otherwise have used.
  let clawithDispatch: CustomerDispatchAuthorization = { allowed: true, reason: null };
  if (agent.brain_provider === 'clawith') {
    // Called even when clawithBinding is null: the gate's own
    // 'no_clawith_binding' denial (lib/clawith/customer-exposure-gate.ts)
    // is what gives THIS failure mode an audit entry too — previously a
    // missing binding fell straight to the console.warn below with no B4
    // evidence at all.
    clawithDispatch = await authorizeCustomerDispatch({
      foundationTenantId: tenantId,
      requestedFoundationAgentId: agent.id,
      agentActive: agent.is_active,
      clawithBinding: clawithBinding
        ? { tenant_id: clawithBinding.tenant_id, clawith_agent_id: clawithBinding.clawith_agent_id }
        : null,
      correlationId: escalationCorrelationId ?? `corr-${sessionId}`,
      source: gatedLoop ? 'chatwoot_a2' : 'direct_whatsapp',
      contactRef: gatedLoop?.contactRef ?? null,
    });
    if (!clawithDispatch.allowed) {
      console.warn(
        `[brain-provider] customer exposure gate DENIED clawith dispatch (reason=${clawithDispatch.reason}) ` +
          `tenant=${tenantId} clawith_agent=${clawithBinding?.clawith_agent_id ?? '(none)'}`,
      );
    }
  }

  if (agent.brain_provider === 'flowise' && agent.flowise_flow_id) {
    const flowiseResult = await tryFlowise({
      flowId: agent.flowise_flow_id,
      messages,
      sessionId,
    });
    if (flowiseResult) {
      result = { ...flowiseResult, model: `flowise:${agent.flowise_flow_id}` };
    } else {
      console.warn('[brain-provider] Flowise failed — falling back to native for this reply');
    }
  }

  // ── HERMES IS RETIRED. ────────────────────────────────────────────────────
  //
  // `dec-one-clawith-runtime-two-isolated-domains-2026-07-30` makes Clawith the
  // only agent runtime. A tenant row may still carry `brain_provider='hermes'`
  // — that is stored data, not a live capability — so the value is honoured by
  // being REFUSED here rather than by silently reaching a frozen platform.
  //
  // Deliberately not deleted-and-forgotten: leaving the branch in place with a
  // loud log is how an operator learns that a row still names a runtime that no
  // longer exists. Deleting it would make those tenants silently native with no
  // signal that anything needed repointing.
  if (!result && agent.brain_provider === 'hermes') {
    console.warn(
      `[brain-provider] brain_provider=hermes is RETIRED (one-runtime decision) — phone_number_id ${phoneNumberId} answered natively; repoint this tenant to clawith`,
    );
  }

  // ── GATED AI-LOOP PATH (default OFF) ──────────────────────────────────────
  // Reached only when ISOLA_AI_LOOP_ENABLED === 'true' AND this exact
  // Chatwoot account/inbox door is listed. With the gate off this whole block
  // is dead code and behaviour below is byte-for-byte what shipped before.
  //
  // Inside it there is no `native` branch at all. Between 2026-07-25 00:34Z
  // and this commit, every inbox-46 message reached the bridge, was rejected
  // 401, and was answered by native Claude — a working-looking EPIC agent that
  // was not EPIC's agent. A brain outage has to look like an outage.
  if (
    !result &&
    agent.brain_provider === 'clawith' &&
    gatedLoop &&
    isAiLoopGatedDoor(gatedLoop.chatwootAccountId, gatedLoop.inboxId)
  ) {
    gatedFailClosed = true;

    if (!clawithDispatch.allowed) {
      // Exposure denial on the gated path resolves exactly like every other
      // gated-path failure: suppressed, never a native reply — §6's "no
      // fourth branch, and in particular no native one" applies here too.
      return {
        text: '',
        tokensUsed: 0,
        model: 'clawith',
        provider: 'clawith',
        needsHandoff: false,
        suppressCustomerReply: true,
        clawithFailure: {
          kind: 'agent_missing',
          detail: `exposure denied: ${clawithDispatch.reason}`,
          status: null,
          correlationId: escalationCorrelationId ?? '',
          conversationId: gatedLoop.conversationId,
          inboundMessageId: gatedLoop.inboundMessageId,
        },
      };
    }

    const outcome = await invokeClawithGated({
      tenantId,
      bindingTenantId: gatedLoop.bindingTenantId,
      conversationTenantId: gatedLoop.conversationTenantId,
      businessId: gatedLoop.businessId,
      chatwootAccountId: gatedLoop.chatwootAccountId,
      inboxId: gatedLoop.inboxId ?? '',
      conversationId: gatedLoop.conversationId,
      inboundMessageId: gatedLoop.inboundMessageId,
      contactRef: gatedLoop.contactRef,
      customerMessage: [...messages].reverse().find((m) => m.role === 'user')?.content ?? '',
      history: messages,
      designatedAgentId: clawithBinding?.clawith_agent_id ?? '',
      knowledgeScopeIds: gatedLoop.knowledgeScopeIds,
      allowedTools: gatedLoop.allowedTools,
      // The authoritative episode state, supplied by the caller from
      // Conversation.ownership_state. buildClawithRequest() refuses any state
      // that does not permit an AI customer reply.
      ownershipState: gatedLoop.ownershipState,
      correlationId: escalationCorrelationId ?? `corr-${sessionId}-${gatedLoop.inboundMessageId}`,
      locale: gatedLoop.locale,
      timezone: gatedLoop.timezone,
    });

    if (outcome.kind === 'suppressed') {
      return {
        text: '',
        tokensUsed: 0,
        model: 'clawith',
        provider: 'clawith',
        needsHandoff: false,
        suppressCustomerReply: true,
        clawithFailure: outcome.failure,
      };
    }

    result = {
      text: outcome.text ?? '',
      tokensUsed: 0,
      model: 'clawith',
      provider: 'clawith',
      needsHandoff: outcome.needsHandoff,
      ...(outcome.kind === 'safe_unavailable' ? { clawithFailure: outcome.failure } : {}),
    };
  }

  if (!result && !gatedFailClosed && agent.brain_provider === 'clawith') {
    if (!clawithBinding) {
      console.warn(
        '[brain-provider] brain_provider=clawith but no ClawithBinding for this tenant — falling back to native',
      );
    } else if (!clawithDispatch.allowed) {
      // Already logged and audited above — falls through to native exactly
      // like the !clawithBinding case: the customer still gets a safe reply,
      // never the denied (e.g. INTERNAL) agent.
    } else if (
      process.env.ISOLA_LEGACY_CLAWITH_FALLBACK === '1' &&
      !ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS.has(phoneNumberId)
    ) {
      // Rollback-only path, OFF by default (legacy runtime.epic.dm dispatch retired
      // 2026-07-18). Set ISOLA_LEGACY_CLAWITH_FALLBACK=1 to temporarily restore the legacy
      // path for a NON-allowlisted number during an incident. Allowlisted numbers (the
      // contained floor) never take this path and can never regress to legacy.
      const clawithResult = await tryClawithLegacy({
        agentId: clawithBinding.clawith_agent_id,
        paperclipAgentId: clawithBinding.paperclip_agent_id,
        paperclipCompanyId: clawithBinding.paperclip_company_id,
        messages,
        sessionId,
        callerPhone: senderPhone,
        odooBinding: odooBinding ?? null,
      });
      if (clawithResult) {
        result = { ...clawithResult, model: 'clawith' };
      } else {
        console.warn('[brain-provider] Clawith (legacy rollback) failed — falling back to native for this reply');
      }
    } else {
      // DEFAULT: the contained v1.11.0 Isola bridge for every clawith number. A missing
      // agent/binding or any bridge error returns null → native fallback (contained,
      // tenant-scoped) — it never falls through to the legacy runtime.
      const clawithResult = await tryIsolaBridge({
        agentId: clawithBinding.clawith_agent_id,
        messages,
        callerPhone: senderPhone,
        conversationRef: conversationRef ?? null,
        correlationId: escalationCorrelationId ?? null,
      });
      if (clawithResult) {
        result = { ...clawithResult, model: 'clawith' };
      } else {
        console.warn('[brain-provider] Isola bridge failed — falling back to native for this reply');
      }
    }
  }

  if (!result) {
    // NOT reachable on the gated path: the block above either returns or
    // assigns `result`. Kept as an explicit typed guard rather than a comment
    // so that a future edit which adds a path out of that block fails CLOSED
    // here — silently reaching `chatComplete` below is the exact regression §6
    // exists to make impossible.
    if (gatedFailClosed) {
      console.error('[brain-provider] gated path produced no result — suppressing rather than answering natively');
      return {
        text: '',
        tokensUsed: 0,
        model: 'clawith',
        provider: 'clawith',
        needsHandoff: false,
        suppressCustomerReply: true,
        clawithFailure: {
          kind: 'invalid_response',
          detail: 'gated Clawith path produced no result',
          status: null,
          correlationId: escalationCorrelationId ?? '',
          conversationId: gatedLoop?.conversationId ?? '',
          inboundMessageId: gatedLoop?.inboundMessageId ?? '',
        },
      };
    }
    const native = await chatComplete({ model, system, messages, maxTokens: 4096 });
    result = {
      text: native.text,
      tokensUsed: native.inputTokens + native.outputTokens,
      model,
      provider: 'native',
    };
  }

  // Claim-guard: post-generation output filter, scoped to the sales tenants
  // (SALES_TENANT_IDS in lib/claim-guard.ts). Runs regardless of which
  // provider answered — this is the one chokepoint every provider's reply
  // passes through, which matters specifically for clawith: its prompt is
  // hosted entirely on the external Clawith side and is not reachable from
  // this repo, so an output filter here is the only enforcement point.
  //
  // Fail-closed on a guard error too: generateReply() is documented above to
  // never throw, so if guardReply() itself ever threw (it's pure regex today
  // and shouldn't, but this is a fabrication guard on a customer-facing sales
  // agent — assume nothing), an unhandled exception here would propagate to
  // the caller's catch block and result in NO reply being sent at all, which
  // is worse than a raw unguarded reply going out. Catch, deflect, and audit
  // instead of letting the raw (unchecked) text through or the call throw.
  // Escalation-intent handoff (def-ema-needs-handoff-flag-inconsistent): force a
  // human handoff for sales tenants when the INBOUND message signals a high-stakes
  // intent (cancellation, contract, refund/billing dispute, price negotiation,
  // explicit human request, complaint), even when the reply is a clean deflection
  // the brain flagged needs_handoff=false. Fail-safe: only ever ADDS a handoff.
  const lastUserText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const escalation = detectEscalationIntent(lastUserText, tenantId);

  try {
    // Provider-failure containment runs FIRST, before the claim-guard.
    // Infrastructure output is not a claim to be checked against a price
    // register — it is text that must never reach a customer at all. A raw
    // `HTTP 402: {"error":...}` dump was relayed verbatim to a customer on
    // 2026-08-13 (Chatwoot conv 233, msg 2784), and the token-quota notice is
    // the same leak waiting on a cap being set. Both originate in Clawith,
    // which this programme does not fork (CLAUDE.md law 2), so this chokepoint
    // is the only place either can be stopped.
    //
    // Not scoped to SALES_TENANT_IDS — same reasoning as the escalation-claim
    // backstop. A leaked provider error is wrong for every tenant.
    const providerFailure = detectProviderFailure(result.text);
    if (providerFailure.leaks) {
      console.warn(
        `[brain-provider] provider-failure contained (rule=${providerFailure.rule}) for tenant ${tenantId}`,
      );
      await audit({
        tenantId,
        actorId: `agent:${agent.id}`,
        action: 'provider_failure.contained',
        entity: 'conversation',
        entityId: sessionId,
        // Rule id only. The failure text is never audited: it is the thing we
        // are containing, and it carries provider payloads and run identifiers.
        meta: { rule: providerFailure.rule },
      });

      // Raise it on the operator alert channel that already exists, rather
      // than inventing a second one. `provider_error_leaked` is a kind the
      // taxonomy ALREADY defines — verbatim, "a structurally valid 200
      // response whose customer-visible text is itself a raw provider/runtime
      // failure ... the exact leak this taxonomy exists to catch when it
      // arrives through a 'successful' call". The kind existed and the alert
      // channel existed; only the detection was missing, which is how this
      // reached a customer through the gap between two things already built.
      //
      // recordClawithFailure is fire-and-forget by contract and flags this
      // kind P0, so an operator query surfaces it without waiting for a second
      // occurrence, and the WhatsApp leg fires when a template is approved.
      // Two audit rows are deliberate and answer different questions:
      // `provider_failure.contained` is what we STOPPED; `clawith.failure` is
      // the operator alert with the full diagnostic.
      if (clawithBinding?.clawith_agent_id) {
        await recordClawithFailure(
          new ClawithFailure(
            'provider_error_leaked',
            // Rule id only. The failure text itself is never carried into the
            // alert: it is the thing being contained, and it holds provider
            // payloads and run identifiers.
            `contained by rule=${providerFailure.rule}`,
          ),
          {
            tenantId:       tenantId,
            agentId:        agent.id,
            clawithAgentId: clawithBinding.clawith_agent_id,
            surface:        'customer_dispatch',
            correlationId:  escalationCorrelationId ?? sessionId,
            actorId:        `agent:${agent.id}`,
          },
        ).catch(() => undefined);
      }

      // DEFLECTION promises a person will follow up, and needsHandoff makes
      // that promise true — the same pairing the claim-guard path relies on.
      return { ...result, text: GUARD_ERROR_DEFLECTION, needsHandoff: true };
    }

    const guarded = guardReply(result.text, tenantId);
    if (guarded.blocked) {
      console.warn(`[brain-provider] claim-guard blocked a reply (rule=${guarded.rule}) for tenant ${tenantId}`);
      await audit({
        tenantId,
        actorId: `agent:${agent.id}`,
        action: 'claim_guard.blocked',
        entity: 'conversation',
        entityId: sessionId,
        meta: { rule: guarded.rule },
      });
      return { ...result, text: guarded.text, needsHandoff: true };
    }
    if (escalation.escalate) {
      console.warn(`[brain-provider] escalation-intent handoff (category=${escalation.category}) for tenant ${tenantId}`);
      await audit({
        tenantId,
        actorId: `agent:${agent.id}`,
        action: 'escalation_intent.handoff_forced',
        entity: 'conversation',
        entityId: sessionId,
        meta: { category: escalation.category },
      });
      return { ...result, needsHandoff: true };
    }

    // Escalation-CLAIM handoff backstop (defect-lite-concierge-stale-owner-active-
    // silent-drop-2026-07-21): force a human handoff whenever the reply text ITSELF
    // asserts a human has been engaged for this conversation, but the brain didn't
    // flag needs_handoff for this turn. Runs for every tenant/provider (not scoped to
    // SALES_TENANT_IDS) — see lib/escalation-claim.ts for why. Fail-safe: only ever
    // ADDS a handoff; a brain that already set needsHandoff=true is left untouched
    // (no redundant audit entry).
    if (!result.needsHandoff) {
      const claim = detectEscalationClaim(result.text);
      if (claim.claims) {
        console.warn(`[brain-provider] escalation-claim handoff backstop (rule=${claim.rule}) for tenant ${tenantId}`);
        await audit({
          tenantId,
          actorId: `agent:${agent.id}`,
          action: 'escalation_claim.handoff_forced',
          entity: 'conversation',
          entityId: sessionId,
          meta: { rule: claim.rule },
        });
        return { ...result, needsHandoff: true };
      }
    }
    return result;
  } catch (err: any) {
    console.error('[brain-provider] claim-guard threw — deflecting fail-closed:', err?.message ?? err);
    await audit({
      tenantId,
      actorId: `agent:${agent.id}`,
      action: 'claim_guard.error',
      entity: 'conversation',
      entityId: sessionId,
      meta: { error: String(err?.message ?? err) },
    });
    if (!SALES_TENANT_IDS.has(tenantId)) return result; // non-sales tenant: guard errors never affect other tenants
    return { ...result, text: GUARD_ERROR_DEFLECTION, needsHandoff: true };
  }
}

// ── Flowise implementation ───────────────────────────────────────────────────

/**
 * Calls the self-hosted Flowise prediction endpoint. Returns null on any
 * failure (timeout, non-2xx, network error, empty/missing text) so the
 * caller can fall back to native — never throws.
 *
 * Verified response shape (live probe against chatflow SOCKET-TEST-fable):
 *   { text, question, chatId, chatMessageId, isStreamValid, sessionId, memoryType }
 * Only `text` is used; the rest is Flowise's own bookkeeping.
 */
async function tryFlowise(params: {
  flowId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
}): Promise<{ text: string; tokensUsed: number; provider: 'flowise' } | null> {
  const baseUrl = process.env.FLOWISE_URL;
  const apiKey = process.env.FLOWISE_API_KEY;
  if (!baseUrl || !apiKey) {
    console.warn('[brain-provider] FLOWISE_URL/FLOWISE_API_KEY not configured — cannot use flowise provider');
    return null;
  }

  // Flowise's /prediction endpoint takes a single "question" plus its own
  // sessionId-keyed memory — it does not accept a full chat history array.
  const lastUserMessage = [...params.messages].reverse().find((m) => m.role === 'user');
  const question = lastUserMessage?.content ?? '';
  if (!question) return null;

  try {
    const res = await fetch(`${baseUrl}/api/v1/prediction/${params.flowId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        question,
        overrideConfig: { sessionId: params.sessionId },
      }),
      signal: AbortSignal.timeout(FLOWISE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[brain-provider] Flowise prediction failed (${res.status}): ${errText}`);
      return null;
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.text === 'string' ? data.text.trim() : '';
    if (!text) {
      console.error('[brain-provider] Flowise response had no usable text field');
      return null;
    }

    // Flowise doesn't report token usage — cost is $0 to our meter for this reply.
    return { text, tokensUsed: 0, provider: 'flowise' };
  } catch (err: any) {
    console.error('[brain-provider] Flowise request error:', err?.message ?? err);
    return null;
  }
}

// ── Hermes implementation ─────────────────────────────────────────────────────

/**
 * Calls the CC-owned, GENERALIZED Hermes agent endpoint — one path for
 * every hermes number (EMA, EPIC main, EPIC FB-linked, and any future
 * addition). Returns null on any failure (timeout, non-2xx, network error,
 * empty/missing reply_text) so the caller falls back to native — never
 * throws.
 *
 * Contract (Foundation → Hermes):
 *   POST {HERMES_AGENT_URL || DEFAULT_HERMES_AGENT_URL}  (.../agent/invoke)
 *   headers: { 'x-internal-secret': BFF_INTERNAL_SECRET } — server-to-server
 *     auth, reusing the same App Secret already set for the mirror-account/
 *     top-up BFF Lite integration. Missing/invalid secret → 401 → fallback
 *     to native (never throws).
 *   body: { phone_number_id, sender_phone, message, session_id } — Hermes
 *     resolves the account/persona (epic-business vs ema-customer, etc.)
 *     from phone_number_id; Foundation does not need to know that mapping.
 *   expects: { reply_text: string, actions?: unknown }
 * `actions` is accepted but currently ignored — Hermes is a pure text brain
 * for this socket; Foundation remains the sole WhatsApp I/O surface.
 */
async function tryHermes(_params: {
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
  phoneNumberId: string;
  senderPhone: string;
}): Promise<{ text: string; tokensUsed: number; provider: 'hermes'; needsHandoff?: boolean; actions?: unknown } | null> {
  // ── RETIRED. NO REQUEST LEAVES THIS FUNCTION. ─────────────────────────────
  //
  // `dec-one-clawith-runtime-two-isolated-domains-2026-07-30` makes Clawith the
  // only agent runtime and freezes Hermes. The single call site in
  // `generateReply` was removed; this body was emptied so the removal is
  // provable rather than believed — there is no longer any code here that
  // could reach a Hermes endpoint even if a future edit re-introduced a caller.
  //
  // THE RETIRED CONTRACT, for the record:
  //   POST {HERMES_AGENT_URL || DEFAULT_HERMES_AGENT_URL}
  //   headers: { 'Content-Type': 'application/json',
  //              'x-internal-secret': BFF_INTERNAL_SECRET }
  //   body:    { phone_number_id, sender_phone, session_id, message }
  //   expects: { reply_text: string, actions?: unknown }
  //   timeout: HERMES_TIMEOUT_MS
  //
  // Kept as prose, not as unreachable code: TypeScript does not narrow types in
  // unreachable code, so the retained implementation stopped type-checking
  // (TS2769) the moment it became dead. A block the compiler can no longer
  // reason about is not documentation, it is rot.
  console.error(
    `[brain-provider] tryHermes is retired — no request sent to ${DEFAULT_HERMES_AGENT_URL} (was ${HERMES_TIMEOUT_MS}ms)`,
  );
  return null;
}

// ── Clawith implementation ────────────────────────────────────────────────────
//
// Two implementations, gated per-number by ISOLA_BRIDGE_ALLOWED_PHONE_NUMBER_IDS
// above: tryIsolaBridge() (new v1.11.0 stack) for allowlisted numbers, and
// tryClawithLegacy() (original contract) for every other clawith tenant. This
// keeps the v1.11.0 cutover scoped to one number without disturbing tenants
// already live on the legacy endpoint with old clawith_agent_ids.

/**
 * Calls the Isola bridge on the v1.11.0 Clawith stack DIRECTLY — this
 * retires the bff-v2 hop that the hermes path above still goes through, and
 * supersedes the old runtime.epic.dm/api/internal/dispatch contract (which
 * required paperclip_agent_id/paperclip_company_id). One shared endpoint for
 * every clawith tenant; the per-tenant identity (clawith_agent_id) comes
 * from the caller's ClawithBinding row, not from any URL configuration.
 *
 * Contract (Foundation → Isola bridge):
 *   POST https://agents.epic.dm/api/isola/bridge/message
 *   headers: { 'X-Isola-Secret': CLAWITH_SHARED_SECRET }
 *   body: { agent_id, phone, text, conversation_ref, correlation_id }
 *   expects: { reply: string, run_id, status, matched_session, needs_handoff?: boolean }
 *
 * Deliberately NOT sent: any raw Conversation id, tenant id, Chatwoot
 * account id, inbox ownership id, or ChatwootBinding id
 * (def-clawith-escalation-shared-token-no-agent-principal-2026-07-21 /
 * scoped-capability hardening) — `conversation_ref` is the only
 * conversation-identifying value the bridge/agent ever receives, and it is
 * opaque. `correlation_id` is a non-secret per-turn trace id, safe to log on
 * either side, that carries no ownership information of its own.
 *
 * Any non-2xx, network error, or empty reply is treated identically: return
 * null so the caller falls back to native. Never throws.
 */
const ISOLA_BRIDGE_URL =
  process.env.ISOLA_BRIDGE_URL || 'https://agents.epic.dm/api/isola/bridge/message';
// No published SLA for the bridge's round-trip; mirrors Hermes's generous
// timeout so a slow-but-healthy reply isn't mistaken for a dead endpoint.
const CLAWITH_TIMEOUT_MS = 45_000;

async function tryIsolaBridge(params: {
  agentId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  callerPhone: string;
  /** Opaque, short-lived, scoped-capability ref (lib/escalation-ref.ts).
   *  Forwarded so the bridge can hand it to the agent for escalate_to_human —
   *  never a raw conversation/tenant/account/inbox id. Null when unavailable
   *  (e.g. EscalationRef mint failed); the bridge/agent simply has no ref to
   *  offer that turn and escalate_to_human is unusable until the next one. */
  conversationRef: string | null;
  /** Non-secret per-turn trace id minted alongside conversationRef — forwarded
   *  for cross-system log correlation only, never used for ownership. */
  correlationId: string | null;
}): Promise<{ text: string; tokensUsed: number; provider: 'clawith'; needsHandoff: boolean } | null> {
  const secret = process.env.CLAWITH_SHARED_SECRET;
  if (!secret) {
    console.warn('[brain-provider] CLAWITH_SHARED_SECRET not configured — cannot use clawith provider');
    return null;
  }

  const lastUser = [...params.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser?.content ?? '';
  if (!userText) return null;

  try {
    const res = await fetch(ISOLA_BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Isola-Secret': secret },
      body: JSON.stringify({
        agent_id: params.agentId,
        phone: params.callerPhone,
        text: userText,
        conversation_ref: params.conversationRef,
        correlation_id: params.correlationId,
      }),
      signal: AbortSignal.timeout(CLAWITH_TIMEOUT_MS),
    });

    if (!res.ok) {
      console.error(`[brain-provider] Isola bridge failed (${res.status}): ${await res.text().catch(() => '')}`);
      return null; // falls back to native
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.reply === 'string' ? data.reply.trim() : '';
    if (!text) {
      console.error('[brain-provider] Isola bridge: no reply text');
      return null;
    }

    return { text, tokensUsed: 0, provider: 'clawith', needsHandoff: data?.needs_handoff === true };
  } catch (err: any) {
    console.error('[brain-provider] Isola bridge error:', err?.message ?? err);
    return null;
  }
}

/**
 * Calls Clawith's ORIGINAL dispatch endpoint DIRECTLY — this retires the
 * bff-v2 hop that the hermes path above still goes through. One shared
 * endpoint for every legacy clawith tenant; the per-tenant identity
 * (clawith_agent_id / paperclip_agent_id / paperclip_company_id) comes from
 * the caller's ClawithBinding row, not from any URL configuration.
 *
 * Contract (Foundation → Clawith):
 *   POST https://runtime.epic.dm/api/internal/dispatch
 *   headers: { Authorization: 'Bearer ' + CLAWITH_SHARED_SECRET } — the same
 *     shared secret bff-v2 already uses as BFF_CLAWITH_SHARED_SECRET.
 *   body: { agent_id, paperclip_agent_id, paperclip_company_id, user_text,
 *     history, session_id, caller_phone } — agent_id/paperclip_agent_id/
 *     paperclip_company_id are all required by Clawith.
 *   expects: { draft: string, needs_handoff: boolean, errors?: unknown }
 *
 * Clawith fails CLOSED on its own downstream outage (503 when Paperclip is
 * unreachable) — any non-2xx here is therefore treated exactly like a
 * network error: return null so the caller falls back to native. Never throws.
 */
const CLAWITH_DISPATCH_URL = 'https://runtime.epic.dm/api/internal/dispatch';

async function tryClawithLegacy(params: {
  agentId: string;
  paperclipAgentId: string;
  paperclipCompanyId: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  sessionId: string;
  callerPhone: string;
  /** When present, Clawith overrides its sandbox Odoo with the tenant's own connection. */
  odooBinding: OdooBindingInput | null;
}): Promise<{ text: string; tokensUsed: number; provider: 'clawith'; needsHandoff: boolean } | null> {
  const sharedSecret = process.env.CLAWITH_SHARED_SECRET;
  if (!sharedSecret) {
    console.warn('[brain-provider] CLAWITH_SHARED_SECRET not configured — cannot use clawith provider');
    return null;
  }

  const lastUserMessage = [...params.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUserMessage?.content ?? '';
  if (!userText) return null;

  try {
    const res = await fetch(CLAWITH_DISPATCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSecret}`,
      },
      body: JSON.stringify({
        agent_id: params.agentId,
        paperclip_agent_id: params.paperclipAgentId,
        paperclip_company_id: params.paperclipCompanyId,
        user_text: userText,
        history: params.messages.map((m) => ({ role: m.role, content: m.content })),
        session_id: params.sessionId,
        caller_phone: params.callerPhone,
        sandbox: false,
        // Tenant-owned Odoo credentials — only included when a binding exists.
        // Clawith ignores these fields when absent, using its own sandbox creds.
        ...(params.odooBinding && {
          odoo_url: params.odooBinding.url,
          odoo_db: params.odooBinding.db,
          odoo_login: params.odooBinding.login,
          odoo_password: params.odooBinding.password,
        }),
      }),
      signal: AbortSignal.timeout(CLAWITH_TIMEOUT_MS),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error(`[brain-provider] Clawith dispatch failed (${res.status}): ${errText}`);
      return null;
    }

    const data: any = await res.json().catch(() => null);
    const text: string = typeof data?.draft === 'string' ? data.draft.trim() : '';
    if (!text) {
      console.error('[brain-provider] Clawith response had no usable draft field');
      return null;
    }

    return {
      text,
      tokensUsed: 0,
      provider: 'clawith',
      needsHandoff: data?.needs_handoff === true,
    };
  } catch (err: any) {
    console.error('[brain-provider] Clawith request error:', err?.message ?? err);
    return null;
  }
}
