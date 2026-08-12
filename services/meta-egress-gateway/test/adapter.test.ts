/**
 * The Chatwoot compatibility surface, asserted against the shapes the DEPLOYED
 * v4.16.1 image actually emits.
 *
 * The pagination tests are the ones that matter most: `fetch_whatsapp_templates`
 * follows `paging.next` verbatim with no headers, so a pass-through would send
 * Chatwoot to graph.facebook.com on page two carrying a workload token. That
 * failure only appears on the SECOND page, which a small test WABA never
 * reaches — so it is tested explicitly here.
 *
 * No network request is made: fetch is replaced throughout.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handleAdapter, ADAPTER_PREFIX, __resetAdapterRateLimits } from '../src/adapter-handler.js';
import { __loadForTest, hashToken } from '../src/credentials.js';
import { __resetContinuations, CONTINUATION_TTL_SECONDS } from '../src/continuation.js';
import { matchRoute, presentedAuth, rewritePaging, ACCEPTED_VERSIONS, ADAPTER_ROUTES } from '../src/chatwoot-adapter.js';

const WABA = '227366173803234';
const PHONE = '278390858690809';
const OTHER_WABA = '999888777666555';

/**
 * Test fixtures only. Assembled at runtime rather than written as literals so
 * neither a reader nor a secret scanner has to judge whether they were ever
 * real. They were not, and they authenticate nothing.
 */
const synthetic = (label: string) => ['SYNTHETIC', label, 'NOT-A-REAL-CREDENTIAL'].join('-');
const CW_TOKEN = synthetic('chatwoot-workload');
const FAKE_META_TOKEN = 'EAA' + 'S'.repeat(48) + synthetic('meta');

let fetchMock: ReturnType<typeof vi.fn>;
let logged: string[];

beforeEach(() => {
  __loadForTest({
    workloads: {
      [hashToken(CW_TOKEN)]: { workload_id: 'chatwoot-production', tenant_id: 'epic-tenant-zero', roles: ['chatwoot'] },
    },
    tenants: {
      'epic-tenant-zero': {
        assets: [
          { kind: 'waba', id: WABA },
          { kind: 'phone_number', id: PHONE },
        ],
        meta_token: FAKE_META_TOKEN,
      },
    },
  });
  __resetAdapterRateLimits();
  __resetContinuations();
  delete process.env.META_GATEWAY_DISABLED;
  process.env.META_GATEWAY_ADAPTER_PUBLIC_BASE = 'http://meta-egress-gateway:3000';
  logged = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    logged.push(String(c));
    return true;
  });
  fetchMock = vi.fn(async () => json({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Exactly how Chatwoot calls: token in the query, no headers. */
const queryCall = (path: string, qs: Record<string, string> = {}) =>
  handleAdapter({
    method: 'GET',
    path: `${ADAPTER_PREFIX}${path}`,
    query: new URLSearchParams({ access_token: CW_TOKEN, ...qs }),
    authorization: null,
    body: undefined,
  });

/** Exactly how Chatwoot calls with api_headers. */
const headerCall = (method: string, path: string, qs: Record<string, string> = {}, body?: unknown) =>
  handleAdapter({
    method,
    path: `${ADAPTER_PREFIX}${path}`,
    query: new URLSearchParams(qs),
    authorization: `Bearer ${CW_TOKEN}`,
    body,
  });

// ------------------------------------------------------------ route contract
describe('route contract', () => {
  it('accepts exactly the versions the deployed Chatwoot emits', () => {
    expect([...ACCEPTED_VERSIONS].sort()).toEqual(['v13.0', 'v14.0', 'v22.0', 'v24.0']);
    for (const v of ACCEPTED_VERSIONS) {
      expect(matchRoute('GET', `/${v}/${WABA}/message_templates`)).not.toBeNull();
    }
  });

  it('rejects a version Chatwoot does not emit, rather than guessing', async () => {
    for (const v of ['v23.0', 'v1.0', 'v99.0', 'latest', '']) {
      const r = await queryCall(`/${v}/${WABA}/message_templates`);
      expect(r.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('normalises every accepted version to the single pinned server version', async () => {
    for (const v of ACCEPTED_VERSIONS) {
      fetchMock.mockClear();
      await queryCall(`/${v}/${WABA}/message_templates`);
      const [url] = fetchMock.mock.calls[0] as [URL];
      expect(url.pathname).toBe(`/v23.0/${WABA}/message_templates`);
    }
  });

  it('refuses any path outside the contract', async () => {
    for (const p of [
      `/v14.0/${WABA}/subscribed_apps`,
      `/v14.0/${WABA}/message_templates/extra`,
      `/v14.0/${WABA}/../oauth/access_token`,
      '/v14.0/oauth/access_token',
      `/v14.0/${WABA}/messages/send`,
    ]) {
      const r = await queryCall(p);
      expect(r.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses an unexpected query key', async () => {
    for (const k of ['url', 'redirect', 'access_token2', 'appsecret_proof']) {
      const r = await handleAdapter({
        method: 'GET',
        path: `${ADAPTER_PREFIX}/v14.0/${WABA}/message_templates`,
        query: new URLSearchParams({ access_token: CW_TOKEN, [k]: 'x' }),
        authorization: null,
        body: undefined,
      });
      expect(r.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ authentication
describe('authentication profile', () => {
  it('accepts the query token on exactly the two validation reads', async () => {
    expect((await queryCall(`/v14.0/${WABA}/message_templates`)).status).toBe(200);
    expect((await queryCall(`/v14.0/${WABA}/phone_numbers`, { fields: 'id', limit: '100' })).status).toBe(200);
  });

  it('accepts the header bearer on the same reads', async () => {
    expect((await headerCall('GET', `/v14.0/${WABA}/message_templates`, { name: 'csat' })).status).toBe(200);
  });

  it('refuses a request presenting BOTH a header and a query token', async () => {
    const r = await handleAdapter({
      method: 'GET',
      path: `${ADAPTER_PREFIX}/v14.0/${WABA}/message_templates`,
      query: new URLSearchParams({ access_token: CW_TOKEN }),
      authorization: `Bearer ${CW_TOKEN}`,
      body: undefined,
    });
    expect(r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses duplicate query tokens', async () => {
    const q = new URLSearchParams();
    q.append('access_token', CW_TOKEN);
    q.append('access_token', CW_TOKEN);
    const r = await handleAdapter({ method: 'GET', path: `${ADAPTER_PREFIX}/v14.0/${WABA}/message_templates`, query: q, authorization: null, body: undefined });
    expect(r.status).toBe(401);
  });

  it('refuses an unknown or absent token', async () => {
    for (const t of ['nope', '']) {
      const r = await handleAdapter({
        method: 'GET',
        path: `${ADAPTER_PREFIX}/v14.0/${WABA}/message_templates`,
        query: new URLSearchParams(t ? { access_token: t } : {}),
        authorization: null,
        body: undefined,
      });
      expect(r.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never forwards the workload token to Meta', async () => {
    await queryCall(`/v14.0/${WABA}/message_templates`);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).not.toContain(CW_TOKEN);
    expect(url.searchParams.get('access_token')).toBeNull();
    expect(JSON.stringify(init.headers)).not.toContain(CW_TOKEN);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_META_TOKEN}`);
  });
});

// ------------------------------------------------------------ scope
describe('tenant and asset scope', () => {
  it("refuses another tenant's WABA", async () => {
    const r = await queryCall(`/v14.0/${OTHER_WABA}/message_templates`);
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('the query token cannot select another asset', async () => {
    for (const id of [OTHER_WABA, PHONE]) {
      fetchMock.mockClear();
      const r = await queryCall(`/v14.0/${id}/message_templates`);
      // PHONE is owned but is not a WABA-scoped asset for this route.
      if (id === OTHER_WABA) expect(r.status).toBe(403);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1);
    }
  });
});

// ------------------------------------------------------------ enablement
describe('operation activation', () => {
  it('only the two validation reads are enabled', () => {
    const enabled = ADAPTER_ROUTES.filter((r) => r.enabled).map((r) => r.id).sort();
    expect(enabled).toEqual(['cw.phone_numbers.list', 'cw.templates.list']);
  });

  it('every mutation is implemented but refused', async () => {
    expect((await headerCall('POST', `/v14.0/${PHONE}/messages`, {}, { messaging_product: 'whatsapp' })).status).toBe(403);
    expect((await headerCall('POST', `/v14.0/${WABA}/message_templates`, {}, { name: 'x' })).status).toBe(403);
    expect((await headerCall('DELETE', `/v14.0/${WABA}/message_templates`, { name: 'x' })).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('media metadata is held closed', async () => {
    expect((await headerCall('GET', `/v13.0/${WABA}`)).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ PAGINATION
describe('pagination stays inside the gateway', () => {
  const metaPage1 = {
    data: [{ name: 'tpl_one' }],
    paging: {
      cursors: { before: 'B1', after: 'A1' },
      next: `https://graph.facebook.com/v14.0/${WABA}/message_templates?access_token=${FAKE_META_TOKEN}&after=A1`,
    },
  };
  const metaPage2 = { data: [{ name: 'tpl_two' }], paging: { cursors: { before: 'B2', after: 'A2' } } };

  it("never returns Meta's absolute next URL, and leaks no credential", async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const r = await queryCall(`/v14.0/${WABA}/message_templates`);
    const s = JSON.stringify(r.body);

    expect(r.status).toBe(200);
    expect(s).not.toContain('graph.facebook.com');
    expect(s).not.toContain(FAKE_META_TOKEN);
    // No Meta version survives either — the follow-up URL carries no version
    // and no asset, only a signed token.
    expect(s).not.toContain('v14.0');
    const next = (r.body as { paging: { next: string } }).paging.next;
    expect(next.startsWith('http://meta-egress-gateway:3000/compat/graph/continue?continuation=')).toBe(true);
    expect(next).not.toContain(WABA);
    // The long-lived workload token is NOT repeated in the rewritten URL.
    expect(next).not.toContain(CW_TOKEN);
  });

  it('page two is served by the gateway and returns the complete set', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);

    fetchMock.mockResolvedValueOnce(json(metaPage2));
    const p2 = await handleAdapter({
      method: 'GET',
      path: next.pathname,
      query: next.searchParams,
      authorization: null,
      body: undefined,
    });

    expect(p2.status).toBe(200);
    expect((p2.body as { data: { name: string }[] }).data[0]!.name).toBe('tpl_two');
    // Page two went upstream with Meta's opaque cursor, not with anything the
    // caller chose.
    const [url2] = fetchMock.mock.calls[1] as [URL];
    expect(url2.origin).toBe('https://graph.facebook.com');
    expect(url2.searchParams.get('after')).toBe('A1');
    // Both pages together are what Chatwoot needs.
    expect((p1.body as { data: { name: string }[] }).data[0]!.name).toBe('tpl_one');
  });

  it('a continuation is single-use', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);
    const call = () =>
      handleAdapter({ method: 'GET', path: next.pathname, query: next.searchParams, authorization: null, body: undefined });

    fetchMock.mockResolvedValueOnce(json(metaPage2));
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(401);
  });

  it('an altered continuation fails closed', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);
    const tok = next.searchParams.get('continuation')!;

    for (const bad of [tok.slice(0, -2) + 'xy', tok.replace('.', '.A'), 'garbage', tok.split('.')[0]!]) {
      const q = new URLSearchParams({ continuation: bad });
      const r = await handleAdapter({ method: 'GET', path: next.pathname, query: q, authorization: null, body: undefined });
      expect(r.status).toBe(401);
    }
  });

  it('a cursor cannot be retargeted, because the URL carries nothing to retarget', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);

    // The asset and operation live inside the signed token, not in the URL.
    expect(next.pathname).toBe(`${ADAPTER_PREFIX}/continue`);
    expect([...next.searchParams.keys()]).toEqual(['continuation']);

    // Presenting the continuation on a normal route is refused outright, so it
    // cannot be pointed at another WABA or another operation that way either.
    for (const p of [`/v14.0/${OTHER_WABA}/message_templates`, `/v14.0/${WABA}/phone_numbers`]) {
      const r = await handleAdapter({
        method: 'GET',
        path: `${ADAPTER_PREFIX}${p}`,
        query: next.searchParams,
        authorization: null,
        body: undefined,
      });
      expect(r.status).toBe(401);
    }
    // And it is still unused, so the legitimate follow-up still works.
    fetchMock.mockResolvedValueOnce(json(metaPage2));
    const ok = await handleAdapter({ method: 'GET', path: next.pathname, query: next.searchParams, authorization: null, body: undefined });
    expect(ok.status).toBe(200);
  });

  it('the continuation endpoint refuses a bearer header or a second token', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);

    const withHeader = await handleAdapter({
      method: 'GET',
      path: next.pathname,
      query: next.searchParams,
      authorization: `Bearer ${CW_TOKEN}`,
      body: undefined,
    });
    expect(withHeader.status).toBe(401);

    const two = new URLSearchParams();
    two.append('continuation', next.searchParams.get('continuation')!);
    two.append('continuation', next.searchParams.get('continuation')!);
    const dup = await handleAdapter({ method: 'GET', path: next.pathname, query: two, authorization: null, body: undefined });
    expect(dup.status).toBe(401);
  });

  it('an expired continuation fails closed', async () => {
    fetchMock.mockResolvedValueOnce(json(metaPage1));
    const p1 = await queryCall(`/v14.0/${WABA}/message_templates`);
    const next = new URL((p1.body as { paging: { next: string } }).paging.next);

    vi.setSystemTime(new Date(Date.now() + (CONTINUATION_TTL_SECONDS + 30) * 1000));
    const r = await handleAdapter({ method: 'GET', path: next.pathname, query: next.searchParams, authorization: null, body: undefined });
    expect(r.status).toBe(401);
    vi.useRealTimers();
  });

  it('rewritePaging drops a next URL it cannot parse rather than passing it on', () => {
    const out = rewritePaging({ data: [], paging: { next: 'not a url' } }, () => 'http://gw/next') as {
      paging: Record<string, unknown>;
    };
    expect(out.paging['next']).toBeUndefined();
  });
});

// ------------------------------------------------------------ compatibility
describe('response compatibility', () => {
  it('preserves the error shape Chatwoot reads', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: 'Invalid OAuth access token', code: 190 } }, 401));
    const r = await queryCall(`/v14.0/${WABA}/message_templates`);
    expect(r.status).toBe(401);
    expect((r.body as { error: { message: string } }).error.message).toBe('Invalid OAuth access token');
  });

  it('passes template data through unaltered', async () => {
    fetchMock.mockResolvedValueOnce(json({ data: [{ name: 'a', status: 'APPROVED', components: [{ type: 'BODY' }] }] }));
    const r = await queryCall(`/v14.0/${WABA}/message_templates`);
    expect((r.body as { data: unknown[] }).data).toEqual([{ name: 'a', status: 'APPROVED', components: [{ type: 'BODY' }] }]);
  });
});

// ------------------------------------------------------------ audit
describe('audit', () => {
  it('never records a query string or a token', async () => {
    await queryCall(`/v14.0/${WABA}/message_templates`);
    expect(logged.length).toBe(1);
    const line = logged[0]!;
    expect(line).not.toContain(CW_TOKEN);
    expect(line).not.toContain(FAKE_META_TOKEN);
    expect(line).not.toContain('access_token');
    const ev = JSON.parse(line);
    expect(ev.target).toBe(`https://graph.facebook.com/v23.0/${WABA}/message_templates`);
    expect(ev.operation_id).toBe('cw.templates.list');
    expect(ev.outcome).toBe('ok');
  });
});

// ------------------------------------------------------------ shutdown
describe('emergency disable', () => {
  it('denies every adapter route and makes no upstream call', async () => {
    process.env.META_GATEWAY_DISABLED = 'true';
    expect((await queryCall(`/v14.0/${WABA}/message_templates`)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------ unit
describe('presentedAuth', () => {
  it('classifies each presentation and refuses conflicts', () => {
    expect(presentedAuth({ authorization: null, queryAccessToken: null, queryContinuation: null }).kind).toBe('none');
    expect(presentedAuth({ authorization: 'Bearer x', queryAccessToken: null, queryContinuation: null }).kind).toBe('header');
    expect(presentedAuth({ authorization: null, queryAccessToken: 'x', queryContinuation: null }).kind).toBe('query');
    expect(presentedAuth({ authorization: null, queryAccessToken: null, queryContinuation: 'c' }).kind).toBe('continuation');
    expect(presentedAuth({ authorization: 'Bearer x', queryAccessToken: 'y', queryContinuation: null }).kind).toBe('conflict');
    expect(presentedAuth({ authorization: null, queryAccessToken: ['a', 'b'], queryContinuation: null }).kind).toBe('conflict');
  });
});
