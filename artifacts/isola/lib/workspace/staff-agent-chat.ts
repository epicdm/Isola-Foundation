/**
 * S1 — Foundation synchronous structured staff chat.
 *
 * Gives a manager-or-above workspace user one live, LIVE_ASSISTED turn with an
 * approved INTERNAL agent, over the same wire contract and the same
 * `callClawithStructured()` seam as the gated inbox-46 customer loop
 * (`lib/clawith/invoke.ts`) — but this module NEVER calls `invokeClawithGated`,
 * carries no Chatwoot/Odoo/PBX/Meta side effect, and always sends
 * `allowed_tools: []`. There is no application tool a staff-chat turn can
 * execute, whatever the response claims — `parseClawithResponse()` in
 * `lib/clawith/response.ts` rejects any `tool_requests` entry against an empty
 * allowlist as `unsupported_tool` before this module ever sees it.
 *
 * ELIGIBILITY (owner/CTO disposition, 2026-08-03, on
 * `xp-foundation-staff-agent-chat-s1-2026-08-03`): the interim rule "no
 * ChatwootBinding with mode a2/lane2" is withdrawn — it was a negative proxy
 * for internal-only exposure and wrongly excluded an agent that legitimately
 * serves multiple isolated surfaces. Eligibility is now positive and explicit:
 * an agent must be named in `FOUNDATION_STAFF_CHAT_AGENT_IDS`. A
 * ChatwootBinding on the agent is read for audit/context only (see
 * `describeChatwootContext`) and never disqualifies it, and this module never
 * issues a Chatwoot call of any kind.
 */

import { prisma } from '@/lib/prisma';
import type { SessionCtx } from '@/lib/session';
import type { ClawithClientOptions } from '@/lib/clawith/client';
import type { ClawithRequest, ClawithToolDefinition } from '@/lib/clawith/contract';
import { buildClawithRequest } from '@/lib/clawith/request';
import { ClawithFailure, isClawithFailure, isConfigurationFailure, type ClawithFailureKind } from '@/lib/clawith/errors';
import { callClawithWithFallback } from '@/lib/clawith/fallback';
import { recordClawithFailure } from '@/lib/clawith/alert';

// ── Allowlist (revised eligibility rule 5) ──────────────────────────────────

export const FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV = 'FOUNDATION_STAFF_CHAT_AGENT_IDS';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parses the comma-separated allowlist. Malformed entries (not a UUID) are
 * dropped, never thrown on and never treated as a wildcard — one bad entry
 * must not widen access to entries that were never approved. Missing or
 * empty input yields an empty set, which fails every agent closed.
 */
export function staffChatAgentAllowlist(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const raw = env[FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV];
  if (typeof raw !== 'string' || raw.trim() === '') return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => UUID_RE.test(s)),
  );
}

export function isAgentAllowlistedForStaffChat(agentId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return staffChatAgentAllowlist(env).has(agentId);
}

// ── Structured endpoint (explicit, validated, no fallback) ──────────────────

/**
 * Staff chat's own endpoint, deliberately independent of `ISOLA_BRIDGE_URL`
 * (never repointed by this feature) and additive to `lib/clawith/client.ts`
 * (whose default endpoint — used by every existing caller, e.g. the gated
 * inbox-46 loop — is completely untouched; see the `url` option threaded
 * through `callClawithStructured`).
 *
 * Unlike every other Foundation surface, staff chat has NO fallback: a
 * missing, empty or invalid `CLAWITH_STRUCTURED_URL` must never silently
 * resolve to the legacy `/api/isola/bridge/message` endpoint (that endpoint
 * expects a different, older request shape — `agent_id`/`phone`/`text` — and
 * sending it a structured envelope produces a misleading validation error
 * rather than a truthful "not configured" state). `performStaffChatTurn`
 * checks this BEFORE building anything network-bound and makes zero upstream
 * calls when it fails.
 */
const APPROVED_STRUCTURED_HOST = 'agents.epic.dm';
const REQUIRED_STRUCTURED_PATH = '/api/isola/bridge/structured/message';

export type StaffChatUrlInvalidReason =
  | 'missing'
  | 'has_query_or_fragment'
  | 'invalid_url'
  | 'not_https'
  | 'has_credentials'
  | 'wrong_host'
  | 'wrong_path';

export type StaffChatUrlValidation =
  | { ok: true; url: string }
  | { ok: false; reason: StaffChatUrlInvalidReason };

/**
 * Same technique as `isUsableBase()` in `lib/chatwoot-conversation-link.ts`:
 * reject a `?`/`#` on the RAW string before parsing, not on `.search`/`.hash`
 * — a bare trailing `?` or `#` with nothing after it parses to an EMPTY
 * search/hash in the WHATWG URL model and would otherwise pass through.
 */
export function validateStaffChatStructuredUrl(env: NodeJS.ProcessEnv = process.env): StaffChatUrlValidation {
  const raw = env.CLAWITH_STRUCTURED_URL;
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, reason: 'missing' };
  const trimmed = raw.trim();
  if (trimmed.includes('?') || trimmed.includes('#')) return { ok: false, reason: 'has_query_or_fragment' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'https:') return { ok: false, reason: 'not_https' };
  if (parsed.username !== '' || parsed.password !== '') return { ok: false, reason: 'has_credentials' };
  if (parsed.hostname !== APPROVED_STRUCTURED_HOST) return { ok: false, reason: 'wrong_host' };
  // Exact match, not a suffix check — the legacy `/api/isola/bridge/message`
  // path and any other neighbouring route must fail closed, not just a path
  // that happens not to end in the right segment.
  if (parsed.pathname !== REQUIRED_STRUCTURED_PATH) return { ok: false, reason: 'wrong_path' };

  return { ok: true, url: trimmed };
}

// ── Eligibility (revised five-rule policy) ──────────────────────────────────

export type StaffChatIneligibleReason =
  | 'agent_not_found'
  | 'inactive'
  | 'wrong_provider'
  | 'no_clawith_binding'
  | 'no_clawith_tenant'
  | 'not_allowlisted';

export interface StaffChatEligibleAgent {
  agentId: string;
  /** Foundation's own tenant id. Used for Foundation-side authorization only
   *  — never sent on the Clawith wire. See `clawithTenantId`. */
  tenantId: string;
  name: string;
  clawithAgentId: string;
  /** The Clawith-side tenant namespace that owns `clawithAgentId`
   *  (`ClawithBinding.clawith_tenant_id`). This, not `tenantId`, is what
   *  `performStaffChatTurn` sends as the structured request's `tenant_id` —
   *  the live endpoint's equality gate is against the CLAWITH tenant, not
   *  Foundation's. See
   *  ev-foundation-clawith-tenant-namespace-reconciliation-2026-08-04. */
  clawithTenantId: string;
  paperclipCompanyId: string;
  /** Audit/context only — see module docstring. Never gates eligibility and
   *  never drives a Chatwoot call. */
  chatwootBindingModes: string[];
}

export type StaffChatEligibility =
  | { eligible: true; agent: StaffChatEligibleAgent }
  | { eligible: false; reason: StaffChatIneligibleReason };

/**
 * Rules 1–4 are read from real tenant-scoped data; rule 5 is the explicit
 * environment allowlist. All five must hold. `agentId` not found for this
 * tenant is a 404 at the route layer (cross-tenant agents stay
 * indistinguishable from absent) and is NOT represented here — call
 * `resolveStaffChatEligibility` only after confirming the agent belongs to
 * `tenantId`.
 */
export async function resolveStaffChatEligibility(
  tenantId: string,
  agentId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StaffChatEligibility> {
  const agent = await prisma.agent.findFirst({
    where: { id: agentId, tenant_id: tenantId },
    select: { id: true, tenant_id: true, name: true, is_active: true, brain_provider: true },
  });
  if (!agent) return { eligible: false, reason: 'agent_not_found' };
  if (!agent.is_active) return { eligible: false, reason: 'inactive' };
  if (agent.brain_provider !== 'clawith') return { eligible: false, reason: 'wrong_provider' };

  const binding =
    (await prisma.clawithBinding.findFirst({
      where: { tenant_id: tenantId, agent_id: agentId },
      select: { clawith_agent_id: true, paperclip_company_id: true, clawith_tenant_id: true },
    })) ??
    (await prisma.clawithBinding.findFirst({
      where: { tenant_id: tenantId, agent_id: null },
      select: { clawith_agent_id: true, paperclip_company_id: true, clawith_tenant_id: true },
    }));
  if (!binding || !binding.clawith_agent_id || !binding.paperclip_company_id) {
    return { eligible: false, reason: 'no_clawith_binding' };
  }
  // Fail closed rather than send Foundation's own tenant id on the wire: the
  // live structured endpoint's tenant_id gate is a strict equality check
  // against the CLAWITH tenant, and no Foundation tenant id has ever matched
  // it. See ev-foundation-clawith-tenant-namespace-reconciliation-2026-08-04.
  if (!binding.clawith_tenant_id) {
    return { eligible: false, reason: 'no_clawith_tenant' };
  }

  if (!isAgentAllowlistedForStaffChat(agentId, env)) {
    return { eligible: false, reason: 'not_allowlisted' };
  }

  const chatwootBindings = await prisma.chatwootBinding.findMany({
    where: { tenant_id: tenantId, agent_id: agentId },
    select: { mode: true },
  });

  return {
    eligible: true,
    agent: {
      agentId: agent.id,
      tenantId: agent.tenant_id,
      name: agent.name,
      clawithAgentId: binding.clawith_agent_id,
      clawithTenantId: binding.clawith_tenant_id,
      paperclipCompanyId: binding.paperclip_company_id,
      chatwootBindingModes: chatwootBindings.map((b) => b.mode),
    },
  };
}

// ── Correlation / contact reference ─────────────────────────────────────────

/** `staff:{userId}:{agentId}` — namespaced away from any E.164 customer
 *  contact ref, so this lane can never be mistaken for a customer contact by
 *  anything downstream that keys off `contact_ref`. */
export function buildStaffContactRef(userId: string, agentId: string): string {
  return `staff:${userId}:${agentId}`;
}

/** `staffchat:{threadId}:{turnId}` — deterministic from the two ids the
 *  caller supplies, so a client-side retry that resends the SAME turnId
 *  reproduces the SAME correlation id rather than minting a new one. */
export function buildStaffChatCorrelationId(threadId: string, turnId: string): string {
  return `staffchat:${threadId}:${turnId}`;
}

/** Placeholder Chatwoot-shaped fields the wire contract requires but that do
 *  not apply to a non-Chatwoot staff conversation. Never used to address a
 *  real Chatwoot account/inbox — no Chatwoot call is ever made from this
 *  module. */
const STAFF_CHAT_CHATWOOT_ACCOUNT_ID = 'foundation-staff-chat';
const STAFF_CHAT_INBOX_ID = 'foundation-staff-chat';

const NO_TOOLS: ClawithToolDefinition[] = [];

// ── Safe state vocabulary ────────────────────────────────────────────────────

export const STAFF_CHAT_STATES = [
  'replied',
  'escalated',
  'blocked',
  'degraded',
  'timeout',
  'unavailable',
  'rejected',
] as const;
export type StaffChatState = (typeof STAFF_CHAT_STATES)[number];

export interface StaffChatTurnResult {
  state: StaffChatState;
  /** Text to show the staff user. Present only for `replied` / `escalated`. */
  text: string | null;
  correlationId: string;
  /** Non-secret, safe classification. Never the raw upstream detail. */
  failureKind: ClawithFailureKind | null;
  attempts: number | null;
}

/** Configuration-shaped failures never claim "something went wrong with your
 *  message" — nothing about the turn itself failed, Foundation just is not
 *  set up to send it. */
const CONFIGURATION_KINDS: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>([
  'secret_missing',
  'agent_missing',
  'request_invalid',
  'tenant_mismatch',
]);

/** Non-retryable-presenting failures — a payment/credential problem or a
 *  caught provider-error leak reads the same as "not available right now",
 *  not "hit a snag, try again" (`degraded`). `rate_limited` deliberately
 *  stays `degraded`: retrying later is a legitimate response to a rate
 *  limit, unlike the other three. */
const UNAVAILABLE_PRESENTING_KINDS: ReadonlySet<ClawithFailureKind> = new Set<ClawithFailureKind>([
  'payment_required',
  'provider_error_leaked',
  'circuit_open',
]);

export function mapFailureToStaffChatState(kind: ClawithFailureKind): StaffChatState {
  if (kind === 'timeout') return 'timeout';
  if (kind === 'auth_rejected') return 'rejected';
  if (CONFIGURATION_KINDS.has(kind)) return 'unavailable';
  if (UNAVAILABLE_PRESENTING_KINDS.has(kind)) return 'unavailable';
  return 'degraded';
}

export interface PerformStaffChatTurnInput {
  session: SessionCtx;
  agent: StaffChatEligibleAgent;
  message: string;
  threadId: string;
  turnId: string;
  env?: NodeJS.ProcessEnv;
  clientOptions?: ClawithClientOptions;
}

export interface PerformStaffChatTurnOutcome {
  result: StaffChatTurnResult;
  /** The exact request Foundation sent, for callers (route + tests) that need
   *  to prove `allowed_tools: []` and the rest of the wire shape without a
   *  second round of construction. */
  sentRequest: ClawithRequest;
}

/**
 * The one entry point: build the zero-tool structured request, send it, and
 * map the outcome to the safe state vocabulary. Never throws — every
 * `ClawithFailure` is caught and classified. Callers are responsible for
 * authorization (`requireWorkspaceAccess`), eligibility
 * (`resolveStaffChatEligibility`) and audit (`lib/audit.ts`); this function
 * assumes `agent` already passed both.
 */
export async function performStaffChatTurn(input: PerformStaffChatTurnInput): Promise<PerformStaffChatTurnOutcome> {
  const env = input.env ?? process.env;
  const correlationId = buildStaffChatCorrelationId(input.threadId, input.turnId);
  const contactRef = buildStaffContactRef(input.session.user.id, input.agent.agentId);

  const request = buildClawithRequest({
    // The CLAWITH tenant, never Foundation's own `input.agent.tenantId` — the
    // live endpoint's tenant_id gate checks against the Clawith agent's owning
    // tenant, and Foundation's tenant id never matches it. Foundation-side
    // authorization already happened separately (session/effectiveTenantId at
    // the route layer, tenant-scoped lookups in resolveStaffChatEligibility).
    tenantId: input.agent.clawithTenantId,
    bindingTenantId: input.agent.clawithTenantId,
    conversationTenantId: input.agent.clawithTenantId,
    businessId: input.agent.paperclipCompanyId,
    chatwootAccountId: STAFF_CHAT_CHATWOOT_ACCOUNT_ID,
    inboxId: STAFF_CHAT_INBOX_ID,
    conversationId: input.threadId,
    inboundMessageId: input.turnId,
    contactRef,
    customerMessage: input.message,
    history: [],
    designatedAgentId: input.agent.clawithAgentId,
    knowledgeScopeIds: [],
    allowedTools: NO_TOOLS,
    ownershipState: 'AI_OWNED',
    correlationId,
    responseDeadlineMs: 45_000,
  });

  // Checked BEFORE any client/network work, and with no fallback: a missing
  // or invalid CLAWITH_STRUCTURED_URL must make zero upstream calls and
  // resolve to the existing safe `unavailable` state, never a guess at the
  // legacy endpoint. The invalid reason is intentionally NOT included in the
  // result — only used for internal reasoning — so the raw env value or a
  // hint about it never has a path to the UI.
  const urlValidation = validateStaffChatStructuredUrl(env);
  if (!urlValidation.ok) {
    return {
      sentRequest: request,
      result: {
        state: 'unavailable',
        text: null,
        correlationId,
        // Reuses the existing CONFIGURATION-classified kind closest in
        // meaning ("Foundation refused to build/send the request") rather
        // than adding a new ClawithFailureKind — this module does not modify
        // lib/clawith/errors.ts.
        failureKind: 'request_invalid',
        attempts: null,
      },
    };
  }

  const clientOptions: ClawithClientOptions = {
    ...input.clientOptions,
    env,
    url: urlValidation.url,
  };

  try {
    const { response, attempts, usedFallback, primaryFailure } = await callClawithWithFallback({
      request,
      tenantId: input.agent.tenantId,
      clientOptions,
      env,
    });

    // See invoke.ts's identical guard: a fallback that recovers the turn
    // still means the primary credential failed, and that failure event
    // must not go unrecorded — otherwise an operator never learns a 402
    // happened until the fallback also fails.
    if (usedFallback && primaryFailure) {
      await recordClawithFailure(primaryFailure, {
        tenantId: input.agent.tenantId,
        agentId: input.agent.agentId,
        clawithAgentId: input.agent.clawithAgentId,
        surface: 'staff_chat',
        correlationId,
        actorId: input.session.user.id,
        env,
      });
    }

    if (response.escalation.requested) {
      return {
        sentRequest: request,
        result: {
          state: 'escalated',
          text: response.escalation.customer_handoff_message ?? response.customer_reply,
          correlationId,
          failureKind: null,
          attempts,
        },
      };
    }
    if (response.customer_reply !== null) {
      return {
        sentRequest: request,
        result: {
          state: 'replied',
          text: response.customer_reply,
          correlationId,
          failureKind: null,
          attempts,
        },
      };
    }
    // Zero tools were offered, so a valid, non-escalating, no-reply response
    // is not reachable in practice — parseClawithResponse() already rejects
    // any tool_requests against an empty allowlist. Fail closed anyway rather
    // than assume that guarantee always holds.
    return {
      sentRequest: request,
      result: {
        state: 'degraded',
        text: null,
        correlationId,
        failureKind: 'contradictory_response',
        attempts,
      },
    };
  } catch (err) {
    const failure = isClawithFailure(err)
      ? err
      : new ClawithFailure('network_error', (err as Error | null)?.message ?? null);

    // Configuration failures are a Foundation-side defect, not a provider
    // event — already funneled to the quiet `unavailable` state above; an
    // operator alert for "no secret configured in this environment" would
    // be noise, not signal, and would fire on every turn while it persists.
    if (!isConfigurationFailure(failure.kind)) {
      await recordClawithFailure(failure, {
        tenantId: input.agent.tenantId,
        agentId: input.agent.agentId,
        clawithAgentId: input.agent.clawithAgentId,
        surface: 'staff_chat',
        correlationId,
        actorId: input.session.user.id,
        env,
      });
    }

    return {
      sentRequest: request,
      result: {
        state: mapFailureToStaffChatState(failure.kind),
        text: null,
        correlationId,
        failureKind: failure.kind,
        attempts: null,
      },
    };
  }
}
