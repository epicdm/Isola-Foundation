/**
 * lib/voice-provisioning.ts had ZERO test coverage before this file — found
 * during the 2026-08-24 Voice-lane P3 dispatch while proving out the
 * Magnus number/seat provisioning, entitlement/credit, route-assignment and
 * failure/recovery contract that Portal's `_resolve_voice_seat` consumes.
 *
 * Covers: fresh provisioning, resume-from-partial-state, idempotent re-run,
 * fail-closed failure capture (never throws), recovery after failure, and
 * extension-first vs cell-forward route reconciliation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { VoiceLine } from '@prisma/client';

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    voiceLine: {
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
    },
  },
}));

const {
  createMagnusUserMock,
  createSipAccountMock,
  readSipAccountMock,
  patchSipCallerIdMock,
  createCallerIdMock,
  drawAvailableDidMock,
  claimDidMock,
  createDidDestinationToSipMock,
  findDidByNumberMock,
  findDidDestinationForSipMock,
  findCallerIdByCidMock,
  readUserPrefixLocalMock,
  patchUserPrefixLocalMock,
  readDidDestinationMock,
  setDidDestinationRouteMock,
  enforceSipSecretMock,
} = vi.hoisted(() => ({
  createMagnusUserMock: vi.fn(),
  createSipAccountMock: vi.fn(),
  readSipAccountMock: vi.fn(),
  patchSipCallerIdMock: vi.fn(),
  createCallerIdMock: vi.fn(),
  drawAvailableDidMock: vi.fn(),
  claimDidMock: vi.fn(),
  createDidDestinationToSipMock: vi.fn(),
  findDidByNumberMock: vi.fn(),
  findDidDestinationForSipMock: vi.fn(),
  findCallerIdByCidMock: vi.fn(),
  readUserPrefixLocalMock: vi.fn(),
  patchUserPrefixLocalMock: vi.fn(),
  readDidDestinationMock: vi.fn(),
  setDidDestinationRouteMock: vi.fn(),
  enforceSipSecretMock: vi.fn(),
}));

vi.mock('./prisma', () => ({ prisma: prismaMock }));
vi.mock('./magnus-voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./magnus-voice')>();
  return {
    ...actual,
    createMagnusUser: createMagnusUserMock,
    createSipAccount: createSipAccountMock,
    readSipAccount: readSipAccountMock,
    patchSipCallerId: patchSipCallerIdMock,
    createCallerId: createCallerIdMock,
    drawAvailableDid: drawAvailableDidMock,
    claimDid: claimDidMock,
    createDidDestinationToSip: createDidDestinationToSipMock,
    findDidByNumber: findDidByNumberMock,
    findDidDestinationForSip: findDidDestinationForSipMock,
    findCallerIdByCid: findCallerIdByCidMock,
    readUserPrefixLocal: readUserPrefixLocalMock,
    patchUserPrefixLocal: patchUserPrefixLocalMock,
    readDidDestination: readDidDestinationMock,
    setDidDestinationRoute: setDidDestinationRouteMock,
    enforceSipSecret: enforceSipSecretMock,
  };
});

import { provisionVoiceLine } from './voice-provisioning';

const MAGNUS_CONFIG = { baseUrl: 'https://example.magnus', apiKey: 'k', apiSecret: 's' } as any;

function line(overrides: Partial<VoiceLine> = {}): VoiceLine {
  return {
    id: 'vl-1',
    owner_kind: 'business',
    tenant_id: 'tenant-1',
    identity_id: null,
    magnus_user_id: null,
    magnus_sip_id: null,
    magnus_sip_username: null,
    magnus_sip_password: null,
    magnus_callerid_id: null,
    magnus_did_id: null,
    magnus_did_number: null,
    magnus_diddestination_id: null,
    voice_forward_to_cell: false,
    voice_cell_number: null,
    provisioning_state: 'pending',
    provisioning_error: null,
    ...overrides,
  } as VoiceLine;
}

/** Makes prisma.voiceLine.update() persist onto a mutable in-memory row and echo it back — mirrors real prisma semantics closely enough for this state machine. */
function wireVoiceLinePersistence(initial: VoiceLine) {
  let current = { ...initial };
  prismaMock.voiceLine.findUniqueOrThrow.mockResolvedValue(current);
  prismaMock.voiceLine.update.mockImplementation(async ({ data }: { data: Partial<VoiceLine> }) => {
    current = { ...current, ...data };
    return current;
  });
  return () => current;
}

beforeEach(() => {
  vi.clearAllMocks();
  readUserPrefixLocalMock.mockResolvedValue('*/1767/7,767/1767/10'); // already correct — no patch needed by default
  readDidDestinationMock.mockResolvedValue(null); // no reconciliation unless a test wires one in
});

describe('provisionVoiceLine — fresh provisioning, all four steps', () => {
  it('creates Magnus user, SIP account, draws/claims/routes a DID, and creates a caller-ID', async () => {
    const getCurrent = wireVoiceLinePersistence(line());
    createMagnusUserMock.mockResolvedValue('mu-1');
    createSipAccountMock.mockResolvedValue('sip-1');
    readSipAccountMock.mockResolvedValue(null); // sip just created this run — nothing live to read yet on the branch that checks !sipId, so this only matters for step 3's liveSip re-read
    drawAvailableDidMock.mockResolvedValue({ id: 'did-1', did: '17671234567' });
    claimDidMock.mockResolvedValue('17671234567');
    createDidDestinationToSipMock.mockResolvedValue('dd-1');
    findCallerIdByCidMock.mockResolvedValue(null);
    createCallerIdMock.mockResolvedValue('cid-1');

    const result = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'ISOLA_TENANT_PBX:Acme',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(createMagnusUserMock).toHaveBeenCalledTimes(1);
    expect(createSipAccountMock).toHaveBeenCalledTimes(1);
    expect(drawAvailableDidMock).toHaveBeenCalledTimes(1);
    expect(claimDidMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'did-1', 'mu-1');
    expect(createDidDestinationToSipMock).toHaveBeenCalledTimes(1);
    expect(patchSipCallerIdMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'sip-1', '17671234567');
    expect(createCallerIdMock).toHaveBeenCalledWith(MAGNUS_CONFIG, { id_user: 'mu-1', cid: '17671234567' });

    expect(result.provisioning_state).toBe('completed');
    expect(result.provisioning_error).toBeNull();
    expect(result.magnus_did_number).toBe('17671234567');
    expect(getCurrent().provisioning_state).toBe('completed');
  });

  it('CONTROL: a genuinely-fresh line never calls claimDid on an existing DID id — proves the draw/claim path is exercised, not skipped by a broken mock', async () => {
    wireVoiceLinePersistence(line());
    createMagnusUserMock.mockResolvedValue('mu-1');
    createSipAccountMock.mockResolvedValue('sip-1');
    readSipAccountMock.mockResolvedValue(null);
    drawAvailableDidMock.mockResolvedValue({ id: 'did-fresh', did: '17679990000' });
    claimDidMock.mockResolvedValue('17679990000');
    createDidDestinationToSipMock.mockResolvedValue('dd-fresh');
    findCallerIdByCidMock.mockResolvedValue(null);
    createCallerIdMock.mockResolvedValue('cid-fresh');

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(claimDidMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'did-fresh', 'mu-1');
  });
});

describe('provisionVoiceLine — resume from partial state', () => {
  it('a line with magnus_user_id already set does NOT re-create the Magnus user', async () => {
    wireVoiceLinePersistence(
      line({ magnus_user_id: 'mu-existing', provisioning_state: 'failed', provisioning_error: 'SIP account create timed out' }),
    );
    createSipAccountMock.mockResolvedValue('sip-2');
    readSipAccountMock.mockResolvedValue(null);
    drawAvailableDidMock.mockResolvedValue({ id: 'did-2', did: '17671110000' });
    claimDidMock.mockResolvedValue('17671110000');
    createDidDestinationToSipMock.mockResolvedValue('dd-2');
    findCallerIdByCidMock.mockResolvedValue(null);
    createCallerIdMock.mockResolvedValue('cid-2');

    const result = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(createMagnusUserMock).not.toHaveBeenCalled();
    expect(createSipAccountMock).toHaveBeenCalledTimes(1);
    expect(result.provisioning_state).toBe('completed');
  });

  it('a fully-provisioned line resyncs the live SIP username/secret but draws no new DID and creates no duplicate caller-ID', async () => {
    const complete = line({
      magnus_user_id: 'mu-1',
      magnus_sip_id: 'sip-1',
      magnus_sip_username: 'ep_tenant1',
      magnus_sip_password: 'existing-secret',
      magnus_did_id: 'did-1',
      magnus_did_number: '17671234567',
      magnus_diddestination_id: 'dd-1',
      magnus_callerid_id: 'cid-1',
      provisioning_state: 'completed',
    });
    wireVoiceLinePersistence(complete);
    readSipAccountMock.mockResolvedValue({
      id: 'sip-1', name: 'ep_tenant1', secret: 'existing-secret',
      callerid: '17671234567', cid_number: '17671234567', dial_timeout: '25', forward: '',
    });
    findCallerIdByCidMock.mockResolvedValue({ id: 'cid-1', cid: '17671234567' });

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(drawAvailableDidMock).not.toHaveBeenCalled();
    expect(createDidDestinationToSipMock).not.toHaveBeenCalled();
    expect(createCallerIdMock).not.toHaveBeenCalled();
    expect(enforceSipSecretMock).not.toHaveBeenCalled(); // live secret already matches — no forced write
  });

  it('DRIFT CONTROL: when Magnus\'s live secret has drifted from the locally-stored one, the local value wins and Magnus is forced back into line', async () => {
    wireVoiceLinePersistence(
      line({
        magnus_user_id: 'mu-1', magnus_sip_id: 'sip-1', magnus_sip_username: 'ep_tenant1',
        magnus_sip_password: 'local-secret', magnus_did_id: 'did-1', magnus_did_number: '17671234567',
        magnus_diddestination_id: 'dd-1', magnus_callerid_id: 'cid-1', provisioning_state: 'completed',
      }),
    );
    readSipAccountMock.mockResolvedValue({
      id: 'sip-1', name: 'ep_tenant1', secret: 'DRIFTED-secret',
      callerid: '17671234567', cid_number: '17671234567', dial_timeout: '25', forward: '',
    });
    findCallerIdByCidMock.mockResolvedValue({ id: 'cid-1', cid: '17671234567' });

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(enforceSipSecretMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'sip-1', 'local-secret');
  });
});

describe('provisionVoiceLine — failure and recovery, fail-closed contract', () => {
  it('an upstream error is captured as provisioning_state=failed and the error message is stored — the function NEVER throws', async () => {
    wireVoiceLinePersistence(line());
    createMagnusUserMock.mockResolvedValue('mu-1');
    createSipAccountMock.mockRejectedValue(new Error('Magnus SIP create timed out'));

    const result = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(result.provisioning_state).toBe('failed');
    expect(result.provisioning_error).toBe('Magnus SIP create timed out');
  });

  it('CONTROL: the same failure path, with a rejection that has no .message, still fails closed rather than throwing "undefined"', async () => {
    wireVoiceLinePersistence(line());
    createMagnusUserMock.mockRejectedValue('a bare string rejection');

    const result = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(result.provisioning_state).toBe('failed');
    expect(result.provisioning_error).toBe('a bare string rejection');
  });

  it('RECOVERY: a second call after a failure resumes past the already-persisted magnus_user_id rather than re-creating it', async () => {
    // First run: user created, SIP create fails.
    const getCurrent = wireVoiceLinePersistence(line());
    createMagnusUserMock.mockResolvedValue('mu-recovered');
    createSipAccountMock.mockRejectedValueOnce(new Error('transient SIP failure'));

    const firstAttempt = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });
    expect(firstAttempt.provisioning_state).toBe('failed');
    expect(getCurrent().magnus_user_id).toBe('mu-recovered'); // persisted despite the later failure

    // Second run: SIP create now succeeds. The already-persisted user id must
    // be reused, not re-created — proves resume, not restart-from-scratch.
    createSipAccountMock.mockResolvedValue('sip-recovered');
    readSipAccountMock.mockResolvedValue(null);
    drawAvailableDidMock.mockResolvedValue({ id: 'did-r', did: '17672220000' });
    claimDidMock.mockResolvedValue('17672220000');
    createDidDestinationToSipMock.mockResolvedValue('dd-r');
    findCallerIdByCidMock.mockResolvedValue(null);
    createCallerIdMock.mockResolvedValue('cid-r');

    const secondAttempt = await provisionVoiceLine('vl-1', MAGNUS_CONFIG, {
      description: 'x',
      usernameSeed: 'tenant-1',
      usernamePrefix: 'ep_',
    });

    expect(createMagnusUserMock).toHaveBeenCalledTimes(1); // still only once, across BOTH attempts
    expect(secondAttempt.provisioning_state).toBe('completed');
    expect(secondAttempt.magnus_user_id).toBe('mu-recovered');
  });
});

describe('provisionVoiceLine — route assignment reconciliation (Step 3b)', () => {
  const provisionedLine = (overrides: Partial<VoiceLine> = {}) =>
    line({
      magnus_user_id: 'mu-1', magnus_sip_id: 'sip-1', magnus_sip_username: 'ep_tenant1',
      magnus_sip_password: 'TEST_FIXTURE_NOT_A_REAL_SECRET', magnus_did_id: 'did-1', magnus_did_number: '17671234567',
      magnus_diddestination_id: 'dd-1', magnus_callerid_id: 'cid-1', provisioning_state: 'completed',
      ...overrides,
    });

  beforeEach(() => {
    readSipAccountMock.mockResolvedValue({
      id: 'sip-1', name: 'ep_tenant1', secret: 'TEST_FIXTURE_NOT_A_REAL_SECRET',
      callerid: '17671234567', cid_number: '17671234567', dial_timeout: '25', forward: '',
    });
    findCallerIdByCidMock.mockResolvedValue({ id: 'cid-1', cid: '17671234567' });
  });

  it('EXTENSION-FIRST DEFAULT: when Magnus is wrongly routed to PSTN and no cell-forward is opted in, reconciliation forces it back to sip', async () => {
    wireVoiceLinePersistence(provisionedLine());
    readDidDestinationMock.mockResolvedValue({ id: 'dd-1', destination: '17679998888', context: 'x', voip_call: '0', id_sip: 'sip-1' });

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, { description: 'x', usernameSeed: 'tenant-1', usernamePrefix: 'ep_' });

    expect(setDidDestinationRouteMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'dd-1', { mode: 'sip' });
  });

  it('CELL-FORWARD OPT-IN: when the owner has opted into cell forwarding but Magnus still rings the SIP extension, reconciliation switches it to cell', async () => {
    wireVoiceLinePersistence(provisionedLine({ voice_forward_to_cell: true, voice_cell_number: '17679991111' }));
    readDidDestinationMock.mockResolvedValue({ id: 'dd-1', destination: '', context: 'x', voip_call: '1', id_sip: 'sip-1' });

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, { description: 'x', usernameSeed: 'tenant-1', usernamePrefix: 'ep_' });

    expect(setDidDestinationRouteMock).toHaveBeenCalledWith(MAGNUS_CONFIG, 'dd-1', { mode: 'cell', cellNumber: '17679991111' });
  });

  it('CONTROL: when the live route already matches the desired mode, reconciliation issues no write at all', async () => {
    wireVoiceLinePersistence(provisionedLine());
    readDidDestinationMock.mockResolvedValue({ id: 'dd-1', destination: '', context: 'x', voip_call: '1', id_sip: 'sip-1' });

    await provisionVoiceLine('vl-1', MAGNUS_CONFIG, { description: 'x', usernameSeed: 'tenant-1', usernamePrefix: 'ep_' });

    expect(setDidDestinationRouteMock).not.toHaveBeenCalled();
  });
});
