import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getPortalAgentBindingConfigMock } = vi.hoisted(() => ({
  getPortalAgentBindingConfigMock: vi.fn(),
}));

vi.mock('@/lib/engines', () => ({
  getPortalAgentBindingConfig: getPortalAgentBindingConfigMock,
}));

import { CCO_TEMPLATE_ID, resolveCcoAgentBinding } from './cco-agent-binding';

const TENANT = 'fnd-tenant-1';
// Assembled at runtime, not a string literal, so no scanner has to decide
// whether this looks like a real credential — same convention this estate's
// Python fixtures already use (e.g. test_foundation_client.py's INERT_TOKEN).
const INERT_TOKEN = ['not', 'a', 'real', 'token', 'fixture', 'only'].join('-');
const CONFIG = { baseUrl: 'https://isola-portal.example.test', token: INERT_TOKEN };

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
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result).toEqual({ outcome: 'not_configured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends the Foundation tenant id and the CCO template id, bearer-authenticated', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'not_provisioned' }));
    await resolveCcoAgentBinding(TENANT);

    const [calledUrl, calledInit] = fetchMock.mock.calls[0]!;
    const url = new URL(String(calledUrl));
    expect(url.origin).toBe('https://isola-portal.example.test');
    expect(url.pathname).toBe('/api/isola/internal/agent-binding/');
    expect(url.searchParams.get('foundation_tenant_id')).toBe(TENANT);
    expect(url.searchParams.get('template_id')).toBe(CCO_TEMPLATE_ID);
    expect((calledInit as RequestInit).headers).toMatchObject({ Authorization: `Bearer ${INERT_TOKEN}` });
  });

  it('linked returns the real paperclip_agent_id/paperclip_company_id — the ACTUAL hired agent', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { ok: true, state: 'linked', paperclip_agent_id: 'agent-42', paperclip_company_id: 'co-real' }),
    );
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result).toEqual({ outcome: 'linked', paperclipAgentId: 'agent-42', paperclipCompanyId: 'co-real' });
  });

  it.each(['tenant_not_mapped', 'not_provisioned', 'not_ready', 'ambiguous'])(
    'passes through the honest-negative state %s unchanged',
    async (state) => {
      fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state }));
      const result = await resolveCcoAgentBinding(TENANT);
      expect(result).toEqual({ outcome: state });
    },
  );

  it('a "linked" state with a missing/empty agent id is treated as unreachable, never as a usable binding', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { ok: true, state: 'linked', paperclip_agent_id: '', paperclip_company_id: 'co-1' }));
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result.outcome).toBe('unreachable');
  });

  it('unreachable on a network failure — never conflated with a genuine "not linked"', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'Error' });
  });

  it('unreachable on a non-200 status — a 401 (bad/rotated token) is never mistaken for "not linked"', async () => {
    fetchMock.mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result).toEqual({ outcome: 'unreachable', detail: 'http_401' });
  });

  it('unreachable on a malformed response body', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { unexpected: 'shape' }));
    const result = await resolveCcoAgentBinding(TENANT);
    expect(result.outcome).toBe('unreachable');
  });
});
