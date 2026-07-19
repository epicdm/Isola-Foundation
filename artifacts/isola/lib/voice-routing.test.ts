import { describe, it, expect } from 'vitest';
import {
  deriveVoiceRoutingMode,
  planRouteMutation,
  validateForwardTarget,
  normalizeForwardNumber,
  CELL_ONLY_DIAL_TIMEOUT_SENTINEL,
  DEFAULT_RING_TIMEOUT_SECONDS,
  type VoiceRoutingSnapshot,
} from './voice-routing';

function snap(overrides: Partial<VoiceRoutingSnapshot> = {}): VoiceRoutingSnapshot {
  return {
    did: '17678185000',
    didId: 'did-1',
    diddestinationId: 'dd-1',
    destination: '',
    voipCall: '1',
    sipId: 'sip-1',
    dialTimeout: '25',
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

  it('SIP + forward + normal timeout -> app_then_cell', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '1', dialTimeout: '25' }));
    expect(result.mode).toBe('app_then_cell');
    expect(result.forwardToCellNumber).toBe('9715551234');
  });

  it("SIP + forward + dial_timeout='1' -> cell", () => {
    const result = deriveVoiceRoutingMode(
      snap({ destination: '9715551234', voipCall: '1', dialTimeout: CELL_ONLY_DIAL_TIMEOUT_SENTINEL }),
    );
    expect(result.mode).toBe('cell');
    expect(result.forwardToCellNumber).toBe('9715551234');
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
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '1', dialTimeout: '0' }));
    expect(result.mode).toBe('degraded');
    expect(result.reason).toBeTruthy();
  });

  it('non-numeric dial_timeout -> degraded with an explicit reason', () => {
    const result = deriveVoiceRoutingMode(snap({ destination: '9715551234', voipCall: '1', dialTimeout: 'garbage' }));
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

  it('cell -> app: clears the forward target and restores a sane ring timeout from the sentinel', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    const plan = planRouteMutation('app', current);
    expect(plan.diddestinationWrite).toEqual({ destination: '', context: '', voip_call: '1', id_ivr: '', id_queue: '' });
    expect(plan.dialTimeoutWrite).toBe(DEFAULT_RING_TIMEOUT_SECONDS);
  });

  it('app -> cell: sets the forward target and the sentinel timeout together', () => {
    const current = snap({ destination: '', voipCall: '1', dialTimeout: '25' });
    const plan = planRouteMutation('cell', current, '9715551234');
    expect(plan.diddestinationWrite?.destination).toBe('9715551234');
    expect(plan.dialTimeoutWrite).toBe(CELL_ONLY_DIAL_TIMEOUT_SENTINEL);
  });

  it('cell -> app_then_cell: same destination, dial_timeout restored from the sentinel', () => {
    const current = snap({ destination: '9715551234', voipCall: '1', dialTimeout: '1' });
    const plan = planRouteMutation('app_then_cell', current, '9715551234');
    expect(plan.diddestinationWrite).toBeNull();
    expect(plan.dialTimeoutWrite).toBe(DEFAULT_RING_TIMEOUT_SECONDS);
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
