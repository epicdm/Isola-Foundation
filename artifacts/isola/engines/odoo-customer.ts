/**
 * odoo-customer.ts — per-authenticated-user customer account reader (public agent, CONTAINED).
 *
 * The public/customer agent NEVER holds an Odoo credential and NEVER reads
 * "any customer". It reads ONLY the ONE verified user's OWN records, resolved
 * by their WhatsApp phone. Admin creds stay server-side (resolveOdooConfigForTenant);
 * every query here is HARD-SCOPED to the matched partner_id — no other partner,
 * no hr.employee, no internal accounting. This IS the containment: a compromised
 * public agent can, at most, read a known number's own account — never internal.
 *
 * Why a seam and not a restricted Odoo user: proven on the live Odoo (2026-07-17)
 * that any INTERNAL user reads hr.employee + accounting by design, and reading
 * arbitrary customers REQUIRES internal level; portal users are record-limited to
 * their own records. So no single Odoo login both reads any customer and denies
 * internal — the containment must live here, scoped per verified user.
 */
import { json2Call, findCustomerByPhone, type OdooConfig } from './odoo'

export interface CustomerOrder { name: string; state: string | null; amountTotal: number | null; date: string | null }
export interface CustomerInvoice { name: string; amountTotal: number | null; amountResidual: number | null; date: string | null; paymentState: string | null }
export interface CustomerAccount {
  matched: boolean
  customer: { id: number; name: string; email: string | null; phone: string | null } | null
  orders: CustomerOrder[]
  invoices: CustomerInvoice[]
  balanceDue: number | null
}

function num(v: unknown): number | null { return typeof v === 'number' ? v : null }
function str(v: unknown): string | null { return typeof v === 'string' && v ? v : null }

/**
 * getCustomerAccountByPhone — resolve the partner by phone, then read ONLY that
 * partner's own orders + customer invoices + balance. Every domain is pinned to
 * partner_id. Best-effort (nulls/[] on failure); never throws to the caller,
 * never widens beyond the one matched partner. Returns { matched:false } when the
 * number isn't recognized (the agent should then offer to pair via OTP).
 */
export async function getCustomerAccountByPhone(config: OdooConfig, phone: string): Promise<CustomerAccount> {
  const empty: CustomerAccount = { matched: false, customer: null, orders: [], invoices: [], balanceDue: null }
  const partner = await findCustomerByPhone(config, phone).catch(() => null)
  if (!partner) return empty
  const pid = partner.id

  const orders = (await json2Call(config, 'sale.order', 'search_read', {
    domain: [['partner_id', '=', pid]],
    fields: ['name', 'state', 'amount_total', 'date_order'],
    order: 'date_order desc', limit: 20,
  }, 12000).catch(() => [])) as Record<string, unknown>[]

  const invoices = (await json2Call(config, 'account.move', 'search_read', {
    domain: [['partner_id', '=', pid], ['move_type', '=', 'out_invoice']],
    fields: ['name', 'amount_total', 'amount_residual', 'invoice_date', 'state', 'payment_state'],
    order: 'invoice_date desc', limit: 20,
  }, 12000).catch(() => [])) as Record<string, unknown>[]

  const balanceDue = invoices
    .filter((i) => i?.state === 'posted')
    .reduce((s, i) => s + (typeof i?.amount_residual === 'number' ? (i.amount_residual as number) : 0), 0)

  return {
    matched: true,
    customer: { id: pid, name: partner.name, email: partner.email, phone: partner.phone },
    orders: orders.map((o) => ({ name: String(o.name ?? ''), state: str(o.state), amountTotal: num(o.amount_total), date: str(o.date_order) })),
    invoices: invoices.map((i) => ({ name: String(i.name ?? ''), amountTotal: num(i.amount_total), amountResidual: num(i.amount_residual), date: str(i.invoice_date), paymentState: str(i.payment_state) })),
    balanceDue: invoices.length ? balanceDue : null,
  }
}
