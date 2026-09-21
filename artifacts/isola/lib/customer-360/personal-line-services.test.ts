import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isPersonalLineServicesConfigured, readPersonalLineServices, resolveAndReadLifecycle } from './personal-line-services';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('readPersonalLineServices', () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  it('CONTROL — fails closed with no fabricated data when the credential is not configured, and never calls fetch', async () => {
    delete process.env.BFF_V2_INTERNAL_BASE_URL;
    delete process.env.BFF_V2_PL_OPERATOR_READ_TOKEN;
    expect(isPersonalLineServicesConfigured()).toBe(false);

    const result = await readPersonalLineServices(42);
    expect(result).toEqual({ available: false, services: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is configured once both env vars are set', () => {
    process.env.BFF_V2_INTERNAL_BASE_URL = 'https://bff-v2.invalid';
    process.env.BFF_V2_PL_OPERATOR_READ_TOKEN = 'test-token';
    expect(isPersonalLineServicesConfigured()).toBe(true);
  });

  describe('once configured', () => {
    beforeEach(() => {
      process.env.BFF_V2_INTERNAL_BASE_URL = 'https://bff-v2.invalid';
      process.env.BFF_V2_PL_OPERATOR_READ_TOKEN = 'test-token';
    });

    it('POSTs the scoped token and odooPartnerId in the body, never the query string', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { services: [] }));
      await readPersonalLineServices(4821);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://bff-v2.invalid/api/internal/customer-360/services');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['x-pl-operator-read-token']).toBe('test-token');
      expect(JSON.parse(init.body as string)).toEqual({ odooPartnerId: 4821 });
    });

    it('reports 0 services as a real, available empty result -- not the same as unavailable', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { services: [] }));
      expect(await readPersonalLineServices(1)).toEqual({ available: true, services: [] });
    });

    it('normalises one linked service with all fields present', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          services: [{ did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: '2026-09-19T00:00:00.000Z' }],
        }),
      );
      const result = await readPersonalLineServices(1);
      expect(result).toEqual({
        available: true,
        services: [{ kind: 'personal_line', did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: '2026-09-19T00:00:00.000Z' }],
      });
    });

    it('normalises many services -- a customer is not assumed to hold exactly one', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          services: [
            { did: '17670000001', sipRegistered: true, magnusUserAssigned: true, createdAt: null },
            { did: '17670000002', sipRegistered: false, magnusUserAssigned: true, createdAt: null },
          ],
        }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services.map((s) => s.did)).toEqual(['17670000001', '17670000002']);
    });

    it('preserves sipRegistered: null (no SIP identity yet, or the check itself failed) rather than coercing it to false', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { services: [{ did: '17678185063', sipRegistered: null, magnusUserAssigned: false, createdAt: null }] }));
      const result = await readPersonalLineServices(1);
      expect(result.services[0].sipRegistered).toBeNull();
    });

    it('drops a service row with no readable did rather than rendering an unkeyable one', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { services: [{ sipRegistered: true, magnusUserAssigned: true }] }));
      const result = await readPersonalLineServices(1);
      expect(result).toEqual({ available: true, services: [] });
    });

    it('never forwards liteAccountId even if the endpoint regresses and sends it', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { services: [{ did: '17678185063', liteAccountId: 'la_should_never_leak', sipRegistered: true, magnusUserAssigned: true, createdAt: null }] }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services[0]).not.toHaveProperty('liteAccountId');
      expect(JSON.stringify(result)).not.toContain('la_should_never_leak');
    });

    it('reports unavailable, never a 500 or a thrown error, on a non-2xx response', async () => {
      fetchMock.mockResolvedValue(jsonResponse(503, { error: 'unavailable' }));
      expect(await readPersonalLineServices(1)).toEqual({ available: false, services: [] });
    });

    it('reports unavailable on a network failure, never throwing past this module', async () => {
      fetchMock.mockRejectedValue(new Error('network down'));
      await expect(readPersonalLineServices(1)).resolves.toEqual({ available: false, services: [] });
    });

    it('reports unavailable on a malformed body (no services array)', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { notServices: [] }));
      expect(await readPersonalLineServices(1)).toEqual({ available: false, services: [] });
    });

    it('reports unavailable when the body is not JSON at all', async () => {
      fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => { throw new Error('not json'); } } as unknown as Response);
      expect(await readPersonalLineServices(1)).toEqual({ available: false, services: [] });
    });

    const FULL_MILESTONE = { status: 'done', evidenceAt: '2026-09-01T00:00:00.000Z', failureReason: null, nextAction: null };
    const FULL_LIFECYCLE = {
      signup: FULL_MILESTONE,
      number_assigned: FULL_MILESTONE,
      sip_registered: FULL_MILESTONE,
      first_confirmation_or_call: FULL_MILESTONE,
      trial_or_plan_active: { status: 'pending', evidenceAt: null, failureReason: null, nextAction: 'No plan selected yet — offer a trial or a paid plan.' },
      odoo_linked: FULL_MILESTONE,
    };

    it('normalises a service that carries a real lifecycle checklist', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { services: [{ did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: null, lifecycle: FULL_LIFECYCLE }] }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services[0].lifecycle).toEqual(FULL_LIFECYCLE);
    });

    it('leaves lifecycle undefined (not fabricated) when the endpoint predates it — forward-compatible with the currently-deployed route', async () => {
      fetchMock.mockResolvedValue(jsonResponse(200, { services: [{ did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: null }] }));
      const result = await readPersonalLineServices(1);
      expect(result.services[0].lifecycle).toBeUndefined();
    });

    it('normalises lifecycle to null (not a guessed checklist) when one milestone has an unrecognised status', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          services: [{
            did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: null,
            lifecycle: { ...FULL_LIFECYCLE, odoo_linked: { status: 'made-up-status', evidenceAt: null, failureReason: null, nextAction: null } },
          }],
        }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services[0].lifecycle).toBeNull();
    });

    it('normalises lifecycle to null when a milestone key is missing entirely, rather than rendering a five-sixths checklist', async () => {
      const { odoo_linked, ...missingOneKey } = FULL_LIFECYCLE;
      fetchMock.mockResolvedValue(
        jsonResponse(200, { services: [{ did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: null, lifecycle: missingOneKey }] }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services[0].lifecycle).toBeNull();
    });

    it('normalises lifecycle to null when it is present but not an object', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, { services: [{ did: '17678185063', sipRegistered: true, magnusUserAssigned: true, createdAt: null, lifecycle: 'not-an-object' }] }),
      );
      const result = await readPersonalLineServices(1);
      expect(result.services[0].lifecycle).toBeNull();
    });
  });
});

describe('resolveAndReadLifecycle', () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    process.env.BFF_V2_INTERNAL_BASE_URL = 'https://bff-v2.invalid';
    process.env.BFF_V2_PL_OPERATOR_READ_TOKEN = 'test-token';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  const FULL_MILESTONE = { status: 'done', evidenceAt: null, failureReason: null, nextAction: null };
  const FULL_LIFECYCLE = {
    signup: FULL_MILESTONE,
    number_assigned: FULL_MILESTONE,
    sip_registered: FULL_MILESTONE,
    first_confirmation_or_call: FULL_MILESTONE,
    trial_or_plan_active: FULL_MILESTONE,
    odoo_linked: FULL_MILESTONE,
  };

  it('CONTROL — fails closed with no fabricated data when the credential is not configured, and never calls fetch', async () => {
    delete process.env.BFF_V2_INTERNAL_BASE_URL;
    delete process.env.BFF_V2_PL_OPERATOR_READ_TOKEN;
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('unavailable');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves did -> liteAccountId, then reads service-detail, and returns ONLY the lifecycle section', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: ['la-1'] }))
      .mockResolvedValueOnce(jsonResponse(200, { account: { odooPartnerId: 1 }, lifecycle: FULL_LIFECYCLE }));

    const result = await resolveAndReadLifecycle('17678185063');
    expect(result).toEqual({ state: 'ready', lifecycle: FULL_LIFECYCLE });

    const [resolveUrl, resolveInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(resolveUrl).toBe('https://bff-v2.invalid/api/internal/personal-line/resolve-action-target');
    expect(JSON.parse(resolveInit.body as string)).toEqual({ did: '17678185063' });

    const [detailUrl] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(detailUrl).toBe('https://bff-v2.invalid/api/internal/personal-line/la-1/service-detail');
  });

  it('reports not-found (not unavailable) when no LiteAccount matches this did', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: [] }));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('not-found');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never reaches service-detail
  });

  it('NEVER GUESSES: reports unavailable, not a picked winner, when more than one account shares this did', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: ['la-1', 'la-2'] }));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(1); // never picks one and reads it
  });

  it('reports unavailable when resolve-action-target itself fails', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503, {}));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('unavailable');
  });

  it('reports unavailable when service-detail fails after a successful resolve', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: ['la-1'] }))
      .mockResolvedValueOnce(jsonResponse(503, {}));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('unavailable');
  });

  it('reports unavailable when service-detail answers but its lifecycle is malformed', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: ['la-1'] }))
      .mockResolvedValueOnce(jsonResponse(200, { account: { odooPartnerId: 1 }, lifecycle: null }));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(result.state).toBe('unavailable');
  });

  it('never forwards liteAccountId in its result, even if it leaked into service-detail’s body', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { liteAccountIds: ['la-1'] }))
      .mockResolvedValueOnce(jsonResponse(200, { account: { odooPartnerId: 1 }, lifecycle: FULL_LIFECYCLE, liteAccountId: 'la_should_never_leak' }));
    const result = await resolveAndReadLifecycle('17678185063');
    expect(JSON.stringify(result)).not.toContain('la_should_never_leak');
  });
});
