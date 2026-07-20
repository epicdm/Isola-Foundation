import { describe, it, expect } from 'vitest';
import { classifyVoiceLineHealth, summarize, type VoiceLineRecord, type MagnusResolution } from './voice-health';

function line(overrides: Partial<VoiceLineRecord> = {}): VoiceLineRecord {
  return {
    id: 'vl-1',
    ownerName: 'Test Owner',
    ownerKind: 'business',
    did: '17678182220',
    magnusUserId: '1563',
    magnusSipId: '1834',
    magnusCallerIdId: '900',
    magnusDidId: '2400',
    magnusDidDestinationId: '2500',
    provisioningState: 'completed',
    ...overrides,
  };
}

function resolution(overrides: Partial<MagnusResolution> = {}): MagnusResolution {
  return {
    sip: { found: true, cidNumber: '17678182220' },
    did: { found: true, did: '17678182220' },
    callerId: { found: true, cid: '17678182220' },
    didDestination: { found: true, idSip: '1834' },
    routing: { mode: 'app' },
    ...overrides,
  };
}

describe('classifyVoiceLineHealth — healthy line', () => {
  it('all ids resolve, routing mode healthy -> OK/green', () => {
    const result = classifyVoiceLineHealth(line(), resolution());
    expect(result.status).toBe('OK');
    expect(result.color).toBe('green');
    expect(result.mode).toBe('app');
    expect(result.issues).toEqual([]);
  });
});

describe('classifyVoiceLineHealth — DB<->Magnus mismatch (the 17678182220-audit class of bug)', () => {
  it('a stored magnus_sip_id that no longer resolves to a live sip row -> MISSING/red', () => {
    const result = classifyVoiceLineHealth(
      line({ magnusSipId: '1831' }),
      resolution({ sip: { found: false, cidNumber: null }, didDestination: { found: true, idSip: '1831' } }),
    );
    expect(result.status).toBe('MISSING');
    expect(result.color).toBe('red');
    expect(result.issues.some((i) => i.includes('magnus_sip_id=1831 does not resolve'))).toBe(true);
  });

  it('multiple unresolved magnus ids on one line all get surfaced, not just the first', () => {
    const result = classifyVoiceLineHealth(
      line({ magnusSipId: '1831', magnusCallerIdId: '381', magnusDidDestinationId: '2603' }),
      resolution({
        sip: { found: false, cidNumber: null },
        callerId: { found: false, cid: null },
        didDestination: { found: false, idSip: null },
      }),
    );
    expect(result.status).toBe('MISSING');
    expect(result.color).toBe('red');
    expect(result.issues).toHaveLength(3);
  });

  it('a live sip row whose cid_number disagrees with the stored DID -> MISMATCH/red', () => {
    const result = classifyVoiceLineHealth(
      line({ did: '17678182220' }),
      resolution({ sip: { found: true, cidNumber: '17678182299' } }),
    );
    expect(result.status).toBe('MISMATCH');
    expect(result.color).toBe('red');
    expect(result.issues.some((i) => i.includes('sip.cid_number=17678182299'))).toBe(true);
  });

  it('a live diddestination row wired to a different sip id -> MISMATCH/red', () => {
    const result = classifyVoiceLineHealth(
      line({ magnusSipId: '1834' }),
      resolution({ didDestination: { found: true, idSip: '9999' } }),
    );
    expect(result.status).toBe('MISMATCH');
    expect(result.color).toBe('red');
    expect(result.issues.some((i) => i.includes('diddestination.id_sip=9999'))).toBe(true);
  });
});

describe('classifyVoiceLineHealth — degraded routing', () => {
  it('deriveVoiceRoutingMode reporting mode=degraded -> DEGRADED/amber', () => {
    const result = classifyVoiceLineHealth(
      line(),
      resolution({ routing: { mode: 'degraded', reason: 'DID has no diddestination row — never provisioned, or routing was removed' } }),
    );
    expect(result.status).toBe('DEGRADED');
    expect(result.color).toBe('amber');
    expect(result.mode).toBe('degraded');
    expect(result.issues.some((i) => i.includes('routing mode=degraded'))).toBe(true);
  });

  it('mode=unknown is also treated as DEGRADED/amber', () => {
    const result = classifyVoiceLineHealth(line(), resolution({ routing: { mode: 'unknown' } }));
    expect(result.status).toBe('DEGRADED');
    expect(result.color).toBe('amber');
  });

  it('a snapshot read that throws surfaces as DEGRADED/amber with the error message', () => {
    const result = classifyVoiceLineHealth(line(), resolution({ routing: { error: 'Magnus request timed out' } }));
    expect(result.status).toBe('DEGRADED');
    expect(result.color).toBe('amber');
    expect(result.mode).toBe('error');
    expect(result.issues.some((i) => i.includes('Magnus request timed out'))).toBe(true);
  });

  it('a MISSING resource error still outranks a DEGRADED routing mode (red wins over amber)', () => {
    const result = classifyVoiceLineHealth(
      line({ magnusSipId: '1831' }),
      resolution({
        sip: { found: false, cidNumber: null },
        didDestination: { found: true, idSip: '1831' },
        routing: { mode: 'degraded', reason: 'DID has no diddestination row' },
      }),
    );
    expect(result.status).toBe('MISSING');
    expect(result.color).toBe('red');
    expect(result.issues).toHaveLength(2);
  });
});

describe('classifyVoiceLineHealth — assignment / provisioning-state checks', () => {
  it('provisioning_state=completed with no DID stored -> MISSING/red', () => {
    const result = classifyVoiceLineHealth(
      line({ did: null, magnusDidId: null, magnusSipId: null, magnusCallerIdId: null, magnusDidDestinationId: null }),
      resolution({ sip: null, did: null, callerId: null, didDestination: null, routing: null }),
    );
    expect(result.status).toBe('MISSING');
    expect(result.color).toBe('red');
  });

  it('null resolution fields (no magnus_*_id stored) are not applicable, not failures', () => {
    const result = classifyVoiceLineHealth(
      line({ magnusCallerIdId: null, magnusDidDestinationId: null }),
      resolution({ callerId: null, didDestination: null }),
    );
    expect(result.status).toBe('OK');
    expect(result.issues).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts results by color and reports the total', () => {
    const summary = summarize([
      classifyVoiceLineHealth(line(), resolution()),
      classifyVoiceLineHealth(line(), resolution({ routing: { mode: 'degraded' } })),
      classifyVoiceLineHealth(line(), resolution({ sip: { found: false, cidNumber: null } })),
    ]);
    expect(summary).toEqual({ total: 3, green: 1, amber: 1, red: 1 });
  });
});
