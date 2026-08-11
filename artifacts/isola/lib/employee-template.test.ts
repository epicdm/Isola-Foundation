import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  REQUIRED_DENIED_CAPABILITIES,
  TEMPLATE_ROOT,
  TemplateShapeError,
  assertSidecarShape,
  assertTemplateShape,
  credentialMayRun,
  loadTemplate,
  resolveExposure,
} from './employee-template';

const SHIPPED = [
  { dir: join(TEMPLATE_ROOT, 'epic-staff-operations-coordinator', 'v1'), exposure: 'INTERNAL' },
  { dir: join(TEMPLATE_ROOT, 'isola-ai-sales-front-desk-agent', 'v1'), exposure: 'PUBLIC' },
] as const;

function validSidecar(over: Record<string, unknown> = {}) {
  return {
    templateId: 't',
    templateVersion: 'v1',
    templateKey: 't@v1',
    displayName: 'T',
    exposure: 'INTERNAL',
    exposureFailClosed: 'INTERNAL',
    toolPolicy: Object.fromEntries(REQUIRED_DENIED_CAPABILITIES.map((c) => [c, false])),
    channelRequirements: { publicInboxBindingPermitted: false, odooWrite: false },
    runtimeProfile: { credentialClass: 'RUNTIME_SECRET_INTERNAL', timeoutMs: 1000 },
    approvalThresholds: {},
    acceptanceJob: {},
    escalationAndHandback: {},
    supportBoundary: {},
    rollback: {},
    ...over,
  };
}

describe('resolveExposure — fails closed', () => {
  it('accepts only the exact string PUBLIC', () => {
    expect(resolveExposure('PUBLIC')).toBe('PUBLIC');
  });

  // Everything else is INTERNAL. The point is that a typo, a casing slip, a null from a
  // missing field or an attacker-supplied object can never widen exposure.
  const notPublic: Array<[unknown, string]> = [
    ['public', 'lowercase'],
    ['Public', 'title case'],
    ['PUBLIC ', 'trailing space'],
    [undefined, 'absent'],
    [null, 'null'],
    ['', 'empty string'],
    ['INTERNAL', 'internal'],
    ['ANYTHING', 'unknown value'],
    [1, 'number'],
    [true, 'boolean'],
    [{ toString: () => 'PUBLIC' }, 'object that stringifies to PUBLIC'],
    [['PUBLIC'], 'array containing PUBLIC'],
  ];
  it.each(notPublic)('resolves %s (%s) to INTERNAL', (input: unknown) => {
    expect(resolveExposure(input)).toBe('INTERNAL');
  });
});

describe('credentialMayRun — exposure classes are isolated in both directions', () => {
  it('allows exact matches', () => {
    expect(credentialMayRun('INTERNAL', 'INTERNAL')).toBe(true);
    expect(credentialMayRun('PUBLIC', 'PUBLIC')).toBe(true);
  });

  it('refuses an INTERNAL credential against the PUBLIC template', () => {
    // This is the concrete attack: the INTERNAL employee can read its own bearer out of
    // adapterConfig, so it must not be able to drive the customer-facing template.
    expect(credentialMayRun('INTERNAL', 'PUBLIC')).toBe(false);
  });

  it('refuses a PUBLIC credential against the INTERNAL template', () => {
    expect(credentialMayRun('PUBLIC', 'INTERNAL')).toBe(false);
  });

  it('refuses fuzzy PUBLIC declarations on either side', () => {
    expect(credentialMayRun('public', 'PUBLIC')).toBe(false);
    expect(credentialMayRun('PUBLIC', 'public')).toBe(false);
    expect(credentialMayRun(undefined, 'PUBLIC')).toBe(false);
    expect(credentialMayRun('PUBLIC', undefined)).toBe(false);
  });
});

describe('assertSidecarShape', () => {
  it('accepts a well-formed sidecar', () => {
    expect(() => assertSidecarShape(validSidecar())).not.toThrow();
  });

  it.each(REQUIRED_DENIED_CAPABILITIES)('rejects toolPolicy.%s that is not false', (cap) => {
    const s = validSidecar();
    (s.toolPolicy as Record<string, unknown>)[cap] = true;
    expect(() => assertSidecarShape(s)).toThrow(TemplateShapeError);
  });

  it('rejects a truthy-but-not-false capability such as "false" the string', () => {
    const s = validSidecar();
    (s.toolPolicy as Record<string, unknown>).shell = 'false';
    expect(() => assertSidecarShape(s)).toThrow(/must be exactly false/);
  });

  it('rejects a missing capability key outright', () => {
    const s = validSidecar();
    delete (s.toolPolicy as Record<string, unknown>).mcp;
    expect(() => assertSidecarShape(s)).toThrow(/toolPolicy\.mcp/);
  });

  it('rejects an exposure that is not exactly INTERNAL or PUBLIC', () => {
    expect(() => assertSidecarShape(validSidecar({ exposure: 'public' }))).toThrow(/exposure/);
    expect(() => assertSidecarShape(validSidecar({ exposure: undefined }))).toThrow(/exposure/);
  });

  it('requires exposureFailClosed to be INTERNAL', () => {
    expect(() => assertSidecarShape(validSidecar({ exposureFailClosed: 'PUBLIC' }))).toThrow(
      /exposureFailClosed/,
    );
  });

  it('requires templateKey to agree with id and version', () => {
    expect(() => assertSidecarShape(validSidecar({ templateKey: 't@v2' }))).toThrow(/templateKey/);
  });

  it('forbids an INTERNAL template from being bindable to a public inbox', () => {
    const s = validSidecar({
      channelRequirements: { publicInboxBindingPermitted: true, odooWrite: false },
    });
    expect(() => assertSidecarShape(s)).toThrow(/publicInboxBindingPermitted/);
  });

  it('forbids odooWrite', () => {
    const s = validSidecar({
      channelRequirements: { publicInboxBindingPermitted: false, odooWrite: true },
    });
    expect(() => assertSidecarShape(s)).toThrow(/odooWrite/);
  });

  it('rejects timeoutMs of 0 — in Paperclip that means no timeout at all', () => {
    const s = validSidecar({
      runtimeProfile: { credentialClass: 'RUNTIME_SECRET_INTERNAL', timeoutMs: 0 },
    });
    expect(() => assertSidecarShape(s)).toThrow(/timeoutMs/);
  });

  it('rejects a credential class that does not match the exposure', () => {
    const s = validSidecar({
      exposure: 'PUBLIC',
      channelRequirements: { publicInboxBindingPermitted: true, odooWrite: false },
      runtimeProfile: { credentialClass: 'RUNTIME_SECRET_INTERNAL', timeoutMs: 1000 },
    });
    expect(() => assertSidecarShape(s)).toThrow(/credentialClass/);
  });
});

describe('assertTemplateShape — the AGENTS.md import trap', () => {
  it('rejects a directory that has AGENT.md instead of AGENTS.md', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isola-tmpl-'));
    try {
      writeFileSync(join(dir, 'AGENT.md'), '# oops');
      writeFileSync(join(dir, '.paperclip.yaml'), 'schema: paperclip/v1\n');
      writeFileSync(join(dir, 'isola-sidecar.json'), '{}');
      // Paperclip would accept this package and silently import zero agents.
      expect(() => assertTemplateShape(dir)).toThrow(/AGENTS\.md/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a directory missing the Isola sidecar', () => {
    const dir = mkdtempSync(join(tmpdir(), 'isola-tmpl-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'AGENTS.md'), '# ok');
      writeFileSync(join(dir, '.paperclip.yaml'), 'schema: paperclip/v1\n');
      expect(() => assertTemplateShape(dir)).toThrow(/isola-sidecar\.json/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the two shipped templates', () => {
  it.each(SHIPPED)('$dir loads and validates', ({ dir, exposure }) => {
    const t = loadTemplate(dir);
    expect(t.sidecar.exposure).toBe(exposure);
    expect(t.agentsMd.length).toBeGreaterThan(200);
  });

  it('ships exactly one INTERNAL and one PUBLIC template', () => {
    const exposures = SHIPPED.map((s) => loadTemplate(s.dir).sidecar.exposure).sort();
    expect(exposures).toEqual(['INTERNAL', 'PUBLIC']);
  });

  it('gives the two templates distinct credential classes', () => {
    const [a, b] = SHIPPED.map((s) => loadTemplate(s.dir).sidecar.runtimeProfile.credentialClass);
    expect(a).not.toBe(b);
  });

  it('denies every prohibited capability on both templates', () => {
    for (const { dir } of SHIPPED) {
      const { sidecar } = loadTemplate(dir);
      for (const cap of REQUIRED_DENIED_CAPABILITIES) {
        expect(sidecar.toolPolicy[cap], `${dir} ${cap}`).toBe(false);
      }
    }
  });

  it('keeps the PUBLIC template staged and not Ready', () => {
    const { sidecar, paperclipYaml } = loadTemplate(SHIPPED[1].dir);
    expect(sidecar.lifecycle).toBe('staged-not-ready');
    expect(paperclipYaml).toMatch(/status:\s*paused/);
  });

  it('disables timer heartbeats on both templates', () => {
    for (const { dir } of SHIPPED) {
      expect(loadTemplate(dir).paperclipYaml, dir).toMatch(/heartbeat:\s*\n\s*enabled:\s*false/);
    }
  });

  it('uses timeoutMs, never the non-existent timeoutSec, in adapterConfig', () => {
    for (const { dir } of SHIPPED) {
      const { paperclipYaml } = loadTemplate(dir);
      expect(paperclipYaml, dir).toMatch(/timeoutMs:\s*[1-9]/);
      expect(paperclipYaml.replace(/#.*$/gm, ''), dir).not.toMatch(/timeoutSec:/);
    }
  });
});
