/**
 * P0 credential-containment guard — operator realm.
 *
 * The twin of app/api/consumer/voice/line. The two realms deliberately share no
 * code (lib/session.ts vs lib/consumer-session.ts), which is exactly why the
 * same defect existed in both and had to be fixed twice — and why it needs a
 * guard in both. Fixing one realm proves nothing about the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { getSessionFromCookieMock, prismaMock } = vi.hoisted(() => ({
  getSessionFromCookieMock: vi.fn(),
  prismaMock: { voiceLine: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/session', () => ({ getSessionFromCookie: getSessionFromCookieMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { GET } from './route';

const SECRET = 'zzUNIQUE-OWNER-SIP-SECRET-4b8e2dzz';

function voiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vl-b1',
    tenant_id: 'tenant-1',
    owner_kind: 'business',
    provisioning_state: 'completed',
    provisioning_error: null,
    magnus_sip_username: 'ep_tenant1',
    magnus_sip_password: SECRET,
    magnus_did_number: '17678183742',
    voice_forward_to_cell: false,
    voice_cell_number: null,
    ...overrides,
  };
}

function request(): NextRequest {
  return new NextRequest('http://localhost/api/voice/line', { headers: { cookie: 'sid=abc' } });
}

beforeEach(() => {
  vi.clearAllMocks();
  getSessionFromCookieMock.mockResolvedValue({ effectiveTenantId: 'tenant-1' });
  prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine());
});

describe('GET /api/voice/line — credential containment', () => {
  it('does not carry the SIP secret anywhere in the serialized response body', async () => {
    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(200);
    expect(raw).not.toContain(SECRET);
  });

  it('exposes no sip_password key, under that or any adjacent name', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(body).not.toHaveProperty('sip_password');
    expect(body).not.toHaveProperty('sipPassword');
    expect(body).not.toHaveProperty('magnus_sip_password');
  });

  it('still returns the non-secret line facts the operator UI needs', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(body.sip_username).toBe('ep_tenant1');
    expect(body.did_number).toBe('17678183742');
    expect(body.activation_state).toBe('unavailable');
  });

  it('leaks nothing on the unauthenticated path', async () => {
    getSessionFromCookieMock.mockResolvedValue(null);
    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(401);
    expect(raw).not.toContain(SECRET);
  });

  it('leaks nothing through the provisioning-error field', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(
      voiceLine({ provisioning_state: 'failed', provisioning_error: `secret was ${SECRET}` }),
    );
    const res = await GET(request());
    const raw = await res.text();

    expect(raw).not.toContain(SECRET);
  });
});
