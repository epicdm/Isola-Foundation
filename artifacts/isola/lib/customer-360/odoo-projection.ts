import { json2Call, type OdooConfig, type OdooCustomer } from '@/engines/odoo';
import { odooDeepLink } from '@/lib/context/customer-sources';
import type {
  Customer360Balance,
  Customer360Document,
  Customer360Loop,
  Customer360RecommendedAction,
  Customer360Snapshot,
} from './contracts';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Refuses to build a deep link against an origin this projection does not
 * trust, even though `odooDeepLink` already refuses a missing baseUrl.
 *
 * `epic_sandbox` is a real, deployed, NON-authoritative Odoo instance
 * (CLAUDE.md's authority map: "the authority is epic-communications-inc.odoo.com
 * and nothing else"). A tenant's OdooBinding is data, not code — a
 * misconfigured row could point there, and a deep link is exactly the kind
 * of confident, clickable artifact that must never be built against it.
 * This does not hardcode a single tenant's host, because other tenants may
 * have their own legitimate self-hosted or SaaS Odoo instances; it refuses
 * only what is generically unsafe: a non-https origin, or a hostname naming
 * itself a sandbox.
 */
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

/** Server-authoritative deep link, or null when it cannot be honestly built. */
function safeOdooLink(baseUrl: string | undefined, model: string, recordId: number): string | null {
  if (!baseUrl || !isAllowedOdooOrigin(baseUrl)) return null;
  return odooDeepLink(baseUrl, model, recordId);
}

/** Odoo returns a many2one as [id, "NAME"]; the currency NAME is the code. */
function currencyCode(value: unknown): string | null {
  return displayName(value);
}

function displayName(value: unknown): string | null {
  if (Array.isArray(value)) return text(value[1]);
  if (value && typeof value === 'object') {
    return text((value as Record<string, unknown>).display_name);
  }
  return null;
}

const CUSTOMER_FIELDS = ['id', 'name', 'email', 'phone', 'phone_sanitized', 'street', 'city', 'is_company'];

/**
 * Sentinel for a read this projection is willing to lose but not willing to
 * misreport. Distinct from `[]`, which means Odoo answered and had nothing.
 */
const TOLERATED_FAILURE = Symbol('tolerated-odoo-read-failure');

/** Unlike the legacy helper, this lookup does not turn transport failure into no-match. */
async function findCustomerStrict(config: OdooConfig, phone: string): Promise<OdooCustomer | null> {
  const digits = phone.replace(/[^\d]/g, '');
  if (digits.length < 7) return null;
  const candidates = [...new Set([
    digits.length === 10 ? `+1${digits}` : `+${digits}`,
    `+${digits}`,
  ])];

  for (const candidate of candidates) {
    const rows = await json2Call(config, 'res.partner', 'search_read', {
      domain: [['phone_sanitized', '=', candidate]],
      fields: CUSTOMER_FIELDS,
      limit: 1,
    }, 12000) as OdooCustomer[];
    if (rows.length) return rows[0];
  }

  const rows = await json2Call(config, 'res.partner', 'search_read', {
    domain: [['phone_sanitized', 'ilike', digits.slice(-10)]],
    fields: CUSTOMER_FIELDS,
    limit: 1,
  }, 12000) as OdooCustomer[];
  return rows[0] ?? null;
}

/**
 * One partner-scoped Odoo projection for the embedded Chatwoot workspace.
 * It creates nothing and every read is pinned to the resolved partner id.
 */
export async function readCustomer360(
  config: OdooConfig,
  phone: string,
  conversation: Customer360Snapshot['conversation'],
): Promise<Customer360Snapshot | null> {
  const partner = await findCustomerStrict(config, phone);
  if (!partner) return null;
  const partnerId = partner.id;

  const [sales, invoices, opportunitiesRaw, tasksRaw] = await Promise.all([
    json2Call(config, 'sale.order', 'search_read', {
      domain: [['partner_id', '=', partnerId]],
      fields: ['id', 'name', 'state', 'amount_total', 'currency_id', 'date_order'],
      order: 'date_order desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'account.move', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice']],
      fields: ['id', 'name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'currency_id', 'invoice_date'],
      order: 'invoice_date desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'crm.lead', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'expected_revenue', 'date_deadline'],
      order: 'write_date desc',
      limit: 8,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
    json2Call(config, 'project.task', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'date_deadline'],
      order: 'date_deadline asc',
      limit: 8,
    }, 12000).catch(() => TOLERATED_FAILURE) as Promise<Record<string, unknown>[] | typeof TOLERATED_FAILURE>,
  ]);

  // A tolerated failure is reported, never rendered as an empty result. The
  // same distinction the customer lookup already makes between "no match" and
  // "could not ask".
  const openLoopsAvailable = opportunitiesRaw !== TOLERATED_FAILURE && tasksRaw !== TOLERATED_FAILURE;
  const opportunities = opportunitiesRaw === TOLERATED_FAILURE ? [] : opportunitiesRaw;
  const tasks = tasksRaw === TOLERATED_FAILURE ? [] : tasksRaw;

  const documents: Customer360Document[] = [
    ...sales.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: row.state === 'draft' || row.state === 'sent' ? 'quotation' as const : 'order' as const,
      state: text(row.state),
      total: number(row.amount_total),
      currency: currencyCode(row.currency_id),
      date: text(row.date_order),
      odooLink: safeOdooLink(config.url, 'sale.order', Number(row.id)),
    })),
    ...invoices.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: 'invoice' as const,
      state: text(row.state),
      paymentState: text(row.payment_state),
      total: number(row.amount_total),
      residual: number(row.amount_residual),
      currency: currencyCode(row.currency_id),
      date: text(row.invoice_date),
      odooLink: safeOdooLink(config.url, 'account.move', Number(row.id)),
    })),
  ];

  const openLoops: Customer360Loop[] = [
    ...opportunities.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'opportunity' as const,
      state: displayName(row.stage_id),
      due: text(row.date_deadline),
      value: number(row.expected_revenue),
      // Same builder as the document links; only the model differs.
      odooLink: safeOdooLink(config.url, 'crm.lead', Number(row.id)),
    })),
    ...tasks.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'task' as const,
      state: displayName(row.stage_id),
      due: text(row.date_deadline),
      odooLink: safeOdooLink(config.url, 'project.task', Number(row.id)),
    })),
  ];

  // GROUPED, NOT SUMMED. `def-receivables-headline-figure-is-mostly-draft-
  // invoices-2026-08-13` measured EPIC's own unpaid set as 265 XCD invoices
  // plus 2 USD ones, and states plainly that adding amount_residual across
  // them without conversion "produces a meaningless total". This runtime has
  // no FX rate and must not invent one, so each currency is reported on its
  // own line and the operator reads them separately.
  const byCurrency = new Map<string, number>();
  for (const row of invoices) {
    if (row.state !== 'posted') continue;
    const residual = number(row.amount_residual) ?? 0;
    if (residual === 0) continue;
    const code = currencyCode(row.currency_id) ?? 'UNKNOWN';
    byCurrency.set(code, (byCurrency.get(code) ?? 0) + residual);
  }
  const balances: Customer360Balance[] = [...byCurrency.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => b.amount - a.amount);

  return {
    verifiedAt: new Date().toISOString(),
    freshness: 'fresh',
    conversation,
    customer: {
      id: partnerId,
      name: partner.name,
      email: partner.email,
      phone: partner.phone,
      city: partner.city,
      // Odoo's own flag. Absent or non-boolean defaults to TRUE — the safe
      // direction, because the cost of an over-formal greeting to a person is
      // trivial and the cost of "Hi EPIC," to a company is a message that
      // reads as machine-generated.
      isCompany: partner.is_company !== false,
    },
    balances,
    documents,
    openLoops,
    openLoopsAvailable,
    recommendedAction: recommendedAction(documents, partner.name),
  };
}

/** en-DM: same locale the panel already renders amounts in. */
function formatMoney(amount: number, currency: string | null): string {
  if (!currency) return `${amount.toLocaleString('en-DM')} (currency unknown)`;
  try {
    return new Intl.NumberFormat('en-DM', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount.toLocaleString('en-DM')} ${currency}`;
  }
}

/**
 * S3: ONE recommendation, and only for the case this slice actually proves —
 * a draft quotation. Every other document shape gets no recommendation
 * rather than a wrong one; withholding is the honest default (dispatch:
 * "recommendation changes or is withheld" for non-draft quotes).
 */
function recommendedAction(
  documents: Customer360Document[],
  customerName: string,
): Customer360RecommendedAction | null {
  const draftQuotation = documents
    .filter((d) => d.kind === 'quotation' && d.state === 'draft')
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))[0];
  if (!draftQuotation) return null;

  const firstName = customerName.trim().split(/\s+/)[0] || customerName;
  const amount = draftQuotation.total != null
    ? formatMoney(draftQuotation.total, draftQuotation.currency)
    : 'an amount Odoo has not confirmed';

  return {
    kind: 'review-draft-quotation',
    headline: `Review quotation ${draftQuotation.reference} and ask the customer whether they would like to proceed or request changes.`,
    document: draftQuotation,
    reasoning: `${draftQuotation.reference} is a draft quotation for ${customerName} — it has not been sent, approved or accepted. Confirming intent before any further action avoids acting on a stale or unreviewed document.`,
    suggestedReply: `Hi ${firstName}, I've reviewed quotation ${draftQuotation.reference} for ${amount}. Would you like to proceed, or is there anything you'd like adjusted?`,
  };
}
