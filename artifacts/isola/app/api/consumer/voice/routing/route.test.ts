import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConsumerSessionAccount } from '@/lib/consumer-session';
import type { VoiceRouteMutationResult } from '@/lib/voice-routing-service';

const { getConsumerSessionMock, isMagnusConfiguredMock, setVoiceRouteModeMock, getVoiceRouteStateMock } = vi.hoisted(() => ({
  getConsumerSessionMock: vi.fn(),
  isMagnusConfiguredMock: vi.fn(),
  setVoiceRouteModeMock: vi.fn(),
  getVoiceRouteStateMock: vi.fn(),
}));

vi.mock('@/lib/consumer-session', () => ({ getConsumerSession: getConsumerSessionMock }));
vi.mock('@/lib/engines', () => ({ isMagnusConfigured: isMagnusConfiguredMock }));
vi.mock('@/lib/voice-routing-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice-routing-service')>();
  return { ...actual, setVoiceRouteMode: setVoiceRouteModeMock, getVoiceRouteState: getVoiceRouteStateMock };
});

import { GET, POST } from './route';

function account(): ConsumerSessionAccount {
  return { id: 'acct-1', identityId: 'identity-c1' } as ConsumerSessionAccount;
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/consumer/voice/routing', {
    method: 'POST',
    headers: { cookie: 'consumer_sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const CRITICAL_RESULT: VoiceRouteMutationResult = {
  ok: false,
  error: 'Voice routing change could not be completed or safely rolled back — this line requires operator attention',
  outcome: 'critical_degraded',
  rollbackAttempted: true,
  rollbackVerified: false,
  critical: {
    consumerAccountId: 'acct-1',
    voiceLineId: 'vl-2',
    did: '17678182220',
    requestedMode: 'cell',
    beforeMode: 'app',
    observedAfterMode: 'unknown',
    rollbackAttempted: true,
    rollbackVerified: false,
    operatorActionRequired: true,
  },
};

const REJECTED_RESULT: VoiceRouteMutationResult = { ok: false, error: 'A forward number is required for this mode', outcome: 'rejected' };

beforeEach(() => {
  vi.clearAllMocks();
  getConsumerSessionMock.mockResolvedValue(account());
  isMagnusConfiguredMock.mockReturnValue(true);
});

describe('POST /api/consumer/voice/routing', () => {
  it('an ordinary validation rejection returns a safe 422 with outcome=rejected', async () => {
    setVoiceRouteModeMock.mockResolvedValue(REJECTED_RESULT);
    const res = await POST(postRequest({ mode: 'cell' }));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.outcome).toBe('rejected');
    expect(body.critical).toBeUndefined();
  });

  it('matches the operator route: critical_degraded gets a server-error status with operatorActionRequired, scoped to consumerAccountId not tenantId', async () => {
    setVoiceRouteModeMock.mockResolvedValue(CRITICAL_RESULT);
    const res = await POST(postRequest({ mode: 'cell', forward_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body.operatorActionRequired).toBe(true);
    expect(body.critical.consumerAccountId).toBe('acct-1');
    expect(body.critical.tenantId).toBeUndefined();
  });

  it('never leaks secrets in a critical response', async () => {
    setVoiceRouteModeMock.mockResolvedValue(CRITICAL_RESULT);
    const res = await POST(postRequest({ mode: 'cell', forward_number: '17678182220' }));
    const raw = JSON.stringify(await res.json()).toLowerCase();

    expect(raw).not.toContain('password');
    expect(raw).not.toContain('secret');
  });

  it('a successful change returns the normal 200 contract', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: true, mode: 'cell', forwardToCellNumber: '17678182220', outcome: 'success' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ mode: 'cell', forward_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ mode: 'cell', forward_to_cell_number: '17678182220' });
  });
});

describe('GET /api/consumer/voice/routing', () => {
  it('returns the current mode for a signed-in consumer', async () => {
    getVoiceRouteStateMock.mockResolvedValue({ mode: 'app', forwardToCellNumber: null, did: '17678182220' });
    const res = await GET(new NextRequest('http://localhost/api/consumer/voice/routing', { headers: { cookie: 'consumer_sid=abc' } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.mode).toBe('app');
  });
});
