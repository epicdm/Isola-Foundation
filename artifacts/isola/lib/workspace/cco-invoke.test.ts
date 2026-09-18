import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCcoAgentBindingMock, getBusinessBriefingMock, getIsolaRuntimeConfigMock } = vi.hoisted(() => ({
  resolveCcoAgentBindingMock: vi.fn(),
  getBusinessBriefingMock: vi.fn(),
  getIsolaRuntimeConfigMock: vi.fn(),
}));

vi.mock('./cco-agent-binding', () => ({
  CCO_TEMPLATE_ID: 'isola-internal-summarizer',
  resolveCcoAgentBinding: resolveCcoAgentBindingMock,
}));
vi.mock('./business-briefing', () => ({
  getBusinessBriefing: getBusinessBriefingMock,
}));
vi.mock('@/lib/engines', () => ({
  getIsolaRuntimeConfig: getIsolaRuntimeConfigMock,
}));

import { askCco, RUNTIME_TEMPLATE_ID } from './cco-invoke';

const TENANT = 'tenant-1';
const THREAD = 'thread-1';
const TURN = 'turn-1';
const MESSAGE = 'How are our receivables looking?';
const RUNTIME_CONFIG = { baseUrl: 'https://runtime.example.test', internalBearer: 'internal-bearer', internalCallerProof: null };

const LINKED = { outcome: 'linked' as const, paperclipAgentId: 'agent-real-42', paperclipCompanyId: 'co-real' };

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
    getBusinessBriefingMock.mockReset();
    getIsolaRuntimeConfigMock.mockReset();
    resolveCcoAgentBindingMock.mockResolvedValue(LINKED);
    getBusinessBriefingMock.mockResolvedValue(OK_BRIEFING);
    getIsolaRuntimeConfigMock.mockReturnValue(RUNTIME_CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  describe('the honest path', () => {
    it('replies with the model text, sourced from the briefing\'s own links, on a genuinely completed run', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'Here is your briefing.' }));

      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      expect(result.state).toBe('replied');
      if (result.state !== 'replied') throw new Error('unreachable');
      expect(result.text).toBe('Here is your briefing.');
      expect(result.sources).toEqual(['https://epic.odoo.com/odoo/account.move/1']);
      expect(result.briefing).toBe(OK_BRIEFING);
      expect(result.correlationId).toBe('corr-1');
    });

    it('sends the RUNTIME template id (not the portal catalogue id), INTERNAL exposure, inline mode, and the REAL agentId/companyId from the binding', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
      expect(new URL(String(calledUrl)).pathname).toBe('/v1/invoke');
      const sentBody = JSON.parse((calledInit as RequestInit).body as string);
      expect(sentBody.templateId).toBe(RUNTIME_TEMPLATE_ID);
      expect(sentBody.templateId).not.toBe('isola-internal-summarizer');
      expect(sentBody.exposure).toBe('INTERNAL');
      expect(sentBody.responseMode).toBe('inline');
      expect(sentBody.agentId).toBe('agent-real-42');
      expect(sentBody.context.companyId).toBe('co-real');
      expect(sentBody.runIdIssuedBy).toBeUndefined();
      expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: 'Bearer internal-bearer' });
    });

    it('NEVER sets context.tenantId -- the AgentOS gate refuses any value that is not its own server-configured constant', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.tenantId).toBeUndefined();
    });

    it('sets a stable conversationRef so persistence can succeed (issueId:null would throw against a real recorder)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.conversationRef).toBe(`cco-briefing:${TENANT}:${THREAD}`);
    });

    it('carries the Odoo briefing AND the owner\'s own words only inside context, side by side -- data, never templateId/exposure/policy', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });

      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.context.businessBriefing).toEqual(OK_BRIEFING);
      expect(sentBody.context.ownerRequest).toBe(MESSAGE);
      expect(sentBody.templateId).not.toContain(MESSAGE);
      expect(sentBody.exposure).not.toContain(MESSAGE);
    });

    it('DUPLICATE REQUEST: the same tenantId+threadId+turnId always produces the same runId, regardless of message content', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: 'a completely different message' });

      const runId1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).runId;
      const runId2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).runId;
      expect(runId1).toBe(runId2);
    });

    it('a DIFFERENT turnId in the SAME thread produces a different runId -- a new question is a new run, not a replay', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'turn-1', message: MESSAGE });
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: 'turn-2', message: 'a follow-up question' });

      const runId1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).runId;
      const runId2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).runId;
      expect(runId1).not.toBe(runId2);

      // But BOTH turns still share the same conversationRef -- they
      // accumulate into one traceable Paperclip issue.
      const ref1 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).context.conversationRef;
      const ref2 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).context.conversationRef;
      expect(ref1).toBe(ref2);
    });

    it('DUPLICATE REQUEST: a replayed run (outcome ok, replay implied by the runtime) still reports replied with the stored answer', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'the original stored answer', replay: true }),
      );
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('replied');
      if (result.state === 'replied') expect(result.text).toBe('the original stored answer');
    });
  });

  describe('WRONG TENANT/AGENT -- the binding refuses before any runtime call', () => {
    it.each(['tenant_not_mapped', 'not_provisioned', 'not_ready', 'ambiguous'] as const)(
      'blocked with reason %s, and the runtime is never called',
      async (outcome) => {
        resolveCcoAgentBindingMock.mockResolvedValue({ outcome });
        const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
        expect(result.state).toBe('blocked');
        if (result.state === 'blocked') expect(result.reason).toBe(outcome);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(getBusinessBriefingMock).not.toHaveBeenCalled();
      },
    );

    it('unavailable (not blocked) when the binding lookup itself is unreachable -- never conflated with "not this tenant\'s agent"', async () => {
      resolveCcoAgentBindingMock.mockResolvedValue({ outcome: 'unreachable', detail: 'http_500' });
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('unavailable');
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('MISSING CALLER PROOF -- the runtime\'s own agent-specific gate refuses', () => {
    it('unavailable, never presented as though the owner\'s own request was rejected', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(403, { ok: false, outcome: 'agent_caller_proof_required', error: 'agent caller proof: missing_proof' }),
      );
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.reason).toBe('agent_caller_proof_required');
    });

    it('sends the configured callerProof when this deployment has one', async () => {
      getIsolaRuntimeConfigMock.mockReturnValue({ ...RUNTIME_CONFIG, internalCallerProof: 'the-real-proof' });
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.callerProof).toBe('the-real-proof');
    });

    it('omits callerProof entirely when this deployment has none configured -- never sends an empty/guessed value', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, outcome: 'ok', correlationId: 'corr-1', answerText: 'x' }));
      await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      const sentBody = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
      expect(sentBody.callerProof).toBeUndefined();
    });
  });

  describe('provisioning / configuration recovery', () => {
    it('unavailable when the runtime is not configured on Foundation\'s side, and the briefing is still returned', async () => {
      getIsolaRuntimeConfigMock.mockReturnValue(null);
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('unavailable');
      expect(result.briefing).toBe(OK_BRIEFING);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('unavailable, not a crash, when the runtime is unreachable over the network', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('unavailable');
      if (result.state === 'unavailable') expect(result.reason).toBe('runtime_unreachable');
    });

    it('timeout, distinct from unavailable, on a model timeout outcome', async () => {
      fetchMock.mockResolvedValue(jsonResponse(504, { ok: false, outcome: 'model_timeout', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('timeout');
    });

    it('degraded (never "unavailable", never a fabricated success) on a persisted-but-not-completed outcome', async () => {
      fetchMock.mockResolvedValue(jsonResponse(502, { ok: false, outcome: 'persistence_failed', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('degraded');
      expect(result.text).toBeNull();
    });

    it('unavailable on budget_exhausted -- never presented as a problem with the owner\'s specific question', async () => {
      fetchMock.mockResolvedValue(jsonResponse(402, { ok: false, outcome: 'budget_exhausted', correlationId: 'corr-1' }));
      const result = await askCco({ tenantId: TENANT, threadId: THREAD, turnId: TURN, message: MESSAGE });
      expect(result.state).toBe('unavailable');
    });
  });
});
