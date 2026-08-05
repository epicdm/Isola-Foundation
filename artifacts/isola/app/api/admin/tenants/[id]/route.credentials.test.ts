/**
 * CB-0 sibling route — the admin tenant-detail API must not ship credentials.
 *
 * Found by independent review of the onboarding fix: this route used
 * `include: { whatsapp_numbers: true, chatwoot_bindings: true }` and returned
 * the tenant directly, so `WhatsAppNumber.access_token`, `token_env` and
 * `ChatwootBinding.token` (a Chatwoot Application API agent token) were all
 * serialised to the client. Admin is a role, not a reason to ship credentials.
 *
 * Scope note: `Tenant.magnus_sip_password` is NOT asserted against here. The
 * schema documents it as deliberately owner-visible for softphone setup, so
 * removing it is a product decision rather than a leak fix, and is recorded
 * separately rather than changed under CB-0.
 *
 * Every secret below is generated at runtime, never written as a literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';

const { getSessionFromCookieMock, prismaMock, getCurrentUsageMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  prismaMock: { tenant: { findUnique: vi.fn() } },
  getCurrentUsageMock: vi.fn(),
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));
vi.mock('@/lib/meter', () => ({ getCurrentUsage: getCurrentUsageMock }));

import { GET } from './route';
import { WHATSAPP_NUMBER_PUBLIC_FIELDS } from '@/lib/whatsapp-number-public';
import { CHATWOOT_BINDING_PUBLIC_FIELDS } from '@/lib/chatwoot-binding-public';

const fake = (label: string) => `SYNTHETIC-${label}-${label.length}-NOT-A-REAL-VALUE`;

const SYNTHETIC = {
  wa_access_token: fake('WA-ACCESS-TOKEN'),
  wa_token_env: fake('WA-TOKEN-ENV'),
  chatwoot_token: fake('CHATWOOT-AGENT-TOKEN'),
} as const;

function adminSession(): SessionCtx {
  return {
    replitId: 'replit-1',
    user: { id: 'user-1' } as User & { tenant: Tenant },
    effectiveTenantId: 'tenant-1',
    effectiveTenant: {} as Tenant,
    isAdmin: true,
    isOwner: true,
    identityId: 'identity-1',
  };
}

function request(): NextRequest {
  return new NextRequest('http://localhost/api/admin/tenants/tenant-9', {
    method: 'GET',
    headers: { cookie: 'sid=abc' },
  });
}

const params = { params: Promise.resolve({ id: 'tenant-9' }) };

/**
 * What the query layer would hand back if the nested selects were removed.
 * Anything here that survives into the response is a leak.
 */
const TENANT_WITH_SECRETS = {
  id: 'tenant-9',
  business_name: 'EPIC',
  whatsapp_numbers: [
    {
      id: 'wan-1',
      phone_number_id: '278390858690809',
      waba_id: '227366173803234',
      phone_number: '+17672956737',
      display_name: 'Front Desk',
      coex_mode: true,
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-02T00:00:00.000Z'),
      access_token: SYNTHETIC.wa_access_token,
      token_env: SYNTHETIC.wa_token_env,
    },
  ],
  chatwoot_bindings: [
    {
      id: 'cwb-1',
      tenant_id: 'tenant-9',
      agent_id: 'agent-1',
      base_url: 'https://inbox.epic.dm',
      account_id: '5',
      inbox_id: '46',
      mode: 'a2',
      created_at: new Date('2026-08-01T00:00:00.000Z'),
      updated_at: new Date('2026-08-02T00:00:00.000Z'),
      token: SYNTHETIC.chatwoot_token,
    },
  ],
  agents: [{ id: 'agent-1', name: 'EPIC Front Desk' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(adminSession());
  getCurrentUsageMock.mockResolvedValue({ messages: 0 });
});

describe('GET /api/admin/tenants/[id] — credential containment', () => {
  it('asks the database for safe projections on both credential-bearing relations', async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(TENANT_WITH_SECRETS);

    await GET(request(), params);

    const include = prismaMock.tenant.findUnique.mock.calls[0][0].include;

    expect(Object.keys(include.whatsapp_numbers.select).sort()).toEqual(
      [...WHATSAPP_NUMBER_PUBLIC_FIELDS].sort(),
    );
    expect(include.whatsapp_numbers.select).not.toHaveProperty('access_token');
    expect(include.whatsapp_numbers.select).not.toHaveProperty('token_env');

    expect(Object.keys(include.chatwoot_bindings.select).sort()).toEqual(
      [...CHATWOOT_BINDING_PUBLIC_FIELDS].sort(),
    );
    expect(include.chatwoot_bindings.select).not.toHaveProperty('token');

    // the relations are no longer requested wholesale
    expect(include.whatsapp_numbers).not.toBe(true);
    expect(include.chatwoot_bindings).not.toBe(true);
  });

  it('no synthetic credential survives into the serialised response', async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(TENANT_WITH_SECRETS);

    const raw = await (await GET(request(), params)).text();

    for (const [name, value] of Object.entries(SYNTHETIC)) {
      expect(raw, `secret "${name}" leaked into the admin response`).not.toContain(value);
    }
    expect(raw).not.toContain('access_token');
    expect(raw).not.toContain('token_env');
  });

  it('still returns the tenant detail an admin actually needs', async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(TENANT_WITH_SECRETS);

    const body = JSON.parse(await (await GET(request(), params)).text());

    expect(body.tenant.id).toBe('tenant-9');
    expect(body.tenant.whatsapp_numbers[0].phone_number).toBe('+17672956737');
    expect(body.tenant.chatwoot_bindings[0].inbox_id).toBe('46');
    expect(body.tenant.agents[0].name).toBe('EPIC Front Desk');
    expect(body).toHaveProperty('usage');
  });

  it('a non-admin is refused and no query runs', async () => {
    getSessionFromCookieMock.mockResolvedValue({ ...adminSession(), isAdmin: false });

    const res = await GET(request(), params);

    expect(res.status).toBe(403);
    expect(prismaMock.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('a missing tenant returns 404 with no row data', async () => {
    prismaMock.tenant.findUnique.mockResolvedValue(null);

    const res = await GET(request(), params);
    const raw = await res.text();

    expect(res.status).toBe(404);
    expect(JSON.parse(raw)).toEqual({ error: 'Not found' });
    for (const value of Object.values(SYNTHETIC)) expect(raw).not.toContain(value);
  });
});
