/**
 * Provision the Isola employee templates into the canonical Paperclip company.
 *
 * Create-or-get on `metadata.isolaTemplateId`. A second run must create nothing and must
 * report the existing agent ids. Nothing here deletes or overwrites an existing agent.
 *
 * Because the EPIC company sets `requireBoardApprovalForNewAgents=true`, direct
 * `POST /api/companies/{id}/agents` returns 409 by design
 * (server/src/routes/agents.ts:2140-2143). The supported path is
 * `POST /api/companies/{id}/agent-hires`, which creates the agent in `pending_approval`
 * and raises a native `hire_agent` approval. That native governance is deliberately kept:
 *   - the INTERNAL employee's hire is approved so it can execute its acceptance job;
 *   - the PUBLIC employee's hire is LEFT PENDING, which is exactly "staged, not ready".
 *
 * Usage:
 *   tsx artifacts/isola/scripts/provision-employees.ts --dry-run
 *   tsx artifacts/isola/scripts/provision-employees.ts
 *
 * Env: PAPERCLIP_BASE_URL, PAPERCLIP_BOARD_KEY, PAPERCLIP_COMPANY_ID,
 *      ISOLA_RUNTIME_URL, RUNTIME_SECRET_INTERNAL, RUNTIME_SECRET_PUBLIC
 */

import { join } from 'node:path';

import { TEMPLATE_ROOT, loadTemplate } from '../lib/employee-template';
import {
  buildHirePayload,
  detectDrift,
  findExistingForTemplate,
  type PaperclipAgent,
} from '../lib/employee-provisioning';

interface Plan {
  dir: string;
  instanceName: string;
  title: string;
  capabilities: string;
  bearerEnv: 'RUNTIME_SECRET_INTERNAL' | 'RUNTIME_SECRET_PUBLIC';
  /** Approve the native hire approval after creating it? */
  approveHire: boolean;
}

const PLANS: Plan[] = [
  {
    dir: join(TEMPLATE_ROOT, 'epic-staff-operations-coordinator', 'v1'),
    instanceName: 'EPIC Staff Operations Coordinator',
    title: 'Staff Operations Coordinator — Internal Operations',
    capabilities:
      'Reads a human-supplied internal operations fixture and returns a prioritised action list. ' +
      'Analysis and recommendation only; performs no action in any external system.',
    bearerEnv: 'RUNTIME_SECRET_INTERNAL',
    approveHire: true,
  },
  {
    dir: join(TEMPLATE_ROOT, 'isola-ai-sales-front-desk-agent', 'v1'),
    instanceName: 'EPIC AI Sales & Front Desk Agent',
    title: 'AI Sales & Front Desk Agent',
    capabilities:
      'Answers customer questions from approved business information, qualifies leads, captures ' +
      'name/contact/request, escalates to a human and resumes only after explicit handback.',
    bearerEnv: 'RUNTIME_SECRET_PUBLIC',
    // Left pending on purpose. An unapproved hire cannot run, which is the native
    // expression of "created but not Ready".
    approveHire: false,
  },
];

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing env ${name}`);
  return v ?? '';
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const base = env('PAPERCLIP_BASE_URL', !dryRun) || 'https://isola-ai.saas00.epic.dm';
  const key = env('PAPERCLIP_BOARD_KEY', !dryRun);
  const companyId = env('PAPERCLIP_COMPANY_ID', !dryRun) || '3ed3869b-463c-4876-8e16-ddc058f06cd9';
  const runtimeUrl = env('ISOLA_RUNTIME_URL', !dryRun) || 'https://isola-runtime.saas00.epic.dm/v1/invoke';

  async function api(method: string, path: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (res.status >= 400) {
      throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
    }
    return data;
  }

  const existing: PaperclipAgent[] = dryRun
    ? []
    : ((await api('GET', `/api/companies/${companyId}/agents`)) as PaperclipAgent[]);

  // The reporting line points at the company CEO when one exists.
  const ceo = existing.find((a) => a.role === 'ceo' || a.urlKey === 'ceo') ?? null;

  const results: Record<string, unknown>[] = [];

  for (const plan of PLANS) {
    const { sidecar } = loadTemplate(plan.dir);
    const payload = buildHirePayload({
      sidecar,
      instanceName: plan.instanceName,
      title: plan.title,
      capabilities: plan.capabilities,
      reportsToAgentId: ceo?.id ?? null,
      runtimeUrl,
      runtimeBearer: dryRun ? 'dry-run-placeholder' : env(plan.bearerEnv),
      budgetMonthlyCents: 1000,
    });

    const found = findExistingForTemplate(existing, sidecar.templateId);

    if (found) {
      // Idempotent path. Report drift but never silently rewrite the live agent.
      const drift = detectDrift(found, payload);
      results.push({
        template: sidecar.templateKey,
        action: 'existing',
        agentId: found.id,
        status: found.status,
        drift: drift.length ? drift : 'none',
      });
      continue;
    }

    if (dryRun) {
      results.push({
        template: sidecar.templateKey,
        action: 'would-create',
        exposure: sidecar.exposure,
        approveHire: plan.approveHire,
        // Never print the bearer, even the placeholder shape.
        adapterConfig: { ...payload.adapterConfig, headers: '<redacted>' },
      });
      continue;
    }

    const created = (await api('POST', `/api/companies/${companyId}/agent-hires`, payload)) as {
      agent?: PaperclipAgent;
      approval?: { id: string; status: string };
      id?: string;
    };
    const agentId = created.agent?.id ?? created.id;
    const approvalId = created.approval?.id ?? null;

    let approvalState = approvalId ? 'pending' : 'none';
    if (plan.approveHire && approvalId) {
      await api('POST', `/api/approvals/${approvalId}/approve`, {
        decisionNote: 'Isola WS1 factory proof — approved to permit the synthetic acceptance run.',
      });
      approvalState = 'approved';
    }

    results.push({
      template: sidecar.templateKey,
      action: 'created',
      agentId,
      approvalId,
      approvalState,
      exposure: sidecar.exposure,
    });
  }

  console.log(JSON.stringify({ companyId, runtimeUrl, dryRun, results }, null, 2));
}

main().catch((e) => {
  console.error('PROVISIONING FAILED:', e.message);
  process.exit(1);
});
