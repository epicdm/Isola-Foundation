import { describe, it, expect, vi, beforeEach } from 'vitest';

const { magnusRequestMock } = vi.hoisted(() => ({ magnusRequestMock: vi.fn() }));

vi.mock('@/engines/magnus', () => ({ magnusRequest: magnusRequestMock }));

import { findDidDestinationForDid, ConflictingDidDestinationsError } from './magnus-voice';

const config = { baseUrl: 'https://example.magnus', apiKey: 'k', apiSecret: 's' } as any;

beforeEach(() => {
  vi.clearAllMocks();
});

// ── Corrective patch: conflicting DID-destination rows ──────────────────────

describe('findDidDestinationForDid — uniqueness / conflict detection', () => {
  it('returns null when no diddestination row exists for the DID', async () => {
    magnusRequestMock.mockResolvedValue({ rows: [] });
    const result = await findDidDestinationForDid(config, 'did-1');
    expect(result).toBeNull();
  });

  it('returns the single row when exactly one diddestination row exists', async () => {
    magnusRequestMock.mockResolvedValue({
      rows: [{ id: '5', id_did: 'did-1', destination: '', voip_call: '1', id_sip: 'sip-1' }],
    });
    const result = await findDidDestinationForDid(config, 'did-1');
    expect(result).toEqual({ id: '5', id_did: 'did-1', destination: '', voip_call: '1', id_sip: 'sip-1' });
  });

  it('fails closed with ConflictingDidDestinationsError when more than one diddestination row exists for the DID', async () => {
    magnusRequestMock.mockResolvedValue({
      rows: [
        { id: '5', id_did: 'did-1', destination: '', voip_call: '1', id_sip: 'sip-1' },
        { id: '6', id_did: 'did-1', destination: '9715551234', voip_call: '1', id_sip: 'sip-2' },
      ],
    });
    await expect(findDidDestinationForDid(config, 'did-1')).rejects.toBeInstanceOf(ConflictingDidDestinationsError);
  });

  it('never silently returns the first row when a conflict exists (all rows visible on the thrown error)', async () => {
    magnusRequestMock.mockResolvedValue({
      rows: [
        { id: '5', id_did: 'did-1', destination: '', voip_call: '1', id_sip: 'sip-1' },
        { id: '6', id_did: 'did-1', destination: '9715551234', voip_call: '1', id_sip: 'sip-2' },
        { id: '7', id_did: 'did-1', destination: '9715559999', voip_call: '1', id_sip: 'sip-3' },
      ],
    });
    try {
      await findDidDestinationForDid(config, 'did-1');
      expect.unreachable('expected findDidDestinationForDid to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ConflictingDidDestinationsError);
      expect((err as ConflictingDidDestinationsError).rowCount).toBe(3);
    }
  });

  it('ignores rows that do not exactly match the requested DID id (defensive client-side filter)', async () => {
    magnusRequestMock.mockResolvedValue({
      rows: [
        { id: '5', id_did: 'did-1', destination: '', voip_call: '1', id_sip: 'sip-1' },
        { id: '9', id_did: 'did-999', destination: '', voip_call: '1', id_sip: 'sip-9' },
      ],
    });
    const result = await findDidDestinationForDid(config, 'did-1');
    expect(result?.id).toBe('5');
  });
});
