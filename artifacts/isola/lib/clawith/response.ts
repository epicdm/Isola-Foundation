/**
 * Validates the Clawith → Foundation structured response.
 *
 * Foundation is the ONLY component allowed to send the customer reply or
 * execute an Odoo tool. Everything Clawith returns is therefore treated as a
 * PROPOSAL that has to survive validation before any of it is acted on.
 *
 * Rejections here are hard: an invalid response does not degrade to a
 * best-effort reply, and it never degrades to the native brain on the gated
 * path. See ./invoke.ts for what happens instead.
 */

import {
  ESCALATION_REASON_CODES,
  ESCALATION_URGENCIES,
  MAX_TOOL_REQUESTS,
  QUALIFICATION_STATES,
  type ClawithEscalation,
  type ClawithResponse,
  type ClawithToolRequest,
  type EscalationReasonCode,
  type EscalationUrgency,
  type QualificationState,
} from './contract';
import { ClawithFailure, type ClawithFailureKind } from './errors';

export interface ExpectedResponseIdentity {
  schemaVersion: string;
  agentId: string;
  correlationId: string;
  tenantId: string;
  /** Tool names this request authorised. Anything else is rejected. */
  allowedToolNames: ReadonlySet<string>;
}

/** Tool names whose execution changes a business system of record. A reply
 *  that presumes one of these has already run is a fabrication until
 *  Foundation says otherwise. */
const MUTATION_HINT = /\.(create|update|delete|schedule|send|log)$/;

/** Signatures of a raw provider/runtime failure leaking through as if it
 *  were ordinary reply text. This is deliberately separate from HTTP-status
 *  classification: a provider can fail with a 200 whose body is otherwise
 *  well-formed but whose `customer_reply` (or handoff message) IS the raw
 *  failure — an HTTP code quoted as prose, a billing message, a bare run id,
 *  or runtime text in a language the agent was never asked to answer in.
 *  Never trust user-facing language alone when a structured code is
 *  available; this exists for the case where there isn't one. */
const UUID_ANYWHERE_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const CJK_RE = /[一-鿿]/;
const PROVIDER_LEAK_SIGNATURES: RegExp[] = [
  /\bHTTP[ _-]?[45]\d{2}\b/i,
  /\binsufficient[ _-]?balance\b/i,
  /\bmodel_call_failed\b/i,
  /\b(payment[ _-]?required|credit[ _-]?exhausted|quota[ _-]?exceeded)\b/i,
  /\brate[ _-]?limit(ed)?\b/i,
  /\brun[ _-]?id\b/i,
  UUID_ANYWHERE_RE,
  CJK_RE,
  /"(error|error_code|error_type|status_code)"\s*:/i,
  /\b(deepseek|openai|anthropic|moonshot|qwen|zhipu)\b/i,
];

/** True when `text` looks like a raw provider/runtime failure rather than an
 *  ordinary reply. Exported so both this module and its tests can reason
 *  about the exact signatures independent of where the check is wired in. */
export function looksLikeProviderErrorLeak(text: string): boolean {
  return PROVIDER_LEAK_SIGNATURES.some((re) => re.test(text));
}

function fail(kind: ClawithFailureKind, detail: string): never {
  throw new ClawithFailure(kind, detail);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function strList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail('invalid_response', `${field} must be an array`);
  if (value.length > max) fail('invalid_response', `${field} exceeds ${max} entries`);
  return value.map((v, i) => {
    const s = str(v);
    if (s === null) fail('invalid_response', `${field}[${i}] must be a non-empty string`);
    return s;
  });
}

function parseEscalation(raw: unknown): ClawithEscalation {
  if (raw === undefined || raw === null) {
    return {
      requested: false,
      reason_code: null,
      explanation: null,
      urgency: null,
      required_team: null,
      customer_handoff_message: null,
    };
  }
  if (typeof raw !== 'object') fail('invalid_response', 'escalation must be an object');
  const e = raw as Record<string, unknown>;
  const requested = e.requested === true;

  const reasonRaw = str(e.reason_code);
  if (requested && reasonRaw === null) fail('invalid_response', 'escalation.requested without reason_code');
  if (reasonRaw !== null && !ESCALATION_REASON_CODES.includes(reasonRaw as EscalationReasonCode)) {
    fail('invalid_response', `unknown escalation reason_code ${reasonRaw}`);
  }

  const urgencyRaw = str(e.urgency);
  if (urgencyRaw !== null && !ESCALATION_URGENCIES.includes(urgencyRaw as EscalationUrgency)) {
    fail('invalid_response', `unknown escalation urgency ${urgencyRaw}`);
  }

  return {
    requested,
    reason_code: (reasonRaw as EscalationReasonCode | null) ?? null,
    explanation: str(e.explanation),
    urgency: (urgencyRaw as EscalationUrgency | null) ?? null,
    required_team: str(e.required_team),
    customer_handoff_message: str(e.customer_handoff_message),
  };
}

function parseToolRequests(raw: unknown, allowed: ReadonlySet<string>): ClawithToolRequest[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail('invalid_response', 'tool_requests must be an array');
  if (raw.length > MAX_TOOL_REQUESTS) {
    fail('invalid_response', `tool_requests exceeds ${MAX_TOOL_REQUESTS} entries`);
  }

  const seenHints = new Set<string>();
  return raw.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null) {
      fail('invalid_response', `tool_requests[${i}] must be an object`);
    }
    const t = entry as Record<string, unknown>;
    const name = str(t.tool_name);
    if (name === null) fail('invalid_response', `tool_requests[${i}].tool_name is required`);

    // The allowlist check is the whole authorisation model: Clawith may ask
    // for anything, and only what Foundation offered this turn is reachable.
    if (!allowed.has(name)) fail('unsupported_tool', `tool ${name} was not authorised for this turn`);

    const hint = str(t.operation_id_hint);
    if (hint === null) fail('invalid_response', `tool_requests[${i}].operation_id_hint is required`);
    // Duplicate hints inside one response are a double-execution request.
    if (seenHints.has(hint)) fail('invalid_response', `duplicate operation_id_hint ${hint}`);
    seenHints.add(hint);

    const args = t.arguments;
    if (args !== undefined && (typeof args !== 'object' || args === null || Array.isArray(args))) {
      fail('invalid_response', `tool_requests[${i}].arguments must be an object`);
    }

    return {
      tool_name: name,
      operation_id_hint: hint,
      arguments: (args as Record<string, unknown> | undefined) ?? {},
      reason: str(t.reason) ?? '',
    };
  });
}

/**
 * Parse + validate one Clawith response against the identity of the request
 * that produced it. Throws `ClawithFailure` — never returns a partial object.
 */
export function parseClawithResponse(raw: unknown, expected: ExpectedResponseIdentity): ClawithResponse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    fail('invalid_response', 'response body must be a JSON object');
  }
  const r = raw as Record<string, unknown>;

  const schemaVersion = str(r.schema_version);
  if (schemaVersion === null) fail('invalid_response', 'schema_version is required');
  if (schemaVersion !== expected.schemaVersion) {
    fail('invalid_response', `schema_version ${schemaVersion} != ${expected.schemaVersion}`);
  }

  // Correlation before agent: a mismatched correlation means this body may
  // belong to a different turn entirely, and nothing else in it can be
  // trusted to describe THIS conversation.
  const correlationId = str(r.correlation_id);
  if (correlationId === null) fail('correlation_mismatch', 'correlation_id is missing');
  if (correlationId !== expected.correlationId) {
    fail('correlation_mismatch', 'correlation_id does not echo the request');
  }

  const agentId = str(r.agent_id);
  if (agentId === null) fail('agent_mismatch', 'agent_id is missing');
  if (agentId !== expected.agentId) fail('agent_mismatch', 'agent_id is not the designated agent');

  const sessionId = str(r.session_id);
  if (sessionId === null) fail('invalid_response', 'session_id is required');

  // A response may carry tenant_id for its own bookkeeping. If it does, it
  // must be OURS — a foreign tenant id is a cross-tenant leak, not a typo.
  const tenantId = str(r.tenant_id);
  if (tenantId !== null && tenantId !== expected.tenantId) {
    fail('tenant_mismatch', 'response references a different tenant');
  }

  const confidenceRaw = r.confidence;
  if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw)) {
    fail('invalid_response', 'confidence is required and must be a number');
  }
  if (confidenceRaw < 0 || confidenceRaw > 1) {
    fail('invalid_response', 'confidence must be within 0..1');
  }

  const qualificationRaw = str(r.qualification_state) ?? 'unknown';
  if (!QUALIFICATION_STATES.includes(qualificationRaw as QualificationState)) {
    fail('invalid_response', `unknown qualification_state ${qualificationRaw}`);
  }

  const escalation = parseEscalation(r.escalation);
  const toolRequests = parseToolRequests(r.tool_requests, expected.allowedToolNames);
  const customerReply = str(r.customer_reply);

  // A "successful" response whose visible text IS the raw failure is the
  // exact leak this taxonomy exists to catch — checked before any of the
  // structural contradiction checks below, and on both fields Foundation
  // ever actually renders to a user (customer_reply, escalation's
  // customer-facing handoff message; escalation.explanation is
  // operator-only and never shown to anyone, so it is not checked here).
  if (customerReply !== null && looksLikeProviderErrorLeak(customerReply)) {
    fail('provider_error_leaked', customerReply.slice(0, 500));
  }
  if (escalation.customer_handoff_message !== null && looksLikeProviderErrorLeak(escalation.customer_handoff_message)) {
    fail('provider_error_leaked', escalation.customer_handoff_message.slice(0, 500));
  }

  // ── Contradiction checks ──────────────────────────────────────────────────
  // A response that says nothing, asks for nothing and escalates nothing is
  // not a turn — acting on it would leave the customer with silence and no
  // recorded reason for it.
  if (customerReply === null && !escalation.requested && toolRequests.length === 0) {
    fail('contradictory_response', 'no customer_reply, no escalation and no tool_requests');
  }
  // Escalating AND asking Foundation to mutate a business record in the same
  // turn leaves ownership ambiguous: the human would inherit a conversation
  // whose side effects are still in flight.
  if (escalation.requested && toolRequests.length > 0) {
    fail('contradictory_response', 'escalation requested alongside tool_requests');
  }
  // A final customer success claim cannot coexist with work Foundation has
  // not yet authorised, executed or read back. This is the specific
  // fabrication the contract names: Clawith never claims a tool succeeded
  // before Foundation returns authoritative readback.
  if (customerReply !== null && toolRequests.some((t) => MUTATION_HINT.test(t.tool_name))) {
    fail('contradictory_response', 'customer_reply asserted alongside an unexecuted mutating tool request');
  }

  const usageRaw = r.usage;
  const usage =
    typeof usageRaw === 'object' && usageRaw !== null && !Array.isArray(usageRaw)
      ? {
          latency_ms:
            typeof (usageRaw as Record<string, unknown>).latency_ms === 'number'
              ? ((usageRaw as Record<string, unknown>).latency_ms as number)
              : undefined,
          tokens:
            typeof (usageRaw as Record<string, unknown>).tokens === 'number'
              ? ((usageRaw as Record<string, unknown>).tokens as number)
              : undefined,
        }
      : null;

  return {
    schema_version: schemaVersion,
    agent_id: agentId,
    session_id: sessionId,
    correlation_id: correlationId,
    customer_reply: customerReply,
    intent: str(r.intent),
    confidence: confidenceRaw,
    qualification_state: qualificationRaw as QualificationState,
    knowledge_references: strList(r.knowledge_references, 'knowledge_references', 32),
    tool_requests: toolRequests,
    escalation,
    missing_information: strList(r.missing_information, 'missing_information', 16),
    follow_up_required: r.follow_up_required === true,
    usage,
  };
}
