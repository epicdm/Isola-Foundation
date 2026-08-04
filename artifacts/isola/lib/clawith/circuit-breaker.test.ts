import { beforeEach, describe, expect, it } from 'vitest';
import {
  CIRCUIT_BREAKER_COOLDOWN_MS,
  circuitKeyFor,
  isCircuitOpen,
  recordClawithOutcome,
  resetAllCircuitBreakers,
} from './circuit-breaker';

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const OTHER_TENANT = '9f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';
const AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const OTHER_AGENT = '9a1c9e2e-6b1a-4b9a-8b1a-2f3c4d5e6f70';

const KEY = circuitKeyFor(TENANT, AGENT);
const OTHER_AGENT_KEY = circuitKeyFor(TENANT, OTHER_AGENT);
const OTHER_TENANT_SAME_AGENT_KEY = circuitKeyFor(OTHER_TENANT, AGENT);

beforeEach(() => {
  resetAllCircuitBreakers();
});

describe('circuit breaker — tripping kinds', () => {
  it('trips on payment_required — a 402 is not retryable on this credential', () => {
    expect(isCircuitOpen(KEY, 0)).toBe(false);
    recordClawithOutcome(KEY, 'payment_required', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
  });

  it('trips on provider_error_leaked', () => {
    recordClawithOutcome(KEY, 'provider_error_leaked', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
  });

  it('does NOT trip on a plain timeout, network_error or rate_limited — those may recover on their own', () => {
    for (const kind of ['timeout', 'network_error', 'http_error', 'rate_limited', 'provider_unavailable'] as const) {
      recordClawithOutcome(KEY, kind, 0);
      expect(isCircuitOpen(KEY, 0), kind).toBe(false);
    }
  });
});

describe('circuit breaker — cooldown window', () => {
  it('closes again once the cooldown elapses', () => {
    recordClawithOutcome(KEY, 'payment_required', 1000);
    expect(isCircuitOpen(KEY, 1000 + CIRCUIT_BREAKER_COOLDOWN_MS - 1)).toBe(true);
    expect(isCircuitOpen(KEY, 1000 + CIRCUIT_BREAKER_COOLDOWN_MS + 1)).toBe(false);
  });

  it('a success immediately closes an open breaker — recovery does not wait out the cooldown', () => {
    recordClawithOutcome(KEY, 'payment_required', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
    recordClawithOutcome(KEY, 'success', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(false);
  });
});

describe('circuit breaker — scoping', () => {
  it('is keyed per tenant+agent — tripping one agent never opens a different agent in the same tenant', () => {
    recordClawithOutcome(KEY, 'payment_required', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
    expect(isCircuitOpen(OTHER_AGENT_KEY, 0)).toBe(false);
  });

  it('a healthy fallback agent/credential is never blocked by the primary circuit', () => {
    // Simulates the invoke.ts/staff-agent-chat.ts pattern: primary agent's
    // credential fails and opens its circuit, but a distinct, healthy agent
    // id (e.g. a different Foundation Agent's own Clawith binding) is a
    // completely independent key and is never refused.
    recordClawithOutcome(KEY, 'payment_required', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
    expect(isCircuitOpen(OTHER_AGENT_KEY, 0)).toBe(false);
    recordClawithOutcome(OTHER_AGENT_KEY, 'success', 0);
    expect(isCircuitOpen(OTHER_AGENT_KEY, 0)).toBe(false);
  });

  it('never crosses tenants — the identical agent id under a different tenant is a separate circuit', () => {
    recordClawithOutcome(KEY, 'payment_required', 0);
    expect(isCircuitOpen(KEY, 0)).toBe(true);
    expect(isCircuitOpen(OTHER_TENANT_SAME_AGENT_KEY, 0)).toBe(false);
  });

  it('two Foundation-side callers that resolve to the SAME Clawith agent id under the SAME tenant share one breaker', () => {
    // The one credential-sharing case Foundation can actually observe: both
    // invoke.ts and staff-agent-chat.ts computing circuitKeyFor from the
    // same (tenantId, designated_agent_id) pair land on the identical key.
    const staffChatKey = circuitKeyFor(TENANT, AGENT);
    const customerDispatchKey = circuitKeyFor(TENANT, AGENT);
    recordClawithOutcome(staffChatKey, 'payment_required', 0);
    expect(isCircuitOpen(customerDispatchKey, 0)).toBe(true);
  });
});
