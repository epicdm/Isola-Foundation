import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  getMagnusConfigMock,
  getVoiceRoutingRingTimeoutSecondsMock,
  readVoiceRoutingSnapshotMock,
  planRouteMutationMock,
  applyRouteMutationMock,
  planRestoreMutationMock,
  applyRestoreMutationMock,
  deriveVoiceRoutingModeMock,
} = vi.hoisted(() => ({
  getMagnusConfigMock: vi.fn(),
  getVoiceRoutingRingTimeoutSecondsMock: vi.fn(),
  readVoiceRoutingSnapshotMock: vi.fn(),
  planRouteMutationMock: vi.fn(),
  applyRouteMutationMock: vi.fn(),
  planRestoreMutationMock: vi.fn(),
  applyRestoreMutationMock: vi.fn(),
  deriveVoiceRoutingModeMock: vi.fn(),
}));

vi.mock('./engines', () => ({
  getMagnusConfig: getMagnusConfigMock,
  getVoiceRoutingRingTimeoutSeconds: getVoiceRoutingRingTimeoutSecondsMock,
}));

vi.mock('./voice-routing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./voice-routing')>();
  return {
    ...actual,
    readVoiceRoutingSnapshot: readVoiceRoutingSnapshotMock,
    planRouteMutation: planRouteMutationMock,
    applyRouteMutation: applyRouteMutationMock,
    planRestoreMutation: planRestoreMutationMock,
    applyRestoreMutation: applyRestoreMutationMock,
    deriveVoiceRoutingMode: deriveVoiceRoutingModeMock,
  };
});

import { voiceRoutingSet, VoiceRoutingConnectorError } from './voice-routing-connector';

const TENANT = { tenantId: 'tenant-1' };
const MAGNUS_CONFIG = { baseUrl: 'https://example.magnus', apiKey: 'k', apiSecret: 's' } as any;

function snapshot(tag: string) {
  return { tag } as any;
}

function state(mode: string, snapshotTag: string) {
  return { mode, forwardToCellNumber: null, snapshot: snapshot(snapshotTag) } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getMagnusConfigMock.mockReturnValue(MAGNUS_CONFIG);
  getVoiceRoutingRingTimeoutSecondsMock.mockReturnValue(null);
  planRestoreMutationMock.mockReturnValue({ diddestinationWrite: null, dialTimeoutWrite: null });
});

// ── Corrective patch: bounded compensating rollback (Section 1) ─────────────

describe('voiceRoutingSet — success path', () => {
  it('reports success and never attempts a rollback when the after-state matches the requested mode', async () => {
    readVoiceRoutingSnapshotMock.mockResolvedValueOnce(snapshot('before')).mockResolvedValueOnce(snapshot('after'));
    deriveVoiceRoutingModeMock.mockReturnValueOnce(state('app', 'before')).mockReturnValueOnce(state('app_then_cell', 'after'));
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: null, dialTimeoutWrite: null, forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('success');
    expect(result.verified).toBe(true);
    expect(result.rollbackAttempted).toBe(false);
    expect(result.rollbackVerified).toBeNull();
    expect(applyRestoreMutationMock).not.toHaveBeenCalled();
    expect(readVoiceRoutingSnapshotMock).toHaveBeenCalledTimes(2);
  });
});

describe('voiceRoutingSet — rollback succeeds (mutation applies but verification mismatches)', () => {
  it('applies the mutation, detects the after-state mismatch, restores exactly the captured before-state, and returns unverified_rolled_back', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockResolvedValueOnce(snapshot('after-mismatch'))
      .mockResolvedValueOnce(snapshot('rollback-verify'));
    deriveVoiceRoutingModeMock
      .mockReturnValueOnce(state('app', 'before'))
      .mockReturnValueOnce(state('app', 'after-mismatch')) // write "succeeded" but mode did not change
      .mockReturnValueOnce(state('app', 'rollback-verify')); // rollback confirmed restoring 'app'
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockResolvedValue(undefined);
    const restorePlan = { diddestinationWrite: {}, dialTimeoutWrite: null };
    planRestoreMutationMock.mockReturnValue(restorePlan);
    applyRestoreMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('unverified_rolled_back');
    expect(result.verified).toBe(false);
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(applyRestoreMutationMock).toHaveBeenCalledTimes(1);
    expect(applyRestoreMutationMock).toHaveBeenCalledWith(MAGNUS_CONFIG, snapshot('before'), restorePlan);
    // Never recurses through voiceRoutingSet / repeats the requested mutation.
    expect(applyRouteMutationMock).toHaveBeenCalledTimes(1);
    expect(planRouteMutationMock).toHaveBeenCalledTimes(1);
    expect(result.after.mode).toBe('app');
  });
});

describe('voiceRoutingSet — ambiguous connector exception (write throws after being attempted)', () => {
  it('treats a throwing write as potentially-changed state, attempts rollback, and verifies final state as mutation_failed_rolled_back', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockResolvedValueOnce(snapshot('after-read')) // after-read still succeeds even though the write threw
      .mockResolvedValueOnce(snapshot('rollback-verify'));
    deriveVoiceRoutingModeMock
      .mockReturnValueOnce(state('app', 'before'))
      .mockReturnValueOnce(state('unknown', 'after-read'))
      .mockReturnValueOnce(state('app', 'rollback-verify'));
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockRejectedValue(new Error('ambiguous network failure mid-write'));
    applyRestoreMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('mutation_failed_rolled_back');
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(true);
    expect(applyRestoreMutationMock).toHaveBeenCalledTimes(1);
    // Exactly one rollback attempt — no repeat of the requested mutation, no retry loop.
    expect(applyRouteMutationMock).toHaveBeenCalledTimes(1);
  });

  it('still attempts and verifies a rollback when the write throws AND the after-read also fails', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockRejectedValueOnce(new Error('after-read network timeout'))
      .mockResolvedValueOnce(snapshot('rollback-verify'));
    deriveVoiceRoutingModeMock.mockReturnValueOnce(state('app', 'before')).mockReturnValueOnce(state('app', 'rollback-verify'));
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockRejectedValue(new Error('ambiguous network failure mid-write'));
    applyRestoreMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('mutation_failed_rolled_back');
    expect(result.rollbackVerified).toBe(true);
    expect(applyRestoreMutationMock).toHaveBeenCalledTimes(1);
  });
});

describe('voiceRoutingSet — rollback fails (critical degraded)', () => {
  it('reports critical_degraded when the restore write itself throws', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockResolvedValueOnce(snapshot('after-mismatch'))
      .mockResolvedValueOnce(snapshot('rollback-verify-attempt'));
    deriveVoiceRoutingModeMock
      .mockReturnValueOnce(state('app', 'before'))
      .mockReturnValueOnce(state('app', 'after-mismatch'))
      .mockReturnValueOnce(state('degraded', 'rollback-verify-attempt'));
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockResolvedValue(undefined);
    applyRestoreMutationMock.mockRejectedValue(new Error('restore write failed'));

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('critical_degraded');
    expect(result.rollbackAttempted).toBe(true);
    expect(result.rollbackVerified).toBe(false);
    expect(result.verified).toBe(false);
    // Never reports a false success no matter what.
    expect(result.outcome).not.toBe('success');
  });

  it('reports critical_degraded when the restore write succeeds but the verification read does not match the before-mode', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockResolvedValueOnce(snapshot('after-mismatch'))
      .mockResolvedValueOnce(snapshot('rollback-verify-mismatch'));
    deriveVoiceRoutingModeMock
      .mockReturnValueOnce(state('app', 'before'))
      .mockReturnValueOnce(state('app', 'after-mismatch'))
      .mockReturnValueOnce(state('degraded', 'rollback-verify-mismatch')); // restore write "succeeded" but resulting mode isn't 'app'
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockResolvedValue(undefined);
    applyRestoreMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('critical_degraded');
    expect(result.rollbackVerified).toBe(false);
  });

  it('reports critical_degraded when the restore write succeeds but the verification read itself fails', async () => {
    readVoiceRoutingSnapshotMock
      .mockResolvedValueOnce(snapshot('before'))
      .mockResolvedValueOnce(snapshot('after-mismatch'))
      .mockRejectedValueOnce(new Error('rollback verify read failed'));
    deriveVoiceRoutingModeMock.mockReturnValueOnce(state('app', 'before')).mockReturnValueOnce(state('app', 'after-mismatch'));
    planRouteMutationMock.mockReturnValue({ targetMode: 'app_then_cell', diddestinationWrite: {}, dialTimeoutWrite: '30', forwardToCellNumber: '9715551234' });
    applyRouteMutationMock.mockResolvedValue(undefined);
    applyRestoreMutationMock.mockResolvedValue(undefined);

    const result = await voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' });

    expect(result.outcome).toBe('critical_degraded');
    expect(result.rollbackVerified).toBe(false);
  });
});

describe('voiceRoutingSet — pre-mutation fail-closed paths (no rollback needed, zero writes)', () => {
  it('throws VoiceRoutingConnectorError and never writes when the before-state read fails', async () => {
    readVoiceRoutingSnapshotMock.mockRejectedValueOnce(new Error('Magnus network timeout'));

    await expect(
      voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' }),
    ).rejects.toBeInstanceOf(VoiceRoutingConnectorError);
    expect(applyRouteMutationMock).not.toHaveBeenCalled();
    expect(applyRestoreMutationMock).not.toHaveBeenCalled();
  });

  it('throws VoiceRoutingConnectorError and never writes when planning refuses (e.g. conflicting destination rows)', async () => {
    readVoiceRoutingSnapshotMock.mockResolvedValueOnce(snapshot('before'));
    deriveVoiceRoutingModeMock.mockReturnValueOnce(state('degraded', 'before'));
    planRouteMutationMock.mockImplementation(() => {
      throw new Error('cannot plan a route mutation: conflicting_did_destinations — 2 diddestination rows exist for this DID');
    });

    await expect(
      voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app_then_cell', forwardNumber: '9715551234' }),
    ).rejects.toThrow(/conflicting_did_destinations/);
    expect(applyRouteMutationMock).not.toHaveBeenCalled();
    expect(applyRestoreMutationMock).not.toHaveBeenCalled();
  });

  it('throws VoiceRoutingConnectorError and never writes when planning refuses due to a missing safe ring timeout', async () => {
    readVoiceRoutingSnapshotMock.mockResolvedValueOnce(snapshot('before'));
    deriveVoiceRoutingModeMock.mockReturnValueOnce(state('cell', 'before'));
    planRouteMutationMock.mockImplementation(() => {
      throw new Error('cannot plan a route mutation: no existing valid dial_timeout is present for this DID, and VOICE_ROUTING_RING_TIMEOUT_SECONDS is not configured');
    });

    await expect(
      voiceRoutingSet(TENANT, { didId: 'did-1', did: '17678185000', targetMode: 'app', forwardNumber: undefined }),
    ).rejects.toThrow(/refusing to guess a ring timeout|not configured/);
    expect(applyRouteMutationMock).not.toHaveBeenCalled();
  });
});
