import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ConsumerSessionAccount } from '@/lib/consumer-session';
import type { VoiceLine } from '@prisma/client';

const { getConsumerSessionMock, isBffConfiguredMock, getTopupOptionsMock, prismaMock } = vi.hoisted(() => ({
  getConsumerSessionMock: vi.fn(),
  isBffConfiguredMock: vi.fn(),
  getTopupOptionsMock: vi.fn(),
  prismaMock: {
    voiceLine: {
      findFirst: vi.fn(),
    },
  },
}));

vi.mock('@/lib/consumer-session', () => ({ getConsumerSession: getConsumerSessionMock }));
vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/engines', () => ({
  isBffConfigured: isBffConfiguredMock,
  getBffConfig: () => ({ baseUrl: 'https://bff.epic.dm', internalSecret: 'secret' }),
  getNbdManualAccount: () => ({ bank: 'NBD', accountName: 'Isola', accountNumber: '123' }),
  defaultTopupCurrency: () => 'EC$',
}));
vi.mock('@/engines/bff', () => ({ getTopupOptions: getTopupOptionsMock }));

import { GET } from './route';

function account(): ConsumerSessionAccount {
  return { id: 'acct-1', identityId: 'identity-c1', phone_number: '+17671234567' } as ConsumerSessionAccount;
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

beforeEach(() => {
  vi.clearAllMocks();
  getConsumerSessionMock.mockResolvedValue(account());
  isBffConfiguredMock.mockReturnValue(true);
});

describe('GET /api/consumer/wallet/topup/bff/options', () => {
  it('retired: returns 410 Gone and never calls the BFF', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ provisioning_state: 'retired' }));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(410);
    expect(body.error).toMatch(/retired/i);
    expect(getTopupOptionsMock).not.toHaveBeenCalled();
  });

  it('non-completed, non-retired (e.g. pending) with creds present: 409 with a distinguishable message, never calls the BFF', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ provisioning_state: 'pending' }));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/provisioning is not complete/i);
    expect(getTopupOptionsMock).not.toHaveBeenCalled();
  });

  it('no creds at all: unchanged 409 "not provisioned yet"', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine({ magnus_sip_username: null, magnus_sip_password: null }));
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body.error).toMatch(/not provisioned yet/i);
    expect(getTopupOptionsMock).not.toHaveBeenCalled();
  });

  it('completed: unchanged pass-through to the BFF and 200 contract', async () => {
    prismaMock.voiceLine.findFirst.mockResolvedValue(voiceLine());
    getTopupOptionsMock.mockResolvedValue({
      ok: true,
      bundles: [{ id: 'b1', paidAmount: 5, creditAmount: 5, currency: 'EC$' }],
      methods: ['card'],
    });

    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.bundles).toHaveLength(1);
    expect(getTopupOptionsMock).toHaveBeenCalledWith(expect.anything(), { username: 'ema_abc', password: 'pw' });
  });
});
