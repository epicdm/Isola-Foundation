import { describe, it, expect, vi, beforeEach } from 'vitest';

const { auditMock } = vi.hoisted(() => ({ auditMock: vi.fn() }));
vi.mock('../audit', () => ({ audit: auditMock }));

import { authorizeCustomerDispatch } from './customer-exposure-gate';

// Canonical topology from xp-foundation-agent-exposure-enforcement-2026-08-04.
const FOUNDATION_TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const EMA = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162'; // PUBLIC
const ATLAS = '9baf6f00-f9e0-4bd4-9672-10865f438e2c'; // INTERNAL
const LEDGER_UNKNOWN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // unclassified
const OTHER_TENANT = 'a-different-foundation-tenant';

function baseParams(overrides: Partial<Parameters<typeof authorizeCustomerDispatch>[0]> = {}) {
  return {
    foundationTenantId: FOUNDATION_TENANT,
    requestedFoundationAgentId: 'agent-row-1',
    agentActive: true,
    clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: EMA },
    correlationId: 'corr-1',
    source: 'direct_whatsapp' as const,
    contactRef: 'contact-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizeCustomerDispatch — PUBLIC positive', () => {
  it('allows dispatch to EMA (PUBLIC, enabled, tenant-matched)', async () => {
    const result = await authorizeCustomerDispatch(baseParams());
    expect(result).toEqual({ allowed: true, reason: null });
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('allows dispatch to EPIC Front Desk (PUBLIC, enabled, tenant-matched)', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: 'a71578a4-12cc-4e38-ad24-4b9fffd69309' } }),
    );
    expect(result).toEqual({ allowed: true, reason: null });
  });
});

describe('authorizeCustomerDispatch — PUBLIC negative (fail closed)', () => {
  it('denies dispatch to Atlas (INTERNAL) — not_public_classified', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: ATLAS } }),
    );
    expect(result).toEqual({ allowed: false, reason: 'not_public_classified' });
  });

  it('denies dispatch to Ledger (unclassified) — not_public_classified, never guessed', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: LEDGER_UNKNOWN_ID } }),
    );
    expect(result).toEqual({ allowed: false, reason: 'not_public_classified' });
  });

  it('missing policy for the agent fails closed, indistinguishable in effect from Ledger', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: 'never-classified' } }),
    );
    expect(result.allowed).toBe(false);
  });

  it('a disabled PUBLIC-classified agent (via env override attempt against a non-floor agent) fails closed', async () => {
    const originalEnv = process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON;
    process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
      { foundationTenantId: OTHER_TENANT, clawithAgentId: 'disabled-public-agent', classification: 'PUBLIC', enabled: false },
    ]);
    try {
      const result = await authorizeCustomerDispatch(
        baseParams({
          foundationTenantId: OTHER_TENANT,
          clawithBinding: { tenant_id: OTHER_TENANT, clawith_agent_id: 'disabled-public-agent' },
        }),
      );
      expect(result).toEqual({ allowed: false, reason: 'not_public_classified' });
    } finally {
      process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = originalEnv;
    }
  });

  it('missing Foundation tenant fails closed — no_foundation_tenant', async () => {
    const result = await authorizeCustomerDispatch(baseParams({ foundationTenantId: '' }));
    expect(result).toEqual({ allowed: false, reason: 'no_foundation_tenant' });
  });

  it('inactive Foundation agent fails closed — agent_inactive', async () => {
    const result = await authorizeCustomerDispatch(baseParams({ agentActive: false }));
    expect(result).toEqual({ allowed: false, reason: 'agent_inactive' });
  });

  it('no ClawithBinding resolved fails closed — no_clawith_binding', async () => {
    const result = await authorizeCustomerDispatch(baseParams({ clawithBinding: null }));
    expect(result).toEqual({ allowed: false, reason: 'no_clawith_binding' });
  });

  it('a ClawithBinding belonging to a DIFFERENT tenant fails closed — binding_tenant_mismatch — even though the agent is PUBLIC', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: OTHER_TENANT, clawith_agent_id: EMA } }),
    );
    expect(result).toEqual({ allowed: false, reason: 'binding_tenant_mismatch' });
  });

  it('no fallback ever crosses into a different or INTERNAL agent — denial never substitutes a binding', async () => {
    const result = await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: ATLAS } }),
    );
    expect(result.allowed).toBe(false);
    // The caller receives only allowed/reason — nothing here ever names a
    // substitute agent id to fall back to.
    expect(Object.keys(result).sort()).toEqual(['allowed', 'reason']);
  });
});

describe('authorizeCustomerDispatch — audit evidence (B4)', () => {
  it('every denial writes exactly one audit entry with a deterministic reason and the correlation id', async () => {
    await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: ATLAS }, correlationId: 'corr-xyz' }),
    );
    expect(auditMock).toHaveBeenCalledTimes(1);
    const call = auditMock.mock.calls[0][0];
    expect(call).toMatchObject({
      tenantId: FOUNDATION_TENANT,
      action: 'clawith.exposure.customer_denied',
      entity: 'clawith_binding',
      entityId: ATLAS,
      requestId: 'corr-xyz',
    });
    expect(call.meta).toMatchObject({
      reason: 'not_public_classified',
      source: 'direct_whatsapp',
      requestedClawithAgentId: ATLAS,
    });
  });

  it('the actor is a non-PII contact reference, never a raw phone number', async () => {
    await authorizeCustomerDispatch(
      baseParams({ clawithBinding: { tenant_id: FOUNDATION_TENANT, clawith_agent_id: ATLAS }, contactRef: 'wa-contact-abc' }),
    );
    const call = auditMock.mock.calls[0][0];
    expect(call.actorId).toBe('contact:wa-contact-abc');
    expect(call.actorId).not.toMatch(/^\+\d/);
  });

  it('a successful (allowed) dispatch never writes an audit entry — no noisy success-per-message logging', async () => {
    await authorizeCustomerDispatch(baseParams());
    expect(auditMock).not.toHaveBeenCalled();
  });
});
