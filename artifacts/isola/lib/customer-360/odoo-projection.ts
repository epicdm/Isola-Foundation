import { json2Call, type OdooConfig, type OdooCustomer } from '@/engines/odoo';
import type {
  Customer360Document,
  Customer360Loop,
  Customer360Snapshot,
} from './contracts';

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function displayName(value: unknown): string | null {
  if (Array.isArray(value)) return text(value[1]);
  if (value && typeof value === 'object') {
    return text((value as Record<string, unknown>).display_name);
  }
  return null;
}

const CUSTOMER_FIELDS = ['id', 'name', 'email', 'phone', 'phone_sanitized', 'street', 'city', 'is_company'];

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

  const [sales, invoices, opportunities, tasks] = await Promise.all([
    json2Call(config, 'sale.order', 'search_read', {
      domain: [['partner_id', '=', partnerId]],
      fields: ['id', 'name', 'state', 'amount_total', 'date_order'],
      order: 'date_order desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'account.move', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['move_type', '=', 'out_invoice']],
      fields: ['id', 'name', 'state', 'payment_state', 'amount_total', 'amount_residual', 'invoice_date'],
      order: 'invoice_date desc',
      limit: 12,
    }, 12000) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'crm.lead', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'expected_revenue', 'date_deadline'],
      order: 'write_date desc',
      limit: 8,
    }, 12000).catch(() => []) as Promise<Record<string, unknown>[]>,
    json2Call(config, 'project.task', 'search_read', {
      domain: [['partner_id', '=', partnerId], ['active', '=', true]],
      fields: ['id', 'name', 'stage_id', 'date_deadline'],
      order: 'date_deadline asc',
      limit: 8,
    }, 12000).catch(() => []) as Promise<Record<string, unknown>[]>,
  ]);

  const documents: Customer360Document[] = [
    ...sales.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: row.state === 'draft' || row.state === 'sent' ? 'quotation' as const : 'order' as const,
      state: text(row.state),
      total: number(row.amount_total),
      date: text(row.date_order),
    })),
    ...invoices.map((row) => ({
      id: Number(row.id),
      reference: String(row.name ?? ''),
      kind: 'invoice' as const,
      state: text(row.state),
      paymentState: text(row.payment_state),
      total: number(row.amount_total),
      residual: number(row.amount_residual),
      date: text(row.invoice_date),
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
    })),
    ...tasks.map((row) => ({
      id: Number(row.id),
      title: String(row.name ?? ''),
      kind: 'task' as const,
      state: displayName(row.stage_id),
      due: text(row.date_deadline),
    })),
  ];

  const balanceDue = invoices
    .filter((row) => row.state === 'posted')
    .reduce((sum, row) => sum + (number(row.amount_residual) ?? 0), 0);

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
    },
    balanceDue: invoices.length ? balanceDue : null,
    documents,
    openLoops,
  };
}
