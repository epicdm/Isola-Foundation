/**
 * orchestrator.ts - Clawith proposes; Foundation authorises and executes.
 *
 * This is the module that turns a validated Clawith response into real business
 * effects, and it is written as a sequence of REFUSAL POINTS rather than a
 * pipeline of transformations. Each step can only narrow what happens next.
 * Nothing here is best-effort: a step that cannot prove its precondition
 * refuses the turn, and refusing means the customer hears nothing rather than
 * hearing something Foundation could not stand behind.
 *
 * ── The invariant that orders everything else ────────────────────────────────
 *
 *   Foundation NEVER reports a tool success before it holds the Odoo readback.
 *
 * The governed tools already enforce this internally - each one claims, writes,
 * rereads and only then completes. The orchestrator enforces it a second time at
 * the boundary, because the thing being protected here is different: not the
 * ledger's correctness, but what CLAWITH is told, and therefore what the
 * customer is told in the next reasoning turn. A tool that returns `ok` with no
 * readback is a bug in that tool; treating it as success would turn that bug
 * into a lie to a customer. So `readback === null` is a refusal even when the
 * tool says it worked.
 *
 * ── Why the iteration cap is a constant and not a parameter ──────────────────
 *
 * `MAX_TOOL_REQUESTS` (8, in ./contract.ts) bounds how many tools ONE response
 * may ask for. It does not bound how many times we go back to the model, and
 * those are the two different unbounded things. A reasoning loop that re-invokes
 * whenever the model asks for another tool is a loop whose length the MODEL
 * chooses - which is to say, unbounded, and billed to us per turn. Two reasoning
 * turns, total, decided here: one to propose the tools, one to speak to the
 * customer about their results. A second turn that asks for MORE tools is
 * refused, not served. There is no recursion in this file and no `while` whose
 * exit depends on a model output.
 *
 * ── Why ownership is read TWICE ──────────────────────────────────────────────
 *
 * Step 3 reads it to decide whether the AI may act at all. Step 14 reads it
 * AGAIN, from the store, immediately before the reply goes out. Between those
 * two points we made network calls to Odoo, which take real wall-clock time, and
 * in that window a human agent can pick the conversation up in Chatwoot. Sending
 * the AI's reply after that has happened is the exact defect the ownership model
 * exists to prevent - two voices in one conversation, the customer unable to
 * tell which is which. The episode counter is checked alongside the state
 * because a conversation can leave AI ownership and come back while we were
 * waiting, and the state alone cannot see that.
 *
 * ── Deliberately NOT here ────────────────────────────────────────────────────
 *
 * No call site. Nothing imports this module into a live route in this commit,
 * and every call site added later must pass `allowedTools: []` until the whole
 * tool set has been reviewed. An empty allowlist makes step 4 refuse every tool
 * request unconditionally, which is what keeps this machinery inert while it is
 * wired.
 */

import { AI_REPLY_OWNERSHIP_STATES, MAX_TOOL_REQUESTS, type ClawithResponse, type ClawithToolDefinition } from './contract';
import { ClawithFailure, isClawithFailure } from './errors';
import { parseClawithResponse, type ExpectedResponseIdentity } from './response';
import { readOwnership, type OwnershipBearingRow, type OwnershipState } from '@/lib/ownership/state';

/** Reasoning turns per inbound message, total. Not model-controlled. */
export const MAX_REASONING_TURNS = 2;

export type OrchestratorRefusalCode =
  /** The response did not survive ./response.ts validation. */
  | 'response_invalid'
  /** The conversation could not be loaded, so nothing about it can be trusted. */
  | 'conversation_not_found'
  /** The conversation belongs to a different tenant than the turn claims. */
  | 'tenant_mismatch'
  /** Ownership does not permit the AI to act (or could not be read - fail closed). */
  | 'ownership_not_ai'
  /** Clawith asked for a tool this TURN did not authorise. */
  | 'tool_not_allowed_this_turn'
  /** The tool was authorised on the wire but Foundation has no executor for it. */
  | 'tool_unknown'
  /** Arguments failed the tool's own contract or tenant policy. */
  | 'tool_arguments_invalid'
  /** The tool refused or failed during execution. */
  | 'tool_execution_failed'
  /** The tool claimed success without an Odoo readback. Never reported as success. */
  | 'readback_missing'
  /** A second reasoning turn asked for more tools. */
  | 'iteration_cap_exceeded'
  /** Ownership left the AI while a tool was running. */
  | 'human_took_over_mid_flight'
  /** The conversation left and re-entered AI ownership while a tool was running. */
  | 'episode_changed_mid_flight';

export interface OrchestratorConversation extends OwnershipBearingRow {
  id: string;
  tenant_id: string;
}

export interface ToolExecutionContext {
  tenantId: string;
  conversationId: string;
  clawithSessionId: string;
  correlationId: string;
  /** Clawith's idempotency hint. An INPUT to the derived operation id. */
  operationIdHint: string;
  /** The partner the conversation resolved, for the tool's ownership check. */
  expectedPartnerId: number | null;
}

/** What a tool reports back. `readback` is the load-bearing field. */
export interface GovernedToolExecution {
  ok: boolean;
  operationId: string | null;
  /**
   * The authoritative Odoo record the tool READ BACK after writing. Null means
   * Foundation does not hold proof, and therefore may not report success -
   * whatever `ok` says.
   */
  readback: { model: string; id: number } | null;
  /** Result fields fit to return to Clawith. Scrubbed again by this module. */
  result: Record<string, unknown>;
  failureCode?: string | null;
  detail?: string | null;
}

export interface GovernedToolEntry {
  name: string;
  mutating: boolean;
  /**
   * Narrow the PROPOSED arguments to AUTHORISED ones.
   *
   * Returning the caller's object unchanged is always wrong: no model, method,
   * domain or field may reach Odoo because Clawith named it. Implementations
   * pick semantic fields out by name and drop the rest.
   */
  authoriseArguments: (
    raw: Record<string, unknown>,
    ctx: ToolExecutionContext,
  ) => { ok: true; authorised: Record<string, unknown> } | { ok: false; detail: string };
  execute: (authorised: Record<string, unknown>, ctx: ToolExecutionContext) => Promise<GovernedToolExecution>;
}

export interface OrchestratorAuditEntry {
  tenantId: string;
  conversationId: string;
  correlationId: string;
  action: string;
  toolName?: string | null;
  operationId?: string | null;
  outcome: 'executed' | 'refused' | 'replied' | 'suppressed';
  detail?: string | null;
  meta?: Record<string, unknown>;
}

export interface ReinvokeInput {
  turn: number;
  toolResults: SanitisedToolResult[];
  correlationId: string;
  conversationId: string;
}

export interface SanitisedToolResult {
  toolName: string;
  ok: boolean;
  operationId: string | null;
  /** Present only when Foundation holds the readback. */
  readback: { model: string; id: number } | null;
  result: Record<string, unknown>;
  failureCode?: string | null;
}

export interface OrchestratorDeps {
  /** Re-read from the store every time. A cached ownership value is a stale one. */
  loadConversation: (conversationId: string) => Promise<OrchestratorConversation | null>;
  tools: Readonly<Record<string, GovernedToolEntry>>;
  /** The ONE permitted second reasoning turn. Returns a raw, unvalidated body. */
  reinvoke: (input: ReinvokeInput) => Promise<unknown>;
  sendCustomerReply: (input: {
    conversationId: string;
    correlationId: string;
    text: string;
  }) => Promise<{ ok: boolean; providerMessageId?: string | null }>;
  audit: (entry: OrchestratorAuditEntry) => Promise<void>;
}

export interface OrchestrateTurnInput {
  /** The tenant Foundation resolved for this delivery. Authoritative. */
  tenantId: string;
  conversationId: string;
  inboundMessageId: string;
  correlationId: string;
  designatedAgentId: string;
  clawithSessionId: string;
  expectedPartnerId: number | null;
  /**
   * The tools Foundation offered THIS turn. Step 4 checks membership of this
   * list - not "is there an executor for it", which is a different and much
   * weaker question. Empty means no tool can run, which is the wiring default.
   */
  allowedTools: ClawithToolDefinition[];
  /** The first reasoning turn's raw, unvalidated response. */
  rawResponse: unknown;
  expectedSchemaVersion: string;
}

export type OrchestratorOutcome =
  | {
      kind: 'replied';
      text: string;
      toolResults: SanitisedToolResult[];
      reasoningTurns: number;
      providerMessageId: string | null;
    }
  | { kind: 'escalated'; text: string | null; toolResults: SanitisedToolResult[]; reasoningTurns: number }
  | { kind: 'suppressed'; reason: string; toolResults: SanitisedToolResult[]; reasoningTurns: number }
  | {
      kind: 'refused';
      code: OrchestratorRefusalCode;
      detail: string;
      toolResults: SanitisedToolResult[];
      reasoningTurns: number;
    };

// ── Sanitisation of what goes BACK to Clawith ───────────────────────────────

/** Key shapes that must never be echoed to the model, whatever a tool returns. */
const FORBIDDEN_RESULT_KEY = /secret|token|password|passwd|credential|apikey|api_key|_key$|^key$|authorization|cookie|session_id|dsn|connection_string/i;

/**
 * Scrub a tool result before it crosses back to Clawith.
 *
 * The governed tools are careful, but "the tool was careful" is not a boundary.
 * This is: one place that decides what a model - and therefore, one turn later,
 * a member of the public - can be told. Values are flattened to primitives
 * because a nested object is a place for something unreviewed to hide, and keys
 * that look like credentials are dropped rather than masked, since a masked key
 * still confirms its existence and its name.
 */
export function sanitiseToolResultForClawith(result: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(result ?? {})) {
    if (FORBIDDEN_RESULT_KEY.test(k)) continue;
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
    // Anything else - objects, arrays, functions, undefined - is dropped. A tool
    // that needs to return structure should return named scalars instead.
  }
  return out;
}

// ── The sequence ────────────────────────────────────────────────────────────

function refuse(
  code: OrchestratorRefusalCode,
  detail: string,
  toolResults: SanitisedToolResult[],
  reasoningTurns: number,
): OrchestratorOutcome {
  return { kind: 'refused', code, detail, toolResults, reasoningTurns };
}

/**
 * Map a validator failure onto a refusal code that says what actually happened.
 *
 * `parseClawithResponse` checks the turn's allowlist itself, so an unauthorised
 * tool is caught in step 1 rather than step 4. Collapsing that into
 * `response_invalid` would tell an operator the JSON was malformed when the truth
 * is that the agent asked for a tool it was not offered - a different problem
 * with a different fix. Step 4 stays in place regardless, for any caller that
 * validated the body elsewhere.
 */
function classifyValidationFailure(err: unknown): { code: OrchestratorRefusalCode; detail: string } {
  if (!isClawithFailure(err)) {
    return { code: 'response_invalid', detail: String((err as Error)?.message ?? err) };
  }
  const detail = `${err.kind}: ${err.detail ?? ''}`;
  if (err.kind === 'unsupported_tool') return { code: 'tool_not_allowed_this_turn', detail };
  if (err.kind === 'tenant_mismatch') return { code: 'tenant_mismatch', detail };
  return { code: 'response_invalid', detail };
}

/** Steps 3 and 14 share this, so the two reads cannot drift apart. */
function aiMayAct(row: OrchestratorConversation): { ok: true; state: OwnershipState; episode: number } | { ok: false; detail: string } {
  const view = readOwnership(row);
  if (view.diverged) {
    return { ok: false, detail: 'ownership could not be read as a consistent fact - failing closed' };
  }
  if (!AI_REPLY_OWNERSHIP_STATES.has(view.state)) {
    return { ok: false, detail: `ownership state ${view.state} does not permit an AI turn` };
  }
  return { ok: true, state: view.state, episode: view.episode };
}

/**
 * Run one inbound turn end to end.
 *
 * Resolves - it does not throw. Every branch a caller must handle is an outcome,
 * because an exception here would be caught two frames up by code that has no
 * way to know whether a reply was already sent.
 */
export async function orchestrateTurn(
  input: OrchestrateTurnInput,
  deps: OrchestratorDeps,
): Promise<OrchestratorOutcome> {
  const toolResults: SanitisedToolResult[] = [];
  let reasoningTurns = 0;

  const audit = async (entry: Omit<OrchestratorAuditEntry, 'tenantId' | 'conversationId' | 'correlationId'>) => {
    // Audit must never be the reason a turn fails. It is evidence, not control
    // flow, and a turn that refused correctly but could not write its audit row
    // is still a turn that refused correctly.
    try {
      await deps.audit({
        tenantId: input.tenantId,
        conversationId: input.conversationId,
        correlationId: input.correlationId,
        ...entry,
      });
    } catch (err) {
      console.error('[orchestrator] audit write failed:', err instanceof Error ? err.message : err);
    }
  };

  const allowedToolNames = new Set(input.allowedTools.map((t) => t.name));
  const identity: ExpectedResponseIdentity = {
    schemaVersion: input.expectedSchemaVersion,
    agentId: input.designatedAgentId,
    correlationId: input.correlationId,
    tenantId: input.tenantId,
    allowedToolNames,
  };

  // ── 1. Validate the structured response, including schema_version ──────────
  // ── 2. ...and tenant, agent_id and correlation_id, which parseClawithResponse
  //       checks as part of the same pass: a body whose correlation does not
  //       echo ours may describe another turn entirely, so nothing in it -
  //       including its tenant claim - can be read first.
  let response: ClawithResponse;
  reasoningTurns = 1;
  try {
    response = parseClawithResponse(input.rawResponse, identity);
  } catch (err) {
    const { code, detail } = classifyValidationFailure(err);
    await audit({ action: 'clawith.response.rejected', outcome: 'refused', detail });
    return refuse(code, detail, toolResults, reasoningTurns);
  }

  // ── 3. Validate conversation ownership ─────────────────────────────────────
  const conversation = await deps.loadConversation(input.conversationId);
  if (!conversation) {
    await audit({ action: 'clawith.conversation.missing', outcome: 'refused', detail: input.conversationId });
    return refuse('conversation_not_found', `conversation ${input.conversationId} not found`, toolResults, reasoningTurns);
  }
  if (conversation.tenant_id !== input.tenantId) {
    // Same class as the 2026-07-01 account-5 incident: two independently
    // sourced tenant ids disagreeing means we act on neither.
    await audit({ action: 'clawith.tenant.mismatch', outcome: 'refused', detail: 'conversation tenant != turn tenant' });
    return refuse('tenant_mismatch', 'conversation tenant does not match the turn tenant', toolResults, reasoningTurns);
  }

  const before = aiMayAct(conversation);
  if (!before.ok) {
    await audit({ action: 'clawith.ownership.refused', outcome: 'refused', detail: before.detail });
    return refuse('ownership_not_ai', before.detail, toolResults, reasoningTurns);
  }
  const episodeAtStart = before.episode;

  // An escalation request is terminal for this turn: ./response.ts has already
  // refused any body that escalates AND asks for tools, so there is no tool work
  // to reconcile here.
  if (response.escalation.requested) {
    await audit({
      action: 'clawith.escalation.requested',
      outcome: 'suppressed',
      detail: response.escalation.reason_code ?? null,
    });
    return {
      kind: 'escalated',
      text: response.escalation.customer_handoff_message ?? response.customer_reply,
      toolResults,
      reasoningTurns,
    };
  }

  // ── 4-9. Authorise, claim, execute and reread - per tool request ───────────
  // Sequential, deliberately. Concurrency here would mean two writes to the same
  // Odoo record racing with no ordering guarantee, and the ledger's exactly-once
  // property is per-operation, not a substitute for ordering between operations.
  if (response.tool_requests.length > MAX_TOOL_REQUESTS) {
    // ./response.ts bounds this too. Asserted again because this module must not
    // depend on a caller having used that validator.
    return refuse(
      'iteration_cap_exceeded',
      `tool_requests exceeds ${MAX_TOOL_REQUESTS}`,
      toolResults,
      reasoningTurns,
    );
  }

  for (const request of response.tool_requests) {
    // 4. In THIS turn's allowlist - not merely a tool that exists.
    if (!allowedToolNames.has(request.tool_name)) {
      await audit({
        action: 'clawith.tool.not_allowed',
        toolName: request.tool_name,
        outcome: 'refused',
        detail: 'absent from this turn allowed_tools',
      });
      return refuse(
        'tool_not_allowed_this_turn',
        `tool ${request.tool_name} was not authorised for this turn`,
        toolResults,
        reasoningTurns,
      );
    }

    const entry = deps.tools[request.tool_name];
    if (!entry) {
      // Offered on the wire but not executable here. That is a configuration
      // defect on our side, and executing something adjacent would be worse.
      await audit({ action: 'clawith.tool.unknown', toolName: request.tool_name, outcome: 'refused' });
      return refuse('tool_unknown', `no Foundation executor for ${request.tool_name}`, toolResults, reasoningTurns);
    }

    const ctx: ToolExecutionContext = {
      tenantId: input.tenantId,
      conversationId: input.conversationId,
      clawithSessionId: input.clawithSessionId,
      correlationId: input.correlationId,
      operationIdHint: request.operation_id_hint,
      expectedPartnerId: input.expectedPartnerId,
    };

    // 5. Arguments against the tool's contract and tenant policy.
    const authorised = entry.authoriseArguments(request.arguments, ctx);
    if (!authorised.ok) {
      await audit({
        action: 'clawith.tool.arguments_invalid',
        toolName: request.tool_name,
        outcome: 'refused',
        detail: authorised.detail,
      });
      return refuse('tool_arguments_invalid', authorised.detail, toolResults, reasoningTurns);
    }

    // 6-9. The tool derives the operation id Foundation-side from the hint plus a
    // hash of the AUTHORISED arguments, claims, executes and rereads Odoo. That
    // sequence lives in ./operation.ts and the tool, not here - duplicating it
    // would create a second claim substrate that could disagree with the first.
    let execution: GovernedToolExecution;
    try {
      execution = await entry.execute(authorised.authorised, ctx);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await audit({ action: 'clawith.tool.threw', toolName: request.tool_name, outcome: 'refused', detail });
      return refuse('tool_execution_failed', detail, toolResults, reasoningTurns);
    }

    // THE invariant. `ok` without a readback is not success, and Clawith is not
    // told it was.
    if (execution.ok && execution.readback === null) {
      await audit({
        action: 'clawith.tool.readback_missing',
        toolName: request.tool_name,
        operationId: execution.operationId,
        outcome: 'refused',
        detail: 'tool reported ok with no Odoo readback',
      });
      return refuse(
        'readback_missing',
        `${request.tool_name} reported success without an Odoo readback`,
        toolResults,
        reasoningTurns,
      );
    }

    const sanitised: SanitisedToolResult = {
      toolName: request.tool_name,
      ok: execution.ok,
      operationId: execution.operationId,
      readback: execution.readback,
      // 11. Sanitised for return to Clawith - no credentials, nothing internal.
      result: sanitiseToolResultForClawith(execution.result),
      failureCode: execution.failureCode ?? null,
    };
    toolResults.push(sanitised);

    // 10. Audit the execution, successful or not.
    await audit({
      action: 'clawith.tool.executed',
      toolName: request.tool_name,
      operationId: execution.operationId,
      outcome: execution.ok ? 'executed' : 'refused',
      detail: execution.detail ?? null,
      meta: { readback: execution.readback, failureCode: execution.failureCode ?? null },
    });

    if (!execution.ok) {
      // A failed tool ends the turn. Continuing would ask the model to narrate a
      // partial outcome to a customer, and the honest thing is a human.
      return refuse(
        'tool_execution_failed',
        execution.detail ?? execution.failureCode ?? `${request.tool_name} failed`,
        toolResults,
        reasoningTurns,
      );
    }
  }

  // ── 12. One bounded second reasoning turn ─────────────────────────────────
  // Only when tools ran. A first turn that already carried a customer_reply and
  // asked for nothing has nothing to reason about again.
  let finalResponse = response;
  if (toolResults.length > 0) {
    if (reasoningTurns >= MAX_REASONING_TURNS) {
      return refuse('iteration_cap_exceeded', `reasoning turns capped at ${MAX_REASONING_TURNS}`, toolResults, reasoningTurns);
    }
    let raw: unknown;
    try {
      raw = await deps.reinvoke({
        turn: reasoningTurns + 1,
        toolResults,
        correlationId: input.correlationId,
        conversationId: input.conversationId,
      });
    } catch (err) {
      const detail = isClawithFailure(err) ? `${err.kind}: ${err.detail ?? ''}` : String((err as Error)?.message ?? err);
      await audit({ action: 'clawith.reinvoke.failed', outcome: 'suppressed', detail });
      return { kind: 'suppressed', reason: `second reasoning turn failed: ${detail}`, toolResults, reasoningTurns };
    }
    reasoningTurns += 1;

    // ── 13. Validate the final response ────────────────────────────────────
    try {
      finalResponse = parseClawithResponse(raw, identity);
    } catch (err) {
      const { code, detail } = classifyValidationFailure(err);
      await audit({ action: 'clawith.final_response.rejected', outcome: 'refused', detail });
      return refuse(code, detail, toolResults, reasoningTurns);
    }

    // The cap, enforced. A second turn that asks for more tools is refused -
    // NOT served, and not silently truncated to "we did the first few".
    if (finalResponse.tool_requests.length > 0) {
      await audit({
        action: 'clawith.iteration_cap',
        outcome: 'refused',
        detail: `second reasoning turn requested ${finalResponse.tool_requests.length} more tools`,
      });
      return refuse(
        'iteration_cap_exceeded',
        `second reasoning turn requested more tools; cap is ${MAX_REASONING_TURNS} reasoning turns`,
        toolResults,
        reasoningTurns,
      );
    }

    if (finalResponse.escalation.requested) {
      await audit({ action: 'clawith.escalation.requested', outcome: 'suppressed', detail: finalResponse.escalation.reason_code ?? null });
      return {
        kind: 'escalated',
        text: finalResponse.escalation.customer_handoff_message ?? finalResponse.customer_reply,
        toolResults,
        reasoningTurns,
      };
    }
  }

  // ── 14. Reread ownership AND episode - a human may have taken over ────────
  const after = await deps.loadConversation(input.conversationId);
  if (!after) {
    return refuse('conversation_not_found', 'conversation disappeared mid-turn', toolResults, reasoningTurns);
  }
  const now = aiMayAct(after);
  if (!now.ok) {
    // The tool work already happened and is recorded. What must NOT happen is
    // the AI speaking into a conversation a person has picked up.
    await audit({ action: 'clawith.handover.mid_flight', outcome: 'suppressed', detail: now.detail });
    return refuse('human_took_over_mid_flight', now.detail, toolResults, reasoningTurns);
  }
  if (now.episode !== episodeAtStart) {
    await audit({
      action: 'clawith.episode.changed',
      outcome: 'suppressed',
      detail: `episode ${episodeAtStart} -> ${now.episode}`,
    });
    return refuse(
      'episode_changed_mid_flight',
      `ownership episode changed from ${episodeAtStart} to ${now.episode} while a tool was running`,
      toolResults,
      reasoningTurns,
    );
  }

  // ── 15. At most ONE customer reply ────────────────────────────────────────
  // There is exactly one call to sendCustomerReply in this function, and it is
  // unreachable twice: every path above returns. That is the guarantee, rather
  // than a flag that a later edit could get wrong.
  const text = finalResponse.customer_reply;
  // Defensive. ./response.ts refuses a body with no reply, no escalation and no
  // tool requests, and both of the other two cases have already returned above -
  // so a validated response reaching here always carries a reply. That guarantee
  // lives in another module, which is exactly why it is not assumed here.
  if (text === null) {
    await audit({ action: 'clawith.turn.no_reply', outcome: 'suppressed', detail: 'no customer_reply after tool execution' });
    return { kind: 'suppressed', reason: 'no customer reply produced', toolResults, reasoningTurns };
  }

  const sent = await deps.sendCustomerReply({
    conversationId: input.conversationId,
    correlationId: input.correlationId,
    text,
  });
  if (!sent.ok) {
    await audit({ action: 'clawith.reply.send_failed', outcome: 'suppressed' });
    return { kind: 'suppressed', reason: 'customer reply could not be sent', toolResults, reasoningTurns };
  }

  await audit({
    action: 'clawith.reply.sent',
    outcome: 'replied',
    meta: { providerMessageId: sent.providerMessageId ?? null, tools: toolResults.length },
  });
  return {
    kind: 'replied',
    text,
    toolResults,
    reasoningTurns,
    providerMessageId: sent.providerMessageId ?? null,
  };
}

/** Re-exported so a call site can assert the wiring default explicitly. */
export const NO_TOOLS_AUTHORISED: ClawithToolDefinition[] = [];

export { ClawithFailure };
