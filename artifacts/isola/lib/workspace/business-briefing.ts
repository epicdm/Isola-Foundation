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
 *
 * COMPANY SCOPE — DERIVED FROM ODOO'S OWN ACL, NEVER ASSERTED BY FOUNDATION
 * ---------------------------------------------------------------------------
 * `OdooBinding` names a DATABASE, not a company — a hosted_saas or
 * local_docker_clone instance can hold more than one `res.company`, and
 * CLAUDE.md is explicit: "Do not assume an Odoo database binding grants
 * access to every company in that database." An earlier version of this
 * module only checked that all rows returned in one section shared the SAME
 * company_id ("multi_company_records_in_one_binding") — that catches a
 * blended read, but a read that comes back entirely from ONE company this
 * tenant is not authorized for would sail through unchanged, because
 * self-consistency is not authorization.
 *
 * The fix resolves the tenant's AUTHORIZED company by querying Odoo's own
 * `res.users` record for the binding's credential (`login`) — the same
 * identity performing every other call here — and requires that credential
 * be scoped to EXACTLY ONE company (`company_ids` a singleton matching
 * `company_id`). This is Law 9's ceiling made concrete: "the ACL is the
 * ceiling ... intersected with the user's effective groups" — Foundation
 * asserts nothing about which company is authorized; it reads Odoo's own
 * answer for the credential the tenant already owns, LIVE, every call, never
 * cached (the same "resolve live, never cached" shape as the Paperclip
 * company-mapping fix in isola-portal PR #158). A binding with no `login`,
 * or whose credential is scoped to zero/more-than-one company, cannot prove
 * an authorized scope and is refused (`odoo_company_scope_unresolvable`) —
 * missing or ambiguous authorization is refused, never guessed.
 *
 * Once resolved, the authorized company id is applied TWICE: as an explicit
 * `company_id =` domain filter on every query (query-level scoping, primary
 * defense) AND as a post-read check that every returned row's own
 * `company_id` equals that same id (`unauthorized_company_records` if not —
 * covers a single wrong company, a mix of authorized/unauthorized rows, and
 * a company-less/`false` row, which can never be proven to belong to the
 * authorized company and is therefore never rendered). Both together are
 * defense-in-depth on top of Odoo's own record-rule ACL, which remains the
 * primary control — see CLAUDE.md Law 9.
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
  | 'odoo_company_scope_unresolvable'
  | 'unauthorized_company_records';

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
const UNAUTHORIZED_COMPANY = Symbol('business-briefing-unauthorized-company-records');

function sectionFrom(
  id: BriefingSectionId,
  result: BriefingRow[] | typeof TOLERATED_FAILURE | typeof UNAUTHORIZED_COMPANY,
): BriefingSection {
  if (result === TOLERATED_FAILURE) return unavailable(id, 'odoo_read_failed');
  if (result === UNAUTHORIZED_COMPANY) return unavailable(id, 'unauthorized_company_records');
  return ok(id, result);
}

function companyIdOf(value: unknown): number | null {
  if (Array.isArray(value) && typeof value[0] === 'number') return value[0];
  return null;
}

/**
 * RECORD SCOPE. Every row's own `company_id` must equal the AUTHORIZED
 * company resolved for this tenant's credential (see the module docstring's
 * "COMPANY SCOPE" section) — not merely agree with each other. This single
 * check subsumes the three failure shapes the task set out to distinguish:
 * a section entirely from one unauthorized company (no row equals
 * `authorizedCompanyId`), a mix of authorized/unauthorized rows (`.every`
 * fails on the unauthorized ones), and a company-less row (`company_id`
 * false/None never equals a real id, so it can never be proven to belong to
 * the authorized company and is treated as unauthorized, not silently
 * included or silently dropped — the whole section is refused by name,
 * consistent with this module's "never omit, report explicit
 * unavailability" rule).
 */
function withAuthorizedCompanyGuard<T extends { company_id: unknown }>(
  rows: T[],
  authorizedCompanyId: number,
  build: (rows: T[]) => BriefingRow[],
): BriefingRow[] | typeof UNAUTHORIZED_COMPANY {
  const allAuthorized = rows.every((r) => companyIdOf(r.company_id) === authorizedCompanyId);
  if (!allAuthorized) return UNAUTHORIZED_COMPANY;
  return build(rows);
}

interface OdooUserRow {
  id: unknown;
  company_id: unknown;
  company_ids: unknown;
}

type CompanyScopeResult = { ok: true; companyId: number } | { ok: false };

/**
 * Resolves the ONE Odoo company this tenant's credential is authorized for,
 * by asking Odoo itself — never a Foundation-asserted value. Requires
 * `binding.login` (the human user the API key belongs to, per
 * `OdooBinding`'s own doc comment) and requires that user's `company_ids`
 * be a singleton equal to its `company_id`: a credential scoped to zero or
 * more than one company cannot answer "which one is this tenant's own", so
 * it is refused rather than guessed (missing/ambiguous authorization).
 */
async function resolveAuthorizedCompany(config: OdooConfig, login: string | null | undefined): Promise<CompanyScopeResult> {
  if (!login || !login.trim()) return { ok: false };

  checkOdooPolicy('res.users', 'search_read');
  let rows: OdooUserRow[];
  try {
    rows = (await json2Call(
      config,
      'res.users',
      'search_read',
      { domain: [['login', '=', login]], fields: ['id', 'company_id', 'company_ids'], limit: 2 },
      12000,
    )) as OdooUserRow[];
  } catch {
    return { ok: false };
  }

  if (!rows || rows.length !== 1) return { ok: false };
  const companyId = companyIdOf(rows[0].company_id);
  if (companyId === null) return { ok: false };

  const allowedIds = Array.isArray(rows[0].company_ids)
    ? rows[0].company_ids.filter((v): v is number => typeof v === 'number')
    : [];
  if (allowedIds.length !== 1 || allowedIds[0] !== companyId) return { ok: false };

  return { ok: true, companyId };
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

async function readOverdueReceivables(config: OdooConfig, authorizedCompanyId: number): Promise<BriefingRow[] | typeof UNAUTHORIZED_COMPANY> {
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
        ['company_id', '=', authorizedCompanyId],
      ],
      fields: ['id', 'name', 'partner_id', 'amount_residual', 'currency_id', 'invoice_date_due', 'company_id'],
      order: 'invoice_date_due asc',
      limit: 25,
    },
    12000,
  )) as AccountMoveRow[];

  return withAuthorizedCompanyGuard(rows ?? [], authorizedCompanyId, (scoped) =>
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

async function readOpenOpportunities(config: OdooConfig, authorizedCompanyId: number): Promise<BriefingRow[] | typeof UNAUTHORIZED_COMPANY> {
  checkOdooPolicy('crm.lead', 'search_read');
  const rows = (await json2Call(
    config,
    'crm.lead',
    'search_read',
    {
      domain: [
        ['active', '=', true],
        ['type', '=', 'opportunity'],
        ['company_id', '=', authorizedCompanyId],
      ],
      fields: ['id', 'name', 'partner_id', 'expected_revenue', 'stage_id', 'date_deadline', 'company_id'],
      order: 'write_date desc',
      limit: 25,
    },
    12000,
  )) as CrmLeadRow[];

  return withAuthorizedCompanyGuard(rows ?? [], authorizedCompanyId, (scoped) =>
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

  const scope = await resolveAuthorizedCompany(config, binding.login);
  if (!scope.ok) {
    return {
      tenantId,
      generatedAt,
      odooConnected: true,
      sections: [
        unavailable('overdue_receivables', 'odoo_company_scope_unresolvable'),
        unavailable('open_opportunities', 'odoo_company_scope_unresolvable'),
      ],
    };
  }

  const toleratedFailure = (): typeof TOLERATED_FAILURE => TOLERATED_FAILURE;
  const [overdue, opportunities] = await Promise.all([
    readOverdueReceivables(config, scope.companyId).catch(toleratedFailure),
    readOpenOpportunities(config, scope.companyId).catch(toleratedFailure),
  ]);

  return {
    tenantId,
    generatedAt,
    odooConnected: true,
    sections: [sectionFrom('overdue_receivables', overdue), sectionFrom('open_opportunities', opportunities)],
  };
}
