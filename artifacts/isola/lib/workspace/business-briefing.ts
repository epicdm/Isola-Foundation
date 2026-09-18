/**
 * Read-only Odoo business briefing for an authenticated staff session.
 *
 * WHY THIS EXISTS
 * ----------------
 * The ratified INTERNAL CCO template (`epic-staff-operations-coordinator@v1`)
 * runs inside services/isola-runtime, which by owner ruling (2026-08-11, "do
 * not re-evaluate") offers the model NO tool of any kind — see that
 * service's own README ("No tool is ever offered to the model"). Its
 * acceptance job today reads only a synthetic overdue-invoice fixture placed
 * in the run context by the caller. This module does not touch that
 * boundary: it never gives the model a tool, and it is not invoked FROM the
 * runtime. It is a plain Foundation-owned read, reachable only by an
 * authenticated staff session, that a human can view directly today and
 * that could later become the caller-supplied run context for that same
 * acceptance job, replacing the synthetic fixture with real data.
 *
 * FIXED SHAPE, NEVER CALLER-CONTROLLED
 * -------------------------------------
 * Unlike lib/agent-tools.ts's `odoo.read` (which accepts a caller-chosen
 * model/method/domain behind a service-token), every query here is a
 * hardcoded model, domain and field list. There is no parameter that widens
 * what is read. `checkOdooPolicy` (lib/agent-tools.ts) is still applied to
 * each call for defense-in-depth symmetry with that module, even though a
 * fixed `search_read` against `account.move`/`crm.lead` could never trip it.
 *
 * TENANT SCOPE — NO PLATFORM-DEFAULT FALLBACK
 * ---------------------------------------------
 * `lib/engine-bindings.ts`'s `resolveOdooConfigForTenant` falls back to the
 * platform-default `ODOO_*` env when a tenant has no `OdooBinding` row. That
 * fallback is safe for callers that already have their own tenant scoping
 * elsewhere; it is NOT safe here, because a report titled "this tenant's
 * receivables" must never silently render another instance's data. This
 * module queries `OdooBinding` directly and reports `unavailable` when the
 * tenant has none — the same "never substitute a shared default for a
 * missing tenant mapping" rule this estate already applies to Paperclip
 * company ids.
 *
 * NEVER SUMS CURRENCIES
 * ----------------------
 * Rows are listed individually, each with its own currency code. No total is
 * ever computed across rows, because rows may be in different currencies —
 * see the Odoo authority rule that only `payment_state` is trustworthy and
 * currencies are never summed.
 */

import { prisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/tenant-secrets';
import { getOdooConfig } from '@/lib/engines';
import { json2Call, type OdooConfig } from '@/engines/odoo';
import { odooDeepLink } from '@/lib/context/customer-sources';
import { checkOdooPolicy } from '@/lib/agent-tools';

export type BriefingSectionId = 'overdue_receivables' | 'open_opportunities';

export type BriefingUnavailableReason =
  | 'no_odoo_connected_for_tenant'
  | 'odoo_binding_incomplete'
  | 'odoo_read_failed'
  | 'multi_company_records_in_one_binding';

export interface BriefingRow {
  id: number;
  label: string;
  detail: string;
  /** Deep link into the tenant's own Odoo, or null when one cannot be honestly built. */
  sourceUrl: string | null;
}

export type BriefingSection =
  | { id: BriefingSectionId; title: string; state: 'ok'; rows: BriefingRow[] }
  | { id: BriefingSectionId; title: string; state: 'unavailable'; reason: BriefingUnavailableReason; rows: [] };

export interface BusinessBriefing {
  tenantId: string;
  generatedAt: string;
  odooConnected: boolean;
  sections: BriefingSection[];
}

const SECTION_TITLES: Record<BriefingSectionId, string> = {
  overdue_receivables: 'Overdue receivables',
  open_opportunities: 'Open opportunities',
};

function unavailable(id: BriefingSectionId, reason: BriefingUnavailableReason): BriefingSection {
  return { id, title: SECTION_TITLES[id], state: 'unavailable', reason, rows: [] };
}

function ok(id: BriefingSectionId, rows: BriefingRow[]): BriefingSection {
  return { id, title: SECTION_TITLES[id], state: 'ok', rows };
}

/** Refuses a deep link into a non-https or self-declared-sandbox origin —
 *  same guard lib/customer-360/odoo-projection.ts applies, duplicated here
 *  rather than imported because it is three lines and this module must not
 *  take a dependency on the customer-360 projection to get it. */
function isAllowedOdooOrigin(baseUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (/sandbox/i.test(parsed.hostname)) return false;
  return true;
}

function safeLink(baseUrl: string, model: string, recordId: number): string | null {
  if (!isAllowedOdooOrigin(baseUrl)) return null;
  return odooDeepLink(baseUrl, model, recordId);
}

function displayName(value: unknown): string {
  if (Array.isArray(value)) return typeof value[1] === 'string' ? value[1] : 'Unknown';
  return 'Unknown';
}

function formatMoney(amount: unknown, currency: unknown): string {
  const n = typeof amount === 'number' ? amount : Number(amount);
  const code = displayName(currency);
  if (!Number.isFinite(n)) return 'amount unknown';
  return code !== 'Unknown' ? `${n.toFixed(2)} ${code}` : n.toFixed(2);
}

const TOLERATED_FAILURE = Symbol('business-briefing-read-failure');
const MULTI_COMPANY = Symbol('business-briefing-multi-company-in-one-binding');

function sectionFrom(
  id: BriefingSectionId,
  result: BriefingRow[] | typeof TOLERATED_FAILURE | typeof MULTI_COMPANY,
): BriefingSection {
  if (result === TOLERATED_FAILURE) return unavailable(id, 'odoo_read_failed');
  if (result === MULTI_COMPANY) return unavailable(id, 'multi_company_records_in_one_binding');
  return ok(id, result);
}

function companyIdOf(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return null;
}

/**
 * RECORD SCOPE. An `OdooBinding` names one Odoo DATABASE, not one COMPANY —
 * a hosted_saas or local_docker_clone instance could in principle hold more
 * than one `res.company`. Odoo's own record rules already scope a
 * `search_read` to the API key's authorised companies (see CLAUDE.md's ACL
 * law: the ceiling is `ir.model.access` intersected with the user's
 * effective groups), so this is defense-in-depth, not the primary control —
 * but a briefing titled "this tenant's receivables" must never silently
 * blend two companies' records into one list. Every row's `company_id` is
 * checked; if more than one distinct company appears, the WHOLE section is
 * refused by name rather than rendered as if it were one company's data.
 */
function withSingleCompanyGuard<T extends { company_id: unknown }>(
  rows: T[],
  build: (rows: T[]) => BriefingRow[],
): BriefingRow[] | typeof MULTI_COMPANY {
  const companyIds = new Set(rows.map((r) => companyIdOf(r.company_id)).filter((id): id is number => id !== null));
  if (companyIds.size > 1) return MULTI_COMPANY;
  return build(rows);
}

interface AccountMoveRow {
  id: unknown;
  name: unknown;
  partner_id: unknown;
  amount_residual: unknown;
  currency_id: unknown;
  invoice_date_due: unknown;
  company_id: unknown;
}

async function readOverdueReceivables(config: OdooConfig): Promise<BriefingRow[] | typeof MULTI_COMPANY> {
  checkOdooPolicy('account.move', 'search_read');
  const today = new Date().toISOString().slice(0, 10);
  const rows = (await json2Call(
    config,
    'account.move',
    'search_read',
    {
      domain: [
        ['move_type', '=', 'out_invoice'],
        ['state', '=', 'posted'],
        ['payment_state', 'in', ['not_paid', 'partial']],
        ['invoice_date_due', '<', today],
      ],
      fields: ['id', 'name', 'partner_id', 'amount_residual', 'currency_id', 'invoice_date_due', 'company_id'],
      order: 'invoice_date_due asc',
      limit: 25,
    },
    12000,
  )) as AccountMoveRow[];

  return withSingleCompanyGuard(rows ?? [], (scoped) =>
    scoped.map((row) => {
      const id = Number(row.id);
      const partner = displayName(row.partner_id);
      return {
        id,
        label: `${String(row.name ?? '')} — ${partner}`,
        detail: `${formatMoney(row.amount_residual, row.currency_id)} outstanding, due ${String(row.invoice_date_due ?? 'unknown')}`,
        sourceUrl: safeLink(config.url, 'account.move', id),
      };
    }),
  );
}

interface CrmLeadRow {
  id: unknown;
  name: unknown;
  partner_id: unknown;
  expected_revenue: unknown;
  stage_id: unknown;
  date_deadline: unknown;
  company_id: unknown;
}

async function readOpenOpportunities(config: OdooConfig): Promise<BriefingRow[] | typeof MULTI_COMPANY> {
  checkOdooPolicy('crm.lead', 'search_read');
  const rows = (await json2Call(
    config,
    'crm.lead',
    'search_read',
    {
      domain: [
        ['active', '=', true],
        ['type', '=', 'opportunity'],
      ],
      fields: ['id', 'name', 'partner_id', 'expected_revenue', 'stage_id', 'date_deadline', 'company_id'],
      order: 'write_date desc',
      limit: 25,
    },
    12000,
  )) as CrmLeadRow[];

  return withSingleCompanyGuard(rows ?? [], (scoped) =>
    scoped.map((row) => {
      const id = Number(row.id);
      const partner = displayName(row.partner_id);
      const stage = displayName(row.stage_id);
      const revenue = typeof row.expected_revenue === 'number' ? row.expected_revenue.toFixed(2) : 'unknown';
      return {
        id,
        label: `${String(row.name ?? '')} — ${partner}`,
        detail: `Stage: ${stage}, expected ${revenue}, deadline ${String(row.date_deadline ?? 'none set')}`,
        sourceUrl: safeLink(config.url, 'crm.lead', id),
      };
    }),
  );
}

export async function getBusinessBriefing(tenantId: string): Promise<BusinessBriefing> {
  const generatedAt = new Date().toISOString();
  const binding = await prisma.odooBinding.findUnique({ where: { tenant_id: tenantId } });

  if (!binding) {
    return {
      tenantId,
      generatedAt,
      odooConnected: false,
      sections: [
        unavailable('overdue_receivables', 'no_odoo_connected_for_tenant'),
        unavailable('open_opportunities', 'no_odoo_connected_for_tenant'),
      ],
    };
  }

  let config: OdooConfig;
  try {
    config = getOdooConfig({ url: binding.url, db: binding.db, apiKey: decryptSecret(binding.api_key_enc) });
  } catch {
    return {
      tenantId,
      generatedAt,
      odooConnected: false,
      sections: [
        unavailable('overdue_receivables', 'odoo_binding_incomplete'),
        unavailable('open_opportunities', 'odoo_binding_incomplete'),
      ],
    };
  }

  const toleratedFailure = (): typeof TOLERATED_FAILURE => TOLERATED_FAILURE;
  const [overdue, opportunities] = await Promise.all([
    readOverdueReceivables(config).catch(toleratedFailure),
    readOpenOpportunities(config).catch(toleratedFailure),
  ]);

  return {
    tenantId,
    generatedAt,
    odooConnected: true,
    sections: [sectionFrom('overdue_receivables', overdue), sectionFrom('open_opportunities', opportunities)],
  };
}
