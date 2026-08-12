import { describe, it, expect } from 'vitest';
import { redactSecret, redactSecrets, REDACTED } from './redact-secret';

describe('redactSecret', () => {
  it('removes every occurrence, not just the first', () => {
    const out = redactSecret('tried s3cr3tvalue then s3cr3tvalue again', 's3cr3tvalue');
    expect(out).toBe(`tried ${REDACTED} then ${REDACTED} again`);
    expect(out).not.toContain('s3cr3tvalue');
  });

  it('leaves text untouched when the secret does not appear', () => {
    expect(redactSecret('magnus rejected the request', 's3cr3tvalue')).toBe('magnus rejected the request');
  });

  it('passes text through when the secret is null or empty, so callers need no branch', () => {
    expect(redactSecret('some error', null)).toBe('some error');
    expect(redactSecret('some error', undefined)).toBe('some error');
    expect(redactSecret('some error', '')).toBe('some error');
  });

  it('returns null for null text', () => {
    expect(redactSecret(null, 's3cr3tvalue')).toBeNull();
    expect(redactSecret(undefined, 's3cr3tvalue')).toBeNull();
  });

  it('ignores secrets too short to redact without mangling ordinary text', () => {
    // A 2-char "secret" would otherwise shred every error message containing it.
    expect(redactSecret('an error occurred', 'or')).toBe('an error occurred');
  });

  it('is case-sensitive — SIP secrets are case-significant random bytes', () => {
    expect(redactSecret('saw ABCDEFGH here', 'abcdefgh')).toBe('saw ABCDEFGH here');
  });

  it('handles a secret containing regex metacharacters literally', () => {
    // split/join is used precisely so this cannot become a regex injection.
    const secret = 'a.b*c+d?[e]';
    expect(redactSecret(`x ${secret} y`, secret)).toBe(`x ${REDACTED} y`);
    expect(redactSecret('x aXbYcZd y', secret)).toBe('x aXbYcZd y');
  });

  it('redacts multiple distinct secrets from one string', () => {
    const out = redactSecrets('sip=firstsecret api=secondsecret', ['firstsecret', 'secondsecret']);
    expect(out).toBe(`sip=${REDACTED} api=${REDACTED}`);
  });

  it('tolerates nulls in the multi-secret list', () => {
    expect(redactSecrets('sip=firstsecret', ['firstsecret', null, undefined])).toBe(`sip=${REDACTED}`);
  });
});
