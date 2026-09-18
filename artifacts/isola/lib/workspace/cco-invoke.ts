/**
 * Owner request -> owner-selected agent resolved precisely -> authorized
 * Odoo briefing -> authenticated CCO invocation -> sourced answer. The
 * integrated path this module exists to assemble.
 *
 * CALLER RESPONSIBILITIES (unchanged from the sibling GET .../briefing route)
 * -----------------------------------------------------------------------------
 * Authentication, tenant-owner authorization (`requireWorkspaceAccess(session,
 * 'owner')`) and audit are the ROUTE's job, not this module's — same division
 * of responsibility `performStaffChatTurn` already uses. This module assumes
 * its caller already did both and passes in an authorized `tenantId`.
 *
 * AGENT SELECTION, NOT TEMPLATE MATCHING
 * -------------------------------------------
 * The owner selects a SPECIFIC hired agent — `input.paperclipAgentId`, when
 * supplied, is resolved by identity via `resolveCcoAgentBinding` (never
 * ambiguous: isola-portal enforces `paperclip_agent_id` globally unique).
 * Two agents sharing the CCO template is ordinary, supported behaviour; this
 * module never picks between them. When the caller has not yet made a
 * selection (`paperclipAgentId` omitted — a genuinely underspecified
 * request), `listCcoAgents` is consulted: zero candidates is `not_provisioned`,
 * exactly one is auto-selected (the only option is not an ambiguity), and
 * more than one is the ONE case this module reports `ambiguous` — a real
 * choice the caller must make, carried back as `availableAgents` so a UI can
 * present it, never guessed.
 *
 * THE THINGS THIS MODULE VERIFIED, NOT ASSUMED, ABOUT THE RUNTIME CALL
 * --------------------------------------------------------------------------
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
 * AUTHENTICATED INVOCATION — THE PROOF IS THE BEARER, NEVER A BODY FIELD
 * ---------------------------------------------------------------------------
 * `bearerForAgent` (lib/engines.ts) presents the caller's OWN agent-bound
 * secret for the resolved `paperclip_agent_id` when this deployment has one
 * configured, mirroring isola-runtime's `RUNTIME_INTERNAL_AGENT_CALLER_SECRETS`
 * — the SAME mechanism PR #139 built for PUBLIC-exposure business-facts
 * agents, extended symmetrically to INTERNAL by this branch (see
 * services/isola-runtime/src/agent-caller-proof.ts). There is no
 * `callerProof` request field: proof of identity IS the credential
 * presented, never something a request body could forge. When no per-agent
 * secret is configured, the call presents the plain shared INTERNAL bearer
 * — exactly today's behaviour for every other INTERNAL template, and the
 * runtime's own gate (not this module) is what refuses that with
 * `no_agent_bound_credential` for a template an operator has opted in.
 *
 * DUPLICATE PROTECTION, TWO LAYERS
 * -----------------------------------
 * `runId` is DETERMINISTIC from `(tenantId, threadId, turnId)` — the same
 * "same turnId reproduces the same id" shape `buildStaffChatCorrelationId`
 * already uses. The runtime's OWN idempotency store (`buildIdempotencyKey`)
 * keys on `(companyId, agentId, runId, issueId, contextText)` and replays a
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
import {
  listCcoAgents,
  resolveCcoAgentBinding,
  type CcoAgentBindingOutcome,
  type CcoAgentCatalogEntry,
} from './cco-agent-binding';
import { bearerForAgent, getIsolaRuntimeConfig } from '@/lib/engines';

/** The isola-runtime registry id — DISTINCT from CCO_TEMPLATE_ID
 *  (cco-agent-binding.ts), which is isola-portal's own catalogue id for the
 *  same underlying agent. Never conflate the two: sending isola-portal's id
 *  to isola-runtime's `findTemplate()` resolves to nothing and 400s as
 *  `unknown_template`. */
export const RUNTIME_TEMPLATE_ID = 'epic-staff-operations-coordinator@v1';

const RUNTIME_REQUEST_TIMEOUT_MS = 55_000;

export type CcoAskState = 'replied' | 'blocked' | 'unavailable' | 'timeout' | 'degraded';

export type CcoAskBlockedReason =
  | Exclude<CcoAgentBindingOutcome['outcome'], 'linked' | 'not_configured' | 'unreachable'>
  | 'not_provisioned'
  /** The genuinely underspecified case: no agent was selected and more than
   *  one executable candidate exists. `availableAgents` carries the choice. */
  | 'ambiguous_agent_selection_required';

export interface CcoAskBlocked {
  state: 'blocked';
  reason: CcoAskBlockedReason;
  briefing: null;
  text: null;
  sources: [];
  correlationId: null;
  /** Populated ONLY for `ambiguous_agent_selection_required` — the real
   *  choices a caller (or UI) must pick from. Empty for every other reason. */
  availableAgents: CcoAgentCatalogEntry[];
}

export interface CcoAskUnavailableOrDegraded {
  state: 'unavailable' | 'timeout' | 'degraded';
  reason: string;
  briefing: BusinessBriefing | null;
  text: null;
  sources: [];
  correlationId: string | null;
  availableAgents: [];
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
  availableAgents: [];
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
  /** The owner's SELECTED agent, by its real `paperclip_agent_id`. Omit only
   *  when the caller genuinely has not made a selection yet — see
   *  `listCcoAgents`/`ambiguous_agent_selection_required` above. */
  paperclipAgentId?: string;
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

function blocked(reason: CcoAskBlockedReason, availableAgents: CcoAgentCatalogEntry[] = []): CcoAskBlocked {
  return { state: 'blocked', reason, briefing: null, text: null, sources: [], correlationId: null, availableAgents };
}

interface RuntimeInvokeBody {
  ok: boolean;
  outcome: string;
  correlationId?: unknown;
  answerText?: unknown;
  error?: unknown;
}

/**
 * Resolves WHICH agent this call runs as. Agent selection, never template
 * matching: an explicit `paperclipAgentId` is resolved by identity; its
 * absence falls back to the catalog ONLY to handle the single-option and
 * genuinely-ambiguous cases, never to pick between real alternatives.
 */
async function resolveSelectedAgent(
  tenantId: string,
  paperclipAgentId: string | undefined,
): Promise<{ kind: 'resolved'; agentId: string; companyId: string } | { kind: 'blocked'; result: CcoAskResult }> {
  if (paperclipAgentId !== undefined && paperclipAgentId.length > 0) {
    const binding = await resolveCcoAgentBinding(tenantId, paperclipAgentId);
    if (binding.outcome === 'linked') {
      return { kind: 'resolved', agentId: binding.paperclipAgentId, companyId: binding.paperclipCompanyId };
    }
    if (binding.outcome === 'not_configured' || binding.outcome === 'unreachable') {
      return {
        kind: 'blocked',
        result: {
          state: 'unavailable',
          reason: `agent_binding_${binding.outcome}`,
          briefing: null,
          text: null,
          sources: [],
          correlationId: null,
          availableAgents: [],
        },
      };
    }
    // tenant_not_mapped | not_found | not_ready
    return { kind: 'blocked', result: blocked(binding.outcome) };
  }

  const catalog = await listCcoAgents(tenantId);
  if (catalog.outcome === 'not_configured' || catalog.outcome === 'unreachable') {
    return {
      kind: 'blocked',
      result: {
        state: 'unavailable',
        reason: `agent_catalog_${catalog.outcome}`,
        briefing: null,
        text: null,
        sources: [],
        correlationId: null,
        availableAgents: [],
      },
    };
  }
  if (catalog.outcome === 'tenant_not_mapped') {
    return { kind: 'blocked', result: blocked('tenant_not_mapped') };
  }
  if (catalog.agents.length === 0) {
    return { kind: 'blocked', result: blocked('not_provisioned') };
  }
  if (catalog.agents.length > 1) {
    // THE ONLY genuinely underspecified case. Never guessed, never the
    // first one picked -- the real choice is handed back.
    return { kind: 'blocked', result: blocked('ambiguous_agent_selection_required', catalog.agents) };
  }
  const only = catalog.agents[0]!;
  return { kind: 'resolved', agentId: only.paperclipAgentId, companyId: only.paperclipCompanyId };
}

export async function askCco(input: CcoAskInput): Promise<CcoAskResult> {
  const selected = await resolveSelectedAgent(input.tenantId, input.paperclipAgentId);
  if (selected.kind === 'blocked') return selected.result;

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
      availableAgents: [],
    };
  }

  const runId = runIdFor(input.tenantId, input.threadId, input.turnId);
  const requestBody: Record<string, unknown> = {
    templateId: RUNTIME_TEMPLATE_ID,
    exposure: 'INTERNAL',
    agentId: selected.agentId,
    runId,
    // NEVER "paperclip" — Foundation did not issue this id through
    // Paperclip's own heartbeat mechanism. Absence is the safe default; see
    // app.ts's own comment on runIdIssuedBy.
    responseMode: 'inline',
    context: {
      companyId: selected.companyId,
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

  let res: Response;
  try {
    res = await fetch(new URL('/v1/invoke', runtimeConfig.baseUrl), {
      method: 'POST',
      headers: {
        // The proof IS this bearer — the agent's own credential when this
        // deployment holds one, else the plain shared bearer. Never a body
        // field; see this module's own docstring.
        Authorization: `Bearer ${bearerForAgent(runtimeConfig, selected.agentId)}`,
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
      availableAgents: [],
    };
  }

  let body: RuntimeInvokeBody;
  try {
    body = (await res.json()) as RuntimeInvokeBody;
  } catch {
    return {
      state: 'unavailable',
      reason: 'runtime_unreadable_response',
      briefing,
      text: null,
      sources: [],
      correlationId: null,
      availableAgents: [],
    };
  }

  const correlationId = typeof body.correlationId === 'string' ? body.correlationId : null;

  if (body.outcome === 'ok') {
    const text = typeof body.answerText === 'string' ? body.answerText : null;
    if (text === null || text.trim().length === 0) {
      // Should not happen when outcome is genuinely "ok" in inline mode
      // (see app.ts's own completionState derivation), but never fabricate
      // an answer if it does.
      return {
        state: 'degraded',
        reason: 'ok_with_no_answer_text',
        briefing,
        text: null,
        sources: [],
        correlationId,
        availableAgents: [],
      };
    }
    return {
      state: 'replied',
      reason: null,
      briefing,
      text,
      sources: briefingSourceLinks(briefing),
      correlationId: correlationId ?? runId,
      availableAgents: [],
    };
  }

  if (body.outcome === 'model_timeout') {
    return { state: 'timeout', reason: body.outcome, briefing, text: null, sources: [], correlationId, availableAgents: [] };
  }

  // CONFIGURATION-SHAPED, mirroring performStaffChatTurn's own
  // CONFIGURATION_KINDS discipline: these say nothing about the owner's
  // message and must never be presented as though they do. This now
  // includes `agent_caller_proof_required` — a Foundation-side wiring gap
  // (a missing/wrong agent-bound bearer for THIS agent), never a fault in
  // the owner's own question.
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
    return { state: 'unavailable', reason: body.outcome, briefing, text: null, sources: [], correlationId, availableAgents: [] };
  }

  // provider_error, persistence_failed, internal_error, duplicate_run_suppressed
  // (the true in-flight-duplicate case) and anything not explicitly named
  // above: transient, "try again" framing — never claims nothing happened.
  return { state: 'degraded', reason: body.outcome, briefing, text: null, sources: [], correlationId, availableAgents: [] };
}
