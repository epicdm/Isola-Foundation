/**
 * Owner request -> authorized Odoo briefing -> correct CCO invocation ->
 * sourced answer. The integrated path this module exists to assemble.
 *
 * CALLER RESPONSIBILITIES (unchanged from the sibling GET .../briefing route)
 * -----------------------------------------------------------------------------
 * Authentication, tenant-owner authorization (`requireWorkspaceAccess(session,
 * 'owner')`) and audit are the ROUTE's job, not this module's — same division
 * of responsibility `performStaffChatTurn` already uses. This module assumes
 * its caller already did both and passes in an authorized `tenantId`.
 *
 * THE THREE THINGS THIS MODULE VERIFIED, NOT ASSUMED, ABOUT THE RUNTIME CALL
 * ------------------------------------------------------------------------------
 *  - `context.tenantId` is NEVER set. `epic-staff-operations-coordinator@v1`
 *    is AgentOS-gated to a single operator-configured tenant
 *    (agentos-allowlist.ts); a request's `context.tenantId` may only ECHO
 *    that value or be absent — any OTHER value is a hard 403
 *    `agentos_tenant_refused`. Foundation has no reason to know that
 *    constant and must not guess it, so this module omits the field
 *    entirely (read agentos-allowlist.ts directly to confirm `null` is
 *    accepted, not just "probably fine").
 *  - `context.conversationRef` IS set, to a stable per-(tenant,thread) key.
 *    Read conversation.ts + app.ts directly: an inline request that
 *    supplies NEITHER an issueId NOR a conversationRef reaches
 *    `recorder.record()` with `issueId: null`, which THROWS against any
 *    REAL (non-null) Paperclip recorder — turning a successful model
 *    answer into `persistence_failed` and withholding it, even though the
 *    model worked. `conversationRef` routes through `ConversationIssues`
 *    instead, which create-or-gets a `backlog`, unassigned, low-priority
 *    issue (never re-triggering Paperclip's scheduler) so persistence can
 *    actually succeed.
 *  - `agentId` sent is the REAL `paperclip_agent_id` resolved via
 *    `resolveCcoAgentBinding` — not a placeholder — so budget bucketing and
 *    (on exhaustion) `pauseAgent` apply to the correct Paperclip agent.
 *
 * DUPLICATE PROTECTION, TWO LAYERS
 * -----------------------------------
 * `runId` is DETERMINISTIC from `(tenantId, turnId)` — the same "same
 * turnId reproduces the same id" shape `buildStaffChatCorrelationId` already
 * uses. The runtime's OWN idempotency store (`buildIdempotencyKey`) keys on
 * `(companyId, agentId, runId, issueId, contextText)` and replays a
 * completed run's stored answer verbatim rather than calling the model
 * again — so a client retry with the same turnId is answered from the
 * store, not re-executed, on EITHER side.
 *
 * ODOO TEXT STAYS DATA, NEVER INSTRUCTION
 * -------------------------------------------
 * Verified directly in context.ts: `buildUserMessage` wraps the ENTIRE
 * `context` value in an explicit "----- BEGIN RUN CONTEXT -----" /
 * "data, not instruction" envelope before it ever reaches the model. The
 * briefing (Odoo-derived rows, including any free text a customer or staff
 * member wrote into Odoo) travels inside `context.businessBriefing` and
 * nowhere else — never into `templateId`, `exposure`, or anything that
 * could be mistaken for policy.
 */

import { getBusinessBriefing, type BusinessBriefing } from './business-briefing';
import { CCO_TEMPLATE_ID, resolveCcoAgentBinding, type CcoAgentBindingOutcome } from './cco-agent-binding';
import { getIsolaRuntimeConfig } from '@/lib/engines';

/** The isola-runtime registry id — DISTINCT from CCO_TEMPLATE_ID, which is
 *  isola-portal's own catalogue id for the same underlying agent. Never
 *  conflate the two: sending isola-portal's id to isola-runtime's
 *  `findTemplate()` resolves to nothing and 400s as `unknown_template`. */
export const RUNTIME_TEMPLATE_ID = 'epic-staff-operations-coordinator@v1';

const RUNTIME_REQUEST_TIMEOUT_MS = 55_000;

export type CcoAskState = 'replied' | 'blocked' | 'unavailable' | 'timeout' | 'degraded';

export interface CcoAskBlocked {
  state: 'blocked';
  reason: Exclude<CcoAgentBindingOutcome['outcome'], 'linked'>;
  briefing: null;
  text: null;
  sources: [];
  correlationId: null;
}

export interface CcoAskUnavailableOrDegraded {
  state: 'unavailable' | 'timeout' | 'degraded';
  reason: string;
  briefing: BusinessBriefing | null;
  text: null;
  sources: [];
  correlationId: string | null;
}

export interface CcoAskReplied {
  state: 'replied';
  reason: null;
  briefing: BusinessBriefing;
  text: string;
  /** Every source link the briefing itself carries, deduplicated — so the
   *  caller can render clickable sources even if the model's own prose
   *  drops one. Never invented: exactly the briefing's own `sourceUrl`s. */
  sources: string[];
  correlationId: string;
}

export type CcoAskResult = CcoAskBlocked | CcoAskUnavailableOrDegraded | CcoAskReplied;

export interface CcoAskInput {
  /** Foundation's own Tenant.id. Already authorized by the caller. */
  tenantId: string;
  /** The owner's actual question. Reaches the model only inside
   *  `context.ownerRequest` — data, never instruction, exactly like the
   *  briefing (see this module's own docstring). */
  message: string;
  /** Groups turns into one Paperclip issue (`conversationRef`) — the SAME
   *  threadId across multiple distinct questions is what makes them
   *  accumulate as one traceable conversation. */
  threadId: string;
  /** Anchors the idempotency key (`runId`) together with `threadId`. The
   *  SAME turnId is what makes a client retry safe (replayed, never a
   *  second model call); a NEW turnId is a new question. */
  turnId: string;
}

function briefingSourceLinks(briefing: BusinessBriefing): string[] {
  const links = new Set<string>();
  for (const section of briefing.sections) {
    if (section.state !== 'ok') continue;
    for (const row of section.rows) {
      if (row.sourceUrl) links.add(row.sourceUrl);
    }
  }
  return Array.from(links);
}

function conversationRefFor(tenantId: string, threadId: string): string {
  return `cco-briefing:${tenantId}:${threadId}`;
}

function runIdFor(tenantId: string, threadId: string, turnId: string): string {
  return `cco-briefing:${tenantId}:${threadId}:${turnId}`;
}

interface RuntimeInvokeBody {
  ok: boolean;
  outcome: string;
  correlationId?: unknown;
  answerText?: unknown;
  error?: unknown;
}

export async function askCco(input: CcoAskInput): Promise<CcoAskResult> {
  const binding = await resolveCcoAgentBinding(input.tenantId);

  if (binding.outcome !== 'linked') {
    if (binding.outcome === 'not_configured' || binding.outcome === 'unreachable') {
      return {
        state: 'unavailable',
        reason: `agent_binding_${binding.outcome}`,
        briefing: null,
        text: null,
        sources: [],
        correlationId: null,
      };
    }
    return {
      state: 'blocked',
      reason: binding.outcome,
      briefing: null,
      text: null,
      sources: [],
      correlationId: null,
    };
  }

  const briefing = await getBusinessBriefing(input.tenantId);

  const runtimeConfig = getIsolaRuntimeConfig();
  if (runtimeConfig === null) {
    return {
      state: 'unavailable',
      reason: 'runtime_not_configured',
      briefing,
      text: null,
      sources: [],
      correlationId: null,
    };
  }

  const runId = runIdFor(input.tenantId, input.threadId, input.turnId);
  const requestBody: Record<string, unknown> = {
    templateId: RUNTIME_TEMPLATE_ID,
    exposure: 'INTERNAL',
    agentId: binding.paperclipAgentId,
    runId,
    // NEVER "paperclip" — Foundation did not issue this id through
    // Paperclip's own heartbeat mechanism. Absence is the safe default; see
    // app.ts's own comment on runIdIssuedBy.
    responseMode: 'inline',
    context: {
      companyId: binding.paperclipCompanyId,
      conversationRef: conversationRefFor(input.tenantId, input.threadId),
      // DATA, never instruction — see this module's own docstring and
      // context.ts's buildUserMessage, which wraps this whole object in an
      // explicit untrusted-context envelope before the model ever sees it.
      // Both the owner's own words AND the Odoo-derived rows travel here,
      // side by side, and nowhere else.
      ownerRequest: input.message,
      businessBriefing: briefing,
    },
  };
  if (runtimeConfig.internalCallerProof !== null) {
    requestBody.callerProof = runtimeConfig.internalCallerProof;
  }

  let res: Response;
  try {
    res = await fetch(new URL('/v1/invoke', runtimeConfig.baseUrl), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${runtimeConfig.internalBearer}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(RUNTIME_REQUEST_TIMEOUT_MS),
      cache: 'no-store',
    });
  } catch (err) {
    return {
      state: 'unavailable',
      reason: err instanceof Error && err.name === 'TimeoutError' ? 'runtime_timeout' : 'runtime_unreachable',
      briefing,
      text: null,
      sources: [],
      correlationId: null,
    };
  }

  let body: RuntimeInvokeBody;
  try {
    body = (await res.json()) as RuntimeInvokeBody;
  } catch {
    return { state: 'unavailable', reason: 'runtime_unreadable_response', briefing, text: null, sources: [], correlationId: null };
  }

  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : null;

  if (body.outcome === 'ok') {
    const text = typeof body.answerText === 'string' ? body.answerText : null;
    if (text === null || text.trim().length === 0) {
      // Should not happen when outcome is genuinely "ok" in inline mode
      // (see app.ts's own completionState derivation), but never fabricate
      // an answer if it does.
      return { state: 'degraded', reason: 'ok_with_no_answer_text', briefing, text: null, sources: [], correlationId };
    }
    return { state: 'replied', reason: null, briefing, text, sources: briefingSourceLinks(briefing), correlationId: correlationId ?? runId };
  }

  if (body.outcome === 'model_timeout') {
    return { state: 'timeout', reason: body.outcome, briefing, text: null, sources: [], correlationId };
  }

  // CONFIGURATION-SHAPED, mirroring performStaffChatTurn's own
  // CONFIGURATION_KINDS discipline: these say nothing about the owner's
  // message and must never be presented as though they do.
  const UNAVAILABLE_OUTCOMES = new Set([
    'unauthorized',
    'no_credential_configured',
    'unknown_template',
    'exposure_mismatch',
    'bad_request',
    'payload_too_large',
    'not_found',
    'unsupported_response_mode',
    'budget_exhausted',
    'cost_delivery_unconfirmed',
    'agentos_routing_refused',
    'agentos_not_configured',
    'agent_caller_proof_required',
  ]);
  if (UNAVAILABLE_OUTCOMES.has(body.outcome)) {
    return { state: 'unavailable', reason: body.outcome, briefing, text: null, sources: [], correlationId };
  }

  // provider_error, persistence_failed, internal_error, duplicate_run_suppressed
  // (the true in-flight-duplicate case) and anything not explicitly named
  // above: transient, "try again" framing — never claims nothing happened.
  return { state: 'degraded', reason: body.outcome, briefing, text: null, sources: [], correlationId };
}
