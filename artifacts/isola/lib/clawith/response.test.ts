import { describe, expect, it } from 'vitest';
import { CLAWITH_SCHEMA_VERSION } from './contract';
import { ClawithFailure } from './errors';
import { parseClawithResponse, type ExpectedResponseIdentity } from './response';

const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';

const EXPECTED: ExpectedResponseIdentity = {
  schemaVersion: CLAWITH_SCHEMA_VERSION,
  agentId: AGENT,
  correlationId: 'corr-1',
  tenantId: TENANT,
  allowedToolNames: new Set(['crm.lead.create', 'crm.contact.lookup']),
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: CLAWITH_SCHEMA_VERSION,
    agent_id: AGENT,
    session_id: 'sess-9',
    correlation_id: 'corr-1',
    customer_reply: 'Yes — we install fibre in Roseau.',
    intent: 'service_availability',
    confidence: 0.86,
    qualification_state: 'qualifying',
    knowledge_references: ['kb-epic-services#fibre'],
    tool_requests: [],
    escalation: { requested: false },
    missing_information: [],
    follow_up_required: false,
    ...overrides,
  };
}

function kindOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ClawithFailure).kind;
  }
  return 'no-error';
}

describe('proof 8: a valid structured response is accepted', () => {
  it('accepts and normalises a well-formed envelope', () => {
    const parsed = parseClawithResponse(body(), EXPECTED);
    expect(parsed.agent_id).toBe(AGENT);
    expect(parsed.session_id).toBe('sess-9');
    expect(parsed.customer_reply).toBe('Yes — we install fibre in Roseau.');
    expect(parsed.confidence).toBeCloseTo(0.86);
    expect(parsed.qualification_state).toBe('qualifying');
    expect(parsed.escalation.requested).toBe(false);
    expect(parsed.tool_requests).toEqual([]);
  });

  it('accepts an authorised tool request', () => {
    const parsed = parseClawithResponse(
      body({
        customer_reply: null,
        tool_requests: [
          {
            tool_name: 'crm.contact.lookup',
            operation_id_hint: 'op-1',
            arguments: { phone: '+17672958382' },
            reason: 'identify caller',
          },
        ],
      }),
      EXPECTED,
    );
    expect(parsed.tool_requests).toHaveLength(1);
    expect(parsed.tool_requests[0].tool_name).toBe('crm.contact.lookup');
  });
});

describe('proof 9: an invalid response schema is rejected', () => {
  it.each([
    ['not an object', 'nope'],
    ['an array', []],
    ['missing schema_version', body({ schema_version: undefined })],
    ['a foreign schema_version', body({ schema_version: '99.0.0' })],
    ['missing session_id', body({ session_id: undefined })],
    ['missing confidence', body({ confidence: undefined })],
    ['a non-numeric confidence', body({ confidence: 'high' })],
    ['an out-of-range confidence', body({ confidence: 1.4 })],
    ['an unknown qualification_state', body({ qualification_state: 'vibing' })],
    ['a non-array tool_requests', body({ tool_requests: {} })],
    ['an unknown escalation reason_code', body({ escalation: { requested: true, reason_code: 'because' } })],
    ['escalation.requested with no reason_code', body({ escalation: { requested: true } })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseClawithResponse(raw, EXPECTED)).toThrow(ClawithFailure);
  });

  it('classifies a malformed body as invalid_response, not as a usable reply', () => {
    expect(kindOf(() => parseClawithResponse(body({ confidence: 'high' }), EXPECTED))).toBe('invalid_response');
  });
});

describe('proof 10: an unsupported tool request is rejected', () => {
  it('rejects a tool that was never authorised for this turn', () => {
    const raw = body({
      customer_reply: null,
      tool_requests: [{ tool_name: 'odoo.execute_kw', operation_id_hint: 'op-x', arguments: {}, reason: 'why not' }],
    });
    expect(kindOf(() => parseClawithResponse(raw, EXPECTED))).toBe('unsupported_tool');
  });

  it('rejects a duplicate operation_id_hint (double-execution request)', () => {
    const raw = body({
      customer_reply: null,
      tool_requests: [
        { tool_name: 'crm.lead.create', operation_id_hint: 'op-1', arguments: {}, reason: 'a' },
        { tool_name: 'crm.contact.lookup', operation_id_hint: 'op-1', arguments: {}, reason: 'b' },
      ],
    });
    expect(() => parseClawithResponse(raw, EXPECTED)).toThrow(/duplicate operation_id_hint/);
  });
});

describe('proof 11: correlation mismatch is rejected', () => {
  it('rejects a response echoing a different correlation id', () => {
    expect(kindOf(() => parseClawithResponse(body({ correlation_id: 'corr-OTHER' }), EXPECTED))).toBe(
      'correlation_mismatch',
    );
  });

  it('rejects a response with no correlation id at all', () => {
    expect(kindOf(() => parseClawithResponse(body({ correlation_id: undefined }), EXPECTED))).toBe(
      'correlation_mismatch',
    );
  });
});

describe('proof 12: agent mismatch is rejected', () => {
  it('rejects a response from a different agent', () => {
    expect(kindOf(() => parseClawithResponse(body({ agent_id: 'some-other-agent' }), EXPECTED))).toBe(
      'agent_mismatch',
    );
  });

  it('rejects a response referencing another tenant', () => {
    expect(kindOf(() => parseClawithResponse(body({ tenant_id: 'another-tenant' }), EXPECTED))).toBe(
      'tenant_mismatch',
    );
  });
});

describe('contradiction rejection', () => {
  it('rejects a turn that says nothing, escalates nothing and asks for nothing', () => {
    expect(
      kindOf(() =>
        parseClawithResponse(body({ customer_reply: null, tool_requests: [], escalation: { requested: false } }), EXPECTED),
      ),
    ).toBe('contradictory_response');
  });

  it('rejects escalation alongside tool requests', () => {
    const raw = body({
      customer_reply: null,
      escalation: { requested: true, reason_code: 'approval_required' },
      tool_requests: [{ tool_name: 'crm.lead.create', operation_id_hint: 'op-2', arguments: {}, reason: 'x' }],
    });
    expect(kindOf(() => parseClawithResponse(raw, EXPECTED))).toBe('contradictory_response');
  });

  it('rejects a customer success claim alongside an unexecuted mutating tool', () => {
    const raw = body({
      customer_reply: 'All set — I have created your lead.',
      tool_requests: [{ tool_name: 'crm.lead.create', operation_id_hint: 'op-3', arguments: {}, reason: 'x' }],
    });
    expect(kindOf(() => parseClawithResponse(raw, EXPECTED))).toBe('contradictory_response');
  });
});
