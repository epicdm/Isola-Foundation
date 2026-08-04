import { describe, it, expect } from 'vitest';
import {
  resolveAgentExposure,
  isAuthorizedPublicAgent,
  isAuthorizedInternalAgent,
} from './agent-exposure-policy';

// Canonical topology from xp-foundation-agent-exposure-enforcement-2026-08-04.
const FOUNDATION_TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const EMA = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const EPIC_FRONT_DESK = 'a71578a4-12cc-4e38-ad24-4b9fffd69309';
const ATLAS = '9baf6f00-f9e0-4bd4-9672-10865f438e2c';
const SCOUT = '695930c9-cfb0-4b52-b33e-f3826493b891';
const LEDGER_UNKNOWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // unresolved — must never be seeded
const OTHER_TENANT = 'some-other-foundation-tenant';

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...overrides } as unknown as NodeJS.ProcessEnv;
}

describe('resolveAgentExposure — B1 canonical classifications', () => {
  it('EMA is PUBLIC and enabled for the Foundation tenant', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA }, env());
    expect(r).toEqual({ matched: true, classification: 'PUBLIC', enabled: true, label: 'EMA' });
    expect(isAuthorizedPublicAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA }, env())).toBe(true);
    expect(isAuthorizedInternalAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA }, env())).toBe(false);
  });

  it('EPIC Front Desk is PUBLIC and enabled for the Foundation tenant', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EPIC_FRONT_DESK }, env());
    expect(r.matched).toBe(true);
    expect(r.classification).toBe('PUBLIC');
    expect(r.enabled).toBe(true);
    expect(isAuthorizedPublicAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EPIC_FRONT_DESK }, env())).toBe(true);
  });

  it('Atlas is INTERNAL and enabled for the Foundation tenant', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: ATLAS }, env());
    expect(r).toEqual({ matched: true, classification: 'INTERNAL', enabled: true, label: 'Atlas' });
    expect(isAuthorizedInternalAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: ATLAS }, env())).toBe(true);
    expect(isAuthorizedPublicAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: ATLAS }, env())).toBe(false);
  });

  it('Scout is INTERNAL and enabled for the Foundation tenant', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: SCOUT }, env());
    expect(r.matched).toBe(true);
    expect(r.classification).toBe('INTERNAL');
    expect(isAuthorizedInternalAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: SCOUT }, env())).toBe(true);
  });

  it('Ledger is NOT classified — fails closed for BOTH public and internal routing (must not be guessed)', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: LEDGER_UNKNOWN_ID }, env());
    expect(r).toEqual({ matched: false, classification: null, enabled: false, label: null });
    expect(isAuthorizedPublicAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: LEDGER_UNKNOWN_ID }, env())).toBe(false);
    expect(isAuthorizedInternalAgent({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: LEDGER_UNKNOWN_ID }, env())).toBe(false);
  });

  it('a genuinely unknown agent id fails closed, unmatched', () => {
    const r = resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: 'never-seen-before' }, env());
    expect(r.matched).toBe(false);
  });

  it('the same clawith_agent_id under a DIFFERENT Foundation tenant is unmatched — classification is not agent-identity-only', () => {
    const r = resolveAgentExposure({ foundationTenantId: OTHER_TENANT, clawithAgentId: EMA }, env());
    expect(r.matched).toBe(false);
  });

  it('an empty foundationTenantId or clawithAgentId never matches by accident', () => {
    expect(resolveAgentExposure({ foundationTenantId: '', clawithAgentId: EMA }, env()).matched).toBe(false);
    expect(resolveAgentExposure({ foundationTenantId: FOUNDATION_TENANT, clawithAgentId: '' }, env()).matched).toBe(false);
  });
});

describe('resolveAgentExposure — additive env extension, hardcoded floor wins', () => {
  it('an extra env-supplied entry for a new (tenant, agent) pair is honoured', () => {
    const extra = JSON.stringify([
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'new-agent-1', classification: 'PUBLIC', enabled: true },
    ]);
    const r = resolveAgentExposure(
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'new-agent-1' },
      env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: extra }),
    );
    expect(r).toEqual({ matched: true, classification: 'PUBLIC', enabled: true, label: null });
  });

  it('the hardcoded floor always wins over an env entry for the SAME (tenant, agent) pair — floor cannot be overridden by config', () => {
    const extra = JSON.stringify([
      { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA, classification: 'INTERNAL', enabled: true },
    ]);
    const r = resolveAgentExposure(
      { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA },
      env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: extra }),
    );
    expect(r.classification).toBe('PUBLIC'); // floor wins, not the malicious/misconfigured override
  });

  it('an env entry can disable a floor-adjacent agent it is not allowed to touch — proven inert (floor still wins)', () => {
    // Same assertion as above from a different angle: the env cannot even
    // flip `enabled` on a floor entry.
    const extra = JSON.stringify([
      { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: ATLAS, classification: 'INTERNAL', enabled: false },
    ]);
    const r = resolveAgentExposure(
      { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: ATLAS },
      env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: extra }),
    );
    expect(r.enabled).toBe(true); // floor's enabled:true wins
  });

  it('malformed JSON in the extra-policy env var is dropped silently (never thrown, never a wildcard)', () => {
    expect(() =>
      resolveAgentExposure(
        { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA },
        env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: '{not valid json' }),
      ),
    ).not.toThrow();
    const r = resolveAgentExposure(
      { foundationTenantId: FOUNDATION_TENANT, clawithAgentId: EMA },
      env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: '{not valid json' }),
    );
    expect(r.classification).toBe('PUBLIC'); // floor still resolves normally
  });

  it('a non-array JSON value in the extra-policy env var is dropped', () => {
    const r = resolveAgentExposure(
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'x' },
      env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: JSON.stringify({ not: 'an array' }) }),
    );
    expect(r.matched).toBe(false);
  });

  it('malformed individual entries in an otherwise-valid array are dropped, not admitted', () => {
    const extra = JSON.stringify([
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'ok-agent', classification: 'PUBLIC', enabled: true },
      { foundationTenantId: OTHER_TENANT, classification: 'PUBLIC', enabled: true }, // missing clawithAgentId
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'bad-classification', classification: 'SUPERUSER', enabled: true },
    ]);
    const e = env({ AGENT_EXPOSURE_POLICY_EXTRA_JSON: extra });
    expect(resolveAgentExposure({ foundationTenantId: OTHER_TENANT, clawithAgentId: 'ok-agent' }, e).matched).toBe(true);
    expect(resolveAgentExposure({ foundationTenantId: OTHER_TENANT, clawithAgentId: 'bad-classification' }, e).matched).toBe(false);
  });
});
