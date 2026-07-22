import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConsumerSessionAccount } from '@/lib/consumer-session';
import type { VoiceLine } from '@prisma/client';

const { getConsumerSessionMock, isBffConfiguredMock, startTopupMock, auditMock, prismaMock } = vi.hoisted(() => ({
  getConsumerSessionMock: vi.fn(),
  isBffConfiguredMock: vi.fn(),
  startTopupMock: vi.fn(),
  auditMock: vi.fn(),
  prismaMock: {
    voiceLine: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/consumer-session', () => ({ getConsumerSession: getConsumerSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/audit', () => ({ audit: auditMock }));
vi.mock('@/lib/engines', () => ({
  isBffConfigured: isBffConfiguredMock,
  getBffConfig: () => ({ baseUrl: 'https://bff.epic.dm', internalSecret: 'secret' }),
}));
vi.mock('@/engines/bff', () => ({ startTopup: startTopupMock }));

import { POST } from './route';

function account(): ConsumerSessionAccount {
  return { id: 'acct-1', identityId: 'identity-c1' } as ConsumerSessionAccount;
}

function voiceLine(overrides: Partial<VoiceLine> = {}): VoiceLine {
  return {
    id: 'vl-1',
    owner_kind: 'consumer',
    identity_id: 'identity-c1',
    magnus_sip_username: 'ema_abc',
    magnus_sip_password: 'pw',
    provisioning_state: 'completed',
    ...overrides,
  } as VoiceLine;
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/consumer/wallet/topup/bff/start', {
    method: 'POST',
    headers: { cookie: 'consumer_sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getConsumerSessionMock.mockResolvedValue(account());
  isBffConfiguredMock.mockReturnValue(true);
});

describe('POST /api/consumer/wallet/topup/bff/start', () => {
  it('retired: returns 410 Gone and never calls the BFF', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ provisioning_state: 'retired' }));
    const res = await POST(postRequest({ bundleId: 'b1', method: 'card' }));
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toMatch(/retired/i);
    expect(startTopupMock).not.toHaveBeenCalled();
  });

  it('non-completed, non-retired with creds present: 409 with a distinguishable message, never calls the BFF', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ provisioning_state: 'pending' }));
    const res = await POST(postRequest({ bundleId: 'b1', method: 'card' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/provisioning is not complete/i);
    expect(startTopupMock).not.toHaveBeenCalled();
  });

  it('no creds at all: unchanged 409 "not provisioned yet"', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ magnus_sip_username: null, magnus_sip_password: null }));
    const res = await POST(postRequest({ bundleId: 'b1', method: 'card' }));
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/not provisioned yet/i);
    expect(startTopupMock).not.toHaveBeenCalled();
  });

  it('completed: unchanged pass-through to the BFF and 200 contract', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine());
    startTopupMock.mockResolvedValue({ ok: true, url: 'https://pay.example/checkout' });

    const res = await POST(postRequest({ bundleId: 'b1', method: 'card' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(startTopupMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ username: 'ema_abc', password: 'pw', bundleId: 'b1', method: 'card' }),
    );
  });
});
