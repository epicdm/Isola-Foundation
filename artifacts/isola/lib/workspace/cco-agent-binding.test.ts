import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPortalAgentBindingConfigMock } = vi.hoisted(() => ({
  getPortalAgentBindingConfigMock: vi.fn(),
}));

vi.mock('@/lib/engines', () => ({
  getPortalAgentBindingConfig: getPortalAgentBindingConfigMock,
}));

import { CCO_TEMPLATE_ID, listCcoAgents, resolveCcoAgentBinding } from './cco-agent-binding';

const TENANT = 'fnd-tenant-1';
// Assembled at runtime, not a string literal, so no scanner has to decide
// whether this looks like a real credential — same convention this estate's
// Python fixtures already use (e.g. test_foundation_client.py's INERT_TOKEN).
const INERT_TOKEN = ['not', 'a', 'real', 'token', 'fixture', 'only'].join('-');
const CONFIG = { baseUrl: 'https://isola-portal.example.test', token: INERT_TOKEN };
const AGENT_ID = 'agent-real-42';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('resolveCcoAgentBinding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getPortalAgentBindingConfigMock.mockReset();
    getPortalAgentBindingConfigMock.mockReturnValue(CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('not_configured when the base URL or token is unset, and never calls fetch', async () => {
    getPortalAgentBindingConfigMock.mockReturnValue(null);
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result).toEqual({ outcome: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the Foundation tenant id and the SELECTED agent id, bearer-authenticated', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'not_found' }));
    await resolveCcoAgentBinding(TENANT, AGENT_ID);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    const url = new URL(String(calledUrl));
    expect(url.origin).toBe('https://isola-portal.example.test');
    expect(url.pathname).toBe('/api/isola/internal/agent-binding/');
    expect(url.searchParams.get('foundation_tenant_id')).toBe(TENANT);
    expect(url.searchParams.get('agent_id')).toBe(AGENT_ID);
    expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${INERT_TOKEN}` });
  });

  it('linked returns the real paperclip_agent_id/paperclip_company_id — the ACTUAL hired agent, resolved by identity', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, state: 'linked', paperclip_agent_id: AGENT_ID, paperclip_company_id: 'co-real' }),
    );
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result).toEqual({ outcome: 'linked', paperclipAgentId: AGENT_ID, paperclipCompanyId: 'co-real' });
  });

  it('CODEX FINDING (2026-09-18): a "linked" response naming a DIFFERENT agent than requested is refused, not silently trusted', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, state: 'linked', paperclip_agent_id: 'some-other-agent-99', paperclip_company_id: 'co-real' }),
    );
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'linked_state_agent_id_mismatch' });
  });

  it.each(['tenant_not_mapped', 'not_found', 'not_ready'])(
    'passes through the honest-negative state %s unchanged',
    async (state) => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state }));
      const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
      expect(result).toEqual({ outcome: state });
    },
  );

  it('CROSS-AGENT CLAIM: a real agent id owned by a different tenant reads identically to not_found -- never confirms existence', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'not_found' }));
    const result = await resolveCcoAgentBinding(TENANT, 'someone-elses-agent-id');
    expect(result).toEqual({ outcome: 'not_found' });
  });

  it('a "linked" state with a missing/empty agent id is treated as unreachable, never as a usable binding', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'linked', paperclip_agent_id: '', paperclip_company_id: 'co-1' }));
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result.outcome).toBe('unreachable');
  });

  it('unreachable on a network failure — never conflated with a genuine "not found"', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'Error' });
  });

  it('unreachable on a non-200 status — a 401 (bad/rotated token) is never mistaken for "not found"', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'http_401' });
  });

  it('unreachable on a malformed response body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));
    const result = await resolveCcoAgentBinding(TENANT, AGENT_ID);
    expect(result.outcome).toBe('unreachable');
  });
});

describe('listCcoAgents', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getPortalAgentBindingConfigMock.mockReset();
    getPortalAgentBindingConfigMock.mockReturnValue(CONFIG);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends the Foundation tenant id and the CCO template id', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'listed', agents: [] }));
    await listCcoAgents(TENANT);

    const [calledUrl] = fetchMock.mock.calls[0]!;
    const url = new URL(String(calledUrl));
    expect(url.pathname).toBe('/api/isola/internal/agent-catalog/');
    expect(url.searchParams.get('foundation_tenant_id')).toBe(TENANT);
    expect(url.searchParams.get('template_id')).toBe(CCO_TEMPLATE_ID);
  });

  it('an empty list is a valid, non-error answer', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'listed', agents: [] }));
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({ outcome: 'listed', agents: [] });
  });

  it('TWO AGENTS SHARING A TEMPLATE: both are returned, in a list, never picked between', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        state: 'listed',
        agents: [
          { paperclip_agent_id: 'agent-a', paperclip_company_id: 'co-a', display_name: 'Agent A' },
          { paperclip_agent_id: 'agent-b', paperclip_company_id: 'co-b', display_name: 'Agent B' },
        ],
      }),
    );
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({
      outcome: 'listed',
      agents: [
        { paperclipAgentId: 'agent-a', paperclipCompanyId: 'co-a', displayName: 'Agent A' },
        { paperclipAgentId: 'agent-b', paperclipCompanyId: 'co-b', displayName: 'Agent B' },
      ],
    });
  });

  it('tenant_not_mapped when the tenant has no adopted mapping', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'tenant_not_mapped', agents: [] }));
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({ outcome: 'tenant_not_mapped' });
  });

  it('not_configured when unset, and never calls fetch', async () => {
    getPortalAgentBindingConfigMock.mockReturnValue(null);
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({ outcome: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('unreachable on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'Error' });
  });

  it('an entry with no usable agent id is dropped, not fabricated into a usable one', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        ok: true,
        state: 'listed',
        agents: [
          { paperclip_agent_id: '', paperclip_company_id: 'co-bad' },
          { paperclip_agent_id: 'agent-good', paperclip_company_id: 'co-good', display_name: 'Good' },
        ],
      }),
    );
    const result = await listCcoAgents(TENANT);
    expect(result).toEqual({ outcome: 'listed', agents: [{ paperclipAgentId: 'agent-good', paperclipCompanyId: 'co-good', displayName: 'Good' }] });
  });
});
