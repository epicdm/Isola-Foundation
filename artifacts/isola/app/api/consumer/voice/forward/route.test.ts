import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import type { ConsumerSessionAccount } from '@/lib/consumer-session';
import type { VoiceRouteMutationResult } from '@/lib/voice-routing-service';

const { getConsumerSessionMock, isMagnusConfiguredMock, setVoiceRouteModeMock } = vi.hoisted(() => ({
  getConsumerSessionMock: vi.fn(),
  isMagnusConfiguredMock: vi.fn(),
  setVoiceRouteModeMock: vi.fn(),
}));

vi.mock('@/lib/consumer-session', () => ({ getConsumerSession: getConsumerSessionMock }));
vi.mock('@/lib/engines', () => ({ isMagnusConfigured: isMagnusConfiguredMock }));
vi.mock('@/lib/voice-routing-service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/voice-routing-service')>();
  return { ...actual, setVoiceRouteMode: setVoiceRouteModeMock };
});

import { POST } from './route';

function account(): ConsumerSessionAccount {
  return { id: 'acct-1', identityId: 'identity-c1' } as ConsumerSessionAccount;
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/consumer/voice/forward', {
    method: 'POST',
    headers: { cookie: 'consumer_sid=abc', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getConsumerSessionMock.mockResolvedValue(account());
  isMagnusConfiguredMock.mockReturnValue(true);
});

describe('POST /api/consumer/voice/forward (legacy compat)', () => {
  it('preserves the exact success contract: { forward_to_cell, cell_number }', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: true, mode: 'app', forwardToCellNumber: null, outcome: 'success' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: false }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ forward_to_cell: false, cell_number: null });
  });

  it('a required-field rejection keeps its pre-existing 400 status, matching the operator route', async () => {
    setVoiceRouteModeMock.mockResolvedValue({ ok: false, error: 'A forward number is required for this mode', outcome: 'rejected' } satisfies VoiceRouteMutationResult);
    const res = await POST(postRequest({ forward_to_cell: true }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/required/i);
  });

  it('a critical_degraded outcome gets its own server-error status, distinguishable from ordinary failures, matching the operator route', async () => {
    const critical: VoiceRouteMutationResult = {
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
    setVoiceRouteModeMock.mockResolvedValue(critical);
    const res = await POST(postRequest({ forward_to_cell: true, cell_number: '17678182220' }));
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.status).not.toBe(502);
    expect(body.operatorActionRequired).toBe(true);
    expect(body.critical.consumerAccountId).toBe('acct-1');
  });
});
