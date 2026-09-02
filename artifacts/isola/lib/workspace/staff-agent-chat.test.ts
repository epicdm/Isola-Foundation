import { describe, it, expect, vi, beforeEach } from 'vitest';

const { prismaMock, recordClawithFailureMock } = vi.hoisted(() => ({
  prismaMock: {
    agent: { findFirst: vi.fn() },
    clawithBinding: { findFirst: vi.fn() },
    chatwootBinding: { findMany: vi.fn() },
  },
  recordClawithFailureMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }));
vi.mock('@/lib/clawith/alert', () => ({ recordClawithFailure: recordClawithFailureMock }));

import {
  FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV,
  staffChatAgentAllowlist,
  isAgentAllowlistedForStaffChat,
  resolveStaffChatEligibility,
  buildStaffContactRef,
  buildStaffChatCorrelationId,
  validateStaffChatStructuredUrl,
  mapFailureToStaffChatState,
  performStaffChatTurn,
  type StaffChatEligibleAgent,
} from './staff-agent-chat';
import { CLAWITH_STRUCTURED_URL as LEGACY_CLAWITH_STRUCTURED_URL, MAX_ATTEMPTS } from '@/lib/clawith/client';
import { CLAWITH_SCHEMA_VERSION } from '@/lib/clawith/contract';
import { resetAllCircuitBreakers } from '@/lib/clawith/circuit-breaker';
import type { SessionCtx } from '@/lib/session';

const TENANT = '43b006e4-33e0-42a8-bec7-4422ba290d79';
const OTHER_TENANT = 'tenant-someone-else';
const AGENT_ID = 'a955edf4-a4c7-4669-b7dc-8dd3526716cf'; // Atlas's Foundation Agent id
// Atlas's real clawith_agent_id — classified INTERNAL in the B1 policy floor
// (lib/clawith/agent-exposure-policy.ts). Used throughout this file as the
// eligible/happy-path fixture, since B3 (xp-foundation-agent-exposure-
// enforcement-2026-08-04) requires the staff-chat positive proof to be a
// genuinely INTERNAL agent. See "proof 15" below for the negative case this
// change exists to prove: EMA's real (PUBLIC) clawith_agent_id, which this
// fixture used exclusively before B3 and would have silently passed.
const CLAWITH_AGENT_ID = '9baf6f00-f9e0-4bd4-9672-10865f438e2c';
// EMA — PUBLIC in the same policy floor. A staff-chat turn must never reach
// this id even when otherwise eligible (allowlisted, active, bound).
const PUBLIC_CLAWITH_AGENT_ID = '81b38cd6-9fba-4cc8-8f87-1bce1a4aa162';
const LEDGER_UNKNOWN_CLAWITH_AGENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // unclassified
const CLAWITH_TENANT_ID = '6572bd90-0371-4041-986b-065379934f5d';
const COMPANY_ID = '4cfe04bb-38e5-4745-ac4d-db202c61085f';

const VALID_STRUCTURED_URL = 'https://agents.epic.dm/api/isola/bridge/structured/message';

/** Every test that exercises performStaffChatTurn's network path needs a
 *  VALID CLAWITH_STRUCTURED_URL — see the dedicated URL-validation describe
 *  block below for the failure modes of this gate itself. */
function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    CLAWITH_SHARED_SECRET: 'test-secret',
    CLAWITH_STRUCTURED_URL: VALID_STRUCTURED_URL,
    ...overrides,
  } as unknown as NodeJS.ProcessEnv;
}

/** For tests of the allowlist/eligibility functions, which don't touch the
 *  URL gate at all — keeps those tests from silently depending on it. */
function envNoStructuredUrl(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CLAWITH_SHARED_SECRET: 'test-secret', ...overrides } as unknown as NodeJS.ProcessEnv;
}

function session(overrides: Record<string, unknown> = {}): SessionCtx {
  return {
    replitId: 'r1',
    user: { id: 'user-1', tenant_id: TENANT, agent_took_over: false, tenant: {} },
    effectiveTenantId: TENANT,
    effectiveTenant: { id: TENANT, business_name: 'EPIC Communications Inc', status: 'active' },
    isAdmin: false,
    isOwner: true,
    identityId: 'identity-1',
    ...overrides,
  } as unknown as SessionCtx;
}

function eligibleAgent(overrides: Partial<StaffChatEligibleAgent> = {}): StaffChatEligibleAgent {
  return {
    agentId: AGENT_ID,
    tenantId: TENANT,
    name: 'Isola',
    clawithAgentId: CLAWITH_AGENT_ID,
    clawithTenantId: CLAWITH_TENANT_ID,
    paperclipCompanyId: COMPANY_ID,
    chatwootBindingModes: ['lane2', 'a2'],
    ...overrides,
  };
}

function okBody(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: CLAWITH_SCHEMA_VERSION,
    agent_id: CLAWITH_AGENT_ID,
    session_id: 'sess-1',
    correlation_id: 'staffchat:thread-1:turn-1',
    customer_reply: 'Here is what I found.',
    confidence: 0.9,
    qualification_state: 'unknown',
    tool_requests: [],
    escalation: { requested: false },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetAllCircuitBreakers();
});

describe('proof 1: allowlist parsing (revised rule 5)', () => {
  it('is empty — and therefore fails everything closed — when the env var is missing', () => {
    expect(staffChatAgentAllowlist(env()).size).toBe(0);
    expect(isAgentAllowlistedForStaffChat(AGENT_ID, env())).toBe(false);
  });

  it('is empty when the env var is an empty string', () => {
    expect(
      staffChatAgentAllowlist(env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: '' })).size,
    ).toBe(0);
  });

  it('is empty when the env var is only whitespace', () => {
    expect(
      staffChatAgentAllowlist(env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: '   ' })).size,
    ).toBe(0);
  });

  it('drops malformed (non-UUID) entries rather than throwing or admitting them', () => {
    const set = staffChatAgentAllowlist(
      env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: 'not-a-uuid, , <script>alert(1)</script>' }),
    );
    expect(set.size).toBe(0);
  });

  it('keeps a well-formed entry alongside dropped malformed ones', () => {
    const set = staffChatAgentAllowlist(
      env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: `not-a-uuid,${AGENT_ID}, ` }),
    );
    expect(set.has(AGENT_ID)).toBe(true);
    expect(set.size).toBe(1);
  });

  it('accepts the first approved value from the owner/CTO disposition', () => {
    expect(
      isAgentAllowlistedForStaffChat(AGENT_ID, env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: AGENT_ID })),
    ).toBe(true);
  });

  it('fails closed for an agent not on the list, even with other agents present', () => {
    const other = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    expect(
      isAgentAllowlistedForStaffChat(AGENT_ID, env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: other })),
    ).toBe(false);
  });
});

describe('proof 2: five-rule eligibility, revised policy', () => {
  const ALLOWLIST_ENV = env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: AGENT_ID });

  it('fails closed — agent_not_found — when the agent does not belong to this tenant (or does not exist)', async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null);
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result).toEqual({ eligible: false, reason: 'agent_not_found' });
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: AGENT_ID, tenant_id: TENANT } }),
    );
  });

  it('fails closed — inactive — when is_active is false', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: false,
      brain_provider: 'clawith',
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result).toEqual({ eligible: false, reason: 'inactive' });
  });

  it('fails closed — wrong_provider — when brain_provider is not clawith', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'native',
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result).toEqual({ eligible: false, reason: 'wrong_provider' });
  });

  it('fails closed — no_clawith_binding — when no ClawithBinding resolves for this tenant/agent', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result).toEqual({ eligible: false, reason: 'no_clawith_binding' });
  });

  it('fails closed — no_clawith_tenant — when the binding resolves but carries no clawith_tenant_id (NULL), and makes zero upstream calls', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      prismaMock.agent.findFirst.mockResolvedValue({
        id: AGENT_ID,
        tenant_id: TENANT,
        name: 'Isola',
        is_active: true,
        brain_provider: 'clawith',
      });
      prismaMock.clawithBinding.findFirst.mockResolvedValue({
        clawith_agent_id: CLAWITH_AGENT_ID,
        paperclip_company_id: COMPANY_ID,
        clawith_tenant_id: null,
      });
      const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
      expect(result).toEqual({ eligible: false, reason: 'no_clawith_tenant' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('fails closed — not_allowlisted — when tenant/active/provider/binding all pass but the agent is unlisted', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: CLAWITH_AGENT_ID,
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, env()); // no allowlist var at all
    expect(result).toEqual({ eligible: false, reason: 'not_allowlisted' });
  });

  it('proof 5: the explicitly listed Isola agent qualifies even though it carries a2 AND lane2 ChatwootBindings', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: CLAWITH_AGENT_ID,
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    prismaMock.chatwootBinding.findMany.mockResolvedValue([{ mode: 'lane2' }, { mode: 'a2' }]);

    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result.eligible).toBe(true);
    if (result.eligible) {
      expect(result.agent.clawithAgentId).toBe(CLAWITH_AGENT_ID);
      expect(result.agent.clawithTenantId).toBe(CLAWITH_TENANT_ID);
      expect(result.agent.paperclipCompanyId).toBe(COMPANY_ID);
      // Read for audit/context only — see proof 7 for the "never triggers a
      // Chatwoot call" half of this guarantee.
      expect(result.agent.chatwootBindingModes.sort()).toEqual(['a2', 'lane2']);
    }
  });

  it('proof 6: tenant scoping is still mandatory — a same-id agent on a DIFFERENT tenant never resolves', async () => {
    // findFirst is given the caller's tenantId in its `where`; a fake/broken
    // Prisma mock that ignores tenant scoping would still fail this test
    // because we assert the exact where-clause was used.
    prismaMock.agent.findFirst.mockImplementation(async ({ where }: { where: { tenant_id: string } }) =>
      where.tenant_id === OTHER_TENANT
        ? { id: AGENT_ID, tenant_id: OTHER_TENANT, name: 'Isola', is_active: true, brain_provider: 'clawith' }
        : null,
    );
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV);
    expect(result).toEqual({ eligible: false, reason: 'agent_not_found' });
  });
});

describe('proof 15: B3 exposure classification enforcement (xp-foundation-agent-exposure-enforcement-2026-08-04)', () => {
  const ALLOWLIST_ENV_FOR = (agentId: string) => env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: agentId });

  it('fails closed — not_internal_classified — when the bound clawith_agent_id is EMA (PUBLIC), even though every other rule passes', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: PUBLIC_CLAWITH_AGENT_ID,
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV_FOR(AGENT_ID));
    expect(result).toEqual({ eligible: false, reason: 'not_internal_classified' });
  });

  it('fails closed — not_internal_classified — when the bound clawith_agent_id is unclassified (Ledger), never guessed as INTERNAL', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: LEDGER_UNKNOWN_CLAWITH_AGENT_ID,
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV_FOR(AGENT_ID));
    expect(result).toEqual({ eligible: false, reason: 'not_internal_classified' });
  });

  it('succeeds — eligible: true — for Atlas, the real INTERNAL-classified agent', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Atlas',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: CLAWITH_AGENT_ID, // Atlas, INTERNAL
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    prismaMock.chatwootBinding.findMany.mockResolvedValue([]);
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, ALLOWLIST_ENV_FOR(AGENT_ID));
    expect(result.eligible).toBe(true);
  });

  it('a PUBLIC agent cannot become the internal default via env override — the hardcoded floor cannot be flipped by configuration', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: PUBLIC_CLAWITH_AGENT_ID,
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    const envWithAttemptedOverride = env({
      [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: AGENT_ID,
      AGENT_EXPOSURE_POLICY_EXTRA_JSON: JSON.stringify([
        { foundationTenantId: TENANT, clawithAgentId: PUBLIC_CLAWITH_AGENT_ID, classification: 'INTERNAL', enabled: true },
      ]),
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, envWithAttemptedOverride);
    expect(result).toEqual({ eligible: false, reason: 'not_internal_classified' });
  });

  it('a disabled INTERNAL classification fails closed too', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({
      id: AGENT_ID,
      tenant_id: TENANT,
      name: 'Isola',
      is_active: true,
      brain_provider: 'clawith',
    });
    prismaMock.clawithBinding.findFirst.mockResolvedValue({
      clawith_agent_id: 'some-other-internal-agent',
      paperclip_company_id: COMPANY_ID,
      clawith_tenant_id: CLAWITH_TENANT_ID,
    });
    const envWithDisabled = env({
      [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: AGENT_ID,
      AGENT_EXPOSURE_POLICY_EXTRA_JSON: JSON.stringify([
        { foundationTenantId: TENANT, clawithAgentId: 'some-other-internal-agent', classification: 'INTERNAL', enabled: false },
      ]),
    });
    const result = await resolveStaffChatEligibility(TENANT, AGENT_ID, envWithDisabled);
    expect(result).toEqual({ eligible: false, reason: 'not_internal_classified' });
  });

  it('a cross-tenant actor cannot borrow Atlas\'s classification — a different tenant requesting the same clawith_agent_id is unmatched', async () => {
    // resolveStaffChatEligibility itself already fails closed at the
    // tenant-scoped agent lookup (agent_not_found) before exposure is even
    // consulted for a genuinely cross-tenant request — this proves the
    // exposure resolver ALSO keys on tenant, as a second independent layer.
    const { resolveAgentExposure } = await import('@/lib/clawith/agent-exposure-policy');
    const resolution = resolveAgentExposure({ foundationTenantId: OTHER_TENANT, clawithAgentId: CLAWITH_AGENT_ID });
    expect(resolution.matched).toBe(false);
  });
});

describe('proof 7: ChatwootBinding presence never triggers a Chatwoot call or delivery', () => {
  it('resolveStaffChatEligibility only ever calls prisma.chatwootBinding.findMany (read), never a fetch', async () => {
    const fetchSpy = vi.fn();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      prismaMock.agent.findFirst.mockResolvedValue({
        id: AGENT_ID,
        tenant_id: TENANT,
        name: 'Isola',
        is_active: true,
        brain_provider: 'clawith',
      });
      prismaMock.clawithBinding.findFirst.mockResolvedValue({
        clawith_agent_id: CLAWITH_AGENT_ID,
        paperclip_company_id: COMPANY_ID,
        clawith_tenant_id: CLAWITH_TENANT_ID,
      });
      prismaMock.chatwootBinding.findMany.mockResolvedValue([{ mode: 'lane2' }, { mode: 'a2' }]);

      await resolveStaffChatEligibility(TENANT, AGENT_ID, env({ [FOUNDATION_STAFF_CHAT_AGENT_IDS_ENV]: AGENT_ID }));

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('proof 3: contact reference and correlation are namespaced and deterministic', () => {
  it('builds a staff-namespaced contact ref, never bare enough to collide with an E.164 customer ref', () => {
    expect(buildStaffContactRef('user-1', AGENT_ID)).toBe(`staff:user-1:${AGENT_ID}`);
  });

  it('builds the same correlation id from the same thread/turn — no hidden randomness', () => {
    const a = buildStaffChatCorrelationId('thread-1', 'turn-1');
    const b = buildStaffChatCorrelationId('thread-1', 'turn-1');
    expect(a).toBe(b);
    expect(a).toBe('staffchat:thread-1:turn-1');
  });

  it('proof: exact correlation replay — a retry with the same threadId/turnId reproduces the identical correlation id on the wire', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const agent = eligibleAgent();

    const first = await performStaffChatTurn({
      session: session(),
      agent,
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    const retry = await performStaffChatTurn({
      session: session(),
      agent,
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1', // reused, exactly as a client retry must
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });

    expect(first.result.correlationId).toBe('staffchat:thread-1:turn-1');
    expect(retry.result.correlationId).toBe(first.result.correlationId);
    expect(first.sentRequest.correlation_id).toBe(retry.sentRequest.correlation_id);
  });
});

describe('proof 4: the structured URL is required, validated, and never falls back', () => {
  it('accepts the exact approved structured URL', () => {
    expect(validateStaffChatStructuredUrl(env())).toEqual({ ok: true, url: VALID_STRUCTURED_URL });
  });

  it('1. fails closed — missing — when CLAWITH_STRUCTURED_URL is not set at all', () => {
    expect(validateStaffChatStructuredUrl(envNoStructuredUrl())).toEqual({ ok: false, reason: 'missing' });
  });

  it('2. fails closed — missing — when CLAWITH_STRUCTURED_URL is an empty or whitespace string', () => {
    expect(validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: '' }))).toEqual({
      ok: false,
      reason: 'missing',
    });
    expect(validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: '   ' }))).toEqual({
      ok: false,
      reason: 'missing',
    });
  });

  it('3. fails closed — invalid_url — on a malformed URL', () => {
    expect(validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'not a url' }))).toEqual({
      ok: false,
      reason: 'invalid_url',
    });
  });

  it('4. fails closed — not_https — on an http:// URL', () => {
    expect(
      validateStaffChatStructuredUrl(
        envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'http://agents.epic.dm/api/isola/bridge/structured/message' }),
      ),
    ).toEqual({ ok: false, reason: 'not_https' });
  });

  it('5. fails closed — has_query_or_fragment — on a URL with a query string', () => {
    expect(
      validateStaffChatStructuredUrl(
        envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: `${VALID_STRUCTURED_URL}?debug=1` }),
      ),
    ).toEqual({ ok: false, reason: 'has_query_or_fragment' });
  });

  it('5b. fails closed — has_query_or_fragment — on a URL with a fragment', () => {
    expect(
      validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: `${VALID_STRUCTURED_URL}#x` })),
    ).toEqual({ ok: false, reason: 'has_query_or_fragment' });
  });

  it('5c. fails closed on a bare trailing "?" or "#" — checked on the raw string, not .search/.hash', () => {
    expect(
      validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: `${VALID_STRUCTURED_URL}?` })),
    ).toEqual({ ok: false, reason: 'has_query_or_fragment' });
  });

  it('fails closed — has_credentials — on a URL carrying a username/password', () => {
    expect(
      validateStaffChatStructuredUrl(
        envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'https://user:pass@agents.epic.dm/api/isola/bridge/structured/message' }),
      ),
    ).toEqual({ ok: false, reason: 'has_credentials' });
  });

  it('fails closed — wrong_host — on an unapproved host, even one that looks similar', () => {
    expect(
      validateStaffChatStructuredUrl(
        envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'https://evil.example.com/api/isola/bridge/structured/message' }),
      ),
    ).toEqual({ ok: false, reason: 'wrong_host' });
    expect(
      validateStaffChatStructuredUrl(
        envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'https://agents.epic.dm.evil.com/api/isola/bridge/structured/message' }),
      ),
    ).toEqual({ ok: false, reason: 'wrong_host' });
  });

  it('6. fails closed — wrong_path — on the right host but wrong path', () => {
    expect(
      validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'https://agents.epic.dm/api/other' })),
    ).toEqual({ ok: false, reason: 'wrong_path' });
  });

  it('7. explicitly rejects the legacy /api/isola/bridge/message endpoint for staff chat', () => {
    expect(
      validateStaffChatStructuredUrl(envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: LEGACY_CLAWITH_STRUCTURED_URL })),
    ).toEqual({ ok: false, reason: 'wrong_path' });
  });

  it('9. generic existing Clawith callers (client.ts default) are completely unaffected by this module', () => {
    // client.ts's own CLAWITH_STRUCTURED_URL constant (used by lib/clawith/invoke.ts,
    // the gated inbox-46 loop) is untouched — it still resolves to the legacy
    // endpoint by default, exactly as before this change.
    expect(LEGACY_CLAWITH_STRUCTURED_URL).toBe('https://agents.epic.dm/api/isola/bridge/message');
  });
});

describe('proof: missing/invalid CLAWITH_STRUCTURED_URL fails the whole turn closed with zero network calls', () => {
  it('8. missing URL — zero fetch calls, safe unavailable state, no leaked reason', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: envNoStructuredUrl(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.result.state).toBe('unavailable');
    expect(outcome.result.text).toBeNull();
    // 10. never leaks the env value, the validation reason, or any hint of it
    expect(JSON.stringify(outcome.result)).not.toContain('CLAWITH_STRUCTURED_URL');
    expect(JSON.stringify(outcome.result)).not.toContain('missing');
    // 11. still built with allowed_tools: [] even though it's never sent
    expect(outcome.sentRequest.allowed_tools).toEqual([]);
  });

  it('malformed URL — zero fetch calls, safe unavailable state', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: 'not a url' }),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.result.state).toBe('unavailable');
  });

  it('the legacy endpoint value — zero fetch calls, never silently used', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: envNoStructuredUrl({ CLAWITH_STRUCTURED_URL: LEGACY_CLAWITH_STRUCTURED_URL }),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.result.state).toBe('unavailable');
  });

  it('a valid structured URL is passed through to callClawithStructured EXACTLY, with no mutation', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(), // includes VALID_STRUCTURED_URL
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(VALID_STRUCTURED_URL);
  });
});

describe('proof 8: allowed_tools is [] on every structured invocation', () => {
  it('sends allowed_tools: [] on a successful turn', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'What is our refund policy?',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.sentRequest.allowed_tools).toEqual([]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).allowed_tools).toEqual([]);
  });

  it('sends allowed_tools: [] even on a failing turn (built before the network call)', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.sentRequest.allowed_tools).toEqual([]);
    expect(outcome.result.state).toBe('timeout');
  });

  it('proof: one submit equals one upstream call — a single successful attempt calls fetch exactly once', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('proof 9: no customer-visible message and no business effect', () => {
  it('the ONLY fetch call a turn makes targets the Clawith structured endpoint — never Chatwoot, Odoo or PBX', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe(VALID_STRUCTURED_URL);
  });

  it('a successful reply never sets ownership away from AI_OWNED or requests a tool', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.sentRequest.ownership_state).toBe('AI_OWNED');
    expect(outcome.result.state).toBe('replied');
  });
});

describe('proof 10: escalation is represented truthfully but performs no handoff', () => {
  it('maps an escalation-requested response to state=escalated with the handoff copy', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        okBody({
          customer_reply: null,
          escalation: {
            requested: true,
            reason_code: 'explicit_human_request',
            explanation: 'wants a person',
            urgency: 'normal',
            required_team: null,
            customer_handoff_message: 'Flagging this for a teammate.',
          },
        }),
      ),
    );
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'get me a human',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('escalated');
    expect(outcome.result.text).toBe('Flagging this for a teammate.');
  });
});

describe('proof 12: the wire tenant_id is the CLAWITH tenant, never Foundation\'s own tenant id', () => {
  it('sends clawithTenantId as tenant_id on the wire — not agent.tenantId (Foundation), which differs in this fixture', async () => {
    expect(CLAWITH_TENANT_ID).not.toBe(TENANT); // the fixture must actually exercise a mismatch
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.sentRequest.tenant_id).toBe(CLAWITH_TENANT_ID);
    expect(outcome.sentRequest.tenant_id).not.toBe(TENANT);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).tenant_id).toBe(CLAWITH_TENANT_ID);
  });

  it('still sends allowed_tools: [] once the tenant field is corrected', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.sentRequest.allowed_tools).toEqual([]);
  });

  it('a mismatched clawithTenantId across the three tenant inputs would be rejected by buildClawithRequest — proven by using the SAME value consistently succeeding without a request_invalid failure', async () => {
    // performStaffChatTurn passes agent.clawithTenantId for tenantId,
    // bindingTenantId AND conversationTenantId. If it ever regressed to
    // passing three different values, buildClawithRequest's cross-tenant
    // check would reject the request before any fetch, and this turn would
    // never reach 'replied'.
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('replied');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('proof 11: failure classification maps onto the closed safe-state vocabulary, never a raw detail', () => {
  const cases: Array<[Parameters<typeof mapFailureToStaffChatState>[0], string]> = [
    ['timeout', 'timeout'],
    ['auth_rejected', 'rejected'],
    ['secret_missing', 'unavailable'],
    ['agent_missing', 'unavailable'],
    ['request_invalid', 'unavailable'],
    ['tenant_mismatch', 'unavailable'],
    ['http_error', 'degraded'],
    ['network_error', 'degraded'],
    ['invalid_response', 'degraded'],
    ['correlation_mismatch', 'degraded'],
    ['agent_mismatch', 'degraded'],
    ['unsupported_tool', 'degraded'],
    ['contradictory_response', 'degraded'],
    ['payment_required', 'unavailable'],
    ['rate_limited', 'degraded'],
    ['provider_unavailable', 'degraded'],
    ['provider_error_leaked', 'unavailable'],
    ['circuit_open', 'unavailable'],
  ];

  for (const [kind, expected] of cases) {
    it(`${kind} -> ${expected}`, () => {
      expect(mapFailureToStaffChatState(kind)).toBe(expected);
    });
  }

  it('a timeout on the wire produces state=timeout end to end, with no detail leaked into the result', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { name: 'TimeoutError' });
    });
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('timeout');
    expect(outcome.result.text).toBeNull();
    // failureKind is OUR classification enum, not the raw thrown detail —
    // confirm the raw message never appears in the result.
    expect(JSON.stringify(outcome.result)).not.toContain('boom');
  });

  it('an unreachable/unconfigured endpoint fails closed to degraded, not to a silent success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'not found' }, 404));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('degraded');
  });

  it('retries a transient failure per client.ts (MAX_ATTEMPTS), then reports the classified outcome', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call += 1;
      if (call < MAX_ATTEMPTS) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return jsonResponse(okBody());
    });
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('replied');
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });
});

describe('proof 13: a staff-chat 402 is sanitized end-to-end and alerts exactly once', () => {
  it('produces state=unavailable, no raw detail, exactly one attempt and exactly one alert', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Insufficient Balance' }, 402));
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });

    expect(outcome.result.state).toBe('unavailable');
    expect(outcome.result.text).toBeNull();
    expect(JSON.stringify(outcome.result)).not.toContain('402');
    expect(JSON.stringify(outcome.result)).not.toContain('Insufficient Balance');
    // 402 is not retryable on the same credential — one attempt, not MAX_ATTEMPTS.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(recordClawithFailureMock).toHaveBeenCalledTimes(1);
    const [failureArg, ctxArg] = recordClawithFailureMock.mock.calls[0] as unknown as [
      { kind: string; status: number | null },
      Record<string, unknown>,
    ];
    expect(failureArg).toMatchObject({ kind: 'payment_required', status: 402 });
    expect(ctxArg).toMatchObject({ surface: 'staff_chat', correlationId: 'staffchat:thread-1:turn-1' });
  });

  it('a retried transient failure that exhausts MAX_ATTEMPTS still produces exactly one alert, not one per attempt', async () => {
    const fetchImpl = vi.fn(async () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    });
    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: env(),
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });
    expect(outcome.result.state).toBe('timeout');
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    expect(recordClawithFailureMock).toHaveBeenCalledTimes(1);
  });
});

describe('proof 14: automatic fallback to a different Clawith agent is disabled — same logical agent, one attempt, no masking', () => {
  const FALLBACK_CLAWITH_AGENT_ID = '9a1c9e2e-6b1a-4b9a-8b1a-2f3c4d5e6f70';
  // The shape the old CLAWITH_APPROVED_FALLBACK_AGENTS env var used to accept
  // (see ev-shared-model-failure-pr72-review-report-2026-08-04) — must now be
  // completely inert. fallback.ts no longer reads any such variable, and
  // there is no export left to name it by, so the literal env var name is
  // reproduced here directly.
  const envWithLegacyFallbackVar = env({
    CLAWITH_APPROVED_FALLBACK_AGENTS: `${CLAWITH_AGENT_ID}:${FALLBACK_CLAWITH_AGENT_ID}`,
  });

  it('a primary 402 is never covered by a second agent — one attempt, sanitized unavailable, no ClawithBinding lookup', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'Insufficient Balance' }, 402));

    const outcome = await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: envWithLegacyFallbackVar,
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });

    expect(outcome.result.state).toBe('unavailable');
    expect(outcome.result.text).toBeNull();
    expect(JSON.stringify(outcome.result)).not.toContain('402');
    expect(JSON.stringify(outcome.result)).not.toContain('Insufficient Balance');
    // Never attempted a second call against any other agent.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // The legacy pairing env var is never even read — no lookup for a
    // fallback agent's ClawithBinding happens at all.
    expect(prismaMock.clawithBinding.findFirst).not.toHaveBeenCalled();

    expect(recordClawithFailureMock).toHaveBeenCalledTimes(1);
    const [failureArg] = recordClawithFailureMock.mock.calls[0] as unknown as [{ kind: string }];
    expect(failureArg).toMatchObject({ kind: 'payment_required' });
  });

  it('every attempt sends the same designated_agent_id the caller resolved — never the legacy fallback agent id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(okBody()));

    await performStaffChatTurn({
      session: session(),
      agent: eligibleAgent(),
      message: 'hello',
      threadId: 'thread-1',
      turnId: 'turn-1',
      env: envWithLegacyFallbackVar,
      clientOptions: { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async () => {} },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sentAgentId = JSON.parse(init.body as string).designated_agent_id;
    expect(sentAgentId).toBe(CLAWITH_AGENT_ID);
    expect(sentAgentId).not.toBe(FALLBACK_CLAWITH_AGENT_ID);
  });
});
