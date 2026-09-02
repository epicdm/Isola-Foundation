/**
 * Isola employee template loading and validation.
 *
 * An Isola employee template is a versioned directory under
 * `artifacts/isola/templates/employees/<templateId>/<version>/` containing:
 *
 *   AGENTS.md          the Paperclip instructions/persona package entry file
 *   .paperclip.yaml    the Paperclip-native agent sidecar
 *   isola-sidecar.json the thin Isola cross-system contract
 *
 * The entry file is `AGENTS.md`, PLURAL. Paperclip's package reader only matches
 * `endsWith("/AGENTS.md")` (server/src/services/company-portability.ts:2492). Its own
 * board-operator doc says `AGENT.md` and is wrong: a package written to the doc imports
 * zero agents and reports success. `assertTemplateShape` fails closed on that mistake so
 * it can never ship silently.
 *
 * These functions are pure and filesystem-free except `loadTemplate`, so the invariants
 * can be unit-tested without a live Paperclip.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Exposure = 'INTERNAL' | 'PUBLIC';

/** Every capability an Isola employee runtime may be granted. All must be false. */
export interface ToolPolicy {
  shell: boolean;
  filesystem: boolean;
  web: boolean;
  mcp: boolean;
  customTools: boolean;
  paperclipVolume: boolean;
  masterKey: boolean;
  unrelatedCredentials: boolean;
  internalEmployeeContext?: boolean;
}

export interface IsolaSidecar {
  templateId: string;
  templateVersion: string;
  templateKey: string;
  displayName: string;
  exposure: Exposure;
  exposureFailClosed: 'INTERNAL';
  toolPolicy: ToolPolicy;
  channelRequirements: {
    publicInboxBindingPermitted: boolean | string;
    internalEmployeeMayBindPublicInbox?: boolean;
    odooWrite: boolean;
    [k: string]: unknown;
  };
  runtimeProfile: { credentialClass: string; timeoutMs: number; [k: string]: unknown };
  approvalThresholds: Record<string, unknown>;
  acceptanceJob: Record<string, unknown>;
  escalationAndHandback: Record<string, unknown>;
  supportBoundary: Record<string, unknown>;
  rollback: Record<string, unknown>;
  [k: string]: unknown;
}

/**
 * Absolute path to the template root, resolved from this module rather than from the
 * process cwd. Callers run from the repo root, from `artifacts/isola` (vitest) and from a
 * built server bundle, so a cwd-relative path silently resolves to three different places.
 */
export const TEMPLATE_ROOT = fileURLToPath(new URL('../templates/employees', import.meta.url));

/** The capability keys that must be denied on every template, without exception. */
export const REQUIRED_DENIED_CAPABILITIES = [
  'shell',
  'filesystem',
  'web',
  'mcp',
  'customTools',
  'paperclipVolume',
  'masterKey',
  'unrelatedCredentials',
] as const;

/**
 * Resolve a declared exposure, failing closed.
 *
 * Anything missing, misspelled, wrongly cased or of the wrong type resolves to INTERNAL.
 * INTERNAL is the safe default because it carries no public channel binding and no
 * customer-facing send.
 */
export function resolveExposure(raw: unknown): Exposure {
  return raw === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
}

/**
 * Decide whether a credential bound to `credentialExposure` may run a template of
 * `templateExposure`. Exact match only — there is deliberately no "INTERNAL can do
 * anything" escalation, because the INTERNAL employee must not be able to reach the
 * customer-facing template.
 */
export function credentialMayRun(credentialExposure: unknown, templateExposure: unknown): boolean {
  const cred = resolveExposure(credentialExposure);
  const tmpl = resolveExposure(templateExposure);
  // Only trust an explicit, exactly-matching PUBLIC declaration on both sides.
  if (tmpl === 'PUBLIC') return credentialExposure === 'PUBLIC' && templateExposure === 'PUBLIC';
  return cred === 'INTERNAL' && tmpl === 'INTERNAL';
}

export class TemplateShapeError extends Error {}

/** Validate a parsed sidecar. Throws TemplateShapeError with a precise reason. */
export function assertSidecarShape(sidecar: unknown, where = '<sidecar>'): asserts sidecar is IsolaSidecar {
  const s = sidecar as Partial<IsolaSidecar> | null;
  const fail = (msg: string): never => {
    throw new TemplateShapeError(`${where}: ${msg}`);
  };

  if (!s || typeof s !== 'object') fail('not an object');

  for (const key of ['templateId', 'templateVersion', 'templateKey', 'displayName'] as const) {
    if (typeof s![key] !== 'string' || !s![key]) fail(`missing string \`${key}\``);
  }

  if (s!.templateKey !== `${s!.templateId}@${s!.templateVersion}`) {
    fail(`templateKey \`${s!.templateKey}\` must equal \`${s!.templateId}@${s!.templateVersion}\``);
  }

  // Exposure must be declared explicitly and exactly. A template that relies on the
  // fail-closed default is a template whose author did not decide.
  if (s!.exposure !== 'INTERNAL' && s!.exposure !== 'PUBLIC') {
    fail('`exposure` must be exactly "INTERNAL" or "PUBLIC"');
  }
  if (s!.exposureFailClosed !== 'INTERNAL') {
    fail('`exposureFailClosed` must be "INTERNAL"');
  }

  const tp = s!.toolPolicy as Record<string, unknown> | undefined;
  if (!tp || typeof tp !== 'object') fail('missing `toolPolicy`');
  for (const cap of REQUIRED_DENIED_CAPABILITIES) {
    if (tp![cap] !== false) fail(`toolPolicy.${cap} must be exactly false (got ${JSON.stringify(tp![cap])})`);
  }

  const ch = s!.channelRequirements as Record<string, unknown> | undefined;
  if (!ch || typeof ch !== 'object') fail('missing `channelRequirements`');
  if (ch!.odooWrite !== false) fail('channelRequirements.odooWrite must be false');

  // An INTERNAL employee may never be bindable to a public inbox. This is the invariant
  // behind acceptance test 21.
  if (s!.exposure === 'INTERNAL' && ch!.publicInboxBindingPermitted !== false) {
    fail('an INTERNAL template must set channelRequirements.publicInboxBindingPermitted to false');
  }
  if (ch!.internalEmployeeMayBindPublicInbox !== undefined && ch!.internalEmployeeMayBindPublicInbox !== false) {
    fail('channelRequirements.internalEmployeeMayBindPublicInbox must be false when present');
  }

  for (const key of [
    'runtimeProfile',
    'approvalThresholds',
    'acceptanceJob',
    'escalationAndHandback',
    'supportBoundary',
    'rollback',
  ] as const) {
    if (!s![key] || typeof s![key] !== 'object') fail(`missing object \`${key}\``);
  }

  const rp = s!.runtimeProfile as Record<string, unknown>;
  if (typeof rp.credentialClass !== 'string' || !rp.credentialClass) {
    fail('runtimeProfile.credentialClass must be a non-empty string');
  }
  // 0 or absent means "no timeout at all" in Paperclip's http adapter. That would let a
  // hung runtime pin a run open forever, so it is rejected here.
  if (typeof rp.timeoutMs !== 'number' || !Number.isFinite(rp.timeoutMs) || rp.timeoutMs <= 0) {
    fail('runtimeProfile.timeoutMs must be a positive number (0/absent means NO timeout in Paperclip)');
  }

  // The credential class must match the exposure, or the boundary is decorative.
  const expected = s!.exposure === 'PUBLIC' ? 'RUNTIME_SECRET_PUBLIC' : 'RUNTIME_SECRET_INTERNAL';
  if (rp.credentialClass !== expected) {
    fail(`runtimeProfile.credentialClass must be \`${expected}\` for exposure ${s!.exposure}`);
  }
}

/** Assert the on-disk shape of a template directory. */
export function assertTemplateShape(dir: string): void {
  if (existsSync(join(dir, 'AGENT.md')) && !existsSync(join(dir, 'AGENTS.md'))) {
    throw new TemplateShapeError(
      `${dir}: found AGENT.md but not AGENTS.md. Paperclip's reader only matches AGENTS.md ` +
        `(plural); a package with AGENT.md imports zero agents and reports success.`,
    );
  }
  for (const f of ['AGENTS.md', '.paperclip.yaml', 'isola-sidecar.json']) {
    if (!existsSync(join(dir, f))) throw new TemplateShapeError(`${dir}: missing ${f}`);
  }
}

export interface LoadedTemplate {
  dir: string;
  sidecar: IsolaSidecar;
  agentsMd: string;
  paperclipYaml: string;
}

/** Load and validate one template directory. */
export function loadTemplate(dir: string): LoadedTemplate {
  assertTemplateShape(dir);
  const sidecar = JSON.parse(readFileSync(join(dir, 'isola-sidecar.json'), 'utf8')) as unknown;
  assertSidecarShape(sidecar, dir);

  const paperclipYaml = readFileSync(join(dir, '.paperclip.yaml'), 'utf8');
  // Cheap, dependency-free cross-check: the exposure the runtime will be told must match
  // the exposure the sidecar declares. A mismatch here is exactly how a PUBLIC employee
  // would end up running on an INTERNAL credential.
  const declared = /exposure:\s*(INTERNAL|PUBLIC)/.exec(paperclipYaml)?.[1];
  if (declared !== sidecar.exposure) {
    throw new TemplateShapeError(
      `${dir}: .paperclip.yaml payloadTemplate exposure (${declared ?? 'absent'}) ` +
        `does not match isola-sidecar.json exposure (${sidecar.exposure})`,
    );
  }

  return { dir, sidecar, agentsMd: readFileSync(join(dir, 'AGENTS.md'), 'utf8'), paperclipYaml };
}
