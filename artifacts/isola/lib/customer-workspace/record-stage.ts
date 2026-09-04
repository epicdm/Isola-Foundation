/**
 * record-stage@1 — the stage tracker shown inside a record's in-app detail
 * sheet (order/invoice/ticket), computed from REAL Odoo state.
 *
 * WHY THIS FILE EXISTS. The Lumen reference design's own stage tracker is a
 * strong pattern (see design/CUSTOMER-360-DESIGN-STUDY.md §3) but its own
 * source implementation is NOT a real computation for two of its three
 * kinds — `stageIdx` is hardcoded to a fixed index for orders and tickets,
 * genuinely computed only for invoices. That is expected of a design mock,
 * not a defect in it (owner correction, 2026-09-04) — but it means this
 * file, not the reference, is the actual spec for what ships. Every
 * function here is pure and every mapping decision is commented with the
 * Odoo field(s) it reads and why.
 *
 * FAIL-CLOSED RULE: when a real value doesn't map confidently onto a known
 * stage, this file returns the EARLIER of the two plausible positions, or
 * (for tickets, where stage names are Odoo-instance-configurable) an
 * explicit `null` index meaning "show the raw stage name, do not guess a
 * position on the tracker." Never claim a later stage than the evidence
 * supports.
 */

/* ── orders: Deal -> Order -> Fulfilled -> Invoiced -> Paid ────────────── */

export const ORDER_STAGES = ['Deal', 'Order', 'Fulfilled', 'Invoiced', 'Paid'] as const

export interface OrderStageInput {
  state: string | null // sale.order.state: draft | sent | sale | done | cancel
  invoiceStatus: string | null // sale.order.invoice_status: no | to invoice | invoiced | upselling
  /** True only when every invoice linked to this order (by invoice_origin = order.name) has payment_state 'paid'. Optional — omit if not fetched; the function stays at 'Invoiced' rather than guessing 'Paid'. */
  allLinkedInvoicesPaid?: boolean
}

/**
 * Reaching an order implies its deal already closed (there is no
 * "quotation that isn't from a deal" in this model), so Deal is always the
 * first, always-complete step for an order sheet — this is the one place
 * this file treats a step as automatically satisfied rather than derived.
 *
 * Order (index 1): the order exists and is not yet known to be fulfilled —
 * draft/sent/sale all land here absent stronger evidence.
 *
 * Fulfilled (index 2): approximated from invoice_status = 'to invoice',
 * since Odoo's default invoicing policies only allow that state once
 * delivery has actually happened. This is a real signal, not a guess, but
 * it is a PROXY for delivery — a build that also reads stock.picking.state
 * directly would be more precise; that read does not exist yet and is not
 * required to ship this stage correctly for the common case.
 *
 * Invoiced (index 3): invoice_status = 'invoiced'.
 *
 * Paid (index 4): only when the caller has separately confirmed every
 * linked invoice is paid (a second query — see `readOrderLinkedInvoices`
 * usage sites). Never inferred from invoice_status alone, since 'invoiced'
 * says nothing about payment.
 */
export function orderStageIndex(input: OrderStageInput): number | null {
  if (input.state === 'cancel') return null // cancelled falls off the linear tracker entirely
  if (input.allLinkedInvoicesPaid === true) return 4
  if (input.invoiceStatus === 'invoiced') return 3
  if (input.invoiceStatus === 'to invoice') return 2
  return 1
}

/* ── invoices: Draft -> Sent -> Due -> Paid ─────────────────────────────── */

export const INVOICE_STAGES = ['Draft', 'Sent', 'Due', 'Paid'] as const

export interface InvoiceStageInput {
  state: string | null // account.move.state: draft | posted | cancel
  paymentState: string | null // account.move.payment_state: not_paid | in_payment | paid | partial | reversed
  dueDate: string | null // account.move.invoice_date_due
  now?: Date
}

/**
 * Draft (0): state = draft — never sent, nothing to collect yet.
 * Paid (3): payment_state = paid (in_payment is treated as not-yet-Paid —
 *   money is moving but not confirmed settled, the same caution this
 *   session's Odoo readers already apply elsewhere to "in_payment").
 * Due (2): posted, not paid, and past its own due date.
 * Sent (1): posted, not paid, due date not yet passed (or no due date on
 *   record — the safer, earlier position when the date itself is unknown).
 */
export function invoiceStageIndex(input: InvoiceStageInput): number | null {
  if (input.state === 'cancel') return null
  if (input.state === 'draft') return 0
  if (input.paymentState === 'paid') return 3
  const now = input.now ?? new Date()
  const due = input.dueDate ? new Date(input.dueDate) : null
  if (due && due.getTime() < now.getTime()) return 2
  return 1
}

/* ── tickets: New -> Diagnosing -> In progress -> Resolved ──────────────── */

export const TICKET_STAGES = ['New', 'Diagnosing', 'In progress', 'Resolved'] as const

/**
 * helpdesk.ticket.stage_id names are configured per Odoo instance — this
 * session has only confirmed two real stage names live ("In Progress",
 * "Solved"). Rather than assume a fixed set of stage IDs that may not match
 * a given instance, this maps by keyword against the stage's own name, and
 * returns null (no guessed position — render the raw stage name instead)
 * when nothing matches. Extend the patterns below only after confirming a
 * real stage name against the live instance, never speculatively.
 */
export function ticketStageIndex(stageName: string | null): number | null {
  if (!stageName) return null
  const s = stageName.toLowerCase()
  if (/resolved|solved|closed/.test(s)) return 3
  if (/progress/.test(s)) return 2
  if (/diagnos/.test(s)) return 1
  if (/new/.test(s)) return 0
  return null
}
