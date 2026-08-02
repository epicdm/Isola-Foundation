import { describe, expect, it } from 'vitest';
import {
  computeLane2BrokerSignature,
  verifyLane2BrokerSignature,
} from './broker-auth';

const SECRET = 'test-lane2-broker-secret';

describe('verifyLane2BrokerSignature', () => {
  it('accepts a correctly signed, fresh delivery', () => {
    const body = JSON.stringify({ hello: 'world' });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = computeLane2BrokerSignature(SECRET, ts, body);
    const result = verifyLane2BrokerSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET });
    expect(result.ok).toBe(true);
  });

  it('rejects when no secret is configured', () => {
    const result = verifyLane2BrokerSignature({ rawBody: '{}', signature: 'sha256=x', timestamp: '1', secret: undefined });
    expect(result).toEqual({ ok: false, reason: 'no-secret-configured' });
  });

  it('rejects a missing signature', () => {
    const result = verifyLane2BrokerSignature({ rawBody: '{}', signature: null, timestamp: '1', secret: SECRET });
    expect(result).toEqual({ ok: false, reason: 'missing-signature' });
  });

  it('rejects a tampered body', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = computeLane2BrokerSignature(SECRET, ts, JSON.stringify({ a: 1 }));
    const result = verifyLane2BrokerSignature({
      rawBody: JSON.stringify({ a: 2 }), signature: sig, timestamp: ts, secret: SECRET,
    });
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });

  it('rejects a stale timestamp outside the tolerance window', () => {
    const body = '{}';
    const staleTs = String(Math.floor(Date.now() / 1000) - 10_000);
    const sig = computeLane2BrokerSignature(SECRET, staleTs, body);
    const result = verifyLane2BrokerSignature({ rawBody: body, signature: sig, timestamp: staleTs, secret: SECRET });
    expect(result).toEqual({ ok: false, reason: 'stale-timestamp' });
  });

  it('rejects a signature signed with the wrong secret', () => {
    const body = '{}';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = computeLane2BrokerSignature('wrong-secret', ts, body);
    const result = verifyLane2BrokerSignature({ rawBody: body, signature: sig, timestamp: ts, secret: SECRET });
    expect(result).toEqual({ ok: false, reason: 'signature-mismatch' });
  });
});
