/**
 * app/api/lane2/broker/turn route — the wiring proof for the
 * Foundation-brokered Clawith refactor (dec-deepseek-foundation-brokered-
 * clawith-refactor-2026-08-02).
 *
 * Drives the REAL route handler with mocked prisma/audit/Clawith-invoke, so
 * this proves what Foundation resolves and enforces from the request/DB
 * state — never from a caller-supplied identity field, since the envelope
 * has no such field to begin with.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { computeLane2BrokerSignature } from '@/lib/lane2/broker-auth';

const H = vi.hoisted(() => ({
  prismaMock: {
    chatwootBinding: { findMany: vi.fn() },
    clawithBinding: { findFirst: vi.fn() },
  },
  claimInboundMessageIdMock: vi.fn(),
  auditMock: vi.fn(),
  invokeClawithGatedMock: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({ prisma: H.prismaMock }));
vi.mock('@/lib/inbound-dedup', () => ({ claimInboundMessageId: H.claimInboundMessageIdMock }));
vi.mock('@/lib/audit', () => ({ audit: H.auditMock }));
vi.mock('@/lib/clawith/invoke', () => ({ invokeClawithGated: H.invokeClawithGatedMock }));
vi.mock('@/lib/chatwoot-binding-resolution', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  resolveActiveBinding: (bindings: any[]) => bindings[0] ?? null,
}));

import { POST } from './route';

const SECRET = 'test-broker-secret';
const ACCOUNT = '5';
const INBOX = '47';   // the one designed door
const OTHER_INBOX = '46';   // AgentBot 4's door — must never be reachable here
const TENANT_ID = 'tenant-lane2-1';
const AGENT_ID = 'agent-lane2-1';
const CLAWITH_AGENT_ID = 'a71578a4-12cc-4e38-ad24-4b9fffd69309';

function envelope(overrides: Record<string, unknown> = {}) {
  return {
    accountId: ACCOUNT,
    inboxId: INBOX,
    conversationId: 900,
    contactId: 12,
    messageId: 5001,
    message: 'hello from lane2',
    eventType: 'message_created',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    ...overrides,
  };
}

function signedRequest(body: Record<string, unknown>, secret: string = SECRET) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-lane2-broker-signature': computeLane2BrokerSignature(secret, ts, raw),
    'x-lane2-broker-timestamp': ts,
  };
  return new NextRequest('https://foundation.test/api/lane2/broker/turn', {
    method: 'POST',
    headers,
    body: raw,
  });
}

/**
 * Builds a request with NO signature/timestamp headers at all — the actual
 * "unsigned request" case. Deliberately a separate function rather than a
 * falsy-secret branch on signedRequest: a defaulted parameter substitutes
 * its default for an explicit `undefined` argument, so that pattern can
 * never reliably produce an unsigned request (dec-pr68-test-fixes-no-gate-
 * waiver-2026-08-02).
 */
function unsignedRequest(body: Record<string, unknown>) {
  const raw = JSON.stringify(body);
  return new NextRequest('https://foundation.test/api/lane2/broker/turn', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

function activeBinding(overrides: Record<string, unknown> = {}) {
  return {
    id: 'binding-1',
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    inbox_id: INBOX,
    mode: 'lane2',
    updated_at: new Date(),
    tenant: { id: TENANT_ID, status: 'active' },
    agent: { id: AGENT_ID, is_active: true, brain_provider: 'clawith' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LANE2_BROKER_SHARED_SECRET = SECRET;
  delete process.env.LANE2_BROKER_ALLOWED_DOOR_KEYS;
  // B2 exposure gate fixture — this suite's TENANT_ID/CLAWITH_AGENT_ID are
  // synthetic and not part of the real production B1 policy floor
  // (lib/clawith/agent-exposure-policy.ts default-denies them). Authorize
  // exactly this pair as PUBLIC so the pre-existing wiring proofs below keep
  // exercising invokeClawithGated. See the dedicated "B2 exposure gate"
  // describe block for the gate's own denial coverage on this route.
  process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
    { foundationTenantId: TENANT_ID, clawithAgentId: CLAWITH_AGENT_ID, classification: 'PUBLIC', enabled: true },
  ]);
  H.claimInboundMessageIdMock.mockResolvedValue(false);
  H.prismaMock.chatwootBinding.findMany.mockResolvedValue([activeBinding()]);
  H.prismaMock.clawithBinding.findFirst.mockResolvedValue({
    id: 'clawith-binding-1', tenant_id: TENANT_ID, agent_id: AGENT_ID,
    clawith_agent_id: CLAWITH_AGENT_ID, paperclip_agent_id: 'p-agent-1', paperclip_company_id: 'p-company-1',
  });
  H.invokeClawithGatedMock.mockResolvedValue({
    kind: 'reply', text: 'hi there', needsHandoff: false,
    response: { schema_version: '1.0.0' },
  });
});

describe('auth', () => {
  it('rejects an unsigned request', async () => {
    const res = await POST(unsignedRequest(envelope()));
    expect(res.status).toBe(401);
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('rejects a request signed with the wrong secret', async () => {
    const res = await POST(signedRequest(envelope(), 'wrong-secret'));
    expect(res.status).toBe(401);
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed request', async () => {
    const res = await POST(signedRequest(envelope()));
    expect(res.status).toBe(200);
    expect(H.invokeClawithGatedMock).toHaveBeenCalledTimes(1);
  });
});

describe('event filtering', () => {
  it('acknowledges but ignores a non-message_created event without touching Clawith', async () => {
    const res = await POST(signedRequest(envelope({ eventType: 'conversation_resolved' })));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, outcome: 'ignored_event_type' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });
});

describe('door allowlist', () => {
  it('proves AgentBot 4 / inbox 46 is unreachable through this route', async () => {
    const res = await POST(signedRequest(envelope({ inboxId: OTHER_INBOX })));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'door_not_allowed' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
    expect(H.prismaMock.chatwootBinding.findMany).not.toHaveBeenCalled();
  });

  it('allows the designed inbox 47 door', async () => {
    const res = await POST(signedRequest(envelope()));
    expect(res.status).toBe(200);
    expect(H.invokeClawithGatedMock).toHaveBeenCalledTimes(1);
  });
});

describe('idempotency', () => {
  it('suppresses a duplicate event without a second Clawith invocation', async () => {
    H.claimInboundMessageIdMock.mockResolvedValue(true);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, outcome: 'duplicate_suppressed', duplicate: true });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });
});

describe('tenant resolution', () => {
  it('returns tenant_unresolved, never a fabricated tenant, when no binding exists', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'tenant_unresolved' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
    expect(H.auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'lane2.broker.turn.refused' }));
  });

  it('refuses a suspended tenant rather than treating it as active', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([
      activeBinding({ tenant: { id: TENANT_ID, status: 'suspended' } }),
    ]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'tenant_unresolved' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });
});

describe('agent resolution', () => {
  it('refuses when the binding has no explicit agent (no implicit fallback)', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([activeBinding({ agent: null })]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'agent_unresolved' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('refuses when the bound agent is not brain_provider=clawith', async () => {
    H.prismaMock.chatwootBinding.findMany.mockResolvedValue([
      activeBinding({ agent: { id: AGENT_ID, is_active: true, brain_provider: 'native' } }),
    ]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'agent_unresolved' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('never trusts a caller-supplied agent id — the envelope has no such field', async () => {
    const res = await POST(signedRequest(envelope({ agentId: 'attacker-supplied-agent' } as never)));
    const body = await res.json();
    expect(res.status).toBe(200);
    const call = H.invokeClawithGatedMock.mock.calls[0][0];
    expect(call.designatedAgentId).toBe(CLAWITH_AGENT_ID);
    expect(body.agentId).toBe(CLAWITH_AGENT_ID);
  });
});

describe('clawith binding resolution', () => {
  it('refuses when no ClawithBinding exists for the tenant', async () => {
    H.prismaMock.clawithBinding.findFirst.mockResolvedValue(null);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'clawith_binding_unresolved' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });
});

describe('B2 exposure gate (xp-foundation-agent-exposure-enforcement-2026-08-04)', () => {
  it('denies dispatch when the bound clawith_agent_id has no PUBLIC policy for this tenant — never calls invokeClawithGated', async () => {
    delete process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON; // withdraw this suite's own PUBLIC authorization
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'exposure_denied', reason: 'not_public_classified' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('denies dispatch when the classification is explicitly INTERNAL for this tenant/agent', async () => {
    process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
      { foundationTenantId: TENANT_ID, clawithAgentId: CLAWITH_AGENT_ID, classification: 'INTERNAL', enabled: true },
    ]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'exposure_denied', reason: 'not_public_classified' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('denies dispatch when the policy entry is disabled', async () => {
    process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON = JSON.stringify([
      { foundationTenantId: TENANT_ID, clawithAgentId: CLAWITH_AGENT_ID, classification: 'PUBLIC', enabled: false },
    ]);
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'exposure_denied', reason: 'not_public_classified' });
    expect(H.invokeClawithGatedMock).not.toHaveBeenCalled();
  });

  it('writes no audit entry of its own beyond the gate\'s internal denial record — the route does not double-audit', async () => {
    delete process.env.AGENT_EXPOSURE_POLICY_EXTRA_JSON;
    await POST(signedRequest(envelope()));
    // The gate itself (lib/clawith/customer-exposure-gate.ts) is the audit
    // author on denial — real in this test (not mocked), so it writes
    // through the mocked @/lib/audit module exactly once.
    expect(H.auditMock).toHaveBeenCalledTimes(1);
    expect(H.auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'clawith.exposure.customer_denied', tenantId: TENANT_ID }),
    );
  });

  it('an authorized PUBLIC pair (this suite\'s default fixture) is unaffected — proves the gate is not merely fail-open by accident', async () => {
    const res = await POST(signedRequest(envelope()));
    expect(res.status).toBe(200);
    expect(H.invokeClawithGatedMock).toHaveBeenCalledTimes(1);
  });
});

describe('outcome mapping and audit', () => {
  it('maps a reply outcome to ok:true and records the audit row', async () => {
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, outcome: 'reply', text: 'hi there', customerState: 'unavailable' });
    expect(H.auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'lane2.broker.turn', tenantId: TENANT_ID }));
  });

  it('maps a safe_unavailable Clawith failure to ok:false without throwing', async () => {
    H.invokeClawithGatedMock.mockResolvedValue({
      kind: 'safe_unavailable', text: 'unavailable line', needsHandoff: true,
      failure: { kind: 'network_error', detail: null, status: null, correlationId: 'c', conversationId: '900', inboundMessageId: '5001' },
    });
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body).toMatchObject({ ok: false, outcome: 'safe_unavailable' });
  });

  it('never re-interprets or rewrites the text Clawith/Foundation produced', async () => {
    H.invokeClawithGatedMock.mockResolvedValue({
      kind: 'reply', text: 'the exact authoritative text', needsHandoff: false,
      response: { schema_version: '1.0.0' },
    });
    const res = await POST(signedRequest(envelope()));
    const body = await res.json();
    expect(body.text).toBe('the exact authoritative text');
  });
});
