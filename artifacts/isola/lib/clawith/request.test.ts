import { describe, expect, it } from 'vitest';
import {
  MAX_ALLOWED_TOOLS,
  MAX_HISTORY_TURNS,
  MAX_KNOWLEDGE_SCOPE_IDS,
  CLAWITH_SCHEMA_VERSION,
  type ClawithToolDefinition,
} from './contract';
import { ClawithFailure } from './errors';
import { boundHistory, buildClawithRequest, normalizeCustomerMessage } from './request';

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';

const TOOL: ClawithToolDefinition = {
  name: 'crm.lead.create',
  description: 'Create a lead',
  arguments: ['name', 'phone'],
  mutating: true,
};

function base(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    bindingTenantId: TENANT,
    conversationTenantId: TENANT,
    businessId: 'epic-communications-inc',
    chatwootAccountId: '5',
    inboxId: '46',
    conversationId: 'cmrxj42cg001qs62mdqtebjy8',
    inboundMessageId: '90210',
    contactRef: 'contact:abc123',
    customerMessage: 'Do you install fibre in Roseau?',
    history: [{ role: 'user' as const, content: 'hi' }],
    designatedAgentId: '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162',
    knowledgeScopeIds: ['kb-epic-services'],
    allowedTools: [TOOL],
    ownershipState: 'AI_OWNED' as const,
    correlationId: 'corr-1',
    ...overrides,
  };
}

describe('buildClawithRequest — proof 1: a valid structured request is produced', () => {
  it('produces every authoritative field the contract requires', () => {
    const req = buildClawithRequest(base());
    expect(req.schema_version).toBe(CLAWITH_SCHEMA_VERSION);
    for (const field of [
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
    ]) {
      expect(req, `missing ${field}`).toHaveProperty(field);
    }
    expect(req.response_deadline_ms).toBeGreaterThan(0);
  });

  it('carries no secret-bearing field', () => {
    const serialized = JSON.stringify(buildClawithRequest(base()));
    for (const forbidden of ['odoo_password', 'api_key', 'secret', 'token', 'password']) {
      expect(serialized.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('proof 2: tenant and inbox are included', () => {
  it('includes tenant, account and inbox', () => {
    const req = buildClawithRequest(base());
    expect(req.tenant_id).toBe(TENANT);
    expect(req.chatwoot_account_id).toBe('5');
    expect(req.inbox_id).toBe('46');
  });
});

describe('proof 3: conversation and message ids are included', () => {
  it('includes both ids verbatim', () => {
    const req = buildClawithRequest(base());
    expect(req.conversation_id).toBe('cmrxj42cg001qs62mdqtebjy8');
    expect(req.inbound_message_id).toBe('90210');
  });

  it('rejects a request with no inbound message id', () => {
    expect(() => buildClawithRequest(base({ inboundMessageId: '' }))).toThrow(ClawithFailure);
  });
});

describe('proof 4: bounded history is included', () => {
  it('keeps only the most recent MAX_HISTORY_TURNS turns', () => {
    const history = Array.from({ length: MAX_HISTORY_TURNS + 25 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `turn-${i}`,
    }));
    const req = buildClawithRequest(base({ history }));
    expect(req.bounded_conversation_history).toHaveLength(MAX_HISTORY_TURNS);
    expect(req.bounded_conversation_history.at(-1)?.content).toBe(`turn-${history.length - 1}`);
  });

  it('truncates an oversized single turn instead of forwarding it', () => {
    const bounded = boundHistory([{ role: 'user', content: 'x'.repeat(50_000) }]);
    expect(bounded[0].content.length).toBeLessThan(50_000);
  });

  it('drops malformed turns rather than forwarding them', () => {
    const bounded = boundHistory([
      { role: 'user', content: 'kept' },
      { role: 'system' as never, content: 'dropped' },
    ]);
    expect(bounded).toEqual([{ role: 'user', content: 'kept' }]);
  });
});

describe('proof 5: knowledge scope is bounded', () => {
  it('rejects an over-large knowledge scope', () => {
    const ids = Array.from({ length: MAX_KNOWLEDGE_SCOPE_IDS + 1 }, (_, i) => `kb-${i}`);
    expect(() => buildClawithRequest(base({ knowledgeScopeIds: ids }))).toThrow(/knowledge scope/);
  });

  it('de-duplicates ids', () => {
    const req = buildClawithRequest(base({ knowledgeScopeIds: ['kb-a', 'kb-a', 'kb-b'] }));
    expect(req.knowledge_scope_ids).toEqual(['kb-a', 'kb-b']);
  });
});

describe('proof 6: allowed tools are bounded', () => {
  it('rejects more than MAX_ALLOWED_TOOLS', () => {
    const tools = Array.from({ length: MAX_ALLOWED_TOOLS + 1 }, (_, i) => ({ ...TOOL, name: `t.${i}` }));
    expect(() => buildClawithRequest(base({ allowedTools: tools }))).toThrow(/allowed tools exceed/);
  });

  it('rejects duplicate tool names', () => {
    expect(() => buildClawithRequest(base({ allowedTools: [TOOL, { ...TOOL }] }))).toThrow(/duplicate tool/);
  });

  it('defaults to an EMPTY tool list — nothing is authorised implicitly', () => {
    const req = buildClawithRequest(base({ allowedTools: undefined }));
    expect(req.allowed_tools).toEqual([]);
  });
});

describe('proof 7: wrong-tenant data is rejected', () => {
  it('rejects a binding belonging to another tenant', () => {
    expect(() => buildClawithRequest(base({ bindingTenantId: 'some-other-tenant' }))).toThrow(
      /binding tenant does not match/,
    );
  });

  it('rejects a conversation belonging to another tenant', () => {
    expect(() => buildClawithRequest(base({ conversationTenantId: 'some-other-tenant' }))).toThrow(
      /conversation tenant does not match/,
    );
  });

  it('classifies both as request_invalid rather than letting them through', () => {
    try {
      buildClawithRequest(base({ conversationTenantId: 'nope' }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as ClawithFailure).kind).toBe('request_invalid');
    }
  });
});

describe('ownership gating on the request', () => {
  it('refuses to ask for a customer reply while a human owns the conversation', () => {
    for (const state of ['HUMAN_REQUESTED', 'HUMAN_OWNED', 'HANDING_BACK'] as const) {
      expect(() => buildClawithRequest(base({ ownershipState: state }))).toThrow(
        /does not permit an AI customer reply/,
      );
    }
  });

  it('permits AI_OWNED and AI_RESUMED', () => {
    for (const state of ['AI_OWNED', 'AI_RESUMED'] as const) {
      expect(buildClawithRequest(base({ ownershipState: state })).ownership_state).toBe(state);
    }
  });
});

describe('normalizeCustomerMessage', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeCustomerMessage('  hello   there \n world  ')).toBe('hello there\nworld');
  });

  it('clamps an unbounded message', () => {
    expect(normalizeCustomerMessage('a'.repeat(100_000)).length).toBeLessThanOrEqual(8_000);
  });
});
