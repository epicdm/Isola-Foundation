import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClawithFailure } from './errors';

const { prismaMock, auditMock, enqueueNotificationMock } = vi.hoisted(() => ({
  prismaMock: { tenant: { findUnique: vi.fn() } },
  auditMock: vi.fn(),
  enqueueNotificationMock: vi.fn(),
}));

vi.mock('../prisma', () => ({ prisma: prismaMock }));
vi.mock('../audit', () => ({ audit: auditMock }));
vi.mock('../notify', () => ({ enqueueNotification: enqueueNotificationMock }));

const { recordClawithFailure, CLAWITH_FAILURE_ALERT_TEMPLATE_ENV } = await import('./alert');

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const CLAWITH_AGENT = 'clawith-agent-1';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    agentId: AGENT,
    clawithAgentId: CLAWITH_AGENT,
    surface: 'staff_chat' as const,
    correlationId: 'corr-1',
    actorId: 'user-1',
    env: {} as NodeJS.ProcessEnv,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.tenant.findUnique.mockResolvedValue({ owner_phone: '+17672958382' });
});

describe('recordClawithFailure — internal diagnostics are always preserved', () => {
  it('always writes a full audit row — kind, status, detail, correlation, tenant, agent, surface', async () => {
    const failure = new ClawithFailure('payment_required', 'Insufficient Balance', 402);
    await recordClawithFailure(failure, ctx());

    expect(auditMock).toHaveBeenCalledTimes(1);
    const [call] = auditMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call).toMatchObject({
      tenantId: TENANT,
      actorId: 'user-1',
      action: 'clawith.failure',
      entity: 'Agent',
      entityId: AGENT,
      requestId: 'corr-1',
      meta: {
        kind: 'payment_required',
        status: 402,
        detail: 'Insufficient Balance',
        surface: 'staff_chat',
        clawithAgentId: CLAWITH_AGENT,
        severity: 'P0',
      },
    });
  });

  it('flags payment_required AND provider_error_leaked as P0, every other kind as P2', async () => {
    // provider_error_leaked was promoted to P0 on 2026-08-13. It is the only
    // kind describing text that already reached, or came one gate away from
    // reaching, a customer: a raw `HTTP 402` body and an internal run id were
    // delivered as an agent reply on Chatwoot conv 233, msg 2784. A payment
    // failure that fails closed costs a reply; a leaked provider error costs
    // trust and cannot be recalled.
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ correlationId: 'corr-a' }));
    await recordClawithFailure(new ClawithFailure('provider_error_leaked', null), ctx({ correlationId: 'corr-b' }));
    await recordClawithFailure(new ClawithFailure('provider_unavailable', null, 503), ctx({ correlationId: 'corr-c' }));

    const severities = (auditMock.mock.calls as unknown as [{ meta: { severity: string } }][]).map(
      ([call]) => call.meta.severity,
    );
    expect(severities).toEqual(['P0', 'P0', 'P2']);
  });

  it('records the customer_dispatch surface with a null Foundation agentId, exactly as invoke.ts calls it', async () => {
    await recordClawithFailure(
      new ClawithFailure('provider_unavailable', 'boom', 503),
      ctx({ agentId: null, surface: 'customer_dispatch', actorId: 'system:clawith' }),
    );
    const [call] = auditMock.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(call.entityId).toBeUndefined();
    expect((call.meta as Record<string, unknown>).surface).toBe('customer_dispatch');
  });
});

describe('recordClawithFailure — operator alert is audit-only by default', () => {
  it('never enqueues a WhatsApp notification when no template is configured', async () => {
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: {} }));
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });

  it('never enqueues when the template env var is set but blank', async () => {
    await recordClawithFailure(
      new ClawithFailure('payment_required', null, 402),
      ctx({ env: { [CLAWITH_FAILURE_ALERT_TEMPLATE_ENV]: '   ' } }),
    );
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
  });
});

describe('recordClawithFailure — operator alert with an approved template configured', () => {
  const envWithTemplate = {
    [CLAWITH_FAILURE_ALERT_TEMPLATE_ENV]: 'clawith_failure_alert_v1',
  } as unknown as NodeJS.ProcessEnv;

  it('enqueues exactly one WhatsApp notification, keyed to the tenant owner and this correlation id', async () => {
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: envWithTemplate }));

    expect(enqueueNotificationMock).toHaveBeenCalledTimes(1);
    expect(enqueueNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        contact: '+17672958382',
        channel: 'whatsapp',
        consentBasis: 'owner_self_notification',
        template: 'clawith_failure_alert_v1',
        dedupeKey: 'clawith-failure:corr-1',
        correlationId: 'corr-1',
      }),
    );
  });

  it('never reveals provider/billing detail in the WhatsApp payload — only kind and surface', async () => {
    await recordClawithFailure(
      new ClawithFailure('payment_required', 'Insufficient Balance — HTTP 402', 402),
      ctx({ env: envWithTemplate }),
    );
    const [[params]] = enqueueNotificationMock.mock.calls as unknown as [[{ payload: Record<string, unknown> }]];
    expect(JSON.stringify(params.payload)).not.toContain('Insufficient Balance');
    expect(JSON.stringify(params.payload)).not.toContain('402');
  });

  it('a retried turn reuses the SAME dedupe key — the outbox unique constraint collapses it to one send', async () => {
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: envWithTemplate }));
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: envWithTemplate }));

    expect(enqueueNotificationMock).toHaveBeenCalledTimes(2);
    const keys = (enqueueNotificationMock.mock.calls as unknown as [{ dedupeKey: string }][]).map(
      ([p]) => p.dedupeKey,
    );
    expect(keys[0]).toBe(keys[1]);
    // The audit trail, unlike the outbox, is NOT deduplicated — every attempt
    // stays reconstructable even though only one WhatsApp send survives.
    expect(auditMock).toHaveBeenCalledTimes(2);
  });

  it('skips the WhatsApp leg silently when the tenant has no owner_phone on file', async () => {
    prismaMock.tenant.findUnique.mockResolvedValue({ owner_phone: null });
    await recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: envWithTemplate }));
    expect(enqueueNotificationMock).not.toHaveBeenCalled();
    expect(auditMock).toHaveBeenCalledTimes(1);
  });

  it('an alerting failure never propagates — the primary flow must not crash on a bad WhatsApp send', async () => {
    enqueueNotificationMock.mockRejectedValue(new Error('outbox unavailable'));
    await expect(
      recordClawithFailure(new ClawithFailure('payment_required', null, 402), ctx({ env: envWithTemplate })),
    ).resolves.toBeUndefined();
  });
});
