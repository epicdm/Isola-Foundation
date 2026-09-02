/**
 * P0 credential-containment guard — consumer realm.
 *
 * GET /api/consumer/voice/line used to return `sip_password`, the plaintext
 * Magnus SIP registration secret, straight into a browser response. The
 * softphone page then rendered it, linked it as `csc:<user>:<pass>@…` and
 * encoded it into a QR image.
 *
 * These tests assert the *serialized body*, not just the parsed object — a
 * field can be absent from a destructure and still present on the wire. Same
 * discipline as app/api/admin/tenants/route.credentials.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConsumerSessionAccount } from '@/lib/consumer-session';

const { getConsumerSessionMock, prismaMock } = vi.hoisted(() => ({
  getConsumerSessionMock: vi.fn(),
  prismaMock: { voiceLine: { findFirst: vi.fn() } },
}));

vi.mock('@/lib/consumer-session', () => ({ getConsumerSession: getConsumerSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));

import { GET } from './route';

/** A value distinctive enough that a substring hit cannot be a coincidence. */
const SECRET = 'zzUNIQUE-SIP-SECRET-9f3a1c7bzz';

function account(): ConsumerSessionAccount {
  return { id: 'acct-1', identityId: 'identity-c1' } as ConsumerSessionAccount;
}

function voiceLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vl-1',
    identity_id: 'identity-c1',
    owner_kind: 'consumer',
    provisioning_state: 'completed',
    provisioning_error: null,
    magnus_sip_username: 'ema_identityc1',
    magnus_sip_password: SECRET,
    magnus_did_number: '17678189796',
    voice_forward_to_cell: false,
    voice_cell_number: null,
    ...overrides,
  };
}

function request(): NextRequest {
  return new NextRequest('http://localhost/api/consumer/voice/line', {
    headers: { cookie: 'consumer_sid=abc' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getConsumerSessionMock.mockResolvedValue(account());
  prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine());
});

describe('GET /api/consumer/voice/line — credential containment', () => {
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
    expect(body).not.toHaveProperty('password');
    expect(body).not.toHaveProperty('secret');
  });

  it('is not satisfied by masking — no partial of the secret survives either', async () => {
    const res = await GET(request());
    const raw = await res.text();

    // Any run of 6+ consecutive characters of the real secret would be a leak.
    for (let i = 0; i + 6 <= SECRET.length; i++) {
      expect(raw).not.toContain(SECRET.slice(i, i + 6));
    }
  });

  it('still returns the non-secret line facts the UI legitimately needs', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(body.state).toBe('completed');
    expect(body.sip_username).toBe('ema_identityc1');
    expect(body.did_number).toBe('17678189796');
    expect(body.registration_server).toBeTruthy();
  });

  it('reports activation as unavailable rather than offering an unsafe path', async () => {
    const res = await GET(request());
    const body = await res.json();

    expect(body.activation_state).toBe('unavailable');
  });

  it('leaks nothing on the unauthenticated path', async () => {
    getConsumerSessionMock.mockResolvedValue(null);
    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(401);
    expect(raw).not.toContain(SECRET);
  });

  it('leaks nothing when the line is missing', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(null);
    const res = await GET(request());
    const raw = await res.text();

    expect(res.status).toBe(404);
    expect(raw).not.toContain(SECRET);
  });

  it('leaks nothing through the provisioning-error field', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(
      voiceLine({ provisioning_state: 'failed', provisioning_error: `magnus rejected secret ${SECRET}` }),
    );
    const res = await GET(request());
    const raw = await res.text();

    // An error string that has captured a credential is still a credential leak.
    expect(raw).not.toContain(SECRET);
  });
});
