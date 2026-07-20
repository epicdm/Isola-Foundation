import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, auditMock, sendWhatsAppMock } = vi.hoisted(() => ({
  prismaMock: {
    notificationOutbox: {
      findMany: vi.fn(),
      updateMany: vi.fn(),
      update: vi.fn(),
    },
  },
  auditMock: vi.fn(),
  sendWhatsAppMock: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./audit', () => ({ audit: auditMock }));
vi.mock('./notify-whatsapp', () => ({ sendWhatsApp: sendWhatsAppMock }));

import { drainNotificationOutbox } from './notify-drain';

function outboxRow(overrides: Record<string, any> = {}) {
  return {
    id: 'notif-1',
    tenant_id: 'tenant-1',
    contact: '+17671234567',
    channel: 'whatsapp',
    consent_basis: 'owner_self_notification',
    template: 'isola_missed_call_alert',
    payload: { summaryLine: 'From +1767: hi' },
    dedupe_key: 'voicemail:tenant-1:msg0000',
    state: 'pending',
    attempt_count: 0,
    max_attempts: 5,
    next_attempt_at: null,
    external_ref: null,
    failure_reason: null,
    sent_at: null,
    created_at: new Date('2026-07-20T00:00:00Z'),
    updated_at: new Date('2026-07-20T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.notificationOutbox.update.mockResolvedValue({});
});

describe('drainNotificationOutbox — atomic claim', () => {
  it('skips a row when the claim updateMany loses the race (count !== 1)', async () => {
    prismaMock.notificationOutbox.findMany.mockResolvedValue([outboxRow()]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 0 });

    const result = await drainNotificationOutbox();

    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(result.claimed).toBe(0);
    expect(result.sent).toBe(0);
  });
});

describe('drainNotificationOutbox — success', () => {
  it('marks a successfully sent row as sent with an external_ref', async () => {
    const row = outboxRow();
    prismaMock.notificationOutbox.findMany.mockResolvedValue([row]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sendWhatsAppMock.mockResolvedValue({ ok: true, status: 200, externalRef: 'wamid.123' });

    const result = await drainNotificationOutbox();

    expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ state: 'sent', external_ref: 'wamid.123' }),
    });
    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(1);
  });
});

describe('drainNotificationOutbox — failure + backoff', () => {
  it('increments attempt_count and sets a future next_attempt_at on failure below max_attempts', async () => {
    const row = outboxRow({ attempt_count: 0, max_attempts: 5 });
    prismaMock.notificationOutbox.findMany.mockResolvedValue([row]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sendWhatsAppMock.mockResolvedValue({ ok: false, status: 500, error: 'boom' });

    const result = await drainNotificationOutbox();

    expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({
        state: 'failed',
        attempt_count: 1,
        failure_reason: 'boom',
        next_attempt_at: expect.any(Date),
      }),
    });
    expect(result.failed).toBe(1);
    expect(result.deadLettered).toBe(0);
  });

  it('dead-letters a row once attempt_count reaches max_attempts', async () => {
    const row = outboxRow({ attempt_count: 4, max_attempts: 5, state: 'failed' });
    prismaMock.notificationOutbox.findMany.mockResolvedValue([row]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sendWhatsAppMock.mockResolvedValue({ ok: false, status: 500, error: 'still failing' });

    const result = await drainNotificationOutbox();

    expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({
        state: 'dead_letter',
        attempt_count: 5,
        next_attempt_at: null,
      }),
    });
    expect(result.deadLettered).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('treats a thrown send error the same as an ok:false result', async () => {
    const row = outboxRow({ attempt_count: 0, max_attempts: 5 });
    prismaMock.notificationOutbox.findMany.mockResolvedValue([row]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });
    sendWhatsAppMock.mockRejectedValue(new Error('network error'));

    const result = await drainNotificationOutbox();

    expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ state: 'failed', failure_reason: 'network error' }),
    });
    expect(result.failed).toBe(1);
  });
});

describe('drainNotificationOutbox — unsupported channel', () => {
  it('fails a row with a channel other than whatsapp instead of sending', async () => {
    const row = outboxRow({ channel: 'sms' });
    prismaMock.notificationOutbox.findMany.mockResolvedValue([row]);
    prismaMock.notificationOutbox.updateMany.mockResolvedValue({ count: 1 });

    const result = await drainNotificationOutbox();

    expect(sendWhatsAppMock).not.toHaveBeenCalled();
    expect(prismaMock.notificationOutbox.update).toHaveBeenCalledWith({
      where: { id: row.id },
      data: expect.objectContaining({ state: 'failed', failure_reason: expect.stringContaining('unsupported channel') }),
    });
    expect(result.failed).toBe(1);
  });
});
