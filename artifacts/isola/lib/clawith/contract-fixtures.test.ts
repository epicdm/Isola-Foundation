/**
 * Golden contract fixture proofs — `dec-clawith-structured-bridge-versioned-endpoint-2026-08-02`
 * slice S1 (contract fixtures, NO behaviour change).
 *
 * This file adds test-only coverage against the EXISTING, unmodified
 * `buildClawithRequest` / `parseClawithResponse`. It changes no runtime
 * behaviour and no Foundation configuration.
 *
 * The canonical fixture pair lives in `./__fixtures__/golden-structured-message.json`
 * and is mirrored (same field values) in `epicdm/isola-runtime` at
 * `backend/isola_tests/fixtures/golden_structured_message.json`, so both
 * repositories are checked against the one example.
 */
import { describe, expect, it } from 'vitest';
import { CLAWITH_SCHEMA_VERSION } from './contract';
import { ClawithFailure } from './errors';
import { buildClawithRequest } from './request';
import { parseClawithResponse, type ExpectedResponseIdentity } from './response';
import {
  GOLDEN_REQUEST,
  GOLDEN_REQUEST_INPUT,
  GOLDEN_RESPONSE,
  LEGACY_LIVE_RESPONSE,
} from './__fixtures__/golden-structured-message';

describe('golden fixture proof 1: the request builder emits the golden request', () => {
  it('buildClawithRequest(GOLDEN_REQUEST_INPUT) deep-equals GOLDEN_REQUEST', () => {
    const built = buildClawithRequest(GOLDEN_REQUEST_INPUT);
    expect(built).toEqual(GOLDEN_REQUEST);
  });

  it('the golden request carries every field the ratified contract requires', () => {
    for (const field of [
      'schema_version',
      'tenant_id',
      'business_id',
      'chatwoot_account_id',
      'inbox_id',
      'conversation_id',
      'inbound_message_id',
      'contact_ref',
      'normalized_customer_message',
      'bounded_conversation_history',
      'designated_agent_id',
      'knowledge_scope_ids',
      'allowed_tools',
      'ownership_state',
      'correlation_id',
      'locale',
      'timezone',
      'response_deadline_ms',
    ] as const) {
      expect(GOLDEN_REQUEST, `golden request missing ${field}`).toHaveProperty(field);
    }
    expect(GOLDEN_REQUEST.schema_version).toBe(CLAWITH_SCHEMA_VERSION);
  });
});

describe('golden fixture proof 2: parseClawithResponse accepts the golden response', () => {
  const expected: ExpectedResponseIdentity = {
    schemaVersion: CLAWITH_SCHEMA_VERSION,
    agentId: GOLDEN_REQUEST.designated_agent_id,
    correlationId: GOLDEN_REQUEST.correlation_id,
    tenantId: GOLDEN_REQUEST.tenant_id,
    allowedToolNames: new Set(GOLDEN_REQUEST.allowed_tools.map((t) => t.name)),
  };

  it('parses without throwing and round-trips every field', () => {
    const parsed = parseClawithResponse(GOLDEN_RESPONSE, expected);
    expect(parsed.schema_version).toBe(GOLDEN_RESPONSE.schema_version);
    expect(parsed.agent_id).toBe(GOLDEN_RESPONSE.agent_id);
    expect(parsed.session_id).toBe(GOLDEN_RESPONSE.session_id);
    expect(parsed.correlation_id).toBe(GOLDEN_REQUEST.correlation_id);
    expect(parsed.customer_reply).toBe(GOLDEN_RESPONSE.customer_reply);
    expect(parsed.confidence).toBeCloseTo(GOLDEN_RESPONSE.confidence);
    expect(parsed.qualification_state).toBe(GOLDEN_RESPONSE.qualification_state);
    expect(parsed.escalation.requested).toBe(false);
    expect(parsed.tool_requests).toEqual([]);
  });

  it('the golden response satisfies the required-envelope shape (schema_version, agent_id, session_id, correlation_id, confidence 0..1)', () => {
    expect(GOLDEN_RESPONSE.schema_version).toBe(CLAWITH_SCHEMA_VERSION);
    expect(GOLDEN_RESPONSE.agent_id).toBe(GOLDEN_REQUEST.designated_agent_id);
    expect(GOLDEN_RESPONSE.session_id).toBeTruthy();
    expect(GOLDEN_RESPONSE.confidence).toBeGreaterThanOrEqual(0);
    expect(GOLDEN_RESPONSE.confidence).toBeLessThanOrEqual(1);
  });
});

describe('golden fixture proof 3: parseClawithResponse REJECTS the current live legacy response shape', () => {
  const expected: ExpectedResponseIdentity = {
    schemaVersion: CLAWITH_SCHEMA_VERSION,
    agentId: GOLDEN_REQUEST.designated_agent_id,
    correlationId: GOLDEN_REQUEST.correlation_id,
    tenantId: GOLDEN_REQUEST.tenant_id,
    allowedToolNames: new Set(GOLDEN_REQUEST.allowed_tools.map((t) => t.name)),
  };

  it('throws ClawithFailure for the deployed /api/isola/bridge/message body ({reply, run_id, matched_session, status, ...})', () => {
    expect(() => parseClawithResponse(LEGACY_LIVE_RESPONSE, expected)).toThrow(ClawithFailure);
  });

  it('classifies the rejection as invalid_response (missing schema_version) — this is defect-clawith-bridge-message-schema-mismatch-2026-08-02, proven again as a regression guard', () => {
    try {
      parseClawithResponse(LEGACY_LIVE_RESPONSE, expected);
      expect.unreachable('legacy shape must not be accepted');
    } catch (err) {
      expect((err as ClawithFailure).kind).toBe('invalid_response');
    }
  });

  it('sanity: the legacy body really does lack the fields the structured contract requires', () => {
    expect(LEGACY_LIVE_RESPONSE).not.toHaveProperty('schema_version');
    expect(LEGACY_LIVE_RESPONSE).not.toHaveProperty('session_id');
    expect(LEGACY_LIVE_RESPONSE).not.toHaveProperty('confidence');
    expect(LEGACY_LIVE_RESPONSE).not.toHaveProperty('customer_reply');
    expect(LEGACY_LIVE_RESPONSE).toHaveProperty('reply');
  });
});
