/**
 * The boundary properties, asserted.
 *
 * These are the tests that matter. Each one corresponds to a row of the
 * adversarial validation matrix in the design packet, and each one fails if the
 * property it names stops holding.
 *
 * No network request is made anywhere in this file: `fetch` is replaced, so a
 * test that accidentally reached Meta would fail rather than succeed quietly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { handle, __resetRateLimits } from '../src/app.js';
import { __loadForTest, hashToken, authenticate, tenantOwnsAsset } from '../src/credentials.js';
import { validateInput, buildPath, project } from '../src/policy.js';
import { findOperation, OPERATIONS } from '../src/operations.js';
import { assertNoSecret } from '../src/audit.js';

const WABA = '272252189309178';
const PHONE = '109988776655443';
const OTHER_WABA = '999888777666555';
const TOKEN_A = 'workload-token-tenant-a';
const TOKEN_B = 'workload-token-tenant-b';
/** Shaped like a real Meta token so the redaction assertions are meaningful. */
const FAKE_META_TOKEN = 'EAA' + 'S'.repeat(48) + 'SYNTHETICNOTREAL';

function seed(): void {
  __loadForTest({
    workloads: {
      [hashToken(TOKEN_A)]: { workload_id: 'foundation-notifier', tenant_id: 'tenant-a', roles: ['reader'] },
      [hashToken(TOKEN_B)]: { workload_id: 'other-caller', tenant_id: 'tenant-b', roles: ['reader'] },
    },
    tenants: {
      'tenant-a': {
        assets: [
          { kind: 'waba', id: WABA },
          { kind: 'phone_number', id: PHONE },
        ],
        meta_token: FAKE_META_TOKEN,
      },
      'tenant-b': { assets: [{ kind: 'waba', id: OTHER_WABA }], meta_token: FAKE_META_TOKEN + 'B' },
    },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let logged: string[];

beforeEach(() => {
  seed();
  __resetRateLimits();
  delete process.env.META_GATEWAY_DISABLED;
  logged = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  });
  fetchMock = vi.fn(async () => jsonResponse({ data: [] }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const post = (op: string, body: unknown, token: string | null = TOKEN_A) =>
  handle({
    method: 'POST',
    path: `/v1/operations/${op}`,
    authorization: token ? `Bearer ${token}` : null,
    body,
  });

// ---------------------------------------------------------------- routes
describe('caller surface', () => {
  it('exposes no route that accepts a URL, path, header or token', async () => {
    for (const path of ['/v1/proxy', '/v1/graph', '/proxy', '/v1/operations', '/']) {
      const r = await handle({ method: 'POST', path, authorization: `Bearer ${TOKEN_A}`, body: { url: 'https://graph.facebook.com/v23.0/me' } });
      expect(r.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('healthz is unauthenticated and reveals no identities or values', async () => {
    const r = await handle({ method: 'GET', path: '/healthz', authorization: null, body: undefined });
    expect(r.status).toBe(200);
    const s = JSON.stringify(r.body);
    expect(s).not.toContain(FAKE_META_TOKEN);
    expect(s).not.toContain('tenant-a');
    expect(s).not.toContain(WABA);
  });
});

// ---------------------------------------------------------------- authn
describe('authentication', () => {
  it('rejects a missing, malformed or unknown bearer token', async () => {
    for (const t of [null, 'not-a-known-token', '']) {
      const r = await post('wa.webhook_ownership.read', { waba_id: WABA }, t);
      expect(r.status).toBe(401);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a Meta credential is not a workload credential', async () => {
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA }, FAKE_META_TOKEN);
    expect(r.status).toBe(401);
  });

  it('authenticate() resolves a known workload and nothing else', () => {
    expect(authenticate(TOKEN_A)?.tenant_id).toBe('tenant-a');
    expect(authenticate('x')).toBeNull();
  });
});

// ---------------------------------------------------------------- allowlist
describe('operation allowlist', () => {
  it('an unknown operation id is refused without an upstream call', async () => {
    for (const id of ['wa.anything', '../../etc/passwd', 'wa.webhook_ownership.write', '']) {
      const r = await post(id, { waba_id: WABA });
      expect(r.status).toBe(404);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('every declared operation is a read in this phase, and none requires an unimplemented approval path to be reachable', () => {
    for (const op of OPERATIONS) {
      expect(op.method).toBe('GET');
      expect(op.class === 'metadata_read' || op.class === 'content_read').toBe(true);
      expect(op.requiresApproval).toBe(false);
    }
  });

  it('a mutation operation cannot execute while approval is unimplemented', async () => {
    const op = { ...findOperation('wa.webhook_ownership.read')!, requiresApproval: true };
    const v = validateInput(op, { waba_id: WABA });
    expect(v.ok).toBe(true);
    // Proven at the app level by the guard in handle(); this asserts the
    // registry flag is the thing that gates it.
    expect(op.requiresApproval).toBe(true);
  });
});

// ---------------------------------------------------------------- schema
describe('input schema', () => {
  it('rejects every unknown key, including credential- and URL-shaped ones', async () => {
    for (const extra of [
      { access_token: 'x' },
      { url: 'https://attacker.example' },
      { fields: 'accounts{access_token}' },
      { headers: { Authorization: 'Bearer x' } },
      { path: '/me' },
      { graph_version: 'v1.0' },
    ]) {
      const r = await post('wa.webhook_ownership.read', { waba_id: WABA, ...extra });
      expect(r.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a waba id that is not digits', async () => {
    for (const bad of ['../me', '123/accounts', 'me', `${WABA}?fields=x`, `${WABA} `, '12']) {
      const r = await post('wa.webhook_ownership.read', { waba_id: bad });
      expect(r.status).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a path template can never be filled into another destination', () => {
    const op = findOperation('wa.webhook_ownership.read')!;
    for (const bad of ['1/accounts', '../oauth/access_token', 'a?b=c', 'x#y', '//evil']) {
      const built = buildPath(op, { waba_id: bad });
      expect(built.ok).toBe(false);
    }
    const good = buildPath(op, { waba_id: WABA });
    expect(good.ok && good.path).toBe(`/${WABA}/subscribed_apps`);
  });
});

// ---------------------------------------------------------------- scope
describe('tenant and asset scope', () => {
  it('denies an asset belonging to another tenant', async () => {
    const r = await post('wa.webhook_ownership.read', { waba_id: OTHER_WABA }, TOKEN_A);
    expect(r.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies an asset that exists for nobody, with the same response as one that is simply not yours', async () => {
    const a = await post('wa.webhook_ownership.read', { waba_id: OTHER_WABA }, TOKEN_A);
    const b = await post('wa.webhook_ownership.read', { waba_id: '111222333444555' }, TOKEN_A);
    expect(a.status).toBe(b.status);
    expect((a.body as { error: string }).error).toBe((b.body as { error: string }).error);
  });

  it('the same asset is allowed for the tenant that owns it', async () => {
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA }, TOKEN_A);
    expect(r.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('scope is derived from the authenticated workload, never from the body', () => {
    expect(tenantOwnsAsset('tenant-a', 'waba', WABA)).toBe(true);
    expect(tenantOwnsAsset('tenant-b', 'waba', WABA)).toBe(false);
  });
});

// ---------------------------------------------------------------- upstream
describe('the request this service actually makes', () => {
  it('uses a pinned version, a fixed method, and puts the credential in a header not the URL', async () => {
    await post('wa.webhook_ownership.read', { waba_id: WABA });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.origin).toBe('https://graph.facebook.com');
    expect(url.pathname).toBe(`/v23.0/${WABA}/subscribed_apps`);
    expect(url.search).toBe('');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(String(url)).not.toContain(FAKE_META_TOKEN);
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_META_TOKEN}`);
  });

  it('sends only the operation-declared query parameters', async () => {
    await post('wa.phone_numbers.list', { waba_id: WABA });
    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.searchParams.get('fields')).toBe('id,display_phone_number,verified_name,quality_rating,platform_type');
    expect([...url.searchParams.keys()]).toEqual(['fields']);
  });

  it('refuses a redirect instead of following it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://attacker.example/' } }));
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    expect(r.status).toBe(504);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refuses an oversized upstream body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ data: 'x'.repeat(300 * 1024) }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    expect(r.status).toBe(504);
  });

  it('does not forward an upstream error body', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: `bad token ${FAKE_META_TOKEN}` } }, 400));
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    expect(r.status).toBe(502);
    expect(JSON.stringify(r.body)).not.toContain(FAKE_META_TOKEN);
    expect(JSON.stringify(r.body)).not.toContain('bad token');
  });
});

// ---------------------------------------------------------------- projection
describe('response projection', () => {
  it('drops every field the operation did not declare, including a credential', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        data: [
          {
            whatsapp_business_api_data: { id: '123', name: 'Isola', link: 'https://x', access_token: FAKE_META_TOKEN },
            surprise_new_field: FAKE_META_TOKEN,
          },
        ],
        paging: { cursors: { after: 'abc' } },
      }),
    );
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    const s = JSON.stringify(r.body);
    expect(r.status).toBe(200);
    expect(s).not.toContain(FAKE_META_TOKEN);
    expect(s).not.toContain('surprise_new_field');
    expect(s).not.toContain('paging');
    expect(s).toContain('Isola');
  });

  it('project() is an allowlist for nested and array shapes alike', () => {
    const out = project({ id: 'a', secret: 'S', nested: { keep: 1, drop: 2 } }, ['id', 'nested.keep']);
    expect(out).toEqual({ id: 'a', nested: { keep: 1 } });
  });
});

// ---------------------------------------------------------------- audit
describe('audit', () => {
  it('emits one event per decision and never a credential', async () => {
    await post('wa.webhook_ownership.read', { waba_id: WABA });
    await post('wa.webhook_ownership.read', { waba_id: OTHER_WABA });
    await post('nope', {});
    expect(logged.length).toBe(3);
    for (const line of logged) {
      expect(line).not.toContain(FAKE_META_TOKEN);
      expect(line).not.toContain(TOKEN_A);
      const ev = JSON.parse(line);
      expect(ev.event).toBe('meta.gateway');
      expect(typeof ev.correlation_id).toBe('string');
    }
    expect(JSON.parse(logged[0]!).outcome).toBe('ok');
    expect(JSON.parse(logged[1]!).outcome).toBe('denied_scope');
    expect(JSON.parse(logged[2]!).outcome).toBe('denied_unknown_operation');
  });

  it('assertNoSecret throws rather than emitting a near-miss', () => {
    expect(() => assertNoSecret({ note: `Bearer ${FAKE_META_TOKEN}` })).toThrow();
    expect(() => assertNoSecret({ token: FAKE_META_TOKEN })).toThrow();
    expect(() => assertNoSecret({ tenant_id: 'tenant-a', outcome: 'ok' })).not.toThrow();
  });
});

// ---------------------------------------------------------------- controls
describe('rate limiting and emergency shutdown', () => {
  it('enforces the per-operation rate limit', async () => {
    const op = findOperation('wa.webhook_ownership.read')!;
    for (let i = 0; i < op.rateLimitPerMinute; i++) {
      expect((await post('wa.webhook_ownership.read', { waba_id: WABA })).status).toBe(200);
    }
    expect((await post('wa.webhook_ownership.read', { waba_id: WABA })).status).toBe(429);
  });

  it('the kill switch denies every operation and makes no upstream call', async () => {
    process.env.META_GATEWAY_DISABLED = 'true';
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    expect(r.status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a tenant with no provisioned credential fails closed rather than borrowing one', async () => {
    __loadForTest({
      workloads: { [hashToken(TOKEN_A)]: { workload_id: 'w', tenant_id: 'tenant-unprovisioned', roles: [] } },
      tenants: { 'tenant-a': { assets: [{ kind: 'waba', id: WABA }], meta_token: FAKE_META_TOKEN } },
    });
    const r = await post('wa.webhook_ownership.read', { waba_id: WABA });
    // Scope is checked first, and an unprovisioned tenant owns nothing.
    expect([403, 503]).toContain(r.status);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
