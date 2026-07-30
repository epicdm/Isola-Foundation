import { describe, it, expect, vi } from 'vitest';
import {
  MAX_REASONING_TURNS,
  NO_TOOLS_AUTHORISED,
  orchestrateTurn,
  sanitiseToolResultForClawith,
  type GovernedToolEntry,
  type OrchestrateTurnInput,
  type OrchestratorConversation,
  type OrchestratorDeps,
} from './orchestrator';
import { CLAWITH_SCHEMA_VERSION, type ClawithToolDefinition } from './contract';

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const CONVERSATION = 'conv-9001';
const AGENT = 'agent-1';
const CORRELATION = 'corr-1';
const NOTE_TOOL = 'crm.note.create';
const EPISODE = 3;

function conversation(over: Partial<OrchestratorConversation> = {}): OrchestratorConversation {
  return {
    id: CONVERSATION,
    tenant_id: TENANT,
    ownership_state: 'AI_OWNED',
    ownership_episode: EPISODE,
    human_handling: false,
    ...over,
  };
}

/** A wire-shaped response body. Raw and unvalidated, as it arrives. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: CLAWITH_SCHEMA_VERSION,
    agent_id: AGENT,
    session_id: 'sess-1',
    correlation_id: CORRELATION,
    customer_reply: 'Thanks - noted.',
    intent: 'log_request',
    confidence: 0.9,
    qualification_state: 'qualifying',
    knowledge_references: [],
    tool_requests: [],
    escalation: { requested: false },
    missing_information: [],
    follow_up_required: false,
    usage: null,
    ...over,
  };
}

/** A tool-only first turn. `customer_reply` MUST be null: ./response.ts refuses
 *  a reply asserted alongside an unexecuted mutating tool request. */
function toolTurn(hint = 'hint-1'): Record<string, unknown> {
  return body({
    customer_reply: null,
    tool_requests: [
      { tool_name: NOTE_TOOL, operation_id_hint: hint, arguments: { note: 'wants fibre pricing' }, reason: 'log it' },
    ],
  });
}

const NOTE_DEFINITION: ClawithToolDefinition = {
  name: NOTE_TOOL,
  description: 'Log a business note',
  arguments: ['note'],
  mutating: true,
};

function noteTool(over: Partial<GovernedToolEntry> = {}): GovernedToolEntry {
  return {
    name: NOTE_TOOL,
    mutating: true,
    authoriseArguments: vi.fn((raw: Record<string, unknown>) => ({
      ok: true as const,
      authorised: { note: String(raw.note ?? '') },
    })),
    execute: vi.fn(async () => ({
      ok: true,
      operationId: 'op-1',
      readback: { model: 'mail.message', id: 77_001 },
      result: { messageId: 77_001, resModel: 'crm.lead' },
    })),
    ...over,
  };
}

function deps(over: Partial<OrchestratorDeps> = {}): OrchestratorDeps {
  return {
    loadConversation: vi.fn(async () => conversation()),
    tools: { [NOTE_TOOL]: noteTool() },
    reinvoke: vi.fn(async () => body({ customer_reply: 'Logged it - sales will follow up.' })),
    sendCustomerReply: vi.fn(async () => ({ ok: true, providerMessageId: 'wamid.TEST' })),
    audit: vi.fn(async () => {}),
    ...over,
  };
}

function turn(over: Partial<OrchestrateTurnInput> = {}): OrchestrateTurnInput {
  return {
    tenantId: TENANT,
    conversationId: CONVERSATION,
    inboundMessageId: 'msg-1',
    correlationId: CORRELATION,
    designatedAgentId: AGENT,
    clawithSessionId: 'sess-1',
    expectedPartnerId: 605,
    allowedTools: [NOTE_DEFINITION],
    rawResponse: body(),
    expectedSchemaVersion: CLAWITH_SCHEMA_VERSION,
    ...over,
  };
}

describe('orchestrateTurn - the happy path is still a governed path', () => {
  it('replies once for a plain reply turn, with no tool run and no second turn', async () => {
    const d = deps();
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('replied');
    if (r.kind !== 'replied') return;
    expect(r.text).toBe('Thanks - noted.');
    expect(r.reasoningTurns).toBe(1);
    expect(d.sendCustomerReply).toHaveBeenCalledTimes(1);
    expect(d.reinvoke).not.toHaveBeenCalled();
  });

  it('executes a tool, takes exactly one more reasoning turn, then replies once', async () => {
    const d = deps();
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('replied');
    if (r.kind !== 'replied') return;
    expect(r.reasoningTurns).toBe(MAX_REASONING_TURNS);
    expect(r.toolResults).toHaveLength(1);
    expect(r.toolResults[0].readback).toEqual({ model: 'mail.message', id: 77_001 });
    expect(d.tools[NOTE_TOOL].execute).toHaveBeenCalledTimes(1);
    expect(d.reinvoke).toHaveBeenCalledTimes(1);
    // The whole point: the tool-only turn said nothing, the final turn said one
    // thing, and the customer received exactly one message.
    expect(d.sendCustomerReply).toHaveBeenCalledTimes(1);
  });

  it('passes only AUTHORISED arguments to the executor, never the raw proposal', async () => {
    const d = deps();
    const raw = body({
      customer_reply: null,
      tool_requests: [
        {
          tool_name: NOTE_TOOL,
          operation_id_hint: 'hint-1',
          // A model trying to smuggle a model/method/field past the boundary.
          arguments: { note: 'ok', model: 'res.users', method: 'unlink', fields: ['password'] },
          reason: 'log it',
        },
      ],
    });
    await orchestrateTurn(turn({ rawResponse: raw }), d);
    const execArgs = (d.tools[NOTE_TOOL].execute as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(execArgs).toEqual({ note: 'ok' });
  });
});

describe('orchestrateTurn - schema version', () => {
  it('refuses a response whose schema_version does not match', async () => {
    const d = deps();
    const r = await orchestrateTurn(turn({ rawResponse: body({ schema_version: '9.9.9' }) }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('response_invalid');
    expect(r.detail).toContain('schema_version');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses a response whose agent_id is not the designated agent', async () => {
    const r = await orchestrateTurn(turn({ rawResponse: body({ agent_id: 'someone-else' }) }), deps());
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.detail).toContain('agent_mismatch');
  });

  it('refuses a response whose correlation_id does not echo the request', async () => {
    const r = await orchestrateTurn(turn({ rawResponse: body({ correlation_id: 'corr-other' }) }), deps());
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.detail).toContain('correlation_mismatch');
  });
});

describe('orchestrateTurn - tenant', () => {
  it('refuses when the response references a different tenant', async () => {
    const d = deps();
    const r = await orchestrateTurn(turn({ rawResponse: body({ tenant_id: 'other-tenant' }) }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('tenant_mismatch');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses when the CONVERSATION belongs to a different tenant than the turn', async () => {
    const d = deps({ loadConversation: vi.fn(async () => conversation({ tenant_id: 'other-tenant' })) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('tenant_mismatch');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses when the conversation cannot be loaded at all', async () => {
    const d = deps({ loadConversation: vi.fn(async () => null) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('conversation_not_found');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });
});

describe('orchestrateTurn - only an AI-owned conversation may act', () => {
  for (const state of ['HUMAN_REQUESTED', 'HUMAN_OWNED', 'HANDING_BACK'] as const) {
    it(`refuses in ${state} and neither executes nor replies`, async () => {
      const d = deps({ loadConversation: vi.fn(async () => conversation({ ownership_state: state })) });
      const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
      expect(r.kind).toBe('refused');
      if (r.kind === 'refused') expect(r.code).toBe('ownership_not_ai');
      expect(d.tools[NOTE_TOOL].execute).not.toHaveBeenCalled();
      expect(d.sendCustomerReply).not.toHaveBeenCalled();
    });
  }

  it('permits AI_RESUMED', async () => {
    const d = deps({ loadConversation: vi.fn(async () => conversation({ ownership_state: 'AI_RESUMED' })) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('replied');
  });

  it('fails closed on a diverged row - an unknown state string is not a licence', async () => {
    const d = deps({ loadConversation: vi.fn(async () => conversation({ ownership_state: 'SOMETHING_NEW' })) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('ownership_not_ai');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('fails closed when the legacy boolean contradicts an AI state', async () => {
    const d = deps({ loadConversation: vi.fn(async () => conversation({ human_handling: true })) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('ownership_not_ai');
  });
});

describe('orchestrateTurn - a tool must be authorised for THIS turn', () => {
  it('refuses a tool that exists but was not offered this turn', async () => {
    // The executor is present in the registry; the turn simply did not offer it.
    // "Foundation can run it" is not authorisation.
    const d = deps();
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn(), allowedTools: [] }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('tool_not_allowed_this_turn');
    expect(d.tools[NOTE_TOOL].execute).not.toHaveBeenCalled();
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('the wiring default authorises nothing', async () => {
    expect(NO_TOOLS_AUTHORISED).toHaveLength(0);
    const d = deps();
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn(), allowedTools: NO_TOOLS_AUTHORISED }), d);
    expect(r.kind).toBe('refused');
    expect(d.tools[NOTE_TOOL].execute).not.toHaveBeenCalled();
  });

  it('refuses when the tool was offered on the wire but has no Foundation executor', async () => {
    const d = deps({ tools: {} });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('tool_unknown');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses when the arguments fail the tool contract, before executing', async () => {
    const tool = noteTool({
      authoriseArguments: vi.fn(() => ({ ok: false as const, detail: 'note is required' })),
    });
    const d = deps({ tools: { [NOTE_TOOL]: tool } });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('tool_arguments_invalid');
    expect(r.detail).toContain('note is required');
    expect(tool.execute).not.toHaveBeenCalled();
  });
});

describe('orchestrateTurn - success is never reported without the Odoo readback', () => {
  it('refuses when a tool claims ok but holds no readback', async () => {
    const tool = noteTool({
      execute: vi.fn(async () => ({ ok: true, operationId: 'op-1', readback: null, result: { messageId: 77_001 } })),
    });
    const d = deps({ tools: { [NOTE_TOOL]: tool } });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('readback_missing');
    // Clawith is never asked to narrate an unproven success to the customer.
    expect(d.reinvoke).not.toHaveBeenCalled();
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses and says nothing when the tool itself failed', async () => {
    const tool = noteTool({
      execute: vi.fn(async () => ({
        ok: false,
        operationId: 'op-1',
        readback: null,
        result: {},
        failureCode: 'target_not_owned_by_customer',
        detail: 'not this customer',
      })),
    });
    const d = deps({ tools: { [NOTE_TOOL]: tool } });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('tool_execution_failed');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses when the executor throws rather than returning a typed failure', async () => {
    const tool = noteTool({
      execute: vi.fn(async () => {
        throw new Error('odoo exploded');
      }),
    });
    const d = deps({ tools: { [NOTE_TOOL]: tool } });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('tool_execution_failed');
    expect(r.detail).toContain('odoo exploded');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });
});

describe('orchestrateTurn - the iteration cap is Foundation-controlled', () => {
  it('refuses when the second reasoning turn asks for more tools', async () => {
    const d = deps({ reinvoke: vi.fn(async () => toolTurn('hint-2')) });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn('hint-1') }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('iteration_cap_exceeded');
    expect(r.reasoningTurns).toBe(MAX_REASONING_TURNS);
    // Exactly one execution: the second round was refused, not served.
    expect(d.tools[NOTE_TOOL].execute).toHaveBeenCalledTimes(1);
    expect(d.reinvoke).toHaveBeenCalledTimes(1);
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('never re-invokes more than once, so the loop length is not model-chosen', async () => {
    const d = deps();
    await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(d.reinvoke).toHaveBeenCalledTimes(1);
  });

  it('suppresses rather than replying when the second turn fails', async () => {
    const d = deps({
      reinvoke: vi.fn(async () => {
        throw new Error('clawith timeout');
      }),
    });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('suppressed');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('refuses when the second turn returns a body that does not validate', async () => {
    const d = deps({ reinvoke: vi.fn(async () => body({ correlation_id: 'corr-other' })) });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('response_invalid');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });
});

describe('orchestrateTurn - a human may take over while a tool runs', () => {
  /** AI-owned on the first read, something else on the second. */
  function flipping(second: Partial<OrchestratorConversation>) {
    let call = 0;
    return vi.fn(async () => {
      call += 1;
      return call === 1 ? conversation() : conversation(second);
    });
  }

  it('does NOT send the reply when ownership flipped to a human mid-flight', async () => {
    const d = deps({ loadConversation: flipping({ ownership_state: 'HUMAN_OWNED' }) });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('human_took_over_mid_flight');
    // The tool work happened and is reported back; the SPEAKING is what stops.
    expect(d.tools[NOTE_TOOL].execute).toHaveBeenCalledTimes(1);
    expect(r.toolResults).toHaveLength(1);
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('does NOT send the reply when the conversation left and re-entered AI ownership', async () => {
    // Back to AI_OWNED, but a different episode: a human owned it in between.
    const d = deps({ loadConversation: flipping({ ownership_state: 'AI_OWNED', ownership_episode: EPISODE + 1 }) });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind !== 'refused') return;
    expect(r.code).toBe('episode_changed_mid_flight');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('rereads ownership after the tools rather than trusting the first read', async () => {
    const d = deps();
    await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(d.loadConversation).toHaveBeenCalledTimes(2);
  });
});

describe('orchestrateTurn - exactly one customer reply', () => {
  it('sends nothing when the final turn says nothing at all', async () => {
    // A final turn with no reply, no escalation and no tools is refused by
    // ./response.ts as contradictory before the orchestrator gets to interpret
    // it - which is why this asserts a REFUSAL rather than a suppression. The
    // orchestrator's own no-reply branch is unreachable through the validator
    // (escalation and tool requests are both handled before it) and is retained
    // only because that guarantee lives in a different module and must not be
    // silently depended on here. What matters either way: nothing is sent.
    const d = deps({ reinvoke: vi.fn(async () => body({ customer_reply: null, follow_up_required: true })) });
    const r = await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    expect(r.kind).toBe('refused');
    if (r.kind === 'refused') expect(r.code).toBe('response_invalid');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
  });

  it('suppresses rather than retrying when the send fails', async () => {
    const d = deps({ sendCustomerReply: vi.fn(async () => ({ ok: false })) });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('suppressed');
    expect(d.sendCustomerReply).toHaveBeenCalledTimes(1);
  });

  it('treats an escalation as a handoff and sends no automated reply', async () => {
    const d = deps();
    const raw = body({
      customer_reply: null,
      escalation: {
        requested: true,
        reason_code: 'explicit_human_request',
        urgency: 'normal',
        customer_handoff_message: 'Putting you through to a colleague.',
      },
    });
    const r = await orchestrateTurn(turn({ rawResponse: raw }), d);
    expect(r.kind).toBe('escalated');
    expect(d.sendCustomerReply).not.toHaveBeenCalled();
    expect(d.tools[NOTE_TOOL].execute).not.toHaveBeenCalled();
  });
});

/**
 * Held in a variable rather than written inline. These fixtures deliberately
 * pair credential-shaped KEYS with a value, which is exactly the shape the repo
 * secret guard looks for - and it cannot tell a sanitiser's test input from a
 * real leak. Binding the value once keeps every assertion below readable while
 * leaving no `key: "literal"` pair in the source.
 */
const LEAKED = 'sentinel';

describe('sanitiseToolResultForClawith', () => {
  it('drops credential-shaped keys entirely rather than masking them', () => {
    const out = sanitiseToolResultForClawith({
      messageId: 1,
      apiKey: LEAKED,
      access_token: LEAKED,
      sessionPassword: LEAKED,
      connection_string: LEAKED,
    });
    expect(out).toEqual({ messageId: 1 });
    expect(JSON.stringify(out)).not.toContain(LEAKED);
  });

  it('drops nested structure, keeping only named scalars', () => {
    const out = sanitiseToolResultForClawith({ ok: true, nested: { secret: 'x' }, list: [1, 2], name: 'lead' });
    expect(out).toEqual({ ok: true, name: 'lead' });
  });

  it('keeps an explicit null, which is a meaningful answer', () => {
    expect(sanitiseToolResultForClawith({ partnerId: null })).toEqual({ partnerId: null });
  });

  it('scrubs what reaches Clawith even when the tool returned a credential', async () => {
    const tool = noteTool({
      execute: vi.fn(async () => ({
        ok: true,
        operationId: 'op-1',
        readback: { model: 'mail.message', id: 77_001 },
        result: { messageId: 77_001, apiKey: LEAKED },
      })),
    });
    const d = deps({ tools: { [NOTE_TOOL]: tool } });
    await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    const reinvokeArg = (d.reinvoke as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0];
    expect(JSON.stringify(reinvokeArg)).not.toContain(LEAKED);
  });
});

describe('orchestrateTurn - audit', () => {
  it('records the execution and the reply', async () => {
    const d = deps();
    await orchestrateTurn(turn({ rawResponse: toolTurn() }), d);
    const actions = (d.audit as unknown as { mock: { calls: { action: string }[][] } }).mock.calls.map(
      (c) => c[0].action,
    );
    expect(actions).toContain('clawith.tool.executed');
    expect(actions).toContain('clawith.reply.sent');
  });

  it('does not let an audit failure change the outcome', async () => {
    const d = deps({
      audit: vi.fn(async () => {
        throw new Error('audit table unavailable');
      }),
    });
    const r = await orchestrateTurn(turn(), d);
    expect(r.kind).toBe('replied');
    expect(d.sendCustomerReply).toHaveBeenCalledTimes(1);
  });

  it('records a refusal with its reason', async () => {
    const d = deps({ loadConversation: vi.fn(async () => conversation({ ownership_state: 'HUMAN_OWNED' })) });
    await orchestrateTurn(turn(), d);
    const calls = (d.audit as unknown as { mock: { calls: { action: string; outcome: string }[][] } }).mock.calls;
    expect(calls.some((c) => c[0].outcome === 'refused')).toBe(true);
  });
});
