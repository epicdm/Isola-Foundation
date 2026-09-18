import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCcoAgentBindingMock, listCcoAgentsMock, getBusinessBriefingMock, getIsolaRuntimeConfigMock, bearerForAgentMock } =
  vi.hoisted(() => ({
    resolveCcoAgentBindingMock: vi.fn(),
    listCcoAgentsMock: vi.fn(),
    getBusinessBriefingMock: vi.fn(),
    getIsolaRuntimeConfigMock: vi.fn(),
    bearerForAgentMock: vi.fn(),
  }));

vi.mock('./cco-agent-binding', () => ({
  CCO_TEMPLATE_ID: 'isola-internal-summarizer',
  resolveCcoAgentBinding: resolveCcoAgentBindingMock,
  listCcoAgents: listCcoAgentsMock,
}));
vi.mock('./business-briefing', () => ({
  getBusinessBriefing: getBusinessBriefingMock,
}));
vi.mock('@/lib/engines', () => ({
  getIsolaRuntimeConfig: getIsolaRuntimeConfigMock,
  bearerForAgent: bearerForAgentMock,
}));

import { askCco, RUNTIME_TEMPLATE_ID } from './cco-invoke';

const TENANT = 'tenant-1';
const THREAD = 'thread-1';
const TURN = 'turn-1';
const MESSAGE = 'How are our receivables looking?';
const AGENT_ID = 'agent-real-42';
const COMPANY_ID = 'co-real';

const RUNTIME_CONFIG = { baseUrl: 'https://runtime.example.test', internalBearer: 'internal-bearer', agentBearerSecrets: {} };

const LINKED = { outcome: 'linked' as const, paperclipAgentId: AGENT_ID, paperclipCompanyId: COMPANY_ID };

const OK_BRIEFING = {
  tenantId: TENANT,
  generatedAt: '2026-09-18T00:00:00.000Z',
  odooConnected: true,
  sections: [
    { id: 'overdue_receivables' as const, title: 'Overdue receivables', state: 'ok' as const, rows: [
      { id: 1, label: 'INV/1', detail: '100 XCD', sourceUrl: 'https://epic.odoo.com/odoo/account.move/1' },
    ] },
    { id: 'open_opportunities' as const, title: 'Open opportunities', state: 'ok' as const, rows: [] },
  ],
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('askCco', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    resolveCcoAgentBindingMock.mockReset();
    listCcoAgentsMock.mockReset();
    getBusinessBriefingMock.mockReset();
    getIsolaRuntimeConfigMock.mockReset();
    bearerForAgentMock.mockReset();
    resolveCcoAgentBindingMock.mockResolvedValue(LINKED);
    getBusinessBriefingMock.mockResolvedValue(OK_BRIEFING);
    getIsolaRuntimeConfigMock.mockReturnValue(RUNTIME_CONFIG);
    bearerForAgentMock.mockReturnValue('internal-bearer');
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('the honest, explicitly-selected-agent path', () => {
    it('replies with the model text, sourced from the briefing\'s own links, on a genuinely completed run', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'Here is your briefing.' }));

      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      expect(result.state).toBe('replied');
      if (result.state !== 'replied') throw new Error('unreachable');
      expect(result.text).toBe('Here is your briefing.');
      expect(result.sources).toEqual(['https://epic.odoo.com/odoo/account.move/1']);
      expect(result.briefing).toBe(OK_BRIEFING);
      expect(result.correlationId).toBe('corr-1');
      expect(resolveCcoAgentBindingMock).toHaveBeenCalledWith(TENANT, AGENT_ID);
      expect(listCcoAgentsMock).not.toHaveBeenCalled();
    });

    it('sends the RUNTIME template id (not the portal catalogue id), INTERNAL exposure, inline mode, and the SELECTED agentId/companyId', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
      expect(new URL(String(calledUrl)).pathname).toBe('/v1/invoke');
      const sentBody = JSON.parse((calledInit as RequestInit).body as string);
      expect(sentBody.templateId).toBe(RUNTIME_TEMPLATE_ID);
      expect(sentBody.templateId).not.toBe('isola-internal-summarizer');
      expect(sentBody.exposure).toBe('INTERNAL');
      expect(sentBody.responseMode).toBe('inline');
      expect(sentBody.agentId).toBe(AGENT_ID);
      expect(sentBody.context.companyId).toBe(COMPANY_ID);
      expect(sentBody.runIdIssuedBy).toBeUndefined();
      expect(sentBody.callerProof).toBeUndefined();
    });

    it('AUTHENTICATED INVOCATION: presents the bearer bearerForAgent resolves for this exact agent -- never a body field', async () => {
      bearerForAgentMock.mockReturnValue('the-agent-bound-secret');
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      expect(bearerForAgentMock).toHaveBeenCalledWith(RUNTIME_CONFIG, AGENT_ID);
      const [, calledInit] = fetchMock.mock.calls[0]!;
      expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer the-agent-bound-secret' });
    });

    it('NEVER sets context.tenantId -- the AgentOS gate refuses any value that is not its own server-configured constant', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.tenantId).toBeUndefined();
    });

    it('sets a stable conversationRef so persistence can succeed (issueId:null would throw against a real recorder)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.conversationRef).toBe(`cco-briefing:${TENANT}:${THREAD}`);
    });

    it('carries the Odoo briefing AND the owner\'s own words only inside context, side by side -- data, never templateId/exposure/policy', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.businessBriefing).toEqual(OK_BRIEFING);
      expect(sentBody.context.ownerRequest).toBe(MESSAGE);
    });

    it('DUPLICATE REQUEST: the same tenantId+threadId+turnId always produces the same runId, regardless of message content', async () => {
      // A FRESH Response per call -- a Response body can only be read once,
      // and both calls below genuinely read it (askCco awaits res.json()).
      // mockResolvedValue would hand back the SAME already-consumed Response
      // on the second call and silently mask a real failure as "unavailable".
      fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      const result1 = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      const result2 = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: 'a completely different message', paperclipAgentId: AGENT_ID });

      expect(result1.state).toBe('replied');
      expect(result2.state).toBe('replied');
      const runId1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).runId;
      const runId2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).runId;
      expect(runId1).toBe(runId2);
    });

    it('a DIFFERENT turnId in the SAME thread produces a different runId but the same conversationRef', async () => {
      fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      const result1 = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'turn-1', message: MESSAGE, paperclipAgentId: AGENT_ID });
      const result2 = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'turn-2', message: 'a follow-up', paperclipAgentId: AGENT_ID });

      expect(result1.state).toBe('replied');
      expect(result2.state).toBe('replied');
      const b1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      const b2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string);
      expect(b1.runId).not.toBe(b2.runId);
      expect(b1.context.conversationRef).toBe(b2.context.conversationRef);
    });

    it('DUPLICATE REQUEST: a replayed run (outcome ok) still reports replied with the stored answer', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'the original stored answer', replay: true }),
      );
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('replied');
      if (result.state === 'replied') expect(result.text).toBe('the original stored answer');
    });
  });

  describe('RESOLVE THE SELECTED AGENT PRECISELY -- wrong/missing agent claims never proceed', () => {
    it.each(['tenant_not_mapped', 'not_found', 'not_ready'] as const)(
      'blocked with reason %s, and the runtime is never called',
      async (outcome) => {
        resolveCcoAgentBindingMock.mockResolvedValue({ outcome });
        const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
        expect(result.state).toBe('blocked');
        if (result.state === 'blocked') expect(result.reason).toBe(outcome);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getBusinessBriefingMock).not.toHaveBeenCalled();
      },
    );

    it('CROSS-AGENT CLAIM: a real agent id belonging to a different tenant resolves not_found, exactly like a bogus id -- never blocked differently', async () => {
      resolveCcoAgentBindingMock.mockResolvedValue({ outcome: 'not_found' });
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: 'someone-elses-agent' });
      expect(result).toEqual(expect.objectContaining({ state: 'blocked', reason: 'not_found' }));
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unavailable (not blocked) when the binding lookup itself is unreachable -- never conflated with "not this tenant\'s agent"', async () => {
      resolveCcoAgentBindingMock.mockResolvedValue({ outcome: 'unreachable', detail: 'http_500' });
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('TWO SAME-TEMPLATE AGENTS -- supported, not ambiguous, once a selection is made', () => {
    it('either agent works fine when explicitly selected, resolved by identity, never by template', async () => {
      resolveCcoAgentBindingMock.mockImplementation(async (_tenantId: string, agentId: string) =>
        agentId === 'agent-a'
          ? { outcome: 'linked', paperclipAgentId: 'agent-a', paperclipCompanyId: 'co-a' }
          : { outcome: 'linked', paperclipAgentId: 'agent-b', paperclipCompanyId: 'co-b' },
      );
      fetchMock.mockImplementation(async () => jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));

      const resultA = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'ta', message: MESSAGE, paperclipAgentId: 'agent-a' });
      const resultB = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'tb', message: MESSAGE, paperclipAgentId: 'agent-b' });

      expect(resultA.state).toBe('replied');
      expect(resultB.state).toBe('replied');
      expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).agentId).toBe('agent-a');
      expect(JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).agentId).toBe('agent-b');
      expect(listCcoAgentsMock).not.toHaveBeenCalled();
    });

    it('exactly one available agent, with no explicit selection, is auto-selected -- the only option is not an ambiguity', async () => {
      listCcoAgentsMock.mockResolvedValue({
        outcome: 'listed',
        agents: [{ paperclipAgentId: 'agent-only', paperclipCompanyId: 'co-only', displayName: 'Only Agent' }],
      });
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));

      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      expect(result.state).toBe('replied');
      expect(resolveCcoAgentBindingMock).not.toHaveBeenCalled();
      expect(JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).agentId).toBe('agent-only');
    });

    it('GENUINELY UNDERSPECIFIED: two available agents with no explicit selection is ambiguous, carries the real choices, and never guesses one', async () => {
      listCcoAgentsMock.mockResolvedValue({
        outcome: 'listed',
        agents: [
          { paperclipAgentId: 'agent-a', paperclipCompanyId: 'co-a', displayName: 'Agent A' },
          { paperclipAgentId: 'agent-b', paperclipCompanyId: 'co-b', displayName: 'Agent B' },
        ],
      });

      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      expect(result.state).toBe('blocked');
      if (result.state === 'blocked') {
        expect(result.reason).toBe('ambiguous_agent_selection_required');
        expect(result.availableAgents).toHaveLength(2);
        expect(result.availableAgents.map((a) => a.paperclipAgentId)).toEqual(['agent-a', 'agent-b']);
      }
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('zero available agents with no explicit selection is not_provisioned, not ambiguous', async () => {
      listCcoAgentsMock.mockResolvedValue({ outcome: 'listed', agents: [] });
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result).toEqual(expect.objectContaining({ state: 'blocked', reason: 'not_provisioned' }));
    });
  });

  describe('MISSING/WRONG CALLER PROOF -- the runtime\'s own agent-specific gate refuses', () => {
    it('unavailable, never presented as though the owner\'s own request was rejected', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, { ok: false, outcome: 'agent_caller_proof_required', error: 'agent caller proof: no_agent_bound_credential' }),
      );
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.reason).toBe('agent_caller_proof_required');
    });
  });

  describe('provisioning / configuration recovery', () => {
    it('unavailable when the runtime is not configured on Foundation\'s side, and the briefing is still returned', async () => {
      getIsolaRuntimeConfigMock.mockReturnValue(null);
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('unavailable');
      expect(result.briefing).toBe(OK_BRIEFING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unavailable, not a crash, when the runtime is unreachable over the network', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.reason).toBe('runtime_unreachable');
    });

    it('timeout, distinct from unavailable, on a model timeout outcome', async () => {
      fetchMock.mockResolvedValue(jsonResponse(504, { ok: false, outcome: 'model_timeout', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('timeout');
    });

    it('degraded (never "unavailable", never a fabricated success) on a persisted-but-not-completed outcome', async () => {
      fetchMock.mockResolvedValue(jsonResponse(502, { ok: false, outcome: 'persistence_failed', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('degraded');
      expect(result.text).toBeNull();
    });

    it('unavailable on budget_exhausted -- never presented as a problem with the owner\'s specific question', async () => {
      fetchMock.mockResolvedValue(jsonResponse(402, { ok: false, outcome: 'budget_exhausted', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE, paperclipAgentId: AGENT_ID });
      expect(result.state).toBe('unavailable');
    });
  });
});
