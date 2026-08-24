/**
 * lib/voice-provisioning-consumer.ts had ZERO test coverage before this file
 * — found during the 2026-08-24 Voice-lane P3 dispatch. This is the
 * reservation-to-provisioning handoff + entitlement/promotional-credit
 * contract Portal's Personal Line signup consumes.
 *
 * `provisionVoiceLine` itself is mocked here (it has its own dedicated,
 * passing test suite in voice-provisioning.test.ts) — this file isolates and
 * proves the CONSUMER WRAPPER's own logic: identity resolution, wallet
 * creation/linking, the one-time starter-credit grant and its idempotency,
 * and the non-fatal BFF mirror.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    consumerAccount: { findUnique: vi.fn() },
    wallet: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    walletTxn: { findFirst: vi.fn(), create: vi.fn() },
    voiceLine: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const {
  getMagnusConfigMock,
  isMagnusConfiguredMock,
  getBffConfigMock,
  isBffConfiguredMock,
  addCreditMock,
  mirrorAccountMock,
  getOrCreateIdentityByPhoneMock,
  provisionVoiceLineMock,
} = vi.hoisted(() => ({
  getMagnusConfigMock: vi.fn(),
  isMagnusConfiguredMock: vi.fn(),
  getBffConfigMock: vi.fn(),
  isBffConfiguredMock: vi.fn(),
  addCreditMock: vi.fn(),
  mirrorAccountMock: vi.fn(),
  getOrCreateIdentityByPhoneMock: vi.fn(),
  provisionVoiceLineMock: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./engines', () => ({
  getMagnusConfig: getMagnusConfigMock,
  isMagnusConfigured: isMagnusConfiguredMock,
  getBffConfig: getBffConfigMock,
  isBffConfigured: isBffConfiguredMock,
}));
vi.mock('@/engines/magnus', () => ({ addCredit: addCreditMock }));
vi.mock('@/engines/bff', () => ({ mirrorAccount: mirrorAccountMock }));
vi.mock('./identity', () => ({ getOrCreateIdentityByPhone: getOrCreateIdentityByPhoneMock }));
vi.mock('./magnus-voice', () => ({ MAGNUS_REGISTRATION_SERVER: 'voice00.epic.dm' }));
vi.mock('./voice-provisioning', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-provisioning')>();
  return { ...actual, provisionVoiceLine: provisionVoiceLineMock };
});

import { provisionConsumerVoice, STARTER_FREE_EC } from './voice-provisioning-consumer';

const MAGNUS_CONFIG = { baseUrl: 'https://example.magnus', apiKey: 'k', apiSecret: 's' } as any;
const BFF_CONFIG = { baseUrl: 'https://example.bff', apiKey: 'k' } as any;

const CONSUMER = { id: 'ca-1', phone_number: '17671234567', display_name: 'Alex' };
const IDENTITY = { id: 'identity-1', phone_number: '17671234567', display_name: 'Alex' };

/** A completed VoiceLine as provisionVoiceLine would return it. */
function completedLine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'vl-1',
    provisioning_state: 'completed',
    provisioning_error: null,
    magnus_user_id: 'mu-1',
    magnus_sip_id: 'sip-1',
    magnus_sip_username: 'ema_identity1',
    magnus_sip_password: 'TEST_FIXTURE_NOT_A_REAL_SECRET',
    magnus_did_id: 'did-1',
    magnus_did_number: '17679990000',
    magnus_diddestination_id: 'dd-1',
    magnus_callerid_id: 'cid-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  isMagnusConfiguredMock.mockReturnValue(true);
  getMagnusConfigMock.mockReturnValue(MAGNUS_CONFIG);
  isBffConfiguredMock.mockReturnValue(false); // BFF mirror off by default — opted in per-test
  getBffConfigMock.mockReturnValue(BFF_CONFIG);
  prismaMock.consumerAccount.findUnique.mockResolvedValue(CONSUMER);
  getOrCreateIdentityByPhoneMock.mockResolvedValue(IDENTITY);
  prismaMock.wallet.findUnique.mockResolvedValue(null);
  prismaMock.wallet.create.mockResolvedValue({ id: 'wallet-1', consumer_account_id: 'ca-1', identity_id: 'identity-1', balance_cache: 0, balance_minor: 0, magnus_user_id: null });
  prismaMock.wallet.update.mockImplementation(async ({ where, data }: any) => ({ id: where.id, ...data }));
  prismaMock.voiceLine.findFirst.mockResolvedValue({ id: 'vl-1', owner_kind: 'consumer', identity_id: 'identity-1' });
  prismaMock.walletTxn.findFirst.mockResolvedValue(null); // no prior grant by default
  prismaMock.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  addCreditMock.mockResolvedValue({ success: true });

  // Default: provisionVoiceLine fires onMagnusUserResolved (as the real one
  // does, right after step 1) and returns a completed line.
  provisionVoiceLineMock.mockImplementation(async (_id: string, _config: unknown, params: any) => {
    if (params.onMagnusUserResolved) await params.onMagnusUserResolved('mu-1');
    return completedLine();
  });
});

describe('provisionConsumerVoice — refuses without Magnus config (fail-closed)', () => {
  it('throws immediately when Magnus is not configured, before touching any consumer/wallet state', async () => {
    isMagnusConfiguredMock.mockReturnValue(false);
    await expect(provisionConsumerVoice('ca-1')).rejects.toThrow(/Magnus not configured/);
    expect(prismaMock.consumerAccount.findUnique).not.toHaveBeenCalled();
  });

  it('throws when the ConsumerAccount does not exist', async () => {
    prismaMock.consumerAccount.findUnique.mockResolvedValue(null);
    await expect(provisionConsumerVoice('ca-missing')).rejects.toThrow(/ConsumerAccount not found/);
  });
});

describe('provisionConsumerVoice — wallet is created up front, before Magnus resolves', () => {
  it('creates a wallet linked to BOTH consumer_account_id and identity_id when none exists', async () => {
    await provisionConsumerVoice('ca-1');
    expect(prismaMock.wallet.create).toHaveBeenCalledWith({
      data: { consumer_account_id: 'ca-1', identity_id: 'identity-1', balance_cache: 0, balance_minor: 0 },
    });
  });

  it('backfills identity_id onto an existing wallet that lacks it, without creating a duplicate', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue({ id: 'wallet-existing', consumer_account_id: 'ca-1', identity_id: null, balance_cache: 5, balance_minor: 500 });
    await provisionConsumerVoice('ca-1');
    expect(prismaMock.wallet.create).not.toHaveBeenCalled();
    expect(prismaMock.wallet.update).toHaveBeenCalledWith({ where: { id: 'wallet-existing' }, data: { identity_id: 'identity-1' } });
  });

  it('CONTROL: a wallet that already has identity_id linked never gets an identity_id write (it may still be updated later for the starter-grant balance increment, which is a separate concern)', async () => {
    prismaMock.wallet.findUnique.mockResolvedValue({ id: 'wallet-linked', consumer_account_id: 'ca-1', identity_id: 'identity-1', balance_cache: 5, balance_minor: 500, magnus_user_id: 'mu-already-linked' });
    await provisionConsumerVoice('ca-1');
    expect(prismaMock.wallet.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ identity_id: expect.anything() }) }),
    );
  });
});

describe('provisionConsumerVoice — the starter-credit entitlement grant', () => {
  it('applies the starter grant exactly once for a fresh identity: calls Magnus addCredit, writes a WalletTxn, and increments the wallet balance', async () => {
    const result = await provisionConsumerVoice('ca-1');

    expect(addCreditMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'mu-1', STARTER_FREE_EC, expect.stringContaining('starter grant'));
    expect(prismaMock.walletTxn.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          identity_id: 'identity-1',
          type: 'starter_grant',
          amount_usd: STARTER_FREE_EC,
          idempotency_key: 'starter_grant:identity-1',
        }),
      }),
    );
    expect(prismaMock.wallet.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'wallet-1' },
        data: expect.objectContaining({
          balance_cache: { increment: STARTER_FREE_EC },
          balance_minor: { increment: Math.round(STARTER_FREE_EC * 100) },
        }),
      }),
    );
    expect(result.state).toBe('completed');
  });

  it('IDEMPOTENCY: when a starter_grant WalletTxn already exists for this identity, the grant is NOT re-applied — no second Magnus credit call, no second WalletTxn', async () => {
    prismaMock.walletTxn.findFirst.mockResolvedValue({ id: 'txn-existing', identity_id: 'identity-1', type: 'starter_grant' });

    await provisionConsumerVoice('ca-1');

    expect(addCreditMock).not.toHaveBeenCalled();
    expect(prismaMock.walletTxn.create).not.toHaveBeenCalled();
  });

  it('NON-FATAL FAILURE: if the Magnus credit call fails, no WalletTxn is written and provisioning still completes (a promo failure must never block a working SIP/DID line)', async () => {
    addCreditMock.mockResolvedValue({ success: false, error: 'Magnus refill endpoint unavailable' });

    const result = await provisionConsumerVoice('ca-1');

    expect(prismaMock.walletTxn.create).not.toHaveBeenCalled();
    expect(result.state).toBe('completed'); // provisionVoiceLine's own mocked result is unaffected by the grant failing
  });
});

describe('provisionConsumerVoice — BFF mirror, non-fatal', () => {
  it('mirrors the finished account into BFF when configured and provisioning completed with full SIP/DID data', async () => {
    isBffConfiguredMock.mockReturnValue(true);
    mirrorAccountMock.mockResolvedValue({ ok: true, created: true });

    await provisionConsumerVoice('ca-1');

    expect(mirrorAccountMock).toHaveBeenCalledWith(BFF_CONFIG, {
      magnusUserId: 'mu-1',
      sipUsername: 'ema_identity1',
      sipPassword: 'TEST_FIXTURE_NOT_A_REAL_SECRET',
      did: '17679990000',
      ownerPhone: '17671234567',
    });
  });

  it('CONTROL: never attempts a mirror when BFF is not configured', async () => {
    isBffConfiguredMock.mockReturnValue(false);
    await provisionConsumerVoice('ca-1');
    expect(mirrorAccountMock).not.toHaveBeenCalled();
  });

  it('CONTROL: never attempts a mirror when provisioning did not complete (e.g. failed line)', async () => {
    isBffConfiguredMock.mockReturnValue(true);
    provisionVoiceLineMock.mockResolvedValue(completedLine({ provisioning_state: 'failed', provisioning_error: 'SIP create failed' }));

    await provisionConsumerVoice('ca-1');

    expect(mirrorAccountMock).not.toHaveBeenCalled();
  });

  it('NON-FATAL: a BFF mirror failure (rejected promise) does not throw out of provisionConsumerVoice', async () => {
    isBffConfiguredMock.mockReturnValue(true);
    mirrorAccountMock.mockRejectedValue(new Error('BFF unreachable'));

    await expect(provisionConsumerVoice('ca-1')).resolves.toMatchObject({ state: 'completed' });
  });
});

describe('provisionConsumerVoice — result shape includes the registration server (independent of Cloud Softphone/Acrobits)', () => {
  it('the returned result carries registration_server and the SIP password for the softphone client — never an Acrobits/csc: URI of any kind', async () => {
    const result = await provisionConsumerVoice('ca-1');
    expect(result.registration_server).toBe('voice00.epic.dm');
    expect(result.magnus_sip_password).toBe('TEST_FIXTURE_NOT_A_REAL_SECRET');
    expect(JSON.stringify(result)).not.toContain('csc:');
  });
});
