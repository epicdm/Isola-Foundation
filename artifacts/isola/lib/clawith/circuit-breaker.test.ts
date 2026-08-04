import { beforeEach, describe, expect, it } from 'vitest';
import {
  CIRCUIT_BREAKER_COOLDOWN_MS,
  isCircuitOpen,
  recordClawithOutcome,
  resetAllCircuitBreakers,
} from './circuit-breaker';

const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const OTHER_AGENT = '9a1c9e2e-6b1a-4b9a-8b1a-2f3c4d5e6f70';

beforeEach(() => {
  resetAllCircuitBreakers();
});

describe('circuit breaker — tripping kinds', () => {
  it('trips on payment_required — a 402 is not retryable on this credential', () => {
    expect(isCircuitOpen(AGENT, 0)).toBe(false);
    recordClawithOutcome(AGENT, 'payment_required', 0);
    expect(isCircuitOpen(AGENT, 0)).toBe(true);
  });

  it('trips on provider_error_leaked', () => {
    recordClawithOutcome(AGENT, 'provider_error_leaked', 0);
    expect(isCircuitOpen(AGENT, 0)).toBe(true);
  });

  it('does NOT trip on a plain timeout, network_error or rate_limited — those may recover on their own', () => {
    for (const kind of ['timeout', 'network_error', 'http_error', 'rate_limited', 'provider_unavailable'] as const) {
      recordClawithOutcome(AGENT, kind, 0);
      expect(isCircuitOpen(AGENT, 0), kind).toBe(false);
    }
  });
});

describe('circuit breaker — cooldown window', () => {
  it('closes again once the cooldown elapses', () => {
    recordClawithOutcome(AGENT, 'payment_required', 1000);
    expect(isCircuitOpen(AGENT, 1000 + CIRCUIT_BREAKER_COOLDOWN_MS - 1)).toBe(true);
    expect(isCircuitOpen(AGENT, 1000 + CIRCUIT_BREAKER_COOLDOWN_MS + 1)).toBe(false);
  });

  it('a success immediately closes an open breaker — recovery does not wait out the cooldown', () => {
    recordClawithOutcome(AGENT, 'payment_required', 0);
    expect(isCircuitOpen(AGENT, 0)).toBe(true);
    recordClawithOutcome(AGENT, 'success', 0);
    expect(isCircuitOpen(AGENT, 0)).toBe(false);
  });
});

describe('circuit breaker — scoping', () => {
  it('is keyed per agent/credential — tripping one never opens another', () => {
    recordClawithOutcome(AGENT, 'payment_required', 0);
    expect(isCircuitOpen(AGENT, 0)).toBe(true);
    expect(isCircuitOpen(OTHER_AGENT, 0)).toBe(false);
  });
});
