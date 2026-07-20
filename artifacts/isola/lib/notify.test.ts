import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, auditMock } = vi.hoisted(() => ({
  prismaMock: {
    consent: {
      findUnique: vi.fn(),
    },
    notificationOutbox: {
      create: vi.fn(),
    },
  },
  auditMock: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./audit', () => ({ audit: auditMock }));

import { enqueueNotification } from './notify';

function p2002Error(): any {
  const err: any = new Error('Unique constraint failed');
  err.code = 'P2002';
  return err;
}

const BASE_PARAMS = {
  tenantId: 'tenant-1',
  contact: '+17671234567',
  channel: 'whatsapp',
  template: 'isola_missed_call_alert',
  payload: { summaryLine: 'From +1767: hi' },
  dedupeKey: 'voicemail:tenant-1:msg0000',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('enqueueNotification — consent gate', () => {
  it('enqueues without a Consent row when consentBasis is owner_self_notification', async () => {
    prismaMock.notificationOutbox.create.mockResolvedValue({ id: 'notif-1' });

    const result = await enqueueNotification({ ...BASE_PARAMS, consentBasis: 'owner_self_notification' });

    expect(prismaMock.consent.findUnique).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: true, id: 'notif-1' });
  });

  it('refuses a customer-basis notification when no Consent row exists', async () => {
    prismaMock.consent.findUnique.mockResolvedValue(null);

    const result = await enqueueNotification({ ...BASE_PARAMS, consentBasis: 'customer_marketing' });

    expect(prismaMock.notificationOutbox.create).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: false, reason: 'consent_denied' });
  });

  it('refuses a customer-basis notification when Consent status is opted_out', async () => {
    prismaMock.consent.findUnique.mockResolvedValue({ status: 'opted_out' });

    const result = await enqueueNotification({ ...BASE_PARAMS, consentBasis: 'customer_marketing' });

    expect(prismaMock.notificationOutbox.create).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: false, reason: 'consent_denied' });
  });

  it('enqueues a customer-basis notification when Consent status is opted_in', async () => {
    prismaMock.consent.findUnique.mockResolvedValue({ status: 'opted_in' });
    prismaMock.notificationOutbox.create.mockResolvedValue({ id: 'notif-2' });

    const result = await enqueueNotification({ ...BASE_PARAMS, consentBasis: 'customer_marketing' });

    expect(prismaMock.notificationOutbox.create).toHaveBeenCalled();
    expect(result).toEqual({ enqueued: true, id: 'notif-2' });
  });
});

describe('enqueueNotification — idempotent dedupe', () => {
  it('reports a duplicate (no double-enqueue) when dedupeKey already exists', async () => {
    prismaMock.notificationOutbox.create.mockRejectedValue(p2002Error());

    const result = await enqueueNotification({ ...BASE_PARAMS, consentBasis: 'owner_self_notification' });

    expect(result).toEqual({ enqueued: false, reason: 'duplicate' });
  });

  it('re-throws unexpected errors instead of swallowing them', async () => {
    prismaMock.notificationOutbox.create.mockRejectedValue(new Error('db is down'));

    await expect(
      enqueueNotification({ ...BASE_PARAMS, consentBasis: 'owner_self_notification' }),
    ).rejects.toThrow('db is down');
  });
});
