/**
 * Builds and validates the Foundation → Clawith structured request.
 *
 * Every authoritative field required by
 * `dec-foundation-clawith-structured-response-contract-2026-07-29` is
 * assembled here, and every bound is applied here, so there is exactly one
 * place to audit what leaves Foundation.
 *
 * What must NEVER cross this boundary, and is therefore not representable in
 * `ClawithRequest` at all: raw secrets, Odoo credentials, cross-tenant
 * records, arbitrary tool names, unlimited history.
 */

import {
  AI_REPLY_OWNERSHIP_STATES,
  CLAWITH_SCHEMA_VERSION,
  DEFAULT_RESPONSE_DEADLINE_MS,
  MAX_ALLOWED_TOOLS,
  MAX_CUSTOMER_MESSAGE_CHARS,
  MAX_HISTORY_TURNS,
  MAX_HISTORY_TURN_CHARS,
  MAX_KNOWLEDGE_SCOPE_IDS,
  MAX_RESPONSE_DEADLINE_MS,
  OWNERSHIP_STATES,
  type ClawithHistoryTurn,
  type ClawithRequest,
  type ClawithToolDefinition,
  type OwnershipState,
} from './contract';
import { ClawithFailure } from './errors';

export interface BuildClawithRequestInput {
  /** The tenant Foundation resolved for THIS webhook delivery. Authoritative. */
  tenantId: string;
  /** Tenant recorded on the ChatwootBinding that received the message. */
  bindingTenantId: string;
  /** Tenant recorded on the local Conversation row. */
  conversationTenantId: string;
  businessId: string;
  chatwootAccountId: string;
  inboxId: string;
  conversationId: string;
  inboundMessageId: string;
  contactRef: string;
  customerMessage: string;
  history: ClawithHistoryTurn[];
  designatedAgentId: string;
  knowledgeScopeIds?: string[];
  allowedTools?: ClawithToolDefinition[];
  ownershipState: OwnershipState;
  correlationId: string;
  locale?: string;
  timezone?: string;
  responseDeadlineMs?: number;
}

function reject(detail: string): never {
  throw new ClawithFailure('request_invalid', detail);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') reject(`${field} is required`);
  return (value as string).trim();
}

/** Collapse whitespace and clamp length. Chatwoot hands us the customer's raw
 *  text; the agent should reason about the message, not about its formatting
 *  accidents, and an unbounded message is an unbounded prompt. */
export function normalizeCustomerMessage(raw: string): string {
  const collapsed = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    // Strip the spaces either side of a newline too, so a line break carries no
    // incidental whitespace into the prompt.
    .replace(/ ?\n ?/g, '\n')
    .trim();
  return collapsed.length > MAX_CUSTOMER_MESSAGE_CHARS
    ? collapsed.slice(0, MAX_CUSTOMER_MESSAGE_CHARS)
    : collapsed;
}

/** Keep the MOST RECENT turns — the tail is what the agent needs; the head is
 *  what an unbounded history wastes. */
export function boundHistory(history: ClawithHistoryTurn[]): ClawithHistoryTurn[] {
  return history
    .filter((t) => t && (t.role === 'user' || t.role === 'assistant') && typeof t.content === 'string')
    .slice(-MAX_HISTORY_TURNS)
    .map((t) => ({
      role: t.role,
      content:
        t.content.length > MAX_HISTORY_TURN_CHARS ? t.content.slice(0, MAX_HISTORY_TURN_CHARS) : t.content,
    }));
}

/**
 * Assemble the request, or throw `ClawithFailure('request_invalid')`.
 *
 * The cross-tenant check is the reason this function exists rather than an
 * object literal at the call site. `tenantId`, the binding's tenant and the
 * conversation's tenant are three independently-sourced values that must
 * agree; when they don't, the safe action is to send nothing at all, not to
 * pick one and hope. Same failure class as the 2026-07-01 account-5 incident.
 */
export function buildClawithRequest(input: BuildClawithRequestInput): ClawithRequest {
  const tenantId = requireNonEmpty(input.tenantId, 'tenant_id');

  if (requireNonEmpty(input.bindingTenantId, 'binding tenant') !== tenantId) {
    reject('binding tenant does not match request tenant');
  }
  if (requireNonEmpty(input.conversationTenantId, 'conversation tenant') !== tenantId) {
    reject('conversation tenant does not match request tenant');
  }

  const message = normalizeCustomerMessage(requireNonEmpty(input.customerMessage, 'customer message'));
  if (!message) reject('customer message is empty after normalization');

  if (!OWNERSHIP_STATES.includes(input.ownershipState)) {
    reject(`unknown ownership state ${String(input.ownershipState)}`);
  }
  if (!AI_REPLY_OWNERSHIP_STATES.has(input.ownershipState)) {
    reject(`ownership state ${input.ownershipState} does not permit an AI customer reply`);
  }

  const knowledgeScopeIds = [...new Set(input.knowledgeScopeIds ?? [])].filter(
    (id) => typeof id === 'string' && id.trim() !== '',
  );
  if (knowledgeScopeIds.length > MAX_KNOWLEDGE_SCOPE_IDS) {
    reject(`knowledge scope exceeds ${MAX_KNOWLEDGE_SCOPE_IDS} ids`);
  }

  const allowedTools = input.allowedTools ?? [];
  if (allowedTools.length > MAX_ALLOWED_TOOLS) {
    reject(`allowed tools exceed ${MAX_ALLOWED_TOOLS}`);
  }
  const toolNames = new Set<string>();
  for (const tool of allowedTools) {
    const name = requireNonEmpty(tool?.name, 'tool name');
    if (toolNames.has(name)) reject(`duplicate tool ${name}`);
    toolNames.add(name);
  }

  const deadline = input.responseDeadlineMs ?? DEFAULT_RESPONSE_DEADLINE_MS;
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > MAX_RESPONSE_DEADLINE_MS) {
    reject(`response deadline ${deadline}ms is out of range`);
  }

  return {
    schema_version: CLAWITH_SCHEMA_VERSION,
    tenant_id: tenantId,
    business_id: requireNonEmpty(input.businessId, 'business_id'),
    chatwoot_account_id: requireNonEmpty(input.chatwootAccountId, 'chatwoot_account_id'),
    inbox_id: requireNonEmpty(input.inboxId, 'inbox_id'),
    conversation_id: requireNonEmpty(input.conversationId, 'conversation_id'),
    inbound_message_id: requireNonEmpty(input.inboundMessageId, 'inbound_message_id'),
    contact_ref: requireNonEmpty(input.contactRef, 'contact_ref'),
    normalized_customer_message: message,
    bounded_conversation_history: boundHistory(input.history ?? []),
    designated_agent_id: requireNonEmpty(input.designatedAgentId, 'designated_agent_id'),
    knowledge_scope_ids: knowledgeScopeIds,
    allowed_tools: allowedTools,
    ownership_state: input.ownershipState,
    correlation_id: requireNonEmpty(input.correlationId, 'correlation_id'),
    locale: input.locale?.trim() || 'en-DM',
    timezone: input.timezone?.trim() || 'America/Dominica',
    response_deadline_ms: deadline,
  };
}
