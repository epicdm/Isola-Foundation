import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { TEMPLATE_ROOT, loadTemplate } from './employee-template';
import {
  ProvisioningError,
  agentExposure,
  buildHirePayload,
  detectDrift,
  findExistingForTemplate,
  templateIdOf,
  type PaperclipAgent,
} from './employee-provisioning';

const INTERNAL = loadTemplate(join(TEMPLATE_ROOT, 'epic-staff-operations-coordinator', 'v1')).sidecar;
const PUBLIC = loadTemplate(join(TEMPLATE_ROOT, 'isola-ai-sales-front-desk-agent', 'v1')).sidecar;

const baseOpts = {
  instanceName: 'EPIC Staff Operations Coordinator',
  title: 'Coordinator',
  capabilities: 'analysis only',
  reportsToAgentId: 'ce2dd64b-82de-4045-a457-0e187ea556cb',
  runtimeUrl: 'https://isola-runtime.saas00.epic.dm/v1/invoke',
  runtimeBearer: 'secret-internal',
  budgetMonthlyCents: 1000,
};

const agent = (over: Partial<PaperclipAgent> = {}): PaperclipAgent => ({
  id: 'a1',
  companyId: 'c1',
  name: 'x',
  status: 'idle',
  adapterType: 'http',
  metadata: { isolaTemplateId: 'epic-staff-operations-coordinator' },
  ...over,
});

describe('create-or-get identity', () => {
  it('matches on metadata.isolaTemplateId, not on display name', () => {
    // The PUBLIC template is deliberately instantiated under a different display name.
    const agents = [agent({ id: 'a9', name: 'Completely Renamed By An Operator' })];
    expect(findExistingForTemplate(agents, 'epic-staff-operations-coordinator')?.id).toBe('a9');
  });

  it('returns null when absent, so the caller creates', () => {
    expect(findExistingForTemplate([], 'epic-staff-operations-coordinator')).toBeNull();
  });

  it('ignores agents with no Isola metadata, such as the pre-existing CEO', () => {
    const ceo = agent({ id: 'ceo', metadata: null, role: 'ceo' });
    expect(templateIdOf(ceo)).toBeNull();
    expect(findExistingForTemplate([ceo], 'epic-staff-operations-coordinator')).toBeNull();
  });

  it('throws rather than picking one when a duplicate already exists', () => {
    // Silently picking the first would hide the duplicate and let retries compound it.
    const dupes = [agent({ id: 'a1' }), agent({ id: 'a2' })];
    expect(() => findExistingForTemplate(dupes, 'epic-staff-operations-coordinator')).toThrow(
      /ambiguous: 2 agents/,
    );
  });
});

describe('buildHirePayload', () => {
  it('produces an http adapter config with a positive timeoutMs and no timeoutSec', () => {
    const p = buildHirePayload({ ...baseOpts, sidecar: INTERNAL });
    expect(p.adapterType).toBe('http');
    expect(p.adapterConfig.timeoutMs).toBeGreaterThan(0);
    expect(p.adapterConfig).not.toHaveProperty('timeoutSec');
  });

  it('carries the template key and exposure in the payload template', () => {
    const p = buildHirePayload({ ...baseOpts, sidecar: INTERNAL });
    expect(p.adapterConfig.payloadTemplate).toEqual({
      templateId: 'epic-staff-operations-coordinator@v1',
      exposure: 'INTERNAL',
    });
  });

  it('disables timer heartbeats', () => {
    const p = buildHirePayload({ ...baseOpts, sidecar: INTERNAL });
    expect((p.runtimeConfig.heartbeat as Record<string, unknown>).enabled).toBe(false);
  });

  it('stamps the stable create-or-get key into metadata', () => {
    const p = buildHirePayload({ ...baseOpts, sidecar: INTERNAL });
    expect(p.metadata.isolaTemplateId).toBe('epic-staff-operations-coordinator');
    expect(p.metadata.isolaExposure).toBe('INTERNAL');
  });

  it('marks the PUBLIC employee as staged, not ready', () => {
    const p = buildHirePayload({
      ...baseOpts,
      sidecar: PUBLIC,
      instanceName: 'EPIC AI Sales & Front Desk Agent',
      runtimeBearer: 'secret-public',
    });
    expect(p.metadata.isolaLifecycle).toBe('staged-not-ready');
    expect(p.metadata.isolaExposure).toBe('PUBLIC');
  });

  it('refuses a bearer whose class does not match the exposure', () => {
    const wrong = { ...PUBLIC, runtimeProfile: { ...PUBLIC.runtimeProfile, credentialClass: 'RUNTIME_SECRET_INTERNAL' } };
    expect(() => buildHirePayload({ ...baseOpts, sidecar: wrong })).toThrow(ProvisioningError);
  });

  it('refuses a non-https runtime url so the bearer is never sent in clear', () => {
    expect(() =>
      buildHirePayload({ ...baseOpts, sidecar: INTERNAL, runtimeUrl: 'http://isola-runtime/v1/invoke' }),
    ).toThrow(/https/);
  });

  it('refuses an empty bearer', () => {
    expect(() => buildHirePayload({ ...baseOpts, sidecar: INTERNAL, runtimeBearer: '' })).toThrow(
      /missing runtime bearer/,
    );
  });

  it('refuses a zero timeout, which Paperclip reads as no timeout at all', () => {
    const bad = { ...INTERNAL, runtimeProfile: { ...INTERNAL.runtimeProfile, timeoutMs: 0 } };
    expect(() => buildHirePayload({ ...baseOpts, sidecar: bad })).toThrow(/timeoutMs/);
  });

  it('gives the two shipped templates different bearers and different template ids', () => {
    const a = buildHirePayload({ ...baseOpts, sidecar: INTERNAL, runtimeBearer: 'i' });
    const b = buildHirePayload({
      ...baseOpts, sidecar: PUBLIC, runtimeBearer: 'p', instanceName: 'EPIC AI Sales & Front Desk Agent',
    });
    const auth = (p: typeof a) => (p.adapterConfig.headers as Record<string, string>).Authorization;
    expect(auth(a)).not.toBe(auth(b));
    expect(p1(a)).not.toBe(p1(b));
    function p1(p: typeof a) {
      return (p.adapterConfig.payloadTemplate as Record<string, unknown>).templateId;
    }
  });
});

describe('detectDrift — an agent may PATCH its own adapterConfig in Paperclip', () => {
  const expected = buildHirePayload({ ...baseOpts, sidecar: INTERNAL });
  const provisioned = agent({ adapterConfig: expected.adapterConfig, metadata: expected.metadata });

  it('reports no drift for a freshly provisioned agent', () => {
    expect(detectDrift(provisioned, expected)).toEqual([]);
  });

  it('catches an agent that rewrote its own template id', () => {
    const tampered = agent({
      adapterConfig: {
        ...expected.adapterConfig,
        payloadTemplate: { templateId: 'isola-ai-sales-front-desk-agent@v1', exposure: 'PUBLIC' },
      },
      metadata: expected.metadata,
    });
    const drift = detectDrift(tampered, expected);
    expect(drift).toContain('payloadTemplate.templateId changed');
    expect(drift).toContain('payloadTemplate.exposure changed');
  });

  it('catches an agent that removed its own timeout', () => {
    const tampered = agent({
      adapterConfig: { ...expected.adapterConfig, timeoutMs: 0 },
      metadata: expected.metadata,
    });
    expect(detectDrift(tampered, expected).join()).toMatch(/timeoutMs/);
  });

  it('catches a smuggled dangerouslySkipPermissions', () => {
    const tampered = agent({
      adapterConfig: { ...expected.adapterConfig, dangerouslySkipPermissions: true },
      metadata: expected.metadata,
    });
    expect(detectDrift(tampered, expected).join()).toMatch(/dangerouslySkipPermissions/);
  });

  it('catches an exposure upgrade in metadata', () => {
    const tampered = agent({
      adapterConfig: expected.adapterConfig,
      metadata: { ...expected.metadata, isolaExposure: 'PUBLIC' },
    });
    expect(detectDrift(tampered, expected)).toContain('metadata.isolaExposure changed');
  });
});

describe('agentExposure fails closed', () => {
  it('treats a missing or malformed exposure as INTERNAL', () => {
    expect(agentExposure(agent({ metadata: null }))).toBe('INTERNAL');
    expect(agentExposure(agent({ metadata: { isolaExposure: 'public' } }))).toBe('INTERNAL');
    expect(agentExposure(agent({ metadata: { isolaExposure: 'PUBLIC' } }))).toBe('PUBLIC');
  });
});
