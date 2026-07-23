import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const { handleInboundWhatsAppMock } = vi.hoisted(() => ({
  handleInboundWhatsAppMock: vi.fn(),
}));

vi.mock('@/lib/agent', () => ({ handleInboundWhatsApp: handleInboundWhatsAppMock }));

import { POST } from './route';

// Port defect-foundation-must-ignore-hermes-9043-2026-07-23: Foundation and
// bff-v2 (EPIC_BFF) are both subscribed to the same WABA, so Meta delivers
// every event to both. Hermes's internal number (9043, phone_number_id
// 1029700810228517) is owned exclusively by bff-v2 -- Foundation must
// acknowledge (HTTP 200) but never invoke handleInboundWhatsApp for it.
const HERMES_9043_PHONE_NUMBER_ID = '1029700810228517';
// Representative customer-facing phone_number_id (the 6737 class of number --
// the exact digits don't matter for this test; what matters is that it is
// NOT in the ignore list and must proceed normally).
const CUSTOMER_PHONE_NUMBER_ID = '111222333444555';

function metaChange(phoneNumberId: string, waMessageId: string) {
  return {
    field: 'messages',
    value: {
      metadata: { phone_number_id: phoneNumberId, display_phone_number: '1' },
      contacts: [{ profile: { name: 'Tester' }, wa_id: '15550001111' }],
      messages: [{ id: waMessageId, from: '15550001111', type: 'text', text: { body: 'hi' } }],
    },
  };
}

function webhookRequest(entries: Array<{ id: string; changes: unknown[] }>): NextRequest {
  return new NextRequest('http://localhost/api/webhooks/whatsapp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ object: 'whatsapp_business_account', entry: entries }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  handleInboundWhatsAppMock.mockResolvedValue(undefined);
  // Dev-mode signature bypass: no app secret configured, and NODE_ENV is
  // 'test' under vitest (not 'production'), so route.ts's POST takes the
  // "trust all incoming webhooks" branch. This isolates the test to the
  // ignore-guard logic rather than HMAC signature verification, which is a
  // separate, pre-existing concern.
  vi.stubEnv('META_WA_APP_SECRET', '');
  vi.stubEnv('META_APP_SECRET', '');
  vi.stubEnv('META_TEST_APP_SECRET', '');
  vi.stubEnv('WEBHOOK_IGNORE_PHONE_IDS', HERMES_9043_PHONE_NUMBER_ID);
});

describe('POST /api/webhooks/whatsapp — per-phone-number-id ignore guard', () => {
  it('9043 (ignored phone_number_id) is acknowledged with zero downstream processing', async () => {
    const req = webhookRequest([
      { id: 'waba-1', changes: [metaChange(HERMES_9043_PHONE_NUMBER_ID, 'wamid.a')] },
    ]);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('6737 (a non-ignored, customer-facing phone_number_id) proceeds through the normal flow', async () => {
    const req = webhookRequest([
      { id: 'waba-1', changes: [metaChange(CUSTOMER_PHONE_NUMBER_ID, 'wamid.b')] },
    ]);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(handleInboundWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(handleInboundWhatsAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: CUSTOMER_PHONE_NUMBER_ID, waMessageId: 'wamid.b' }),
    );
  });

  it('a batched webhook with BOTH a 9043 change and a 6737-class change processes only the allowed one', async () => {
    const req = webhookRequest([
      {
        id: 'waba-1',
        changes: [
          metaChange(HERMES_9043_PHONE_NUMBER_ID, 'wamid.c-9043'),
          metaChange(CUSTOMER_PHONE_NUMBER_ID, 'wamid.c-6737'),
        ],
      },
    ]);
    const res = await POST(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(handleInboundWhatsAppMock).toHaveBeenCalledTimes(1);
    expect(handleInboundWhatsAppMock).toHaveBeenCalledWith(
      expect.objectContaining({ phoneNumberId: CUSTOMER_PHONE_NUMBER_ID, waMessageId: 'wamid.c-6737' }),
    );
    // Explicitly prove the 9043 event was never dispatched, not merely that
    // exactly one call happened to match the customer one.
    for (const call of handleInboundWhatsAppMock.mock.calls) {
      expect(call[0].phoneNumberId).not.toBe(HERMES_9043_PHONE_NUMBER_ID);
    }
  });

  it('9043 stays ignored even with WEBHOOK_IGNORE_PHONE_IDS unset — hardcoded floor, not env-only', async () => {
    // This exact scenario (env var unset/never wired to code) is what let
    // Foundation process 9043 the first time. The fix must not repeat that
    // failure mode: 9043 is a hardcoded floor, independent of this env var.
    vi.stubEnv('WEBHOOK_IGNORE_PHONE_IDS', '');
    const req = webhookRequest([
      { id: 'waba-1', changes: [metaChange(HERMES_9043_PHONE_NUMBER_ID, 'wamid.d')] },
    ]);
    await POST(req);
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });

  it('WEBHOOK_IGNORE_PHONE_IDS can add further ignored ids on top of the hardcoded 9043 floor', async () => {
    const EXTRA_IGNORED_ID = '999888777666555';
    vi.stubEnv('WEBHOOK_IGNORE_PHONE_IDS', `${HERMES_9043_PHONE_NUMBER_ID}, ${EXTRA_IGNORED_ID}`);
    const req = webhookRequest([
      { id: 'waba-1', changes: [metaChange(EXTRA_IGNORED_ID, 'wamid.e')] },
    ]);
    await POST(req);
    expect(handleInboundWhatsAppMock).not.toHaveBeenCalled();
  });
});
