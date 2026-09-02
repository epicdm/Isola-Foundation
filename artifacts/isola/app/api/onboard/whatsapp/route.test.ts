/**
 * CB-0 — the WhatsApp onboarding API must never serialise a credential.
 *
 * This drives the REAL route handlers, not a re-implementation of their rules.
 * Every secret below is synthetic and generated in this file; no value here
 * resembles, is derived from, or was read from any real credential.
 *
 * The properties under test:
 *   • POST never returns `access_token` or `token_env`, on any path.
 *   • GET never returns `access_token` or `token_env`, on any path.
 *   • Neither returns app-secret / verify-token / Chatwoot-api-key shaped keys.
 *   • A row carrying realistic synthetic secret strings is fully redacted —
 *     asserted against the serialised JSON text, not just the parsed object,
 *     so a secret nested anywhere in the payload still fails the test.
 *   • The fields the onboarding UI and dashboard actually consume survive.
 *   • A NEW, unapproved model column does not become public. This is the
 *     regression that a denylist or a spread would fail.
 *   • Auth behaviour, tenant scoping and cross-tenant refusal are unchanged.
 *   • Error responses carry no row data at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';

const { getSessionFromCookieMock, prismaMock, auditMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  prismaMock: {
    whatsAppNumber: { findUnique: vi.fn(), upsert: vi.fn(), findMany: vi.fn() },
  },
  auditMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));

import { POST, GET } from './route';
import { WHATSAPP_NUMBER_PUBLIC_FIELDS } from '@/lib/whatsapp-number-public';

/* ----------------------------------------------------------- synthetic data */

/**
 * Distinctive, obviously-fake strings. If one of these ever appears in a
 * response body the test fails and names which field leaked.
 *
 * These are BUILT AT RUNTIME rather than written as string literals. Two
 * reasons, both deliberate: the file then contains no `secret_name: '...'`
 * assignment for a scanner (ours or GitHub's) to flag, and there is no way for
 * a reader to mistake any of them for a real value.
 */
const fake = (label: string) => `SYNTHETIC-${label}-${label.length}-NOT-A-REAL-VALUE`;

const SYNTHETIC = {
  access_token: fake('ACCESS-TOKEN'),
  token_env: fake('TOKEN-ENV'),
  app_secret: fake('APP-SECRET'),
  verify_token: fake('VERIFY-TOKEN'),
  chatwoot_api_key: fake('CHATWOOT-API-KEY'),
  future_secret: fake('FUTURE-COLUMN'),
} as const;

const PUBLIC_ROW = {
  id: 'wan-1',
  phone_number_id: '278390858690809',
  waba_id: '227366173803234',
  phone_number: '+17672956737',
  display_name: 'EPIC Front Desk',
  coex_mode: true,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-02T00:00:00.000Z'),
};

/**
 * A row as it would look if the `select` were removed AND the schema had since
 * grown extra credential columns. Anything that survives serialisation from
 * this object is a leak.
 */
const FULL_ROW_WITH_SECRETS = {
  ...PUBLIC_ROW,
  tenant_id: 'tenant-1',
  access_token: SYNTHETIC.access_token,
  token_env: SYNTHETIC.token_env,
  // columns that do not exist today — the future-schema regression
  app_secret: SYNTHETIC.app_secret,
  verify_token: SYNTHETIC.verify_token,
  chatwoot_api_key: SYNTHETIC.chatwoot_api_key,
  some_future_secret_column: SYNTHETIC.future_secret,
};

function session(tenantId = 'tenant-1'): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-1' } as User & { tenant: Tenant },
    effectiveTenantId: tenantId,
    effectiveTenant: {} as Tenant,
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
  };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/onboard/whatsapp', {
    method: 'POST',
    headers: { cookie: 'sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function getRequest(): NextRequest {
  return new NextRequest('http://localhost/api/onboard/whatsapp', {
    method: 'GET',
    headers: { cookie: 'sid=abc' },
  });
}

const VALID_BODY = {
  phone_number_id: '278390858690809',
  waba_id: '227366173803234',
  phone_number: '+17672956737',
  access_token: SYNTHETIC.access_token,
  display_name: 'EPIC Front Desk',
  coex_mode: true,
};

/** Assert no synthetic secret survives anywhere in the serialised payload. */
function expectNoSecretsInText(raw: string) {
  for (const [name, value] of Object.entries(SYNTHETIC)) {
    expect(raw, `secret "${name}" leaked into the response body`).not.toContain(value);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(session());
  auditMock.mockResolvedValue(undefined);
});

/* --------------------------------------------------------------------- POST */

describe('POST /api/onboard/whatsapp — credential containment', () => {
  it('never returns access_token or token_env, even when the query layer hands back a full row', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(FULL_ROW_WITH_SECRETS);

    const res = await POST(postRequest(VALID_BODY));
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBe(200);
    expect(body.whatsapp_number).not.toHaveProperty('access_token');
    expect(body.whatsapp_number).not.toHaveProperty('token_env');
    expectNoSecretsInText(raw);
  });

  it('does not leak app-secret, verify-token or Chatwoot-api-key shaped fields', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(FULL_ROW_WITH_SECRETS);

    const body = JSON.parse(await (await POST(postRequest(VALID_BODY))).text());

    for (const forbidden of ['app_secret', 'verify_token', 'chatwoot_api_key']) {
      expect(body.whatsapp_number).not.toHaveProperty(forbidden);
    }
  });

  it('a NEW unapproved model column does not become public (spread/denylist regression)', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(FULL_ROW_WITH_SECRETS);

    const body = JSON.parse(await (await POST(postRequest(VALID_BODY))).text());

    expect(body.whatsapp_number).not.toHaveProperty('some_future_secret_column');
    // The response shape is exactly the approved allowlist — nothing more.
    expect(Object.keys(body.whatsapp_number).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
  });

  it('asks the database for the safe projection, not the whole row', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(PUBLIC_ROW);

    await POST(postRequest(VALID_BODY));

    const upsertArgs = prismaMock.whatsAppNumber.upsert.mock.calls[0][0];
    expect(Object.keys(upsertArgs.select).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
    expect(upsertArgs.select).not.toHaveProperty('access_token');

    // the ownership pre-check reads only what it needs
    const findArgs = prismaMock.whatsAppNumber.findUnique.mock.calls[0][0];
    expect(findArgs.select).toEqual({ tenant_id: true });
  });

  it('still persists the token and still writes the audit record', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(PUBLIC_ROW);

    await POST(postRequest(VALID_BODY));

    const upsertArgs = prismaMock.whatsAppNumber.upsert.mock.calls[0][0];
    expect(upsertArgs.create.access_token).toBe(SYNTHETIC.access_token);
    expect(upsertArgs.update.access_token).toBe(SYNTHETIC.access_token);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'whatsapp.connect', entityId: PUBLIC_ROW.id }),
    );
  });

  it('preserves the public fields the onboarding UI and dashboard consume', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(PUBLIC_ROW);

    const body = JSON.parse(await (await POST(postRequest(VALID_BODY))).text());

    expect(body.ok).toBe(true);
    expect(body.whatsapp_number).toMatchObject({
      id: 'wan-1',
      phone_number: '+17672956737',
      display_name: 'EPIC Front Desk',
      phone_number_id: '278390858690809',
      waba_id: '227366173803234',
      coex_mode: true,
    });
  });
});

/* ---------------------------------------------------------------------- GET */

describe('GET /api/onboard/whatsapp — credential containment', () => {
  it('never returns access_token or token_env, even from a full row', async () => {
    prismaMock.whatsAppNumber.findMany.mockResolvedValue([FULL_ROW_WITH_SECRETS]);

    const res = await GET(getRequest());
    const raw = await res.text();
    const body = JSON.parse(raw);

    expect(res.status).toBe(200);
    expect(body.numbers[0]).not.toHaveProperty('access_token');
    expect(body.numbers[0]).not.toHaveProperty('token_env');
    expectNoSecretsInText(raw);
  });

  it('returns exactly the approved allowlist and nothing else', async () => {
    prismaMock.whatsAppNumber.findMany.mockResolvedValue([FULL_ROW_WITH_SECRETS]);

    const body = JSON.parse(await (await GET(getRequest())).text());

    expect(Object.keys(body.numbers[0]).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
  });

  it('asks the database for the safe projection and scopes to the session tenant', async () => {
    prismaMock.whatsAppNumber.findMany.mockResolvedValue([]);

    await GET(getRequest());

    const args = prismaMock.whatsAppNumber.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenant_id: 'tenant-1' });
    expect(Object.keys(args.select).sort()).toEqual([...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort());
    expect(args.select).not.toHaveProperty('access_token');
  });

  it('GET and POST expose an identical public shape', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue(null);
    prismaMock.whatsAppNumber.upsert.mockResolvedValue(FULL_ROW_WITH_SECRETS);
    prismaMock.whatsAppNumber.findMany.mockResolvedValue([FULL_ROW_WITH_SECRETS]);

    const postBody = JSON.parse(await (await POST(postRequest(VALID_BODY))).text());
    const getBody = JSON.parse(await (await GET(getRequest())).text());

    expect(Object.keys(getBody.numbers[0]).sort()).toEqual(
      Object.keys(postBody.whatsapp_number).sort(),
    );
  });
});

/* -------------------------------------------------- auth, tenancy, errors */

describe('auth, tenant scoping and error paths are unchanged', () => {
  it('POST and GET both refuse an unauthenticated caller', async () => {
    getSessionFromCookieMock.mockResolvedValue(null);

    const post = await POST(postRequest(VALID_BODY));
    const get = await GET(getRequest());

    expect(post.status).toBe(401);
    expect(get.status).toBe(401);
    expect(await post.json()).toEqual({ error: 'Unauthorized' });
    expect(prismaMock.whatsAppNumber.upsert).not.toHaveBeenCalled();
    expect(prismaMock.whatsAppNumber.findMany).not.toHaveBeenCalled();
  });

  it('refuses a number already owned by another tenant, and leaks nothing about it', async () => {
    prismaMock.whatsAppNumber.findUnique.mockResolvedValue({ tenant_id: 'tenant-OTHER' });

    const res = await POST(postRequest(VALID_BODY));
    const raw = await res.text();

    expect(res.status).toBe(409);
    expect(JSON.parse(raw)).toEqual({
      error: 'This phone number is already registered to another tenant',
    });
    expect(raw).not.toContain('tenant-OTHER');
    expectNoSecretsInText(raw);
    expect(prismaMock.whatsAppNumber.upsert).not.toHaveBeenCalled();
  });

  it('one tenant cannot read another tenant\'s numbers', async () => {
    getSessionFromCookieMock.mockResolvedValue(session('tenant-2'));
    prismaMock.whatsAppNumber.findMany.mockResolvedValue([]);

    await GET(getRequest());

    expect(prismaMock.whatsAppNumber.findMany.mock.calls[0][0].where).toEqual({
      tenant_id: 'tenant-2',
    });
  });

  it('the missing-field error response carries no row data', async () => {
    const res = await POST(postRequest({ phone_number_id: '1' }));
    const raw = await res.text();

    expect(res.status).toBe(400);
    expect(JSON.parse(raw)).toEqual({ error: 'Missing required fields' });
    expectNoSecretsInText(raw);
  });
});
