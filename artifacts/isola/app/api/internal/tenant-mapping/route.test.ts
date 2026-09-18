import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getAgentToolsTokenMock, findUniqueTenantMock } = vi.hoisted(() => ({
  getAgentToolsTokenMock: vi.fn(),
  findUniqueTenantMock: vi.fn(),
}));

vi.mock('@/lib/engines', () => ({ getAgentToolsToken: getAgentToolsTokenMock }));
vi.mock('@/lib/prisma', () => ({ prisma: { tenant: { findUnique: findUniqueTenantMock } } }));

import { NextRequest } from 'next/server';
import { GET } from './route';

const TOKEN = ['not', 'a', 'real', 'token', 'fixture', 'only'].join('-');

function get(tenantId: string | null, authHeader?: string) {
  const url = tenantId ? `http://localhost/api/internal/tenant-mapping?tenant_id=${encodeURIComponent(tenantId)}` : 'http://localhost/api/internal/tenant-mapping';
  const headers = new Headers();
  if (authHeader !== undefined) headers.set('authorization', authHeader);
  return GET(new NextRequest(url, { headers }));
}

beforeEach(() => {
  getAgentToolsTokenMock.mockReset();
  findUniqueTenantMock.mockReset();
  getAgentToolsTokenMock.mockReturnValue(TOKEN);
});

describe('GET /api/internal/tenant-mapping', () => {
  it('401 when the token is not configured at all — never authenticates against an empty expected value', async () => {
    getAgentToolsTokenMock.mockReturnValue('');
    const res = await get('tenant-1', 'Bearer anything');
    expect(res.status).toBe(401);
    expect(findUniqueTenantMock).not.toHaveBeenCalled();
  });

  it('401 for a missing or wrong bearer', async () => {
    const res = await get('tenant-1', 'Bearer wrong-token');
    expect(res.status).toBe(401);
    expect(findUniqueTenantMock).not.toHaveBeenCalled();
  });

  it('400 when tenant_id is missing', async () => {
    const res = await get(null, `Bearer ${TOKEN}`);
    expect(res.status).toBe(400);
  });

  it('404 for a tenant that does not exist — distinct from "not mapped"', async () => {
    findUniqueTenantMock.mockResolvedValue(null);
    const res = await get('does-not-exist', `Bearer ${TOKEN}`);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ ok: false, error: 'tenant_not_found' });
  });

  it('reports an empty (never null, never a default) paperclip_company_id for a tenant that exists but has no mapping yet', async () => {
    findUniqueTenantMock.mockResolvedValue({ paperclip_company_id: null });
    const res = await get('tenant-1', `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, paperclip_company_id: '' });
  });

  it('returns the real per-tenant mapping when one exists', async () => {
    findUniqueTenantMock.mockResolvedValue({ paperclip_company_id: 'co-real-42' });
    const res = await get('tenant-1', `Bearer ${TOKEN}`);
    const body = await res.json();
    expect(body).toEqual({ ok: true, paperclip_company_id: 'co-real-42' });
    expect(findUniqueTenantMock).toHaveBeenCalledWith({ where: { id: 'tenant-1' }, select: { paperclip_company_id: true } });
  });

  it('two different tenants never see each other\'s mapping', async () => {
    findUniqueTenantMock.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === 'tenant-a' ? { paperclip_company_id: 'co-a' } : { paperclip_company_id: 'co-b' },
    );
    const resA = await get('tenant-a', `Bearer ${TOKEN}`);
    const resB = await get('tenant-b', `Bearer ${TOKEN}`);
    expect((await resA.json()).paperclip_company_id).toBe('co-a');
    expect((await resB.json()).paperclip_company_id).toBe('co-b');
  });
});
