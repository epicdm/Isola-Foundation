/**
 * CB-0 sibling — the admin tenant LIST must not ship the plaintext SIP password.
 *
 * `GET /api/admin/tenants` ran `prisma.tenant.findMany` with relation includes
 * but no scalar projection, so every tenant's `magnus_sip_password` — a
 * plaintext SIP registration password — was returned to any staff admin, for
 * every tenant at once.
 *
 * It is legitimately owner-visible; the owner surface is `/api/voice/line` and
 * `app/home/route.ts`. The admin console is not that surface and nothing in the
 * admin UI reads the field.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { SessionCtx } from '@/lib/session';
import type { User, Tenant } from '@prisma/client';

const { getSessionFromCookieMock, prismaMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  prismaMock: { tenant: { findMany: vi.fn() } },
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: vi.fn() }));

import { GET } from './route';


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
  return new NextRequest('http://localhost/api/admin/tenants', {
    method: 'GET',
    headers: { cookie: 'sid=abc' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue(adminSession());
});

describe('GET /api/admin/tenants — credential containment', () => {
  it('omits the plaintext SIP password at the query', async () => {
    prismaMock.tenant.findMany.mockResolvedValue([]);

    await GET(request());

    expect(prismaMock.tenant.findMany.mock.calls[0][0].omit).toEqual({
      magnus_sip_password: true,
    });
  });

  it('still returns the tenant list the admin console needs', async () => {
    prismaMock.tenant.findMany.mockResolvedValue([
      { id: 'tenant-1', business_name: 'EPIC', subscription: { plan: 'pro' } },
    ]);

    const body = JSON.parse(await (await GET(request())).text());

    expect(body.tenants).toHaveLength(1);
    expect(body.tenants[0].business_name).toBe('EPIC');
  });

  it('a non-admin is refused and no query runs', async () => {
    getSessionFromCookieMock.mockResolvedValue({ ...adminSession(), isAdmin: false });

    const res = await GET(request());

    expect(res.status).toBe(403);
    expect(prismaMock.tenant.findMany).not.toHaveBeenCalled();
  });
});
