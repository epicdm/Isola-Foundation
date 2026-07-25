import { describe, it, expect } from 'vitest';
import {
  decideChatwootBindingSeed,
  describeSeedDecision,
  type AgentFacts,
  type DesiredRegistration,
  type ExistingRegistration,
  type SeedInput,
  type TenantFacts,
} from './chatwoot-binding-seed-guard';

// ── Fixtures modelled on the live account 5 / inbox 3 collision ──────────────
const ACTIVE_TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79'; // EPIC Communications Inc
const RETIRED_TENANT = 'ema_sales_tenant';
const EMA_AGENT = 'cmrhp53b30007s61711vk4dbt'; // Foundation Agent row registering Clawith "EMA"
const CLAWITH_AGENT = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
// Opaque fixture strings standing in for the Chatwoot auth value. Not credentials.
const AUTH_CURRENT = 'fixture-auth-current';
const AUTH_PRIOR = 'fixture-auth-prior';

function desired(over: Partial<DesiredRegistration> = {}): DesiredRegistration {
  return {
    tenantId: ACTIVE_TENANT,
    agentId: EMA_AGENT,
    baseUrl: 'https://inbox.epic.dm',
    accountId: '5',
    inboxId: '3',
    mode: 'a2',
    token: AUTH_CURRENT,
    ...over,
  };
}

function tenant(over: Partial<TenantFacts> = {}): TenantFacts {
  return { id: ACTIVE_TENANT, status: 'active', ...over };
}

function agent(over: Partial<AgentFacts> = {}): AgentFacts {
  return {
    id: EMA_AGENT,
    tenant_id: ACTIVE_TENANT,
    brain_provider: 'clawith',
    clawith_agent_id: CLAWITH_AGENT,
    ...over,
  };
}

function existing(over: Partial<ExistingRegistration> = {}): ExistingRegistration {
  return {
    id: 'cb-active',
    tenant_id: ACTIVE_TENANT,
    tenant_status: 'active',
    agent_id: EMA_AGENT,
    base_url: 'https://inbox.epic.dm',
    account_id: '5',
    inbox_id: '3',
    mode: 'a2',
    token: AUTH_CURRENT,
    ...over,
  };
}

function input(over: Partial<SeedInput> = {}): SeedInput {
  return {
    desired: desired(),
    tenant: tenant(),
    agent: agent(),
    doorRegistrations: [],
    ...over,
  };
}

describe('decideChatwootBindingSeed — the correct registration already exists', () => {
  it('makes NO write when the correct registration already exists (no updated_at churn)', () => {
    const d = decideChatwootBindingSeed(input({ doorRegistrations: [existing()] }));
    expect(d.action).toBe('noop');
    expect(d.action === 'noop' && d.bindingId).toBe('cb-active');
  });

  it('is idempotent across repeated cold starts — every start after the first is a noop', () => {
    const first = decideChatwootBindingSeed(input({ doorRegistrations: [] }));
    expect(first.action).toBe('create');

    // Simulate the row the create would have produced, then re-run 5 more times.
    const row = existing({ id: 'cb-created' });
    for (let coldStart = 0; coldStart < 5; coldStart++) {
      const again = decideChatwootBindingSeed(input({ doorRegistrations: [row] }));
      expect(again.action).toBe('noop');
    }
  });

  it('updates ONLY the fields that genuinely differ — a rotated token is reported by name, never by value', () => {
    const d = decideChatwootBindingSeed(
      input({ doorRegistrations: [existing({ token: AUTH_PRIOR })] }),
    );
    expect(d.action).toBe('update');
    expect(d.action === 'update' && d.changedFields).toEqual(['token']);
    expect(describeSeedDecision(d)).not.toContain(AUTH_CURRENT);
    expect(describeSeedDecision(d)).not.toContain(AUTH_PRIOR);
  });

  it('pins a NULL agent pointer on an otherwise-correct existing row (one-time repair, then noop)', () => {
    const d = decideChatwootBindingSeed(
      input({ doorRegistrations: [existing({ agent_id: null })] }),
    );
    expect(d.action).toBe('update');
    expect(d.action === 'update' && d.changedFields).toEqual(['agent_id']);
  });
});

describe('decideChatwootBindingSeed — refusals leave existing data unchanged', () => {
  it('refuses when the tenant is RETIRED — the live ema_sales_tenant case', () => {
    const d = decideChatwootBindingSeed(
      input({
        desired: desired({ tenantId: RETIRED_TENANT }),
        tenant: tenant({ id: RETIRED_TENANT, status: 'retired' }),
        agent: agent({ tenant_id: RETIRED_TENANT }),
      }),
    );
    expect(d.action).toBe('refuse');
    expect(d.action === 'refuse' && d.reason).toBe('tenant_not_active');
  });

  it('refuses when the tenant is suspended (any status other than active)', () => {
    const d = decideChatwootBindingSeed(input({ tenant: tenant({ status: 'suspended' }) }));
    expect(d.action === 'refuse' && d.reason).toBe('tenant_not_active');
  });

  it('refuses when the tenant row does not exist at all', () => {
    const d = decideChatwootBindingSeed(input({ tenant: null }));
    expect(d.action === 'refuse' && d.reason).toBe('tenant_missing');
  });

  it('refuses when the agent registration would be NULL', () => {
    const d = decideChatwootBindingSeed(input({ desired: desired({ agentId: null }) }));
    expect(d.action === 'refuse' && d.reason).toBe('agent_registration_null');
  });

  it('refuses when the agent registration would be an empty string', () => {
    const d = decideChatwootBindingSeed(input({ desired: desired({ agentId: '   ' }) }));
    expect(d.action === 'refuse' && d.reason).toBe('agent_registration_null');
  });

  it('refuses when the referenced Foundation Agent row does not exist', () => {
    const d = decideChatwootBindingSeed(input({ agent: null }));
    expect(d.action === 'refuse' && d.reason).toBe('agent_row_missing');
  });

  it('refuses when the referenced Agent row belongs to a different tenant', () => {
    const d = decideChatwootBindingSeed(
      input({ agent: agent({ tenant_id: 'some-other-tenant' }) }),
    );
    expect(d.action === 'refuse' && d.reason).toBe('agent_tenant_mismatch');
  });

  it("refuses when brain_provider is 'clawith' but no ClawithBinding/clawith_agent_id exists", () => {
    const d = decideChatwootBindingSeed(input({ agent: agent({ clawith_agent_id: null }) }));
    expect(d.action === 'refuse' && d.reason).toBe('clawith_identity_missing');
  });

  it("refuses when brain_provider is 'clawith' and clawith_agent_id is blank", () => {
    const d = decideChatwootBindingSeed(input({ agent: agent({ clawith_agent_id: '' }) }));
    expect(d.action === 'refuse' && d.reason).toBe('clawith_identity_missing');
  });

  it('does NOT require a Clawith identity for a native-brain agent', () => {
    const d = decideChatwootBindingSeed(
      input({ agent: agent({ brain_provider: 'native', clawith_agent_id: null }) }),
    );
    expect(d.action).toBe('create');
  });

  it('refuses when another ACTIVE registration already owns the door — wrong tenant owns it', () => {
    const d = decideChatwootBindingSeed(
      input({
        desired: desired({ tenantId: RETIRED_TENANT }),
        tenant: tenant({ id: RETIRED_TENANT, status: 'active' }), // even if it were active…
        agent: agent({ id: 'agent-b', tenant_id: RETIRED_TENANT }),
        doorRegistrations: [existing({ id: 'cb-epic' })], // …EPIC already owns account 5 / inbox 3
      }),
    );
    expect(d.action).toBe('refuse');
    expect(d.action === 'refuse' && d.reason).toBe('door_owned_by_other_active_registration');
    expect(d.action === 'refuse' && d.detail.conflicting.map((c) => c.binding_id)).toEqual([
      'cb-epic',
    ]);
  });

  it('refuses when TWO active registrations from other tenants already claim the door', () => {
    const d = decideChatwootBindingSeed(
      input({
        desired: desired({ tenantId: 'third-tenant' }),
        tenant: tenant({ id: 'third-tenant' }),
        agent: agent({ id: 'agent-c', tenant_id: 'third-tenant' }),
        doorRegistrations: [
          existing({ id: 'cb-one', tenant_id: 'tenant-one' }),
          existing({ id: 'cb-two', tenant_id: 'tenant-two' }),
        ],
      }),
    );
    expect(d.action === 'refuse' && d.reason).toBe('door_owned_by_other_active_registration');
    expect(d.action === 'refuse' && d.detail.conflicting).toHaveLength(2);
  });

  it('refuses when this tenant already holds two registrations at the same door (ambiguous)', () => {
    const d = decideChatwootBindingSeed(
      input({
        doorRegistrations: [existing({ id: 'cb-a' }), existing({ id: 'cb-b' })],
      }),
    );
    expect(d.action === 'refuse' && d.reason).toBe('ambiguous_duplicate_registration');
  });

  it('refuses when the inbox is not configured — ownership is never inferred from account_id alone', () => {
    const d = decideChatwootBindingSeed(input({ desired: desired({ inboxId: null }) }));
    expect(d.action === 'refuse' && d.reason).toBe('config_incomplete');
  });

  it('refuses when base_url or mode is not configured', () => {
    expect(
      decideChatwootBindingSeed(input({ desired: desired({ baseUrl: '' }) })).action,
    ).toBe('refuse');
    expect(decideChatwootBindingSeed(input({ desired: desired({ mode: '' }) })).action).toBe(
      'refuse',
    );
  });

  it('a refusal never carries a create/update payload — nothing for a caller to write', () => {
    const d = decideChatwootBindingSeed(input({ tenant: tenant({ status: 'retired' }) }));
    expect(d.action).toBe('refuse');
    expect(d).not.toHaveProperty('data');
    expect(d).not.toHaveProperty('bindingId');
  });

  it('a refusal is deterministic and repeatable across cold starts — never degrades into a write', () => {
    const i = input({
      desired: desired({ tenantId: RETIRED_TENANT }),
      tenant: tenant({ id: RETIRED_TENANT, status: 'retired' }),
      agent: agent({ tenant_id: RETIRED_TENANT }),
      doorRegistrations: [
        existing({ id: 'cb-epic' }),
        existing({
          id: 'cb-stale',
          tenant_id: RETIRED_TENANT,
          tenant_status: 'retired',
          agent_id: null,
        }),
      ],
    });
    for (let coldStart = 0; coldStart < 3; coldStart++) {
      const d = decideChatwootBindingSeed(i);
      expect(d.action).toBe('refuse');
      expect(d.action === 'refuse' && d.reason).toBe('tenant_not_active');
    }
  });
});

describe('decideChatwootBindingSeed — active + retired duplicate at one door', () => {
  it('reports the retired duplicate as a warning without touching it, and still noops on the correct row', () => {
    const d = decideChatwootBindingSeed(
      input({
        doorRegistrations: [
          existing({ id: 'cb-active' }),
          existing({
            id: 'cb-stale',
            tenant_id: RETIRED_TENANT,
            tenant_status: 'retired',
            agent_id: null,
          }),
        ],
      }),
    );
    expect(d.action).toBe('noop');
    expect(d.warnings).toEqual([
      {
        code: 'stale_inactive_registration_at_door',
        binding_id: 'cb-stale',
        tenant_id: RETIRED_TENANT,
        tenant_status: 'retired',
        agent_id: null,
      },
    ]);
  });

  it('a retired duplicate never blocks the legitimate active owner from being created', () => {
    const d = decideChatwootBindingSeed(
      input({
        doorRegistrations: [
          existing({
            id: 'cb-stale',
            tenant_id: RETIRED_TENANT,
            tenant_status: 'retired',
            agent_id: null,
          }),
        ],
      }),
    );
    expect(d.action).toBe('create');
    expect(d.warnings).toHaveLength(1);
  });

  it('still reports the stale duplicate when the decision is a refusal', () => {
    const d = decideChatwootBindingSeed(
      input({
        tenant: tenant({ status: 'retired' }),
        doorRegistrations: [
          existing({
            id: 'cb-stale',
            tenant_id: 'someone-else',
            tenant_status: 'retired',
            agent_id: null,
          }),
        ],
      }),
    );
    expect(d.action).toBe('refuse');
    expect(d.warnings.map((w) => w.binding_id)).toEqual(['cb-stale']);
  });
});

describe('describeSeedDecision — correlation-safe logging', () => {
  it('never emits the token value for any decision shape', () => {
    const shapes: SeedInput[] = [
      input({ doorRegistrations: [existing()] }), // noop
      input(), // create
      input({ doorRegistrations: [existing({ token: AUTH_PRIOR })] }), // update
      input({ tenant: tenant({ status: 'retired' }) }), // refuse
    ];
    for (const i of shapes) {
      const line = describeSeedDecision(decideChatwootBindingSeed(i));
      expect(line).not.toContain(AUTH_CURRENT);
      expect(line).not.toContain(AUTH_PRIOR);
    }
  });

  it('emits the reason code plus the conflicting ids for a refusal', () => {
    const line = describeSeedDecision(
      decideChatwootBindingSeed(
        input({
          desired: desired({ tenantId: RETIRED_TENANT }),
          tenant: tenant({ id: RETIRED_TENANT }),
          agent: agent({ tenant_id: RETIRED_TENANT }),
          doorRegistrations: [existing({ id: 'cb-epic' })],
        }),
      ),
    );
    expect(line).toContain('REFUSED reason=door_owned_by_other_active_registration');
    expect(line).toContain('cb-epic');
    expect(line).toContain(ACTIVE_TENANT);
  });
});
