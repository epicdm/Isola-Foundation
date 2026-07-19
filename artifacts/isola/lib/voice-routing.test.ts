import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  deriveVoiceRoutingMode,
  readVoiceRoutingSnapshot,
  planRouteMutation,
  planRestoreMutation,
  validateForwardTarget,
  normalizeForwardNumber,
  isValidRingTimeoutSeconds,
  formatSipForward,
  CELL_ONLY_DIAL_TIMEOUT_SENTINEL,
  type VoiceRoutingSnapshot,
} from './voice-routing';
import { ConflictingDidDestinationsError } from './magnus-voice';

const { findDidDestinationForDidMock } = vi.hoisted(() => ({ findDidDestinationForDidMock: vi.fn() }));

vi.mock('./magnus-voice', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./magnus-voice')>();
  return { ...actual, findDidDestinationForDid: findDidDestinationForDidMock };
});

const MAGNUS_CONFIG = { baseUrl: 'https://example.magnus', apiKey: 'k', apiSecret: 's' } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

function snap(overrides: Partial<VoiceRoutingSnapshot> = {}): VoiceRoutingSnapshot {
  return {
    did: '17678185000',
    didId: 'did-1',
    diddestinationId: 'dd-1',
    destination: '',
    voipCall: '1',
    sipId: 'sip-1',
    dialTimeout: '25',
    sipForward: null,
    ...overrides,
  };
}

// ── Section 10: state derivation ────────────────────────────────────────────

describe('deriveVoiceRoutingMode — state derivation', () => {
  it('SIP-only (no forward, voip_call=1, sane timeout) -> app', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '', voipCall: '1', dialTimeout: '25' }));
    expect(result.mode).toBe('app');
    expect(result.forwardToCellNumber).toBeNull();
  });

  it('SIP + forward + normal timeout + matching sip.forward -> app_then_cell', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715551234') }),
    );
    expect(result.mode).toBe('app_then_cell');
    expect(result.forwardToCellNumber).toBe('9715551234');
  });

  it("SIP + forward + dial_timeout='1' + matching sip.forward -> cell", () => {
    const result = deriveVoiceRoutingMode(
      snap({
        destination: '9715551234',
        voipCall: '1',
        dialTimeout: CELL_ONLY_DIAL_TIMEOUT_SENTINEL,
        sipForward: formatSipForward('9715551234'),
      }),
    );
    expect(result.mode).toBe('cell');
    expect(result.forwardToCellNumber).toBe('9715551234');
  });

  it('diddestination forward target present but sip.forward unset -> degraded (the S5 non-forwarding defect)', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: '' }),
    );
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/sip\.forward/i);
    expect(result.forwardToCellNumber).toBe('9715551234');
  });

  it('diddestination forward target present but sip.forward points at a different number -> degraded', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715559999') }),
    );
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/sip\.forward/i);
  });

  it("dial_timeout='1' sentinel present but sip.forward unset -> degraded, never reported as cell", () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: CELL_ONLY_DIAL_TIMEOUT_SENTINEL, sipForward: '' }),
    );
    expect(result.mode).toBe('degraded');
  });

  it('no diddestination forward target but a stale sip.forward is still set -> degraded, never reported as app', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715551234') }),
    );
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/sip\.forward/i);
  });

  it('no diddestination forward target and sip.forward empty -> clean app', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: '' }));
    expect(result.mode).toBe('app');
  });

  it('legacy binary hard-bypass shape (voip_call=0) still reads as cell (backward-compat, no migration)', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '0', dialTimeout: '' }));
    expect(result.mode).toBe('cell');
  });

  it('bare-PSTN shape (forward target present, no SIP account wired) -> degraded', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '0', sipId: null, dialTimeout: null }));
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/bare-PSTN/i);
  });

  it('missing SIP (no forward target, no SIP account wired) -> degraded', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '', voipCall: '1', sipId: null, dialTimeout: null }));
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/no SIP account/i);
  });

  it('unexpected dial_timeout (e.g. "0") with forward + voip_call=1 -> degraded with an explicit reason', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: '0', sipForward: formatSipForward('9715551234') }),
    );
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBeTruthy();
  });

  it('non-numeric dial_timeout -> degraded with an explicit reason', () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: 'garbage', sipForward: formatSipForward('9715551234') }),
    );
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBeTruthy();
  });

  it('incomplete Magnus response (SIP wired but dial_timeout unreadable) -> unknown', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '1', sipId: 'sip-1', dialTimeout: null }));
    expect(result.mode).toBe('unknown');
  });

  it('no diddestination row at all -> degraded', () => {
    const result = deriveVoiceRoutingMode(snap({ diddestinationId: null, destination: null, voipCall: null, dialTimeout: null }));
    expect(result.mode).toBe('degraded');
  });

  it('never mislabels a bare-PSTN shape as one of the three healthy modes', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '0', sipId: null, dialTimeout: null }));
    expect(['app', 'app_then_cell', 'cell']).not.toContain(result.mode);
  });
});

// ── Section 10: mode transitions ────────────────────────────────────────────

describe('planRouteMutation — mode transitions', () => {
  it('app -> app_then_cell: writes the forward target, preserves an already-sane timeout', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    expect(plan.diddestinationWrite).toEqual({ destination: '9715551234', context: '', voip_call: '1', id_ivr: '', id_queue: '' });
    expect(plan.dialTimeoutWrite).toBeNull();
  });

  it('app_then_cell -> cell: same destination, dial_timeout flips to the sentinel', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('cell', current, '9715551234');
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.dialTimeoutWrite).toBe(CELL_ONLY_DIAL_TIMEOUT_SENTINEL);
  });

  it('cell -> app: clears the forward target and uses the explicitly configured ring timeout', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    const plan = planRouteMutation('app', current, undefined, '40');
    expect(plan.diddestinationWrite).toEqual({ destination: '', context: '', voip_call: '1', id_ivr: '', id_queue: '' });
    expect(plan.dialTimeoutWrite).toBe('40');
  });

  it('app -> cell: sets the forward target and the sentinel timeout together', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('cell', current, '9715551234');
    expect(plan.diddestinationWrite?.destination).toBe('9715551234');
    expect(plan.dialTimeoutWrite).toBe(CELL_ONLY_DIAL_TIMEOUT_SENTINEL);
  });

  it('cell -> app_then_cell: same destination, dial_timeout restored from the configured value', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234', '30');
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.dialTimeoutWrite).toBe('30');
  });

  it('preserves an existing valid timeout even when no ring-timeout is configured', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    expect(plan.dialTimeoutWrite).toBeNull();
  });

  it('fails closed (throws) when leaving cell mode with no preserved timeout and no configured timeout', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    expect(() => planRouteMutation('app_then_cell', current, '9715551234')).toThrow(/refusing to guess/i);
  });

  it('fails closed (throws) BEFORE any mutation when the configured timeout is invalid', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    expect(() => planRouteMutation('app_then_cell', current, '9715551234', '0')).toThrow();
    expect(() => planRouteMutation('app_then_cell', current, '9715551234', 'garbage')).toThrow();
  });

  it('ensures cell continues to use the "1" sentinel regardless of any configured ring timeout', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('cell', current, '9715551234', '40');
    expect(plan.dialTimeoutWrite).toBe(CELL_ONLY_DIAL_TIMEOUT_SENTINEL);
  });

  it('fails closed (throws) when the DID has conflicting diddestination rows, before any mutation', () => {
    const current = snap({ conflictingDestinationRows: 2 });
    expect(() => planRouteMutation('app', current)).toThrow(/conflicting_did_destinations/);
  });

  it('same-mode transition is idempotent — no writes planned when already in the target shape', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.dialTimeoutWrite).toBeNull();
  });

  it('every planned diddestination write keeps voip_call=1 (SIP-first-safe in all three modes)', () => {
    for (const mode of ['app', 'app_then_cell', 'cell'] as const) {
      const current = snap({ destination: 'something-else', voipCall: '1', dialTimeout: '25' });
      const plan = planRouteMutation(mode, current, '9715551234');
      if (plan.diddestinationWrite) expect(plan.diddestinationWrite.voip_call).toBe('1');
    }
  });

  it('fails closed (throws) when the DID has no SIP account wired at all', () => {
    const current = snap({ sipId: null, dialTimeout: null });
    expect(() => planRouteMutation('app', current)).toThrow();
  });

  it('throws when a forward number is required for the mode but not supplied', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25' });
    expect(() => planRouteMutation('cell', current)).toThrow();
  });
});

// ── sip.forward: the field SipCallAgi.php::callForward() actually gates on ─

describe('planRouteMutation — sip.forward (the field that actually gates Magnus call-forwarding)', () => {
  it('app -> app_then_cell: writes sip.forward alongside the diddestination forward target', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: '' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    expect(plan.forwardWrite).toBe(formatSipForward('9715551234'));
  });

  it('app -> cell: writes sip.forward alongside the sentinel dial_timeout', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: '' });
    const plan = planRouteMutation('cell', current, '9715551234');
    expect(plan.forwardWrite).toBe(formatSipForward('9715551234'));
  });

  it('cell -> app: clears sip.forward', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1', sipForward: formatSipForward('9715551234') });
    const plan = planRouteMutation('app', current, undefined, '40');
    expect(plan.forwardWrite).toBe('');
  });

  it('app_then_cell -> cell (same number): sip.forward already correct, no rewrite needed', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715551234') });
    const plan = planRouteMutation('cell', current, '9715551234');
    expect(plan.forwardWrite).toBeNull();
  });

  it('changing the forward number while already in cell/app_then_cell rewrites sip.forward to the new target', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715551234') });
    const plan = planRouteMutation('app_then_cell', current, '9715559999');
    expect(plan.forwardWrite).toBe(formatSipForward('9715559999'));
  });

  it('detects and repairs today\'s live defect: diddestination already shows app_then_cell but sip.forward was never set', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: '' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    // diddestination itself needs no rewrite (already correct shape) — but sip.forward does.
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.forwardWrite).toBe(formatSipForward('9715551234'));
  });

  it('app -> app: already clear, no forward rewrite needed', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: '' });
    const plan = planRouteMutation('app', current);
    expect(plan.forwardWrite).toBeNull();
  });
});

// ── Section 10: guards (forward-target validation) ─────────────────────────

describe('validateForwardTarget — guards', () => {
  const ownDid = '17678185000';

  it('rejects an exact self-forward (same DID)', () => {
    expect(validateForwardTarget({ ownDid, candidate: ownDid, managedDids: [] }).ok).toBe(false);
  });

  it('rejects the 10-digit equivalent of its own DID', () => {
    expect(validateForwardTarget({ ownDid, candidate: '7678185000', managedDids: [] }).ok).toBe(false);
  });

  it('rejects a formatted 11-digit self-equivalent (plus/parens/dashes/spaces)', () => {
    expect(validateForwardTarget({ ownDid, candidate: '+1 (767) 818-5000', managedDids: [] }).ok).toBe(false);
  });

  it('rejects a protected operational DID', () => {
    expect(validateForwardTarget({ ownDid, candidate: '17678183742', managedDids: [] }).ok).toBe(false);
  });

  it('rejects another Foundation-managed VoiceLine DID (dynamic loop check, not just the static list)', () => {
    const result = validateForwardTarget({ ownDid, candidate: '17678186001', managedDids: ['17678186001'] });
    expect(result.ok).toBe(false);
  });

  it('accepts an external, owner-controlled mobile number not on any managed/protected list', () => {
    const result = validateForwardTarget({ ownDid, candidate: '17671234567', managedDids: ['17678186001'] });
    expect(result.ok).toBe(true);
    expect(result.normalized).toBe('17671234567');
  });

  it('rejects an empty candidate', () => {
    expect(validateForwardTarget({ ownDid, candidate: '', managedDids: [] }).ok).toBe(false);
  });

  it('rejects an unsupported destination type (too short to be a phone number)', () => {
    expect(validateForwardTarget({ ownDid, candidate: '123', managedDids: [] }).ok).toBe(false);
  });

  it('never discloses the specific protected/managed number in the rejection message', () => {
    const protectedResult = validateForwardTarget({ ownDid, candidate: '17678183742', managedDids: [] });
    expect(protectedResult.error).not.toContain('17678183742');
    const managedResult = validateForwardTarget({ ownDid, candidate: '17678186001', managedDids: ['17678186001'] });
    expect(managedResult.error).not.toContain('17678186001');
  });
});

describe('normalizeForwardNumber', () => {
  it('strips non-digit characters', () => {
    expect(normalizeForwardNumber('+1 (767) 818-5000')).toBe('17678185000');
  });
});

// ── Corrective patch: timeout configuration policy ──────────────────────────

describe('isValidRingTimeoutSeconds', () => {
  it('accepts a sane positive integer', () => {
    expect(isValidRingTimeoutSeconds('25')).toBe(true);
    expect(isValidRingTimeoutSeconds('40')).toBe(true);
  });

  it('rejects the cell-only sentinel value', () => {
    expect(isValidRingTimeoutSeconds('1')).toBe(false);
  });

  it('rejects zero and negative-looking strings', () => {
    expect(isValidRingTimeoutSeconds('0')).toBe(false);
    expect(isValidRingTimeoutSeconds('-5')).toBe(false);
  });

  it('rejects non-numeric input', () => {
    expect(isValidRingTimeoutSeconds('garbage')).toBe(false);
    expect(isValidRingTimeoutSeconds('25.5')).toBe(false);
    expect(isValidRingTimeoutSeconds('')).toBe(false);
  });

  it('rejects a value above the sanity ceiling', () => {
    expect(isValidRingTimeoutSeconds('99999')).toBe(false);
  });
});

// ── Corrective patch: bounded compensating rollback (pure restore planning) ─

describe('planRestoreMutation — exact snapshot restore', () => {
  it('restores destination/voip_call/dial_timeout exactly from the captured before-snapshot', () => {
    const captured = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25' });
    const plan = planRestoreMutation(captured);
    expect(plan.diddestinationWrite).toEqual({ destination: '9715551234', context: '', voip_call: '1', id_ivr: '', id_queue: '' });
    expect(plan.dialTimeoutWrite).toBe('25');
  });

  it('never restores a bare-PSTN voip_call=0 shape, even if that was the captured legacy value', () => {
    const captured = snap({ destination: '9715551234', voipCall: '0', dialTimeout: '' });
    const plan = planRestoreMutation(captured);
    expect(plan.diddestinationWrite?.voip_call).toBe('1');
  });

  it('restores the cell-only sentinel exactly when that was the captured before-state', () => {
    const captured = snap({ destination: '9715551234', voipCall: '1', dialTimeout: CELL_ONLY_DIAL_TIMEOUT_SENTINEL });
    const plan = planRestoreMutation(captured);
    expect(plan.dialTimeoutWrite).toBe(CELL_ONLY_DIAL_TIMEOUT_SENTINEL);
  });

  it('never guesses a dial_timeout when the captured snapshot could not read one (unknown before-state)', () => {
    const captured = snap({ destination: '9715551234', voipCall: '1', sipId: 'sip-1', dialTimeout: null });
    const plan = planRestoreMutation(captured);
    expect(plan.dialTimeoutWrite).toBeNull();
  });

  it('returns a no-op plan when the DID had no diddestination row before the mutation was attempted', () => {
    const captured = snap({ diddestinationId: null, destination: null, voipCall: null, sipId: null, dialTimeout: null, sipForward: null });
    const plan = planRestoreMutation(captured);
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.dialTimeoutWrite).toBeNull();
    expect(plan.forwardWrite).toBeNull();
  });

  it('restores sip.forward exactly from the captured before-snapshot', () => {
    const captured = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25', sipForward: formatSipForward('9715551234') });
    const plan = planRestoreMutation(captured);
    expect(plan.forwardWrite).toBe(formatSipForward('9715551234'));
  });

  it('restores a cleared sip.forward exactly (captured before-state was app mode)', () => {
    const captured = snap({ destination: '', voipCall: '1', dialTimeout: '25', sipForward: '' });
    const plan = planRestoreMutation(captured);
    expect(plan.forwardWrite).toBe('');
  });

  it('never guesses sip.forward when the captured snapshot could not read it (unknown before-state)', () => {
    const captured = snap({ destination: '9715551234', voipCall: '1', sipId: 'sip-1', dialTimeout: null, sipForward: null });
    const plan = planRestoreMutation(captured);
    expect(plan.forwardWrite).toBeNull();
  });
});

// ── Corrective patch: conflicting DID-destination rows ──────────────────────

describe('deriveVoiceRoutingMode — conflicting destination rows', () => {
  it('classifies a conflicting-rows snapshot as degraded, never a healthy mode', () => {
    const result = deriveVoiceRoutingMode(snap({ conflictingDestinationRows: 2 }));
    expect(result.mode).toBe('degraded');
    expect(result.reason).toMatch(/conflicting_did_destinations/);
  });

  it('never mislabels a conflicting-rows snapshot as app/app_then_cell/cell', () => {
    const result = deriveVoiceRoutingMode(snap({ conflictingDestinationRows: 3 }));
    expect(['app', 'app_then_cell', 'cell']).not.toContain(result.mode);
  });
});

describe('readVoiceRoutingSnapshot — conflicting destination rows', () => {
  it('translates a ConflictingDidDestinationsError from Magnus into a degraded-classifiable snapshot instead of throwing', async () => {
    findDidDestinationForDidMock.mockRejectedValue(new ConflictingDidDestinationsError('did-1', 2));

    const snapshot = await readVoiceRoutingSnapshot(MAGNUS_CONFIG, 'did-1', '17678185000');
    expect(snapshot.conflictingDestinationRows).toBe(2);

    const state = deriveVoiceRoutingMode(snapshot);
    expect(state.mode).toBe('degraded');
    expect(state.reason).toMatch(/conflicting_did_destinations/);
  });

  it('propagates any other Magnus error unchanged (not swallowed as a conflict)', async () => {
    findDidDestinationForDidMock.mockRejectedValue(new Error('network timeout'));
    await expect(readVoiceRoutingSnapshot(MAGNUS_CONFIG, 'did-1', '17678185000')).rejects.toThrow('network timeout');
  });
});
