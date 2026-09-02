/**
 * Pure helpers for provisioning Isola employee templates into a Paperclip company.
 *
 * Kept free of I/O so the create-or-get identity rule and the hire payload can be
 * unit-tested without touching the live instance. The thin I/O driver lives in
 * `artifacts/isola/scripts/provision-employees.ts`.
 *
 * Why create-or-get is matched on metadata rather than on name:
 * Paperclip enforces no uniqueness on agent name, and the display name differs from the
 * template id on purpose (template "Isola AI Sales & Front Desk Agent" is instantiated on
 * the EPIC company as "EPIC AI Sales & Front Desk Agent"). Matching on name would create a
 * duplicate the first time an instance is renamed. `metadata.isolaTemplateId` is the stable
 * key and is written by us at hire time.
 */

import type { Exposure, IsolaSidecar } from './employee-template';
import { resolveExposure } from './employee-template';

export interface PaperclipAgent {
  id: string;
  companyId: string;
  name: string;
  status: string;
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  urlKey?: string | null;
  role?: string | null;
}

export interface HireInput {
  name: string;
  role: string;
  title?: string;
  reportsTo?: string | null;
  capabilities?: string | null;
  adapterType: 'http';
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  budgetMonthlyCents: number;
  metadata: Record<string, unknown>;
}

/** The stable identity of a provisioned employee, independent of its display name. */
export function templateIdOf(agent: PaperclipAgent): string | null {
  const v = agent.metadata?.isolaTemplateId;
  return typeof v === 'string' && v ? v : null;
}

/**
 * Find the single existing agent for a template id.
 *
 * Throws when more than one matches. A duplicate is a provisioning defect and must be
 * surfaced, never silently resolved by picking the first — picking one would hide the
 * duplicate and let the next retry compound it.
 */
export function findExistingForTemplate(
  agents: readonly PaperclipAgent[],
  templateId: string,
): PaperclipAgent | null {
  const matches = agents.filter((a) => templateIdOf(a) === templateId);
  if (matches.length > 1) {
    throw new Error(
      `create-or-get is ambiguous: ${matches.length} agents carry metadata.isolaTemplateId=` +
        `"${templateId}" (${matches.map((m) => m.id).join(', ')}). Resolve the duplicate before retrying.`,
    );
  }
  return matches[0] ?? null;
}

export interface BuildHireOptions {
  sidecar: IsolaSidecar;
  /** Display name on this company; may differ from the template name. */
  instanceName: string;
  title: string;
  capabilities: string;
  /** Resolved agent UUID for the reporting line, or null for top level. */
  reportsToAgentId: string | null;
  runtimeUrl: string;
  /** Bearer for the exposure class this template belongs to. */
  runtimeBearer: string;
  budgetMonthlyCents: number;
}

export class ProvisioningError extends Error {}

/**
 * The bearer travels in this URL's `Authorization` header on every run, so the transport
 * must not be readable by anything outside the host.
 *
 * Two shapes are accepted:
 *  - `https://…` — anything, because TLS protects the bearer;
 *  - `http://<name>[:port]` where `<name>` contains no dot — a Docker/Swarm service alias,
 *    which is only resolvable on the container network and never routable from outside.
 *
 * Plain `http://` to a dotted host or an IP literal is refused: that is the case where the
 * bearer would cross a real network in clear. A dotted name is refused even if it looks
 * private, because DNS can be repointed and we would not notice.
 */
export function assertRuntimeUrlIsSafe(runtimeUrl: string, templateKey: string): void {
  let parsed: URL;
  try {
    parsed = new URL(runtimeUrl);
  } catch {
    throw new ProvisioningError(`template ${templateKey}: runtimeUrl is not a valid URL`);
  }

  if (parsed.protocol === 'https:') return;

  if (parsed.protocol !== 'http:') {
    throw new ProvisioningError(`template ${templateKey}: runtimeUrl must be http or https`);
  }
  // `URL.hostname` strips the port and lowercases; IPv6 literals keep their brackets.
  const host = parsed.hostname;
  const isDockerAlias = !host.includes('.') && !host.includes(':') && !host.startsWith('[');
  if (!isDockerAlias) {
    throw new ProvisioningError(
      `template ${templateKey}: plain http is only allowed to a dot-free Docker service alias ` +
        `(got "${host}"); use https for any routable host so the bearer is not sent in clear`,
    );
  }
}

/**
 * Build the `POST /api/companies/{id}/agent-hires` body for a template.
 *
 * Fails closed in three ways that matter:
 *  - a sidecar whose exposure is not exactly INTERNAL/PUBLIC is refused outright rather
 *    than defaulted, because defaulting at provision time would silently downgrade a
 *    template the author intended to be PUBLIC and produce a confusingly inert employee;
 *  - the credential class must match the exposure, so the wrong bearer cannot be wired in;
 *  - `timeoutMs` must be positive, because 0/absent means "no timeout" in Paperclip's http
 *    adapter and would let a hung runtime pin a run open indefinitely.
 */
export function buildHirePayload(opts: BuildHireOptions): HireInput {
  const { sidecar } = opts;

  if (sidecar.exposure !== 'INTERNAL' && sidecar.exposure !== 'PUBLIC') {
    throw new ProvisioningError(
      `template ${sidecar.templateKey}: exposure must be exactly INTERNAL or PUBLIC`,
    );
  }
  const expectedClass = sidecar.exposure === 'PUBLIC' ? 'RUNTIME_SECRET_PUBLIC' : 'RUNTIME_SECRET_INTERNAL';
  if (sidecar.runtimeProfile.credentialClass !== expectedClass) {
    throw new ProvisioningError(
      `template ${sidecar.templateKey}: credentialClass ${sidecar.runtimeProfile.credentialClass} ` +
        `does not match exposure ${sidecar.exposure}`,
    );
  }
  const timeoutMs = sidecar.runtimeProfile.timeoutMs;
  if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new ProvisioningError(`template ${sidecar.templateKey}: runtimeProfile.timeoutMs must be positive`);
  }
  if (!opts.runtimeBearer) {
    throw new ProvisioningError(`template ${sidecar.templateKey}: missing runtime bearer`);
  }
  assertRuntimeUrlIsSafe(opts.runtimeUrl, sidecar.templateKey);

  return {
    name: opts.instanceName,
    role: 'general',
    title: opts.title,
    reportsTo: opts.reportsToAgentId,
    capabilities: opts.capabilities,
    adapterType: 'http',
    adapterConfig: {
      url: opts.runtimeUrl,
      method: 'POST',
      timeoutMs,
      headers: { Authorization: `Bearer ${opts.runtimeBearer}` },
      payloadTemplate: {
        templateId: sidecar.templateKey,
        exposure: sidecar.exposure,
      },
    },
    runtimeConfig: {
      heartbeat: {
        enabled: false,
        wakeOnDemand: true,
        intervalSec: 300,
        cooldownSec: 10,
        maxConcurrentRuns: 1,
      },
    },
    budgetMonthlyCents: opts.budgetMonthlyCents,
    metadata: {
      isolaTemplateId: sidecar.templateId,
      isolaTemplateVersion: sidecar.templateVersion,
      isolaExposure: sidecar.exposure,
      isolaManagedBy: 'xp-isola-signup-to-agent-mvp-2026-08-10',
      ...(sidecar.lifecycle ? { isolaLifecycle: sidecar.lifecycle } : {}),
    },
  };
}

/**
 * Whether a provisioned agent still matches what its template says it should be.
 * Used to detect drift — including an agent that has PATCHed its own adapterConfig,
 * which Paperclip permits (server/src/routes/agents.ts:685).
 */
export function detectDrift(agent: PaperclipAgent, expected: HireInput): string[] {
  const drift: string[] = [];
  const cfg = (agent.adapterConfig ?? {}) as Record<string, unknown>;
  const expCfg = expected.adapterConfig;

  if (agent.adapterType !== expected.adapterType) {
    drift.push(`adapterType ${agent.adapterType} != ${expected.adapterType}`);
  }
  if (cfg.url !== expCfg.url) drift.push('adapterConfig.url changed');
  if (cfg.timeoutMs !== expCfg.timeoutMs) {
    drift.push(`adapterConfig.timeoutMs ${String(cfg.timeoutMs)} != ${String(expCfg.timeoutMs)}`);
  }

  const pt = (cfg.payloadTemplate ?? {}) as Record<string, unknown>;
  const expPt = expCfg.payloadTemplate as Record<string, unknown>;
  if (pt.templateId !== expPt.templateId) drift.push('payloadTemplate.templateId changed');
  if (pt.exposure !== expPt.exposure) drift.push('payloadTemplate.exposure changed');

  // The one that actually matters for containment.
  if (resolveExposure(agent.metadata?.isolaExposure) !== resolveExposure(expected.metadata.isolaExposure)) {
    drift.push('metadata.isolaExposure changed');
  }
  if (cfg.dangerouslySkipPermissions !== undefined) {
    drift.push('adapterConfig.dangerouslySkipPermissions was set — not valid for the http adapter');
  }
  return drift;
}

/** Exposure a runtime should assume for an agent record, failing closed. */
export function agentExposure(agent: PaperclipAgent): Exposure {
  return resolveExposure(agent.metadata?.isolaExposure);
}
