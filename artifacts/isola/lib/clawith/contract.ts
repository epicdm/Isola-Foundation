/**
 * Foundation ↔ Clawith structured contract — shared types and bounds.
 *
 * Implements `dec-foundation-clawith-structured-response-contract-2026-07-29`.
 *
 * This module is deliberately provider-independent: nothing here names
 * DeepSeek, Anthropic or any other model vendor. Provider/model selection is
 * Clawith configuration and never leaks into the wire contract.
 *
 * It is also deliberately dependency-free. `zod` is not a dependency of
 * `@workspace/isola`, and a wire contract that guards a live customer path is
 * not the place to introduce one — the validators in `./request.ts` and
 * `./response.ts` are hand-written and exhaustively tested instead.
 *
 * The existing text-only bridge (`tryIsolaBridge()` in lib/brain-provider.ts)
 * is NOT replaced by this module and NOT duplicated by it: `./client.ts`
 * wraps the same endpoint and the same credential, adding the structured
 * envelope, correlation, timeout, bounded retry and error classification the
 * live product needs. The permanent path stays direct Foundation → Clawith
 * with no BFF-v2 hop.
 */

/** Bumped only for a breaking wire change. Sent on every request; echoed on
 *  every response and checked. */
export const CLAWITH_SCHEMA_VERSION = '1.0.0';

// ── Bounds ───────────────────────────────────────────────────────────────────
// Every list crossing the wire is bounded. An unbounded history, knowledge
// scope or tool list is how a tenant-scoped request quietly becomes a
// cross-tenant one, and how a single conversation grows an unbounded prompt.

/** Maximum conversation turns forwarded to Clawith. */
export const MAX_HISTORY_TURNS = 20;
/** Maximum characters of a single history turn; longer turns are truncated. */
export const MAX_HISTORY_TURN_CHARS = 4_000;
/** Maximum characters of the normalized inbound customer message. */
export const MAX_CUSTOMER_MESSAGE_CHARS = 8_000;
/** Maximum knowledge collection ids a single request may scope to. */
export const MAX_KNOWLEDGE_SCOPE_IDS = 16;
/** Maximum tool definitions a single request may authorise. */
export const MAX_ALLOWED_TOOLS = 24;
/** Maximum tool requests Foundation will consider in one response. */
export const MAX_TOOL_REQUESTS = 8;

/** Default deadline Foundation gives Clawith for one turn. */
export const DEFAULT_RESPONSE_DEADLINE_MS = 45_000;
/** Hard ceiling — a caller may not ask Clawith to take longer than this. */
export const MAX_RESPONSE_DEADLINE_MS = 90_000;

// ── Ownership ────────────────────────────────────────────────────────────────
// The authoritative ownership vocabulary shared by
// `dec-chatwoot-escalation-contract-inbox46-2026-07-29` and
// `dec-chatwoot-human-to-ai-handback-contract-inbox46-2026-07-29`.
// Commit 1 only TRANSPORTS this value; Commit 2 makes Foundation's own store
// authoritative for it. Declaring it here keeps the two commits speaking the
// same vocabulary rather than inventing it twice.

export const OWNERSHIP_STATES = [
  'AI_OWNED',
  'HUMAN_REQUESTED',
  'HUMAN_OWNED',
  'HANDING_BACK',
  'AI_RESUMED',
] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/** Ownership states in which Foundation may ask Clawith for a CUSTOMER-FACING
 *  reply. While a human owns or has been requested for the conversation,
 *  Clawith is not invoked for a reply at all. */
export const AI_REPLY_OWNERSHIP_STATES: ReadonlySet<OwnershipState> = new Set<OwnershipState>([
  'AI_OWNED',
  'AI_RESUMED',
]);

// ── Escalation ───────────────────────────────────────────────────────────────

export const ESCALATION_REASON_CODES = [
  'explicit_human_request',
  'low_confidence',
  'policy_boundary',
  'approval_required',
  'tool_failure',
  'complaint_sensitive',
  'unsupported_request',
] as const;
export type EscalationReasonCode = (typeof ESCALATION_REASON_CODES)[number];

export const ESCALATION_URGENCIES = ['low', 'normal', 'high'] as const;
export type EscalationUrgency = (typeof ESCALATION_URGENCIES)[number];

// ── Qualification ────────────────────────────────────────────────────────────

export const QUALIFICATION_STATES = [
  'unknown',
  'browsing',
  'qualifying',
  'qualified',
  'disqualified',
  'existing_customer',
] as const;
export type QualificationState = (typeof QUALIFICATION_STATES)[number];

// ── Request ──────────────────────────────────────────────────────────────────

/** One tool Foundation is willing to EXECUTE on Clawith's request this turn.
 *  Clawith requests; Foundation authorises and executes. A tool absent from
 *  this list can never be invoked, however the agent phrases it. */
export interface ClawithToolDefinition {
  /** Stable tool name, e.g. `crm.lead.create`. */
  name: string;
  /** One-line description handed to the agent. */
  description: string;
  /** Argument names the tool accepts. Kept as names rather than a JSON Schema
   *  so the authorisation surface stays inspectable and diffable. */
  arguments: string[];
  /** Arguments that must be present for the request to be considered. */
  required?: string[];
  /** True when executing the tool writes to a business system of record. */
  mutating: boolean;
}

export interface ClawithHistoryTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface ClawithRequest {
  schema_version: string;
  tenant_id: string;
  business_id: string;
  chatwoot_account_id: string;
  inbox_id: string;
  conversation_id: string;
  inbound_message_id: string;
  contact_ref: string;
  normalized_customer_message: string;
  bounded_conversation_history: ClawithHistoryTurn[];
  designated_agent_id: string;
  knowledge_scope_ids: string[];
  allowed_tools: ClawithToolDefinition[];
  ownership_state: OwnershipState;
  correlation_id: string;
  locale: string;
  timezone: string;
  response_deadline_ms: number;
}

// ── Response ─────────────────────────────────────────────────────────────────

export interface ClawithToolRequest {
  tool_name: string;
  /** Idempotency hint. Foundation treats a repeated hint as the SAME
   *  operation and must not execute it twice. */
  operation_id_hint: string;
  arguments: Record<string, unknown>;
  reason: string;
}

export interface ClawithEscalation {
  requested: boolean;
  reason_code: EscalationReasonCode | null;
  explanation: string | null;
  urgency: EscalationUrgency | null;
  required_team: string | null;
  customer_handoff_message: string | null;
}

export interface ClawithResponse {
  schema_version: string;
  agent_id: string;
  session_id: string;
  correlation_id: string;
  customer_reply: string | null;
  intent: string | null;
  confidence: number;
  qualification_state: QualificationState;
  knowledge_references: string[];
  tool_requests: ClawithToolRequest[];
  escalation: ClawithEscalation;
  missing_information: string[];
  follow_up_required: boolean;
  usage: { latency_ms?: number; tokens?: number } | null;
}
